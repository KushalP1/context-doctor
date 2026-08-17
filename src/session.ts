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

export function parseSessionFile(path: string): ParsedSession {
  const raw = readFileSync(path, "utf8");
  const messages: Array<Record<string, unknown>> = [];
  let title: string | undefined;
  let model: string | undefined;

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
    messages.push({ role: message.role, content: message.content });
  }

  return {
    conversationJson: JSON.stringify({ messages }),
    title,
    model,
    messageCount: messages.length,
    path,
  };
}
