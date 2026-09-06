/**
 * Claude Code UserPromptSubmit hook: runs on EVERY query in Claude Code.
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
import { join } from "node:path";
import { recordLedger, statePath } from "./ledger.js";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { parseSessionFile } from "./session.js";
import { formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";
import { checkBudget, loadConfig } from "./config.js";
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
 * Fast-path gate: text tokens are at least ~4 bytes each and the transcript
 * carries JSON overhead on top, so a file smaller than this cannot possibly
 * hold that many tokens of context. Lean sessions cost one stat() call — the
 * transcript is never even read.
 */
function minBytesForWarn(threshold) {
    return threshold * 4;
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
export async function runHook() {
    // A hook must never break the user's prompt: any failure exits silently.
    try {
        const input = JSON.parse(await readStdin());
        const transcriptPath = input.transcript_path;
        if (!transcriptPath || !existsSync(transcriptPath))
            return;
        // Fast path 1: a small transcript cannot exceed the threshold — exit on a
        // single stat() without reading the file. This is the every-prompt cost
        // for lean sessions: ~1ms.
        const { config } = loadConfig(input.cwd ?? process.cwd());
        const threshold = warnThreshold(config.budget?.maxTokens);
        const sizeBytes = statSync(transcriptPath).size;
        if (sizeBytes < minBytesForWarn(threshold))
            return;
        // Fast path 2: growth gate BEFORE parsing. If the file hasn't grown ~40%
        // since the last full parse, nothing new can trigger — exit without the
        // expensive read. Heavy-but-quiet sessions cost one stat + tiny state read.
        const sessionId = input.session_id ?? transcriptPath;
        const prev = readSessionState(sessionId);
        if (prev.b > 0 && sizeBytes < prev.b * REGROWTH_FACTOR)
            return;
        // Slow path (growth events only): full parse + profile.
        const parsed = parseSessionFile(transcriptPath);
        if (parsed.messageCount === 0)
            return;
        const profile = profileConversation(parseConversation(parsed.conversationJson), parsed.model);
        // Prefer the API's own figure when the transcript carries it: it includes
        // the system prompt and tool schemas the transcript omits, so it is the
        // real context size rather than a message-only estimate.
        const liveTokens = parsed.reportedInputTokens ?? profile.totalTokens;
        // Record this parse so the next prompts take fast path 2.
        const shouldWarn = liveTokens >= threshold && liveTokens >= prev.t * REGROWTH_FACTOR;
        writeSessionState(sessionId, { t: shouldWarn ? liveTokens : prev.t, b: sizeBytes });
        recordLedger({ ev: "check", sid: sessionId.slice(0, 12), tok: liveTokens, warn: shouldWarn });
        if (!shouldWarn)
            return;
        const windowPct = profile.contextWindow ? (liveTokens / profile.contextWindow) * 100 : undefined;
        const costPerCall = profile.cost && profile.totalTokens > 0
            ? (profile.cost.perCallUsd * liveTokens) / profile.totalTokens
            : undefined;
        const lines = [
            `This session's context is at ~${formatTokens(liveTokens)} tokens` +
                (windowPct !== undefined ? ` (${windowPct.toFixed(0)}% of the window)` : "") +
                (costPerCall !== undefined ? `, costing ~${formatUsd(costPerCall)} of input per message` : "") +
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
            lines.push("If it fits the flow, offer the user a compaction of the older history.");
        }
        console.log(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: `<context-doctor>\n${lines.join("\n")}\n</context-doctor>`,
            },
        }));
    }
    catch {
        /* silent — never disturb the prompt */
    }
}
