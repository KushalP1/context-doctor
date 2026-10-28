/**
 * Claude Code UserPromptSubmit hook: runs on EVERY query in Claude Code (and
 * Codex, same format), and after every tool call in Cursor (postToolUse).
 *
 * Claude Code pipes hook input as JSON on stdin ({session_id, transcript_path,
 * prompt, ...}). We profile the session transcript; when the context is lean
 * we print nothing (zero noise, near-zero cost). When it crosses thresholds we
 * emit additionalContext with targeted hygiene guidance — so every query in a
 * heavy session gets nudged toward a leaner context automatically.
 *
 * Registered by `context-doctor install` under hooks.UserPromptSubmit in
 * ~/.claude/settings.json; removed by `context-doctor uninstall`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { ledgerPath, recordLedger, statePath } from "./ledger.js";
import { copilotSessionStartOutput } from "./copilot.js";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { parseSessionFile } from "./session.js";
import { formatTokens, CHARS_PER_TOKEN, LARGEST_WINDOW } from "./tokens.js";
import { ensureProxyUp } from "./autopilot.js";
import { autoCompactsAt, detectColdResume, renderColdResume, renderColdResumeNotice, resumeVerdict, sessionWriteMultiplier, withResumeVerdict } from "./coldresume.js";
import { formatUsd, pricingFor } from "./pricing.js";
import { checkBudget, loadConfig } from "./config.js";
import { modelSwitchMessage } from "./modelswitch.js";
import { compactFacts, compactInstructions } from "./precompact.js";
import { fanoutHook, subagentCosts } from "./fanout.js";
import { claudeDir } from "./claudedir.js";
/** Default nudge threshold; a project budget or env var can lower/raise it. */
const DEFAULT_WARN_TOKENS = 80_000;
/**
 * Threshold precedence: CONTEXT_DOCTOR_WARN_TOKENS env var, then the project
 * budget's maxTokens (.contextdoctorrc), then the default.
 */
function warnThreshold(budgetMaxTokens) {
    const env = Number(process.env.CONTEXT_DOCTOR_WARN_TOKENS);
    if (env > 0)
        return env;
    if (budgetMaxTokens !== undefined && budgetMaxTokens > 0)
        return budgetMaxTokens;
    return DEFAULT_WARN_TOKENS;
}
/** Re-nudge only after the context grows another 40% — one reminder, not a nag. */
const REGROWTH_FACTOR = 1.4;
/**
 * Fast-path gate: no tokenizer we model packs more than one token into fewer
 * bytes than its densest ratio (Claude on code, 2.4), and the transcript
 * carries JSON overhead on top, so a file smaller than this cannot possibly
 * hold that many tokens of context. Lean sessions cost one stat() call — the
 * transcript is never even read. (This used 4 bytes per token until 0.19,
 * which let Claude sessions past the threshold take the fast path.)
 *
 * The threshold is compared with the API's figure, which also counts what the
 * transcript never holds: system prompt, tool schemas, memory files. Sized as
 * if the transcript were the whole context, the gate hid sessions from low
 * thresholds (a 60k budget saw nothing until 144 KB; half of one machine's
 * sessions passed 60k live tokens below that). So that front matter is
 * allowed for first. Measured on 78 Claude Code sessions with several MCP
 * servers: first requests carried 27k-70k tokens, of which up to 43k could
 * not have come from the transcript at its densest; 50k covers that. Lean
 * sessions below the remaining byte count still cost one stat().
 */
const DENSEST_CHARS_PER_TOKEN = Math.min(...Object.values(CHARS_PER_TOKEN).map((r) => Math.min(r.prose, r.code)));
const FRONT_MATTER_ALLOWANCE = 50_000;
function minBytesForWarn(threshold) {
    return Math.floor(Math.max(0, threshold - FRONT_MATTER_ALLOWANCE) * DENSEST_CHARS_PER_TOKEN);
}
/**
 * State lives in one small file per session, not one shared map.
 *
 * The hook runs once per prompt in every Claude Code window, and people keep
 * several open. With a shared JSON map, concurrent hooks each read the whole
 * map and wrote it back, so the last writer erased everyone else: measured,
 * 12 simultaneous sessions left 4 surviving entries. The cost of losing an
 * entry is a repeated warning the regrowth gate exists to prevent, plus a full
 * re-parse of a transcript that can be hundreds of megabytes.
 *
 * A process that only ever writes its own session's file cannot race another.
 */
