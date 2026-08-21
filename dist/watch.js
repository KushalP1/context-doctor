/**
 * `context-doctor watch [file]` — live monitor for a growing session/agent
 * trace. Polls the file (default: your most recent Claude Code session) and
 * on growth re-profiles, printing one status line per change plus any NEW
 * findings as they appear. Ctrl-C to stop.
 *
 * Polling (not fs.watch) is deliberate: editors/agents rewrite files in ways
 * that break watchers cross-platform, and a 2s stat is effectively free.
 */
import { existsSync, statSync } from "node:fs";
import { listSessions, parseSessionFile } from "./session.js";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";
export function runWatch(opts) {
    const file = opts.file ?? listSessions(1)[0]?.path;
    if (!file || !existsSync(file)) {
        console.error("No transcript to watch. Pass a .jsonl file or run where Claude Code sessions exist.");
        process.exitCode = 1;
        return;
    }
    const intervalMs = opts.intervalMs ?? 2000;
    let lastSize = -1;
    let lastTokens = 0;
    const seenFindings = new Set();
    console.error(`Watching ${file} (every ${intervalMs / 1000}s; Ctrl-C to stop)`);
    const tick = () => {
        try {
            const size = statSync(file).size;
            if (size === lastSize)
                return; // nothing new — cost of this tick was one stat
            lastSize = size;
            const parsed = parseSessionFile(file);
            if (parsed.messageCount === 0)
                return;
            const profile = profileConversation(parseConversation(parsed.conversationJson), opts.model ?? parsed.model);
            const delta = profile.totalTokens - lastTokens;
            lastTokens = profile.totalTokens;
            const cost = profile.cost ? ` · ${formatUsd(profile.cost.perCallUsd)}/msg` : "";
            const pct = profile.usagePct !== undefined ? ` · ${profile.usagePct.toFixed(1)}% of window` : "";
            console.log(`[${new Date().toISOString().slice(11, 19)}] ~${formatTokens(profile.totalTokens)} tokens` +
                (delta !== 0 ? ` (${delta > 0 ? "+" : ""}${formatTokens(Math.abs(delta)) === "0" ? delta : (delta > 0 ? "" : "-") + formatTokens(Math.abs(delta))})` : "") +
                `${pct}${cost} · ${profile.messageCount} messages`);
            // Surface each finding once, when it first appears.
            for (const f of profile.findings) {
                if (f.estSavings === 0)
                    continue;
                const key = `${f.id}:${f.messages.join(",")}`;
                if (seenFindings.has(key))
                    continue;
                seenFindings.add(key);
                console.log(`  ⚠ ${f.message} [save ~${formatTokens(f.estSavings)}]`);
            }
        }
        catch {
            /* transient read race — try again next tick */
        }
    };
    tick();
    setInterval(tick, intervalMs);
}
