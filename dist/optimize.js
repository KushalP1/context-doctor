/**
 * The optimizer: deterministic, lossless-first strategies that rewrite a
 * conversation's message array to reclaim tokens. No LLM calls — everything
 * here is safe to run offline and inspect before use.
 *
 * Strategies operate on the ORIGINAL JSON structure (not the normalized view)
 * so the output is a drop-in replacement for the input conversation.
 */
import { createHash } from "node:crypto";
import { estimateTokens } from "./tokens.js";
import { hasBase64Blob, stripBase64Blobs } from "./blob.js";
const DEFAULTS = {
    strategies: ["dedupe", "trim-tool-results", "strip-base64"],
    keepRecent: 6,
    maxToolResultTokens: 300,
};
/**
 * Shrink the arguments of a tool call that has already run.
 *
 * In file-heavy agent sessions the biggest single items in context are not
 * tool RESULTS but tool CALLS: a Write or a `cat > file <<EOF` carries the
 * whole file inline, forever. Once the call has returned, the live context
 * only needs enough of the arguments to identify what was done.
 *
 * Keys are preserved (so the call still reads as itself) and only long string
 * values are cut, with an explicit marker so nothing looks silently complete.
 */
function trimCallArguments(input, maxTokens) {
    const budgetChars = maxTokens * 4;
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === "string" && value.length > budgetChars) {
            out[key] = value.slice(0, budgetChars) + `\n[context-doctor: ${value.length - budgetChars} more chars trimmed — this call already ran]`;
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
function hash(text) {
    return createHash("sha1").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}
/** Extract all text from a message content value (string or block array). */
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return JSON.stringify(content ?? "");
    return content
        .map((b) => {
        if (typeof b === "string")
            return b;
        if (b?.type === "text")
            return b.text ?? "";
        if (b?.type === "tool_result")
            return textOf(b.content);
        if (b?.type === "tool_use")
            return JSON.stringify(b.input ?? {});
        return "";
    })
        .join("\n");
}
/**
 * Replace the text of a message content value, preserving block structure.
 * tool_result blocks must keep their type and tool_use_id — the Anthropic API
 * rejects conversations where a tool_use has no matching tool_result — so the
 * replacement text goes INSIDE the first tool_result/text block rather than
 * replacing the block itself. Later text blocks are dropped; other block types
 * (tool_use, image) pass through untouched.
 */
