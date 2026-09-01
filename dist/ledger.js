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
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export function statePath() {
    return process.env.CONTEXT_DOCTOR_HOOK_STATE ?? join(homedir(), ".claude", ".context-doctor-hook-state.json");
}
export function ledgerPath() {
    return join(dirname(statePath()), ".context-doctor-ledger.jsonl");
}
export function recordLedger(entry) {
    const path = ledgerPath();
    try {
        // Claude-Desktop-only machines have no ~/.claude — create it so their
        // optimize events count in `context-doctor report` too.
        mkdirSync(dirname(path), { recursive: true });
        // Cap growth: past ~256KB keep the most recent 500 entries.
        if (existsSync(path) && statSync(path).size > 256 * 1024) {
            const lines = readFileSync(path, "utf8").trimEnd().split("\n");
            writeFileSync(path, lines.slice(-500).join("\n") + "\n");
        }
        appendFileSync(path, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
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
