/**
 * Gemini CLI chat recordings, read into the same shape as Claude Code and
 * Codex transcripts so `session`, `watch` and the every-prompt hook work on
 * them.
 *
 * Gemini CLI writes ~/.gemini/tmp/<project>/chats/session-*.jsonl: a metadata
 * record, then one record per message (`user`, `gemini`, `info`, `error`).
 * A message written again with the same id replaces the earlier copy (tool
 * results and token counts arrive after the text), `{"$rewindTo": id}` drops
 * that message and everything after it, and `{"$set": …}` updates metadata.
 * Older versions wrote the whole conversation as one JSON document with a
 * `messages` array; both are read.
 *
 * Each `gemini` message records the API's own usage (`tokens.input` is the
 * request's promptTokenCount, cached part included), so the live context size
 * is exact, as it is for Claude Code and Codex.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forEachLine, type ParsedSession, type SessionInfo, type UsageSample } from "./session.js";

/** True when the file's first record looks like a Gemini CLI chat (cheap: reads 4 KB). */
export function isGeminiChat(path: string): boolean {
  if (!/\.jsonl?$/.test(path)) return false;
  try {
    const buf = Buffer.alloc(4096);
    const fd = openSync(path, "r");
    const n = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const head = buf.subarray(0, n).toString("utf8");
    return /"projectHash"\s*:/.test(head) && /"sessionId"\s*:/.test(head);
  } catch {
    return false;
  }
}

/** Text of a Gemini `content`: a string, or Part[] with `text` fields. */
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  return "";
}

/** What a tool call returned, as the model saw it. */
function resultText(call: any): string {
  const r = call?.result;
  if (typeof r === "string") return r;
  if (Array.isArray(r)) {
    return r
      .map((p: any) => {
        const resp = p?.functionResponse?.response;
        if (resp !== undefined) return typeof resp?.output === "string" ? resp.output : JSON.stringify(resp);
        return typeof p?.text === "string" ? p.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return typeof call?.resultDisplay === "string" ? call.resultDisplay : r === undefined ? "" : JSON.stringify(r);
}

/** The ordered, de-duplicated, rewind-applied messages of a chat file. */
export function readGeminiMessages(path: string): any[] {
  const order: string[] = [];
  const byId = new Map<string, any>();
  let anon = 0;
  const upsert = (m: any) => {
    const id = typeof m.id === "string" ? m.id : `anon-${anon++}`;
    if (!byId.has(id)) order.push(id);
    byId.set(id, m);
  };
  const raw = readFileSync(path, "utf8");
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    // Legacy: one JSON document.
    try {
      const doc = JSON.parse(raw);
      for (const m of doc.messages ?? []) upsert(m);
      return order.map((id) => byId.get(id));
    } catch {
      /* fall through to JSONL */
    }
  }
  forEachLine(path, (line) => {
    if (!line.trim()) return;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (!r || typeof r !== "object") return;
    if (typeof r.$rewindTo === "string") {
      const at = order.indexOf(r.$rewindTo);
      if (at >= 0) for (const id of order.splice(at)) byId.delete(id);
      return;
    }
    if (typeof r.type === "string" && ("content" in r || "toolCalls" in r)) upsert(r);
  });
  return order.map((id) => byId.get(id));
}

export function parseGeminiChat(path: string): ParsedSession {
  const messages: Array<Record<string, unknown>> = [];
  const usageSamples: UsageSample[] = [];
  let model: string | undefined;
  let reportedInputTokens: number | undefined;
  for (const m of readGeminiMessages(path)) {
    if (m.type === "user") {
      const t = text(m.content);
      if (t) messages.push({ role: "user", content: t });
    } else if (m.type === "gemini") {
      if (typeof m.model === "string") model = m.model;
      const input = Number(m.tokens?.input);
      if (Number.isFinite(input) && input > 0) {
        reportedInputTokens = input;
        usageSamples.push({ index: messages.length, input });
      }
      const blocks: unknown[] = [];
      const t = text(m.content);
      if (t) blocks.push({ type: "text", text: t });
      const calls: any[] = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      for (const c of calls) blocks.push({ type: "tool_use", id: String(c.id ?? c.name), name: String(c.name ?? "tool"), input: c.args ?? {} });
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
      const results = calls.filter((c) => c.result !== undefined || c.resultDisplay !== undefined);
      if (results.length) {
        messages.push({ role: "user", content: results.map((c) => ({ type: "tool_result", tool_use_id: String(c.id ?? c.name), content: resultText(c) })) });
      }
    }
  }
  return {
    conversationJson: JSON.stringify({ messages }),
    model,
    messageCount: messages.length,
    reportedInputTokens,
    usageSamples,
    path,
  };
}

/** Gemini CLI chats on this machine: ~/.gemini/tmp/<project>/chats/session-*.json[l]. */
export function listGeminiChats(home = homedir()): SessionInfo[] {
  const root = join(home, ".gemini", "tmp");
  if (!existsSync(root)) return [];
  const out: SessionInfo[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const project of projects) {
    const dir = join(root, project, "chats");
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^session-.*\.jsonl?$/.test(f)) continue;
      const path = join(dir, f);
      try {
        const st = statSync(path);
        out.push({ path, project: "gemini", modifiedAt: st.mtime, sizeBytes: st.size });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}
