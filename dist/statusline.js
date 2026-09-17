/**
 * `context-doctor statusline` — live context health in Claude Code's status bar.
 *
 * Claude Code's `statusLine` setting runs a command on every refresh and shows
 * its first line of stdout. That is "context health where the work happens"
 * without an editor extension: the number that matters, visible while typing.
 *
 * It has to be fast and silent. Fast: the status payload on stdin carries the
 * live context size in recent versions; when it does not, only the tail of the
 * transcript is read (last 256KB, ~1ms on a 20MB file). Silent: any failure
 * prints nothing at all, because a status line that shows an error is worse
 * than one that shows nothing.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { contextWindowFor, formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";
/** Newest assistant usage from the END of a transcript, without reading the file. */
export function tailUsage(path, tailBytes = 256 * 1024) {
    try {
        const size = statSync(path).size;
        const n = Math.min(size, tailBytes);
        const fd = openSync(path, "r");
        const buf = Buffer.alloc(n);
        try {
            readSync(fd, buf, 0, n, size - n);
        }
        finally {
            closeSync(fd);
        }
        for (const line of buf.toString("utf8").split("\n").reverse()) {
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue; // the first line of a tail is usually a partial one
            }
            const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
            if (!usage)
                continue;
            const read = usage.cache_read_input_tokens ?? 0;
            const tokens = (usage.input_tokens ?? 0) + read + (usage.cache_creation_input_tokens ?? 0);
            if (tokens > 0)
                return { tokens, cacheShare: read / tokens, model: entry.message?.model };
        }
    }
    catch {
        /* unreadable: the caller shows nothing */
    }
    return undefined;
}
/** Ten-cell bar; the visual half of the number. */
function bar(pct) {
    const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
    return "▮".repeat(filled) + "░".repeat(10 - filled);
}
/** Build the status line, or null when there is nothing trustworthy to show. */
export function renderStatusLine(input) {
    let live;
    const cw = input.context_window;
    const fromPayload = cw?.current_usage
        ? (cw.current_usage.input_tokens ?? 0) + (cw.current_usage.cache_read_input_tokens ?? 0) + (cw.current_usage.cache_creation_input_tokens ?? 0)
        : cw?.total_input_tokens;
    if (fromPayload && fromPayload > 0) {
        const read = cw?.current_usage?.cache_read_input_tokens;
        live = { tokens: fromPayload, cacheShare: read !== undefined ? read / fromPayload : undefined, model: input.model?.id };
    }
    else if (input.transcript_path) {
        live = tailUsage(input.transcript_path);
    }
    if (!live)
        return null;
    const window = cw?.context_window_size ?? contextWindowFor(live.model ?? input.model?.id);
    const parts = [];
    if (window) {
        const pct = (live.tokens / window) * 100;
        parts.push(`ctx ${formatTokens(live.tokens)}/${formatTokens(window)} ${bar(pct)} ${pct.toFixed(0)}%${pct >= 70 ? " ⚠" : ""}`);
    }
    else {
        parts.push(`ctx ${formatTokens(live.tokens)}`);
    }
    if (live.cacheShare !== undefined)
        parts.push(`cache ${Math.round(live.cacheShare * 100)}%`);
    if (input.cost?.total_cost_usd && input.cost.total_cost_usd > 0)
        parts.push(formatUsd(input.cost.total_cost_usd));
    return parts.join(" · ");
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
export async function runStatusLine() {
    try {
        const input = JSON.parse(await readStdin());
        const line = renderStatusLine(input);
        if (line)
            console.log(line);
    }
    catch {
        /* silent by design */
    }
}
