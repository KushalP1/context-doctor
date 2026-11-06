/**
 * A session's own price, said once while it runs.
 *
 * The budget counts a day across tools; one session can cost $2,000 on its
 * own without anyone noticing that each message now re-reads ~470k tokens
 * (the author's `gantry-ai` audit: 2,795 requests, 1.3B cached tokens read).
 * So before each prompt (Claude Code's and Codex's UserPromptSubmit, Gemini
 * CLI's BeforeAgent) the hook adds up what this session has cost, subagents
 * included (they bill to it), and when it passes $25, $100 and $500 says so
 * to the user once: the cost so far, what each message of the main
 * conversation now costs at the model's cache-read rate (or, after an idle
 * that expired the cache, the re-write this message pays), and that
 * /compact or a handoff to a new session cuts it.
 *
 * To the user, not the model: compacting or moving to a new session is the
 * person's decision about their money, and only they can run /compact. The
 * cold-resume offer measured how a model-delivered offer fares (acted on 1
 * time in 33 before it got a line of its own), and a note in the model's
 * context costs every later request and can pull it off the task. The
 * heavy-context note already asks the model to offer a compaction.
 *
 * Fast and quiet. The cost is the budget ledger's per-transcript entry
 * (budget.ts refreshEntry), with the period starting at 0: a prompt reads
 * only what was appended since the last read. The entries are kept beside
 * the hook's per-session state, but written only once enough was read to be
 * worth keeping (SAVE_BYTES) or a threshold was said, so a session below
 * the first threshold costs a read of its last turns and writes nothing.
 * Each threshold is claimed by creating a file that must not exist yet
 * (`wx`), which exactly one of several hooks running at once can do. Once
 * the top threshold is said, the check is one stat.
 *
 * Thresholds: CONTEXT_DOCTOR_SESSION_PRICE (dollars, e.g. "50,200");
 * off: CONTEXT_DOCTOR_NO_SESSION_PRICE=1.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { statePath } from "./ledger.js";
import { refreshEntry, wellFormed, writeWhole } from "./budget.js";
import { codexFileSpend, geminiFileSpend } from "./spend.js";
import { isGeminiChat } from "./gemini.js";
import { subagentDir } from "./subagents.js";
import { tailUsage } from "./statusline.js";
import { autoCompactsAt, detectColdResume, withResumeVerdict } from "./coldresume.js";
import { formatUsd, pricingFor } from "./pricing.js";
import { formatTokens } from "./tokens.js";
/** Where the hook speaks unless CONTEXT_DOCTOR_SESSION_PRICE says otherwise. */
export const SESSION_PRICE_THRESHOLDS = [25, 100, 500];
/**
 * The entries are written once a prompt has read this much: below it, the
 * next prompt reading the same bytes again costs a few milliseconds, less
 * than a write.
 */
const SAVE_BYTES = 512 * 1024;
/** The thresholds in force, ascending; none when switched off. */
export function sessionPriceThresholds(env = process.env) {
    if (env.CONTEXT_DOCTOR_NO_SESSION_PRICE === "1")
        return [];
    const raw = env.CONTEXT_DOCTOR_SESSION_PRICE?.trim();
    if (!raw)
        return SESSION_PRICE_THRESHOLDS;
    const set = raw.split(/[\s,]+/).map((v) => Number(v.replace(/^\$/, ""))).filter((v) => Number.isFinite(v) && v > 0);
    // A value that is not a list of dollars is not a reason to go quiet: the defaults.
    return set.length ? [...new Set(set)].sort((a, b) => a - b) : SESSION_PRICE_THRESHOLDS;
}
/** This session's files beside the hook's own state: one hash per session, as hook.ts and fanout.ts name them. */
function base(sessionId) {
    return join(statePath().replace(/\.json$/, "") + ".d", createHash("sha1").update(sessionId).digest("hex").slice(0, 16));
}
const ledgerFile = (b) => `${b}.price.json`;
const claimFile = (b, usd) => `${b}.price-${usd}`;
const DAY = 86_400_000;
/**
 * Whether a threshold was said: its marker is there. The marker of a
 * session still in use is touched once a day, so the hook's pruning (the
 * sessions touched least recently go, hook.ts) does not take it while the
 * session goes on, and the threshold is not said twice.
 */
function said(path, now) {
    try {
        if (now - statSync(path).mtimeMs > DAY)
            try {
                utimesSync(path, new Date(now), new Date(now));
            }
            catch { /* read-only: said all the same */ }
        return true;
    }
    catch {
        return false;
    }
}
/** True for exactly one caller per path: the file is created only if it is not there. */
function claim(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(path, "", { flag: "wx", mode: 0o600 });
            return true;
        }
        catch (e) {
            if (e.code !== "ENOENT" || attempt)
                return false;
            mkdirSync(dirname(path), { recursive: true });
        }
    }
    return false;
}
/** The app a transcript belongs to. */
function appOf(transcript, event) {
    if (event === "BeforeAgent" || isGeminiChat(transcript))
        return "gemini";
    return /^rollout-.*\.jsonl$/.test(basename(transcript)) ? "codex" : "claude";
}
/**
 * The threshold this prompt is the first to pass, with what to say about
 * it, or undefined (below the first, said already, or anything unreadable).
 * Claims the threshold: a second call for the same one gets undefined.
 */