function stateDir() {
    return statePath().replace(/\.json$/, "") + ".d";
}
function sessionStatePath(sessionId) {
    // Session ids are usually uuids, but the fallback id is a filesystem path.
    // Hashing keeps the filename valid whatever the id looks like.
    return join(stateDir(), createHash("sha1").update(sessionId).digest("hex").slice(0, 16) + ".json");
}
function readSessionState(sessionId) {
    try {
        const raw = JSON.parse(readFileSync(sessionStatePath(sessionId), "utf8"));
        if (typeof raw?.t === "number" && typeof raw?.b === "number")
            return raw;
    }
    catch {
        /* absent or half-written: treat as a first run */
    }
    // Migration: entries written by the shared-map versions are still useful.
    try {
        const legacy = JSON.parse(readFileSync(statePath(), "utf8"));
        const entry = legacy[sessionId];
        if (typeof entry === "number")
            return { t: entry, b: 0 };
        if (entry && typeof entry.t === "number")
            return { t: entry.t, b: entry.b ?? 0 };
    }
    catch {
        /* no legacy file */
    }
    return { t: 0, b: 0 };
}
/** Keep the directory from growing without bound as sessions come and go. */
const MAX_STATE_FILES = 200;
function writeSessionState(sessionId, state) {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionStatePath(sessionId), JSON.stringify(state));
    try {
        const files = readdirSync(dir);
        if (files.length <= MAX_STATE_FILES)
            return;
        const byAge = files
            .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)
            .slice(MAX_STATE_FILES);
        for (const { f } of byAge)
            rmSync(join(dir, f), { force: true });
    }
    catch {
        /* pruning is housekeeping, never worth failing a prompt over */
    }
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
function settingsHasOurHook(event = "UserPromptSubmit") {
    try {
        // Per event: a settings.json that has our prompt hook but not our
        // PreModelSwitch one (install skips it next to an older Claude Code)
        // must not silence the plugin's copy of the event it lacks.
        const hooks = JSON.parse(readFileSync(join(claudeDir(), "settings.json"), "utf8"))?.hooks?.[event || "UserPromptSubmit"];
        return JSON.stringify(hooks ?? "").includes("context-doctor");
    }
    catch {
        return false;
    }
}
/**
 * Hook input with the string fields checked. A number or object where a path
 * belongs reached fs.existsSync, which on current Node prints a
 * DeprecationWarning into the user's session (and will throw on a later one).
 */
