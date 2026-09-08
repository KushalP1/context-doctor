/**
 * Claude Code session analyzer: profile the transcripts Claude Code writes to
 * ~/.claude/projects/<project>/<session>.jsonl, answering "where did my
 * tokens go?" for real sessions instead of hand-exported conversations.
 *
 * Transcript lines are JSON objects; the ones that matter here are
 * `{type: "user"|"assistant", message: {role, content}, isSidechain, ...}`
 * where `message` is in Anthropic Messages format. Everything else
 * (titles, mode changes, hook records) is metadata and skipped.
 */
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Read one usage field defensively.
 *
 * A numeric string plainly means that number, and discarding it would throw
 * away ground truth and silently fall back to the heuristic — so it is parsed.
 * Anything else unusable (objects, null, "abc", negatives) counts as nothing.
 */
function usageNumber(value) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}
function projectsDir() {
    return join(homedir(), ".claude", "projects");
}
/** All session transcripts on this machine, newest first. */
export function listSessions(limit = 20) {
    const root = projectsDir();
    if (!existsSync(root))
        return [];
    const sessions = [];
    for (const project of readdirSync(root)) {
        const dir = join(root, project);
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue; // not a directory
        }
        for (const file of entries) {
            if (!file.endsWith(".jsonl"))
                continue;
            const path = join(dir, file);
            const stat = statSync(path);
            sessions.push({ path, project, modifiedAt: stat.mtime, sizeBytes: stat.size });
        }
    }
    return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()).slice(0, limit);
}
/**
 * ChatGPT data export (chatgpt.com → Settings → Data controls → Export):
 * conversations.json is an array of conversations, each holding a `mapping`
 * tree of nodes. We profile the most recently updated conversation.
 */
/**
 * A stand-in for a non-text export part.
 *
 * The bytes are not in the export, so the exact token cost is unknowable; what
 * matters is that the turn stops being invisible and keeps its place in the
 * conversation.
 */
function chatGptAttachmentLabel(part) {
    const kind = part?.content_type;
    if (typeof kind === "string")
        return `[${kind}]`;
    if (part?.asset_pointer)
        return "[image]";
    return "[attachment]";
}
function parseChatGPTExport(data, path) {
    const conversations = data
        .filter((c) => c && typeof c.mapping === "object")
        .sort((a, b) => (b.update_time ?? 0) - (a.update_time ?? 0));
    const conv = conversations[0];
    if (!conv)
        return { conversationJson: JSON.stringify({ messages: [] }), messageCount: 0, path };
    const nodes = Object.values(conv.mapping)
        .filter((n) => {
        const m = n?.message;
        if (!m?.author?.role || !["user", "assistant", "system"].includes(m.author.role))
            return false;
        const parts = m.content?.parts;
        if (!Array.isArray(parts))
            return false;
        // A turn containing an image is exported as multimodal_text, with the
        // picture as an object among the string parts. Requiring a non-empty
        // string dropped those turns entirely, so an image-heavy conversation
        // profiled as smaller than it is.
        return parts.some((p) => (typeof p === "string" && p.length > 0) || (p && typeof p === "object"));
    })
        .sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));
    const messages = nodes.map((n) => ({
        role: n.message.author.role,
        content: n.message.content.parts
            .map((p) => (typeof p === "string" ? p : chatGptAttachmentLabel(p)))
            .filter((p) => p.length > 0)
            .join("\n"),
    }));
    return {
        conversationJson: JSON.stringify({ messages }),
        title: typeof conv.title === "string" ? conv.title : undefined,
        model: typeof conv.default_model_slug === "string" ? conv.default_model_slug : "gpt-5",
        messageCount: messages.length,
        path,
    };
}
/**
 * Read a JSONL transcript line by line without ever materializing the whole
 * file as one string.
 *
 * Agent sessions with large tool results reach hundreds of MB, and those are
 * exactly the sessions that most need analysis — but V8 refuses to build a
 * string past ~512MB, so readFileSync would throw on them (and in the hook,
 * throw *silently*). Streaming has no such ceiling and keeps peak memory at
 * one chunk. StringDecoder carries partial UTF-8 sequences across chunk
 * boundaries so multi-byte characters are never corrupted.
 */