function replaceText(content, newText) {
    if (typeof content === "string" || !Array.isArray(content))
        return newText;
    let placed = false;
    const out = content
        .map((b) => {
        if (b?.type === "tool_result") {
            const replaced = { ...b, content: placed ? "[removed]" : newText };
            placed = true;
            return replaced;
        }
        if (b?.type === "text") {
            if (placed)
                return null;
            placed = true;
            return { ...b, text: newText };
        }
        return b;
    })
        .filter(Boolean);
    if (!placed)
        out.push({ type: "text", text: newText });
    return out;
}
function truncateToTokens(text, maxTokens) {
    const approxChars = maxTokens * 4;
    if (text.length <= approxChars)
        return text;
    const head = text.slice(0, approxChars);
    const omitted = text.length - approxChars;
    return `${head}\n…[context-doctor: trimmed ${omitted} chars of stale tool output]`;
}
function isToolResultMessage(m) {
    if (m?.role === "tool")
        return true;
    if (Array.isArray(m?.content))
        return m.content.some((b) => b?.type === "tool_result");
    return false;
}
export function optimizeConversation(input, options = {}) {
    // ?? per field (not object spread) so an explicit `undefined` from a caller
    // still falls back to the default.
    const opts = {
        strategies: options.strategies ?? DEFAULTS.strategies,
        keepRecent: options.keepRecent ?? DEFAULTS.keepRecent,
        maxToolResultTokens: options.maxToolResultTokens ?? DEFAULTS.maxToolResultTokens,
    };
    let data;
    try {
        data = JSON.parse(input);
    }
    catch {
        throw new Error("optimize requires a JSON conversation (message array, or object with a `messages` field)");
    }
    const messages = Array.isArray(data) ? data : data.messages;
    if (!Array.isArray(messages)) {
        throw new Error("No `messages` array found in input");
    }
    const tokensBefore = messages.reduce((s, m) => s + estimateTokens(textOf(m.content)), 0);
    const applied = [];
    // -- strip-base64: replace inline blobs with a placeholder --------------------
    if (opts.strategies.includes("strip-base64")) {
        messages.forEach((m, i) => {
            const text = textOf(m.content);
            if (!hasBase64Blob(text))
                return;
            const before = estimateTokens(text);
            const cleaned = stripBase64Blobs(text);
            const saved = before - estimateTokens(cleaned);
            if (saved > 50) {
                m.content = replaceText(m.content, cleaned);
                applied.push({ strategy: "strip-base64", messageIndex: i, tokensSaved: saved, note: "Removed inline base64 data" });
            }
        });
    }
    // -- dedupe: identical content beyond the first occurrence --------------------
    if (opts.strategies.includes("dedupe")) {
        const seen = new Map();
        messages.forEach((m, i) => {
            const text = textOf(m.content);
            if (text.length < 300)
                return;
            const h = hash(text);
            const first = seen.get(h);
            if (first === undefined) {
                seen.set(h, i);
                return;
            }
            const saved = estimateTokens(text);
            m.content = replaceText(m.content, `[context-doctor: identical to message #${first} — content removed]`);
            applied.push({ strategy: "dedupe", messageIndex: i, tokensSaved: saved, note: `Duplicate of message #${first}` });
        });
    }
    // -- trim-tool-results: shrink stale tool output ------------------------------
    if (opts.strategies.includes("trim-tool-results")) {
        const cutoff = messages.length - opts.keepRecent;
        messages.forEach((m, i) => {
            if (i >= cutoff || !isToolResultMessage(m))
                return;
            const text = textOf(m.content);
            const before = estimateTokens(text);
            if (before <= opts.maxToolResultTokens)
                return;
            const trimmed = truncateToTokens(text, opts.maxToolResultTokens);
            m.content = replaceText(m.content, trimmed);
            applied.push({
                strategy: "trim-tool-results",
                messageIndex: i,
                tokensSaved: before - estimateTokens(trimmed),
                note: "Stale tool result truncated",
            });
        });
    }
    // -- trim-tool-calls: shrink the arguments of calls that already ran ----------
    if (opts.strategies.includes("trim-tool-calls")) {
        const cutoff = messages.length - opts.keepRecent;
        messages.forEach((m, i) => {
            if (i >= cutoff)
                return;
            let saved = 0;
            // Anthropic shape: tool_use blocks with a structured `input`.
            if (Array.isArray(m.content)) {
                for (const b of m.content) {
                    if (b?.type !== "tool_use" || b.input == null || typeof b.input !== "object")
                        continue;
                    const before = estimateTokens(JSON.stringify(b.input));
                    if (before <= opts.maxToolResultTokens)
                        continue;
                    b.input = trimCallArguments(b.input, opts.maxToolResultTokens);
                    saved += before - estimateTokens(JSON.stringify(b.input));
                }
            }
            // OpenAI shape: tool_calls[].function.arguments is a JSON string.
            for (const tc of m.tool_calls ?? []) {
                const args = tc?.function?.arguments;
                if (typeof args !== "string")
                    continue;
                const before = estimateTokens(args);
                if (before <= opts.maxToolResultTokens)
                    continue;
                tc.function.arguments = truncateToTokens(args, opts.maxToolResultTokens);
                saved += before - estimateTokens(tc.function.arguments);
            }
            if (saved > 0) {
                applied.push({
                    strategy: "trim-tool-calls",
                    messageIndex: i,
                    tokensSaved: saved,
                    note: "Arguments of a completed tool call truncated",
                });
            }
        });
    }
    // -- prune-history: replace the older half with a stub ------------------------
    // Opt-in only: it is lossy, so it is not in the default strategy set.
    let prunedDigest;
    if (opts.strategies.includes("prune-history") && messages.length > opts.keepRecent * 2) {
        let keepFrom = messages.length - opts.keepRecent;
        // Never let the kept tail START with a tool result: its matching tool_use
        // would be pruned away and both the Anthropic and OpenAI APIs reject
        // conversations with orphaned tool results. Advance past any leading tool
        // messages (their calls are in the pruned half anyway).
        while (keepFrom < messages.length && isToolResultMessage(messages[keepFrom]))
            keepFrom++;
        // Boundary adjustment may leave too little tail to be worth keeping —
        // in that case skip pruning entirely rather than gutting the conversation.
        if (messages.length - keepFrom >= 2) {
            const pruned = messages.slice(0, keepFrom);
            const prunedTokens = pruned.reduce((s, m) => s + estimateTokens(textOf(m.content)), 0);
            // Digest: first ~200 chars of each pruned turn — enough for a host LLM to
            // write a faithful summary, small enough not to defeat the pruning.
            prunedDigest = pruned
                .map((m, i) => `[${i}:${m.role}] ${textOf(m.content).replace(/\s+/g, " ").slice(0, 200)}`)
                .join("\n");
            const stub = {
                role: "user",
                content: `[context-doctor: ${pruned.length} earlier messages (~${prunedTokens} tokens) pruned. ` +
                    `Replace this stub with an LLM-written summary of those turns for best results.]`,
            };
            messages.splice(0, keepFrom, stub);
            applied.push({
                strategy: "prune-history",
                messageIndex: 0,
                tokensSaved: prunedTokens - estimateTokens(stub.content),
                note: `Pruned ${pruned.length} old messages`,
            });
        }
    }
    const tokensAfter = messages.reduce((s, m) => s + estimateTokens(textOf(m.content)), 0);
    return { conversation: data, tokensBefore, tokensAfter, applied, prunedDigest };
}
