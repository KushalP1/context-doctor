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

export interface SessionInfo {
  path: string;
  project: string;
  modifiedAt: Date;
  sizeBytes: number;
}

export interface ParsedSession {
  /**
   * The real input size of the most recent request, as reported by the API
   * (input + cache-read + cache-creation tokens). Transcripts do not contain
   * the harness's system prompt, tool schemas or skills, so an estimate over
   * transcript messages alone undercounts badly — measured against these
   * figures, by roughly 60%. When this is present, prefer it: it is ground
   * truth rather than an estimate.
   */
  reportedInputTokens?: number;
  /**
   * Messages dropped because a compaction replaced them. Reporting live
   * context means counting only what the model still sees; this records what
   * was compacted away so the difference can be shown rather than hidden.
   */
  compactedAway?: number;
  /** Conversation JSON string in Anthropic-ish format, ready for parseConversation(). */
  conversationJson: string;
  title?: string;
  model?: string;
  messageCount: number;
  path: string;
}

function projectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** All session transcripts on this machine, newest first. */
export function listSessions(limit = 20): SessionInfo[] {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const sessions: SessionInfo[] = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // not a directory
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
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
function parseChatGPTExport(data: Array<Record<string, any>>, path: string): ParsedSession {
  const conversations = data
    .filter((c) => c && typeof c.mapping === "object")
    .sort((a, b) => (b.update_time ?? 0) - (a.update_time ?? 0));
  const conv = conversations[0];
  if (!conv) return { conversationJson: JSON.stringify({ messages: [] }), messageCount: 0, path };

  const nodes = Object.values(conv.mapping as Record<string, any>)
    .filter((n) => {
      const m = n?.message;
      if (!m?.author?.role || !["user", "assistant", "system"].includes(m.author.role)) return false;
      const parts = m.content?.parts;
      return Array.isArray(parts) && parts.some((p: unknown) => typeof p === "string" && p.length > 0);
    })
    .sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));

  const messages = nodes.map((n) => ({
    role: n.message.author.role,
    content: (n.message.content.parts as unknown[]).filter((p) => typeof p === "string").join("\n"),
  }));

  return {
    conversationJson: JSON.stringify({ messages }),
    title: typeof conv.title === "string" ? conv.title : undefined,
    model: typeof conv.default_model_slug === "string" ? conv.default_model_slug : "gpt-5",
    messageCount: messages.length,
    path,
  };
}

export function parseSessionFile(path: string): ParsedSession {
  const raw = readFileSync(path, "utf8");

  // ChatGPT exports are one big JSON array, not JSONL.
  if (raw.trimStart().startsWith("[")) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.some((c) => c && typeof c.mapping === "object")) {
        return parseChatGPTExport(data, path);
      }
    } catch {
      /* fall through to JSONL parsing */
    }
  }

  const messages: Array<Record<string, unknown>> = [];
  let title: string | undefined;
  let model: string | undefined;
  /** Index in `messages` of the newest compaction summary, or -1. */
  let lastCompactIndex = -1;
  /** Newest API-reported input size, if the transcript carries usage. */
  let reportedInputTokens: number | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Titles are metadata lines; the last one wins.
    if (entry.type === "custom-title" && entry.customTitle) title = entry.customTitle;
    if (entry.type === "ai-title" && entry.aiTitle && !title) title = entry.aiTitle;

    if ((entry.type !== "user" && entry.type !== "assistant") || !entry.message) continue;
    if (entry.isSidechain) continue; // subagent traffic has its own context window
    const message = entry.message as Record<string, unknown>;
    if (!message.role || message.content == null) continue;
    if (typeof message.model === "string") model = message.model;
    const usage = message.usage as Record<string, number> | undefined;
    if (entry.type === "assistant" && usage) {
      const total =
        (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (total > 0) reportedInputTokens = total;
    }
    if (entry.isCompactSummary) lastCompactIndex = messages.length;
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
