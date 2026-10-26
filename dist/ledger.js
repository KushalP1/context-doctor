/**
 * Local activity ledger: one JSONL line per notable event, feeding
 * `context-doctor report`. Best-effort by design — a ledger failure must
 * never break a prompt, a tool call, or an optimize run.
 *
 * Event shapes (all carry ts):
 *   check    — hook deep-parsed a session   {ev?: undefined|"check", sid, tok, warn}
 *              (pre-0.3.6 hook entries have no `ev` field; treated as checks)
 *   optimize — an optimization was applied  {ev: "optimize", src: "cli"|"mcp", saved, model?}
 *   proxy    — proxy savings checkpoint      {ev: "proxy", saved, usd?, requests?}
 *   rollup   — totals folded in on rotation   {ev: "rollup", ...carried sums}
 *   session_rules — a Copilot session start got the standing rules {ev: "session_rules", app}
 *
 * The ledger is capped, and everything it feeds is a LIFETIME total. Simply
 * dropping old lines made those totals go backwards — measured: 1,692,000
 * tokens saved became 501,000 the moment the cap was hit. So rotation folds
 * what it drops into a single rollup entry instead of discarding it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const EMPTY_CARRIED = {
    optimizeSaved: 0, optimizeUsd: 0, proxySaved: 0, proxyUsd: 0,
    proxyRequests: 0, checks: 0, warnings: 0, shrinkage: 0,
};
/**
 * Reduce a set of entries to the totals the reports care about.
 *
 * Absorbs existing rollups, so folding stays correct across any number of
 * rotations rather than only the first.
 */
export function foldTotals(entries) {
    const out = { ...EMPTY_CARRIED };
    const perSession = new Map();
    for (const e of entries) {
        if (e.ev === "rollup" && e.carried) {
            out.optimizeSaved += e.carried.optimizeSaved;
            out.optimizeUsd += e.carried.optimizeUsd;
            out.proxySaved += e.carried.proxySaved;
            out.proxyUsd += e.carried.proxyUsd;
            out.proxyRequests += e.carried.proxyRequests;
            out.checks += e.carried.checks;
            out.warnings += e.carried.warnings;
            out.shrinkage += e.carried.shrinkage;
            if (e.carried.since)
                out.since = Math.min(out.since ?? e.carried.since, e.carried.since);
            continue;
        }
        out.since = Math.min(out.since ?? e.ts, e.ts);
        if (e.ev === "optimize") {
            out.optimizeSaved += e.saved ?? 0;
            out.optimizeUsd += e.usd ?? 0;
        }
        else if (e.ev === "proxy") {
            out.proxySaved += e.saved ?? 0;
            out.proxyUsd += e.usd ?? 0;
            out.proxyRequests += e.requests ?? 0;
        }
        else if ((e.ev === "check" || e.ev === undefined) && e.sid !== "doctor-probe") {
            // Exactly what the live reports (impact, dashboard) count, or totals
            // jump when the ledger rotates. Not every other event is a check:
            // cold_resume and precompact are not, and precompact's tok is a
            // CHARACTER count that read as hundreds of tokens of "shrinkage".
            // "doctor-probe" came from `doctor` before 0.30, not from the hook.
            out.checks++;
            if (e.warn)
                out.warnings++;
            // "mcp-sketch" was one id shared by unrelated chats (until 0.24): its
            // sizes are not one session's, so no shrinkage is read from them.
            if (e.sid && e.sid !== "mcp-sketch" && typeof e.tok === "number")
                perSession.set(e.sid, [...(perSession.get(e.sid) ?? []), e.tok]);
        }
    }
    for (const toks of perSession.values()) {
        for (let i = 1; i < toks.length; i++)
            if (toks[i] < toks[i - 1])
                out.shrinkage += toks[i - 1] - toks[i];
    }
    return out;
}
export function statePath() {
    return process.env.CONTEXT_DOCTOR_HOOK_STATE ?? join(homedir(), ".claude", ".context-doctor-hook-state.json");
}
export function ledgerPath() {
    return join(dirname(statePath()), ".context-doctor-ledger.jsonl");
}
/** Longest string field kept in a ledger entry (a model name, a session id). */
export const LEDGER_STRING_MAX = 100;
/** On rotation: what is kept, by bytes and by entries; longer lines are folded, not kept. */
const LEDGER_ROTATE_AT = 256 * 1024;
const LEDGER_KEEP_BYTES = 128 * 1024;
const LEDGER_KEEP_LINES = 500;
const LEDGER_LINE_MAX = 4 * 1024;
/** A string field as the ledger keeps it: no control characters, at most LEDGER_STRING_MAX. */
function cap(v) {
    if (typeof v !== "string")
        return undefined;
    // eslint-disable-next-line no-control-regex
    const clean = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    return clean.length > LEDGER_STRING_MAX ? clean.slice(0, LEDGER_STRING_MAX) : clean;
}
export function recordLedger(entry) {
    const path = ledgerPath();
    try {
        // Claude-Desktop-only machines have no ~/.claude — create it so their
        // optimize events count in `context-doctor report` too.
        mkdirSync(dirname(path), { recursive: true });
        // Cap growth by bytes, not lines: past 256KB keep the newest entries that
        // fit 128KB (at most 500), and fold the rest into a rollup first, or every
        // lifetime total in the reports silently shrinks the moment a heavy user
        // crosses the cap. A line too long to be a real entry is folded, never kept.
        if (existsSync(path) && statSync(path).size > LEDGER_ROTATE_AT) {
            const lines = readFileSync(path, "utf8").trimEnd().split("\n");
            const parse = (line) => {
                try {
                    return [JSON.parse(line)];
                }
                catch {
                    return [];
                }
            };
            const keptAt = new Set();
            let bytes = 0;
            for (let i = lines.length - 1; i >= 0 && keptAt.size < LEDGER_KEEP_LINES; i--) {
                const n = Buffer.byteLength(lines[i]) + 1;
                if (n > LEDGER_LINE_MAX)
                    continue;
                if (bytes + n > LEDGER_KEEP_BYTES)
                    break;
                keptAt.add(i);
                bytes += n;
            }
            const kept = lines.filter((_, i) => keptAt.has(i));
            const dropped = lines.filter((_, i) => !keptAt.has(i)).flatMap(parse);
            const carried = foldTotals(dropped);
            const rollup = { ts: Date.now(), ev: "rollup", carried };
            writeFileSync(path, [JSON.stringify(rollup), ...kept].join("\n") + "\n");
        }
        const clean = { ...entry };
        for (const k of ["model", "sid", "cv", "app"]) {
            if (k in clean) {
                const v = cap(clean[k]);
                if (v === undefined)
                    delete clean[k];
                else
                    clean[k] = v;
            }
        }
        appendFileSync(path, JSON.stringify({ ts: Date.now(), ...clean }) + "\n");
    }
    catch {
        /* best-effort */
    }
}
export function readLedger() {
    const path = ledgerPath();
    if (!existsSync(path))
        return [];
    try {
        return readFileSync(path, "utf8")
            .trimEnd()
            .split("\n")
            .flatMap((line) => {
            try {
                return [JSON.parse(line)];
            }
            catch {
                return [];
            }
        });
    }
    catch {
        return [];
    }
}
