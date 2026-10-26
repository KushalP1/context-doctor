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

import { realModel } from "./tokens.js";
import { openAIUsage } from "./pricing.js";
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { join } from "node:path";
import { isGeminiChat, listGeminiChats, parseGeminiChat } from "./gemini.js";

export interface SessionInfo {
  path: string;
  project: string;
  modifiedAt: Date;
  sizeBytes: number;
}

/**
 * Read one usage field defensively.
 *
 * A numeric string plainly means that number, and discarding it would throw
 * away ground truth and silently fall back to the heuristic — so it is parsed.
 * Anything else unusable (objects, null, "abc", negatives) counts as nothing.
 */
function usageNumber(value: unknown): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/** Wall-clock spent inside one tool, aggregated across a session. */
export interface ToolTiming {
  tool: string;
  calls: number;
  totalMs: number;
  medianMs: number;
  maxMs: number;
}

/** One API-reported input size, positioned in the message array. */
export interface UsageSample {
  /** Index into the live `messages` array of the assistant message reporting it. */
  index: number;
  /** input + cache-read + cache-creation tokens for that request. */
  input: number;
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
  /**
   * Every API-reported input size in the transcript, tagged with its position
   * in the live message array. Consecutive samples are what make key-free
   * accuracy measurement possible: the harness's system prompt and tool
   * schemas are constant between two calls, so the DIFFERENCE between two
   * reported figures is the cost of the messages in between — directly
   * comparable to what the heuristic estimates for those same messages.
   */
  usageSamples?: UsageSample[];
  /**
   * Time between each tool_use and its tool_result, per tool, from the
   * timestamps every transcript entry carries. This is the other half of the
   * cost picture: tokens are what a call puts INTO context, this is how long
   * it made you wait. Caveat that must travel with the number: the gap also
   * contains any time spent waiting on a permission prompt, so an
   * unattended run reads cleaner than an interactive one.
   */
  toolTimings?: ToolTiming[];
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
  // Codex keeps rollouts by date: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
  const codexRoot = join(homedir(), ".codex", "sessions");
  if (existsSync(codexRoot)) {
    const walk = (dir: string, depth: number): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const path = join(dir, name);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (depth < 3) walk(path, depth + 1);
        } else if (name.endsWith(".jsonl")) {
          sessions.push({ path, project: "codex", modifiedAt: stat.mtime, sizeBytes: stat.size });
        }
      }
    };
    walk(codexRoot, 0);
  }
  sessions.push(...listGeminiChats());
  return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()).slice(0, limit);
}

/** Claude Code's project folder for a working directory: every non-alphanumeric becomes "-". */
export function claudeProjectDir(cwd: string, home = homedir()): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** A session `session` picked by itself, and how, in words. */
export interface PickedSession {
  path: string;
  how: string;
}

/**
 * The session `session` profiles when no file is given: the one it is
 * running in. Inside Claude Code (a Bash tool call, the plugin's checkup
 * skill) CLAUDE_CODE_SESSION_ID names it; otherwise the newest transcript of
 * this folder's project; otherwise the newest on the machine. "Newest on the
 * machine" alone picked whichever other project had written last.
 */