export function sessionPriceDue(input, now = Date.now(), env = process.env) {
    const thresholds = sessionPriceThresholds(env);
    if (!thresholds.length)
        return undefined;
    const b = base(input.sessionId);
    // Everything said: one stat from now on.
    if (said(claimFile(b, thresholds[thresholds.length - 1]), now))
        return undefined;
    const app = appOf(input.transcript, input.event);
    const files = [[input.transcript, false]];
    if (app === "claude") {
        // Subagents bill to the session that started them.
        const dir = subagentDir(input.transcript);
        try {
            for (const f of readdirSync(dir))
                if (f.endsWith(".jsonl"))
                    files.push([join(dir, f), true]);
        }
        catch { /* no subagents */ }
    }
    let saved = {};
    try {
        const raw = JSON.parse(readFileSync(ledgerFile(b), "utf8"))?.f;
        if (raw && typeof raw === "object")
            saved = raw;
    }
    catch { /* none yet, or damaged: read again */ }
    const kept = {};
    let read = 0;
    for (const [file] of files) {
        const prev = saved[file];
        const r = refreshEntry(app, file, wellFormed(prev) && prev.t === app ? prev : undefined, 0, true);
        if (!r)
            continue;
        kept[file] = r.e;
        // Only a Claude Code entry saves a read: Codex's and Gemini's are read whole on a change (through the scan's cache).
        if (app === "claude")
            read += Math.max(0, r.read);
    }
    // Each reply once: a fork's copy shares its key with the reply it copied.
    const seen = new Set();
    let usd = 0, subagentUsd = 0;
    for (const [file, sub] of files) {
        const e = kept[file];
        if (!e)
            continue;
        e.k.forEach((key, i) => {
            if (key) {
                if (seen.has(key))
                    return;
                seen.add(key);
            }
            usd += e.d[i];
            if (sub)
                subagentUsd += e.d[i];
        });
    }
    const save = () => { try {
        writeWhole(ledgerFile(b), { f: kept });
    }
    catch { /* read again next time */ } };
    const passed = thresholds.filter((t) => usd >= t);
    const top = passed[passed.length - 1];
    if (top === undefined || said(claimFile(b, top), now) || !claim(claimFile(b, top))) {
        if (read >= SAVE_BYTES)
            save();
        return undefined;
    }
    // Passed two at once (a first look at a long session): said once, for the higher.
    for (const t of passed.slice(0, -1))
        claim(claimFile(b, t));
    save();
    return { app, threshold: top, usd, subagentUsd, ...perMessage(app, input, now) };
}
/** The main conversation's context now, and what the next message pays for it. */
function perMessage(app, input, now) {
    try {
        if (app !== "claude") {
            // Codex and Gemini CLI: the last request's prompt, at the cached rate.
            const items = app === "codex" ? codexFileSpend(input.transcript, 0) : geminiFileSpend(input.transcript, 0);
            const last = items[items.length - 1];
            const model = last?.model ?? input.model;
            const p = pricingFor(model);
            if (!last || !p)
                return {};
            const tokens = last.input + last.read + last.write;
            return { tokens, model, readUsd: (tokens * p.cacheReadPerM) / 1e6 };
        }
        // Undefined right after a compaction: the new size is not known yet.
        const live = tailUsage(input.transcript);
        if (!live)
            return {};
        const model = live.model ?? input.model;
        const p = pricingFor(model);
        // Claude Code compacts this very prompt itself: the figure is about to be wrong.
        if (!p || live.tokens >= (autoCompactsAt(model) ?? Infinity))
            return {};
        const cold = withResumeVerdict(detectColdResume(input.transcript, now, undefined, 0), input.rv?.(), now);
        return { tokens: live.tokens, model, readUsd: (live.tokens * p.cacheReadPerM) / 1e6, ...(cold?.resumeUsd !== undefined ? { coldUsd: cold.resumeUsd } : {}) };
    }
    catch {
        return {};
    }
}
/** "$112", "$1,240", "$25.40": a session's cost as the line shows it. */
const dollars = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
/** The line for the user (the hook's systemMessage). */
export function renderSessionPrice(p) {
    const subs = p.subagentUsd >= 0.005 ? ` (${dollars(p.subagentUsd)} of it subagents)` : "";
    const head = `context-doctor: this session has cost ${dollars(p.usd)} so far${subs}`;
    if (p.tokens === undefined || p.readUsd === undefined)
        return `${head}.`;
    const compact = p.app === "gemini" ? "/compress" : "/compact";
    const ctx = `~${formatTokens(p.tokens)} tokens`;
    const each = p.coldUsd !== undefined
        ? `the cache expired while it was idle, so this message re-writes its ${ctx} (~${formatUsd(p.coldUsd)}), and each one after re-reads them (~${formatUsd(p.readUsd)})`
        : `each message now re-reads ${ctx} (~${formatUsd(p.readUsd)})`;
    return `${head}; ${each}. ${compact}, or a handoff to a new session, cuts that.`;
}