function forEachLine(path, onLine) {
    const fd = openSync(path, "r");
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let pending = "";
    try {
        for (;;) {
            const bytes = readSync(fd, buf, 0, buf.length, null);
            if (bytes === 0)
                break;
            pending += decoder.write(buf.subarray(0, bytes));
            let nl;
            while ((nl = pending.indexOf("\n")) !== -1) {
                onLine(pending.slice(0, nl));
                pending = pending.slice(nl + 1);
            }
        }
        pending += decoder.end();
        if (pending)
            onLine(pending);
    }
    finally {
        closeSync(fd);
    }
}
/** Peek at the first bytes to tell a ChatGPT export (JSON array) from JSONL. */
function startsWithArray(path) {
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.allocUnsafe(64);
        const bytes = readSync(fd, buf, 0, 64, 0);
        return buf.subarray(0, bytes).toString("utf8").trimStart().startsWith("[");
    }
    finally {
        closeSync(fd);
    }
}
export function parseSessionFile(path) {
    // ChatGPT exports are one big JSON array, not JSONL — and small enough to
    // read whole. Only peek first, so multi-hundred-MB JSONL is never slurped.
    if (startsWithArray(path)) {
        try {
            const data = JSON.parse(readFileSync(path, "utf8"));
            if (Array.isArray(data) && data.some((c) => c && typeof c.mapping === "object")) {
                return parseChatGPTExport(data, path);
            }
        }
        catch {
            /* fall through to JSONL parsing */
        }
    }
    const messages = [];
    let title;
    let model;
    /** Index in `messages` of the newest compaction summary, or -1. */
    let lastCompactIndex = -1;
    /** Newest API-reported input size, if the transcript carries usage. */
    let reportedInputTokens;
    /** Every reported size, positioned — the basis for `context-doctor accuracy`. */
    const usageSamples = [];
    forEachLine(path, (line) => {
        if (!line.trim())
            return;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            return;
        }
        // Titles are metadata lines; the last one wins.
        if (entry.type === "custom-title" && entry.customTitle)
            title = entry.customTitle;
        if (entry.type === "ai-title" && entry.aiTitle && !title)
            title = entry.aiTitle;
        if ((entry.type !== "user" && entry.type !== "assistant") || !entry.message)
            return;
        if (entry.isSidechain)
            return; // subagent traffic has its own context window
        const message = entry.message;
        if (!message.role || message.content == null)
            return;
        if (typeof message.model === "string")
            model = message.model;
        const usage = message.usage;
        if (entry.type === "assistant" && usage) {
            // Coerce, do not trust: a transcript whose usage numbers are STRINGS
            // turned `1200 + 300` into "12003000" through JavaScript concatenation,
            // an 8000x overstatement that drives the hook, the cost figures and the
            // window percentage. Anything not a finite non-negative number is 0.
            const total = usageNumber(usage.input_tokens) +
                usageNumber(usage.cache_read_input_tokens) +
                usageNumber(usage.cache_creation_input_tokens);
            if (total > 0) {
                reportedInputTokens = total;
                usageSamples.push({ index: messages.length, input: total });
            }
        }
        if (entry.isCompactSummary)
            lastCompactIndex = messages.length;
        messages.push({ role: message.role, content: message.content });
    });
    // A compaction replaces everything before it: the summary entry IS the live
    // history from that point on. Counting the pre-compaction turns would
    // overstate context, cost per message and window fill — sometimes hugely.
    const compactedAway = lastCompactIndex >= 0 ? lastCompactIndex : 0;
    const live = lastCompactIndex >= 0 ? messages.slice(lastCompactIndex) : messages;
    return {
        conversationJson: JSON.stringify({ messages: live }),
        title,
        model,
        messageCount: live.length,
        compactedAway,
        reportedInputTokens,
        // Samples before the compaction boundary describe a context that no longer
        // exists; re-base the rest onto the live array.
        usageSamples: usageSamples
            .filter((u) => u.index >= compactedAway)
            .map((u) => ({ index: u.index - compactedAway, input: u.input })),
        path,
    };
}