export function pickCurrentSession(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir()): PickedSession | undefined {
  const id = env.CLAUDE_CODE_SESSION_ID?.trim();
  const here = claudeProjectDir(cwd, home);
  if (id && /^[\w.-]+$/.test(id)) {
    const root = join(home, ".claude", "projects");
    let dirs: string[] = [];
    try { dirs = readdirSync(root); } catch { /* no projects */ }
    const candidates = [here, ...dirs.map((d) => join(root, d))].map((d) => join(d, `${id}.jsonl`));
    const found = candidates.find((p) => existsSync(p));
    if (found) return { path: found, how: `the current Claude Code session (CLAUDE_CODE_SESSION_ID ${id})` };
  }
  let newest: { path: string; at: number } | undefined;
  try {
    for (const f of readdirSync(here)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(here, f);
      const at = statSync(p).mtimeMs;
      if (!newest || at > newest.at) newest = { path: p, at };
    }
  } catch { /* no project folder for this directory */ }
  if (newest) return { path: newest.path, how: "the newest Claude Code session in this folder's project" };
  const any = listSessions(1)[0];
  return any ? { path: any.path, how: "the newest session on this machine (none for this folder)" } : undefined;
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
function chatGptAttachmentLabel(part: unknown): string {
  const kind = (part as { content_type?: string })?.content_type;
  if (typeof kind === "string") return `[${kind}]`;
  if ((part as { asset_pointer?: string })?.asset_pointer) return "[image]";
  return "[attachment]";
}

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
      if (!Array.isArray(parts)) return false;
      // A turn containing an image is exported as multimodal_text, with the
      // picture as an object among the string parts. Requiring a non-empty
      // string dropped those turns entirely, so an image-heavy conversation
      // profiled as smaller than it is.
      return parts.some((p: unknown) => (typeof p === "string" && p.length > 0) || (p && typeof p === "object"));
    })
    .sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));

  const messages = nodes.map((n) => ({
    role: n.message.author.role,
    content: (n.message.content.parts as unknown[])
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
export function forEachLine(path: string, onLine: (line: string) => void): void {
  const fd = openSync(path, "r");
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  let pending = "";
  try {
    for (;;) {
      const bytes = readSync(fd, buf, 0, buf.length, null);
      if (bytes === 0) break;
      pending += decoder.write(buf.subarray(0, bytes));
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    }
    pending += decoder.end();
    if (pending) onLine(pending);
  } finally {
    closeSync(fd);
  }
}

/**
 * Has this API reply been counted already? Claude Code writes one reply as
 * several rows (one per content block, ~2.2 on average) carrying the same
 * message id and the same usage, so a row is not a request. And a forked
 * session starts as a verbatim copy of its parent's transcript in a new file
 * (same row uuids, same message ids), so across files one reply can turn up
 * twice. Within a file the message id identifies the reply; across files
 * the uuid of its row does, which unrelated files never share even when they
 * reuse an id (hand-made transcripts do).
 *
 * Make one per file, passing the same `runRows` set to every file of one
 * report. Returns "new" the first time a reply is met in the run, "copy"
 * when its file met it first but an earlier file already counted it, and
 * "repeat" for its later rows in the same file.
 */
export function replyCounter(runRows?: Set<string>): (entry: Record<string, any>) => "new" | "copy" | "repeat" {
  const ids = new Set<string>();
  return (entry) => {
    const id = entry?.message?.id;
    if (typeof id === "string") {
      if (ids.has(id)) return "repeat";
      ids.add(id);
    }
    const uuid = entry?.uuid;
    if (runRows && typeof uuid === "string") {
      if (runRows.has(uuid)) return "copy";
      runRows.add(uuid);
    }
    return "new";
  };
}

/**
 * A counted reply's output, settled. Subagent transcripts are written as a
 * reply streams, each row with a snapshot of its usage: the input and cache
 * counts are final from the first row, output_tokens only on the last. On
 * the author's machine 5.8k subagent replies changed it, their first rows
 * carrying 1.3M output tokens against a final 6.7M (main-thread rows carry
 * the final usage throughout). Call with `first` on the row a reply is
 * counted at; for its later rows it returns the output tokens not yet
 * charged, and 0 for replies never counted.
 */
export function outputSettler(): (entry: Record<string, any>, first: boolean) => number {
  const charged = new Map<string, number>();
  return (entry, first) => {
    const raw = Number(entry?.message?.usage?.output_tokens);
    const out = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const id = entry?.message?.id;
    if (typeof id !== "string") return first ? out : 0;
    if (first) {
      charged.set(id, out);
      return out;
    }
    const prev = charged.get(id);
    if (prev === undefined || out <= prev) return 0;
    charged.set(id, out);
    return out - prev;
  };
}

/**
 * Text the user typed while the agent was working. Claude Code delivers it
 * mid-turn and records it only as an attachment line (type "attachment",
 * attachment.type "queued_command"), never as a user row: on the author's
 * machine 511 such prompts against ~2.5k typed user rows. Task
 * notifications and subagent hand-backs arrive the same way, so only
 * human-origin prompts count (older lines carry no origin; their prompts
 * were human). Undefined for anything else.
 */
export function queuedUserPrompt(entry: Record<string, any>): string | unknown[] | undefined {
  const a = entry?.attachment;
  if (entry?.type !== "attachment" || a?.type !== "queued_command" || entry.isSidechain || entry.isMeta || a.isMeta) return undefined;
  if ((a.commandMode ?? "prompt") !== "prompt") return undefined;
  if (a.origin !== undefined && a.origin?.kind !== "human") return undefined;
  if (typeof a.prompt === "string") return a.prompt.trim() ? a.prompt : undefined;
  return Array.isArray(a.prompt) && a.prompt.length ? a.prompt : undefined;
}

/** Peek at the first bytes to tell a ChatGPT export (JSON array) from JSONL. */
function startsWithArray(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(64);
    const bytes = readSync(fd, buf, 0, 64, 0);
    return buf.subarray(0, bytes).toString("utf8").trimStart().startsWith("[");
  } finally {
    closeSync(fd);
  }
}

/**
 * Codex (OpenAI's agent: the Codex tab in ChatGPT.app, the IDE extension, the
 * CLI) writes rollouts to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl as
 * {timestamp, type, payload}. Convert one line into the Claude-shaped entry the
 * rest of this parser understands, or return null for lines that carry no
 * context (reasoning is encrypted, world_state is bookkeeping).
 *
 *   response_item/message                  → user or assistant text; developer (and
 *                                            system) messages as role "system"
 *   response_item/function_call | custom_tool_call | local_shell_call → assistant tool_use
 *   response_item/*_call_output            → user tool_result
 *   event_msg/token_count                  → the API's own usage figures
 *   turn_context                           → model
 */
function fromCodexLine(entry: Record<string, any>): Record<string, any> | null {
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return null;
  const timestamp = entry.timestamp;

  if (entry.type === "turn_context") {
    return typeof payload.model === "string" ? { codexModel: payload.model } : null;
  }

  if (entry.type === "event_msg" && payload.type === "token_count") {
    const last = payload.info?.last_token_usage;
    if (!last || !(last.input_tokens > 0)) return null;
    // Codex's input_tokens holds the cached portion and the cache writes
    // too (each input token is billed once, at one of the three rates), so
    // it maps to Anthropic's input + cache_read + cache_creation. Through
    // 0.37 the writes were counted twice, as uncached input and as writes.
    return {
      type: "assistant",
      timestamp,
      codexUsageOnly: true,
      message: { role: "assistant", content: [], usage: openAIUsage(last) },
    };
  }

  if (entry.type !== "response_item") return null;
  const text = (parts: unknown): string =>
    Array.isArray(parts)
      ? parts.map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "")).join("\n")
      : typeof parts === "string" ? parts : "";

  switch (payload.type) {
    case "message": {
      // Developer messages (sandbox and approval rules, AGENTS.md, skills) are
      // in every request Codex sends; dropping them undercounted the context.
      if (payload.role === "developer" || payload.role === "system") {
        return { type: "user", timestamp, message: { role: "system", content: text(payload.content) } };
      }
      const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null;
      if (!role) return null;
      return { type: role, timestamp, message: { role, content: text(payload.content) } };
    }
    case "local_shell_call": {
      // Codex's built-in shell (older models): the command is in `action`.
      const id = payload.call_id ?? payload.id;
      return {
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "tool_use", id, name: "local_shell", input: payload.action ?? {} }] },
      };
    }
    case "function_call":
    case "custom_tool_call":
    case "web_search_call": {
      const id = payload.call_id ?? payload.id;
      let input: unknown = payload.arguments ?? payload.input ?? payload.action ?? {};
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = { input }; }
      }
      return {
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "tool_use", id, name: payload.name ?? payload.type, input }] },
      };
    }
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output": {
      return {
        type: "user",
        timestamp,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: payload.call_id, content: text(payload.output) }] },
      };
    }
    default:
      return null;
  }
}