export function hookInput(raw) {
    const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const out = { ...obj };
    for (const key of ["session_id", "transcript_path", "cwd", "hook_event_name", "conversation_id", "model", "cursor_version"]) {
        if (typeof obj[key] !== "string" || obj[key] === "")
            delete out[key];
    }
    out.workspace_roots = Array.isArray(obj.workspace_roots) ? obj.workspace_roots.filter((r) => typeof r === "string") : undefined;
    if (out.workspace_roots === undefined)
        delete out.workspace_roots;
    return out;
}
export async function runHook(app) {
    // A hook must never break the user's prompt: any failure exits silently.
    try {
        // GitHub Copilot (`hook copilot`, its sessionStart): the standing rules,
        // nothing else. No Copilot hook that can add context gets a transcript,
        // and Copilot never routes through autopilot, so there is no self-heal.
        if (app === "copilot") {
            // An input that does not parse (empty, a BOM, cut short) is still a
            // session start: the rules go in rather than nothing.
            let input = {};
            try {
                input = JSON.parse((await readStdin()).replace(/^\uFEFF/, ""));
            }
            catch { /* not JSON: answer as for an empty input */ }
            const out = copilotSessionStartOutput(input);
            if (out) {
                process.stdout.write(out + "\n");
                // Evidence for `doctor`, only where the ledger's folder already is:
                // creating ~/.claude would make install and doctor see Claude Code.
                if (existsSync(dirname(ledgerPath())))
                    recordLedger({ ev: "session_rules", app: "copilot" });
            }
            return;
        }
        // Autopilot self-heal: this prompt's request is about to go to the proxy,
        // so if the proxy died, start it now. One existsSync when autopilot is
        // off; a ~1ms localhost health check when it is on and healthy.
        const heal = ensureProxyUp().catch(() => undefined);
        // Installed both ways (plugin and `context-doctor install`)? The plugin
        // copy stays silent so the model is told once, not twice.
        const input = hookInput(JSON.parse(await readStdin()));
        if (process.env.CLAUDE_PLUGIN_ROOT && settingsHasOurHook(input.hook_event_name)) {
            await heal;
            return;
        }
        await heal;
        // Before a model switch: what re-writing this context into the new
        // model's cache costs, shown to the user. Never blocks (no decision, exit
        // 0); a hook that failed or timed out here would block the switch, so
        // this path only reads the transcript's tail.
        if (input.hook_event_name === "PreModelSwitch") {
            const message = modelSwitchMessage(input);
            if (message)
                process.stdout.write(JSON.stringify({ systemMessage: message }) + "\n");
            return;
        }
        // Before a subagent starts (PreToolUse on the Agent tool): its price at
        // the user's own median, to the user, and once to the model. Never a
        // permission decision, never exit 2: the subagent always starts.
        if (input.hook_event_name === "PreToolUse") {
            const r = fanoutHook(input, subagentCosts(), input.session_id ?? input.transcript_path ?? "unknown");
            const out = {};
            if (r.systemMessage)
                out.systemMessage = r.systemMessage;
            if (r.additionalContext)
                out.hookSpecificOutput = { hookEventName: "PreToolUse", additionalContext: r.additionalContext };
            if (Object.keys(out).length)
                process.stdout.write(JSON.stringify(out) + "\n");
            return;
        }
        // A resumed session: Claude Code says whether its cache expired and what
        // re-caching costs. Kept for the first prompt, which decides the offer
        // (an offer before any message would come before the rebuild it prices).
        if (input.hook_event_name === "SessionStart") {
            const verdict = resumeVerdict(input);
            if (verdict && input.session_id)
                writeSessionState(input.session_id, { ...readSessionState(input.session_id), rv: verdict });
            return;
        }
        // Before a compaction: tell the summary what this session cannot lose.
        // Claude Code adds a PreCompact hook's plain-text output to the
        // compaction's instructions (auto and manual alike).
        if (input.hook_event_name === "PreCompact") {
            if (input.transcript_path && existsSync(input.transcript_path)) {
                const text = compactInstructions(compactFacts(input.transcript_path));
                if (text) {
                    process.stdout.write(text + "\n");
                    recordLedger({ ev: "precompact", sid: (input.session_id ?? "").slice(0, 12), tok: text.length });
                }
            }
            return;
        }
        // Cursor runs this hook twice over: Claude Code's UserPromptSubmit as its
        // beforeSubmitPrompt (which cannot add context, so there is nothing to do),
        // and natively after each tool call, where `additional_context` reaches
        // the model. Codex and Claude Code send UserPromptSubmit.
        // Cursor marks every hook input with cursor_version; any of its events but
        // postToolUse would only spend the once-per-growth warning on output Cursor
        // drops.
        // postToolUseFailure and sessionStart carry additional_context too: the
        // first serves a chat whose tool calls fail, the second a resumed heavy chat.
        const cursor = input.hook_event_name === "postToolUse" || input.hook_event_name === "postToolUseFailure" || input.hook_event_name === "sessionStart";
        if (input.hook_event_name === "beforeSubmitPrompt" || (input.cursor_version && !cursor))
            return;
        const transcriptPath = input.transcript_path;
        if (!transcriptPath || !existsSync(transcriptPath))
            return;
        // Fast path 1: a small transcript cannot exceed the threshold — exit on a
        // single stat() without reading the file. This is the every-prompt cost
        // for lean sessions: ~1ms.
        const { config } = loadConfig(input.cwd ?? input.workspace_roots?.[0] ?? process.cwd());
        const threshold = warnThreshold(config.budget?.maxTokens);
        const sizeBytes = statSync(transcriptPath).size;
        if (sizeBytes < minBytesForWarn(threshold))
            return;
        // Fast path 2: growth gate BEFORE parsing. If the file hasn't grown ~40%
        // since the last full parse, nothing new can trigger — exit without the
        // expensive read. Heavy-but-quiet sessions cost one stat + tiny state read.
        const sessionId = input.session_id ?? input.conversation_id ?? transcriptPath;
        const prev = readSessionState(sessionId);
        // Cold resume: back on a large session after the cache expired. Checked
        // before the growth gate, because a return after idle involves no growth.
        // Once per idle period; the tail read is ~1 ms and only on large files.
        const notes = [];
        let notice;
        // Silent when Claude Code compacts this very prompt itself (the context
        // is past its auto-compact window, e.g. one set smaller since): an offer
        // would arrive after the compaction it proposes. Below the window the
        // note tells the model to stay quiet if a compaction came first (seen
        // once in 516 cold returns: a 964k session compacted, then the reply
        // offered /compact on the fresh summary).
        let cold = withResumeVerdict(detectColdResume(transcriptPath), prev.rv);
        if (cold && cold.tokens >= (autoCompactsAt(cold.model ?? input.model) ?? Infinity))
            cold = undefined;
        let cr = prev.cr;
        if (cold && cold.lastReplyAt !== prev.cr) {
            notes.push(renderColdResume(cold));
            notice = renderColdResumeNotice(cold);
            cr = cold.lastReplyAt;
            recordLedger({ ev: "cold_resume", sid: sessionId.slice(0, 12), tok: cold.tokens, model: cold.model });
        }
        const emit = (lines) => {
            if (lines.length === 0 && !notice)
                return;
            const block = `<context-doctor>\n${lines.join("\n")}\n</context-doctor>`;
            if (cursor) {
                // Cursor's postToolUse has no user-facing field, so only the model's note goes out.
                if (lines.length > 0)
                    console.log(JSON.stringify({ additional_context: block }));
                return;
            }
            const out = {};
            // systemMessage is shown to the user in the app; additionalContext goes to the model.
            if (notice)
                out.systemMessage = notice;
            // Gemini CLI's prompt hook is BeforeAgent; it reads the same output shape.
            const event = input.hook_event_name === "BeforeAgent" ? "BeforeAgent" : "UserPromptSubmit";
            if (lines.length > 0)
                out.hookSpecificOutput = { hookEventName: event, additionalContext: block };
            console.log(JSON.stringify(out));
        };
        if (prev.b > 0 && sizeBytes < prev.b * REGROWTH_FACTOR) {
            if (cr !== prev.cr)
                writeSessionState(sessionId, { ...prev, cr });
            emit(notes);
            return;
        }
        // Slow path (growth events only): full parse + profile.
        const parsed = parseSessionFile(transcriptPath);
        if (parsed.messageCount === 0)
            return;
        const model = parsed.model ?? input.model;
        const profile = profileConversation(parseConversation(parsed.conversationJson), model);
        // Prefer the API's own figure when the transcript carries it: it includes
        // the system prompt and tool schemas the transcript omits, so it is the
        // real context size rather than a message-only estimate.
        const liveTokens = parsed.reportedInputTokens ?? profile.totalTokens;
        // Record this parse so the next prompts take fast path 2.
        const shouldWarn = liveTokens >= threshold && liveTokens >= prev.t * REGROWTH_FACTOR;
        // The regrowth bar follows the context DOWN as well: after a compaction it
        // is measured from the compacted size. Kept at the old peak, the next
        // warning needed 1.4x a size the session no longer had (seen: warned at
        // 843k, compacted, then regrew to 809k without a word).
        writeSessionState(sessionId, { t: shouldWarn ? liveTokens : Math.min(prev.t, liveTokens), b: sizeBytes, cr });
        recordLedger({ ev: "check", sid: sessionId.slice(0, 12), tok: liveTokens, warn: shouldWarn, ...(input.cursor_version ? { cv: input.cursor_version } : {}) });
        if (!shouldWarn) {
            emit(notes);
            return;
        }
        // An estimate past the window (no API figure, e.g. a history imported into
        // Codex) is not the live context: the app must already be trimming it.
        const overWindow = !cursor && parsed.reportedInputTokens === undefined && liveTokens > (profile.contextWindow ?? LARGEST_WINDOW);
        const windowPct = !cursor && !overWindow && profile.contextWindow ? (liveTokens / profile.contextWindow) * 100 : undefined;
        // Agent sessions run on the prompt cache: a message normally re-reads the
        // context at the cached rate (0.1x) and pays the full rate only when the
        // cache has expired. Quoting the uncached figure alone overstated the
        // per-message cost tenfold (fixed in 0.22).
        // An expired cache is re-written at the TTL this session writes at, read
        // from the transcript's tail: Claude Code's main thread has mostly
        // written the 1-hour cache, at 2x input, where a flat 1.25x quoted the
        // cold message 37% low (5-minute writes stay at 1.25x).
        const pricing = pricingFor(model);
        const cachedUsd = pricing ? (liveTokens * pricing.cacheReadPerM) / 1e6 : undefined;
        const coldUsd = pricing ? (liveTokens * pricing.inputPerM * sessionWriteMultiplier(transcriptPath)) / 1e6 : undefined;
        // Cursor's agent transcript records tool calls but not their output, and
        // keeps turns Cursor has since summarized, so it measures how much the chat
        // has accumulated, not the live context: no window share or price for it.
        const lines = cursor ? [
            `This chat has accumulated ~${formatTokens(liveTokens)} tokens of messages and tool calls (tool output not counted; Cursor summarizes older turns itself, so the live context may differ).`,
            "Practice context hygiene from here on: summarize large tool results instead of keeping them verbatim, reference earlier content rather than re-reading or re-quoting it, and keep responses lean.",
        ] : overWindow ? [
            `This session's transcript holds ~${formatTokens(liveTokens)} tokens, more than ${profile.contextWindow ? `the model's ~${formatTokens(profile.contextWindow)}` : "any current model's"} window, so the app is already summarizing or dropping older turns; what the model sees is a part of it.`,
            "Practice context hygiene from here on: summarize large tool results instead of keeping them verbatim, reference earlier content rather than re-reading or re-quoting it, and keep responses lean.",
        ] : [
            `This session's context is at ~${formatTokens(liveTokens)} tokens` +
                (windowPct !== undefined ? ` (${windowPct.toFixed(0)}% of the window)` : "") +
                (cachedUsd !== undefined ? `: each message re-reads it for ~${formatUsd(cachedUsd)} from the prompt cache, ~${formatUsd(coldUsd)} when the cache has expired` : "") +
                ".",
            "Practice context hygiene from here on: summarize large tool results instead of keeping them verbatim, reference earlier content rather than re-reading or re-quoting it, and keep responses lean.",
        ];
        // A configured budget is the user's own limit — say so first and by name.
        const verdict = checkBudget(config.budget, { ...profile, totalTokens: liveTokens, usagePct: windowPct });
        if (verdict.overBudget) {
            lines.splice(1, 0, `This project's context budget is exceeded: ${verdict.breaches.join("; ")}. Treat compaction as a priority, not an option.`);
        }
        const topFinding = profile.findings.find((f) => f.estSavings > 0);
        if (topFinding) {
            lines.push(`Largest recoverable waste: ${topFinding.message} (${topFinding.suggestion})`);
        }
        if (liveTokens > threshold * 2) {
            lines.push(cursor
                ? "If the task changes, suggest the user start a new chat from a short summary of this one."
                : "If it fits the flow, offer the user a compaction of the older history.");
        }
        emit([...notes, ...lines]);
    }
    catch {
        /* silent — never disturb the prompt */
    }
}
