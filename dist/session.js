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
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
        return Array.isArray(parts) && parts.some((p) => typeof p === "string" && p.length > 0);
    })
        .sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));
    const messages = nodes.map((n) => ({
        role: n.message.author.role,
        content: n.message.content.parts.filter((p) => typeof p === "string").join("\n"),
    }));
    return {
        conversationJson: JSON.stringify({ messages }),
        title: typeof conv.title === "string" ? conv.title : undefined,
        model: typeof conv.default_model_slug === "string" ? conv.default_model_slug : "gpt-5",
        messageCount: messages.length,
        path,
    };
}
export function parseSessionFile(path) {
    const raw = readFileSync(path, "utf8");
    // ChatGPT exports are one big JSON array, not JSONL.
    if (raw.trimStart().startsWith("[")) {
        try {
            const data = JSON.parse(raw);
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
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        // Titles are metadata lines; the last one wins.
        if (entry.type === "custom-title" && entry.customTitle)
            title = entry.customTitle;
        if (entry.type === "ai-title" && entry.aiTitle && !title)
            title = entry.aiTitle;
        if ((entry.type !== "user" && entry.type !== "assistant") || !entry.message)
            continue;
        if (entry.isSidechain)
            continue; // subagent traffic has its own context window
        const message = entry.message;
        if (!message.role || message.content == null)
            continue;
        if (typeof message.model === "string")
            model = message.model;
        const usage = message.usage;
        if (entry.type === "assistant" && usage) {
            const total = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            if (total > 0)
                reportedInputTokens = total;
        }
        if (entry.isCompactSummary)
            lastCompactIndex = messages.length;
        messages.push({ role: message.role, content: message.content });
    }
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
        path,
    };
}