/** Message content as a block array (a plain string becomes one text block). */
function asBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content == null ? [] : [content];
}

export function parseSessionFile(path: string): ParsedSession {
  if (isGeminiChat(path)) return parseGeminiChat(path);
  // ChatGPT exports are one big JSON array, not JSONL — and small enough to
  // read whole. Only peek first, so multi-hundred-MB JSONL is never slurped.
  if (startsWithArray(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
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
  let lastReplyId: string | undefined;
  /** Where each API reply (by message id) lives in `messages`. */
  const replyIndex = new Map<string, number>();
  let lastSampledReplyId: string | undefined;
  // A compaction summary marks where the live context starts; never merge into it.
  const prevIndexAllowsMerge = (i: number): boolean => i !== lastCompactIndex;
  /** Newest API-reported input size, if the transcript carries usage. */
  let reportedInputTokens: number | undefined;
  /** Every reported size, positioned — the basis for `context-doctor accuracy`. */
  const usageSamples: UsageSample[] = [];
  /** Open tool calls awaiting their result, by tool_use id. */
  const pendingCalls = new Map<string, { tool: string; at: number }>();
  const latenciesByTool = new Map<string, number[]>();
  /**
   * A compaction keeps the last few messages verbatim after its summary
   * (compact_boundary's compactMetadata.preservedMessages). They sit BEFORE
   * the boundary in the file, so cutting at the summary dropped them from the
   * live context as if they had been compacted away. Rows are remembered by
   * uuid (references, not copies) so the kept ones can be put back.
   */
  const rowsByUuid = new Map<string, { role: unknown; content: unknown; seq: number }>();
  let boundaryKeeps: string[] | undefined;
  let liveKeeps: { uuids: string[]; seq: number } | undefined;
  let seq = 0;

  forEachLine(path, (line) => {
    if (!line.trim()) return;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    // Titles are metadata lines; the last one wins.
    if (entry.type === "custom-title" && entry.customTitle) title = entry.customTitle;
    if (entry.type === "ai-title" && entry.aiTitle && !title) title = entry.aiTitle;

    // Codex rollouts: translate, then fall through to the shared handling.
    if (entry.payload && typeof entry.payload === "object" && typeof entry.type === "string" && ["response_item", "event_msg", "turn_context"].includes(entry.type)) {
      const converted = fromCodexLine(entry);
      if (!converted) return;
      if (converted.codexModel) {
        model = converted.codexModel;
        return;
      }
      if (converted.codexUsageOnly) {
        // A usage-only line attaches to the conversation position, not a message.
        const u = converted.message.usage;
        const total = usageNumber(u.input_tokens) + usageNumber(u.cache_read_input_tokens) + usageNumber(u.cache_creation_input_tokens);
        if (total > 0) {
          reportedInputTokens = total;
          usageSamples.push({ index: messages.length, input: total });
        }
        return;
      }
      entry = converted;
    }

    // Cursor's agent transcripts (~/.cursor/projects/*/agent-transcripts/) are
    // one {role, message:{content}} per line: no `type`, no `message.role`, no
    // usage. Cursor hands this path to hooks it loads from ~/.claude/settings.json,
    // so until this shape parsed, our hook fired on every Cursor prompt and
    // returned nothing.
    if (!entry.type && (entry.role === "user" || entry.role === "assistant") && entry.message && (entry.message as Record<string, unknown>).content != null) {
      const message = entry.message as Record<string, unknown>;
      messages.push({ role: entry.role, content: message.content });
      return;
    }

    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      const kept = entry.compactMetadata?.preservedMessages;
      const uuids = Array.isArray(kept) ? kept : Array.isArray(kept?.uuids) ? kept.uuids : Array.isArray(kept?.allUuids) ? kept.allUuids : undefined;
      boundaryKeeps = uuids?.filter((u: unknown): u is string => typeof u === "string");
      // The last reply's usage measured the context the compaction just
      // replaced. Kept, the every-prompt hook read the pre-compaction size
      // (say 800k) until the next reply reported the real one; with no figure
      // it falls back to its estimate of the live messages.
      reportedInputTokens = undefined;
      return;
    }

    // A prompt typed while the agent worked is the user's turn too, though
    // Claude Code records it only as an attachment.
    const queued = queuedUserPrompt(entry);
    if (queued !== undefined) entry = { ...entry, type: "user", message: { role: "user", content: queued } };

    if ((entry.type !== "user" && entry.type !== "assistant") || !entry.message) return;
    if (entry.isSidechain) return; // subagent traffic has its own context window
    const message = entry.message as Record<string, unknown>;
    if (!message.role || message.content == null) return;
    seq++;
    if (typeof entry.uuid === "string") {
      rowsByUuid.set(entry.uuid, { role: message.role, content: message.content, seq });
    }
    if (entry.isCompactSummary) {
      // The kept messages belong to the boundary just before this summary.
      liveKeeps = boundaryKeeps ? { uuids: boundaryKeeps, seq } : undefined;
      boundaryKeeps = undefined;
    }
    model = realModel(message.model) ?? model;
    const usage = message.usage as Record<string, number> | undefined;
    if (entry.type === "assistant" && usage) {
      // Coerce, do not trust: a transcript whose usage numbers are STRINGS
      // turned `1200 + 300` into "12003000" through JavaScript concatenation,
      // an 8000x overstatement that drives the hook, the cost figures and the
      // window percentage. Anything not a finite non-negative number is 0.
      const total =
        usageNumber(usage.input_tokens) +
        usageNumber(usage.cache_read_input_tokens) +
        usageNumber(usage.cache_creation_input_tokens);
      if (total > 0) {
        reportedInputTokens = total;
        // One sample per API reply: Claude Code writes a reply as several
        // rows (one per content block) carrying the same usage. The request's
        // input is everything before the reply's first row.
        const replyId = typeof message.id === "string" ? message.id : undefined;
        if (!replyId || replyId !== lastSampledReplyId) {
          const prevMsg = messages[messages.length - 1];
          const startsNew = !(prevMsg?.role === "assistant" && replyId !== undefined && replyId === lastReplyId);
          usageSamples.push({ index: startsNew ? messages.length : messages.length - 1, input: total });
          lastSampledReplyId = replyId;
        }
      }
    }
    if (entry.isCompactSummary) lastCompactIndex = messages.length;

    // Pair every tool_use with its tool_result by id and record the gap.
    const at = Date.parse(String(entry.timestamp ?? ""));
    if (Number.isFinite(at) && Array.isArray(message.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block?.type === "tool_use" && typeof block.id === "string") {
          pendingCalls.set(block.id, { tool: String(block.name ?? "unknown"), at });
        } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          const call = pendingCalls.get(block.tool_use_id);
          if (call) {
            pendingCalls.delete(block.tool_use_id);
            const ms = at - call.at;
            if (ms >= 0) latenciesByTool.set(call.tool, [...(latenciesByTool.get(call.tool) ?? []), ms]);
          }
        }
      }
    }

    // Rebuild messages the way the API saw them. Claude Code writes one row
    // per content block, so one reply (text + two tool calls) arrived as three
    // "assistant" messages and its results as two "user" ones: exported
    // conversations broke tool_use/tool_result pairing, and every split added
    // per-message overhead to the profile. The API treats consecutive
    // same-role messages as one; so do we.
    // Parallel tool calls are written as they stream: a reply's later
    // tool_use rows can land after the first tool_result rows. A row that
    // belongs to an earlier reply (same message id) joins that reply.
    const replyId = entry.type === "assistant" && typeof message.id === "string" ? message.id : undefined;
    const home = replyId !== undefined ? replyIndex.get(replyId) : undefined;
    if (home !== undefined && home > lastCompactIndex && home < messages.length - 1) {
      messages[home].content = [...asBlocks(messages[home].content), ...asBlocks(message.content)];
      return;
    }
    const prev = messages[messages.length - 1];
    if (entry.type === "assistant") lastReplyId = replyId;
    if (prev && prev.role === message.role && !entry.isCompactSummary && prevIndexAllowsMerge(messages.length - 1)) {
      prev.content = [...asBlocks(prev.content), ...asBlocks(message.content)];
      if (replyId !== undefined) replyIndex.set(replyId, messages.length - 1);
    } else {
      messages.push({ role: message.role, content: message.content });
      if (replyId !== undefined) replyIndex.set(replyId, messages.length - 1);
    }
  });

  const toolTimings: ToolTiming[] = [...latenciesByTool.entries()]
    .map(([tool, ms]) => {
      const sorted = [...ms].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return {
        tool,
        calls: ms.length,
        totalMs: ms.reduce((a, b) => a + b, 0),
        medianMs: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
        maxMs: sorted[sorted.length - 1],
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);

  // A compaction replaces everything before it: the summary entry IS the live
  // history from that point on. Counting the pre-compaction turns would
  // overstate context, cost per message and window fill — sometimes hugely.
  // ...except the messages the compaction kept verbatim, which follow the
  // summary in what the model sees. Rebuilt the way the main pass merges
  // rows: consecutive same-role rows are one message.
  const kept: Array<Record<string, unknown>> = [];
  if (lastCompactIndex >= 0 && liveKeeps) {
    for (const uuid of liveKeeps.uuids) {
      const row = rowsByUuid.get(uuid);
      if (!row || row.seq >= liveKeeps.seq) continue; // only rows the cut dropped
      const prev = kept[kept.length - 1];
      if (prev && prev.role === row.role) prev.content = [...asBlocks(prev.content), ...asBlocks(row.content)];
      else kept.push({ role: row.role, content: row.content });
    }
  }
  const compactedAway = lastCompactIndex >= 0 ? Math.max(0, lastCompactIndex - kept.length) : 0;
  const live = lastCompactIndex >= 0 ? [messages[lastCompactIndex], ...kept, ...messages.slice(lastCompactIndex + 1)] : messages;

  return {
    conversationJson: JSON.stringify({ messages: live }),
    title,
    model,
    messageCount: live.length,
    compactedAway,
    reportedInputTokens,
    // Samples before the compaction boundary describe a context that no longer
    // exists; re-base the rest onto the live array, after the kept messages.
    usageSamples:
      lastCompactIndex >= 0
        ? usageSamples
            .filter((u) => u.index >= lastCompactIndex)
            .map((u) => ({ index: u.index - lastCompactIndex + (u.index > lastCompactIndex ? kept.length : 0), input: u.input }))
        : usageSamples,
    toolTimings,
    path,
  };
}
