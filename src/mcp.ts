#!/usr/bin/env node
/**
 * context-doctor MCP server (stdio).
 *
 * Plug into Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI or any MCP
 * client that launches a local command:
 *
 *   { "mcpServers": { "context-doctor": { "command": "npx", "args": ["-y", "context-doctor", "mcp"] } } }
 *
 * ChatGPT launches nothing locally: it connects only to a URL (a developer-mode
 * connector), which `--http` serves (see the transport dispatch at the end).
 *
 * Tools:
 *   profile_context   — analyze a conversation/prompt, report token breakdown + findings
 *   optimize_context  — apply safe strategies, return the slimmed conversation
 *   context_best_practices — curated checklist for a given provider/use case
 *   pack_context      — only the chunks of big files a question needs, within a token budget
 *   save_handoff      — store a handoff brief the next chat starts from (a chat's history cannot be cut)
 *   recall            — search this session's own transcript (compacted turns, cleared output); stdio only
 * Prompts: context_checkup, handoff, ask_file. Resources (stdio): handoff://latest, handoff://<id>.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { optimizeConversation } from "./optimize.js";
import { renderProfile } from "./report.js";
import { formatTokens } from "./tokens.js";
import { recordLedger } from "./ledger.js";
import { renderSketchProfile, runSketchProfile } from "./sketch.js";
import { packContextSemantic, readSourcesAsync, renderPack } from "./pack.js";
import { SERVER_INSTRUCTIONS } from "./rules.js";
import { compactOutline, compactProfile, compactSketch, resultMode, type CompactResult } from "./compact.js";
import { HANDOFF_LIMITS, handoffDir, listHandoffs, maskSecrets, readHandoff, renderMath, saveHandoff, tildify, tildifyAll, validateHandoff } from "./handoff.js";
import { sourcesFromOpenAiFiles } from "./fileparams.js";
import { makeGuard, readJsonBody, refusal } from "./httpguard.js";
import { currentTranscript, recall, renderRecall } from "./recall.js";

const STRATEGY_IDS = ["dedupe", "trim-tool-results", "trim-tool-calls", "strip-base64", "prune-history"] as const;

type Text = { type: "text"; text: string };

/** Largest size hint a sketch block may carry (a block, not a library). */
const SKETCH_MAX = { approx_tokens: 10_000_000, approx_lines: 1_000_000, approx_words: 5_000_000, approx_chars: 40_000_000 };

/**
 * A tool result in the form the caller should get: the full text by default,
 * or (ChatGPT, or CONTEXT_DOCTOR_RESULTS=compact) a short text with the detail
 * as structuredContent and presentation-only data in _meta. See compact.ts.
 */
function shaped(requestMeta: unknown, full: string, compact: () => CompactResult) {
  if (resultMode(requestMeta) === "full") return { content: [{ type: "text" as const, text: full }] };
  const c = compact();
  return { content: [{ type: "text" as const, text: c.text }], structuredContent: c.structured, _meta: c.meta };
}

type Consent = { asked: false } | { asked: true; ok: boolean; content: Record<string, unknown>; why?: string };

/**
 * Ask the user through the client's own form (MCP elicitation), when the
 * client declares form elicitation. `asked: false` means it does not: the
 * caller falls back to consent in the chat, as before. Once the client has
 * declared it, the answer fails closed: a decline, a dismissal, an answer
 * that does not fit the form, a client error or no answer in two minutes is
 * a no, never "go ahead".
 */
async function askConsent(server: McpServer, message: string, properties: Record<string, { type: "boolean"; title: string; default?: boolean }>): Promise<Consent> {
  if (!server.server.getClientCapabilities()?.elicitation?.form) return { asked: false };
  try {
    const r = await server.server.elicitInput({ mode: "form", message, requestedSchema: { type: "object", properties } }, { timeout: 120_000 });
    if (r.action === "accept") return { asked: true, ok: true, content: (r.content ?? {}) as Record<string, unknown> };
    return { asked: true, ok: false, content: {}, why: r.action === "decline" ? "the user declined" : "the user dismissed the prompt" };
  } catch (e) {
    if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) return { asked: true, ok: false, content: {}, why: "no answer within two minutes" };
    return { asked: true, ok: false, content: {}, why: "the consent form failed, so nothing was assumed" };
  }
}

/**
 * Build a fully-configured server instance. A factory (not a singleton) so the
 * stateless HTTP mode can hand every request its own server, per the MCP SDK's
 * recommended pattern.
 *
 * `http`: the server is reachable over a URL, possibly by anyone holding it
 * (a tunnel, a shared host). It then reads no files, keeps no handoffs unless
 * `storeHandoffs` (`--store-handoffs`, for a server on the user's own machine),
 * and exposes no handoff resources at all.
 */
function createServer({ http = false, storeHandoffs = !http }: { http?: boolean; storeHandoffs?: boolean } = {}): McpServer {
  const fileAccess = !http;
  const server = new McpServer(
    { name: "context-doctor", version: "0.38.0" },
    // Server instructions are injected by MCP clients (Claude Desktop, Cursor, …)
    // into the system context of EVERY conversation where this server is
    // enabled: standing context-hygiene rules in every chat, no hook needed.
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.tool(
  "profile_context",
  "Profile a conversation's context: token breakdown, largest blocks, wasted context. Pass `conversation` (JSON or text) or, in a chat app, a `sketch` (~120 tokens). Call it when the user asks about tokens, cost, speed or limits, and once past ~30 turns or 3+ large pastes. Act on the top finding.",
  {
    conversation: z.string().optional().describe("JSON or text; in a chat app pass `sketch`"),
    sketch: z.object({
      turns: z.number().int().nonnegative().describe("Exchanges so far"),
      model: z.string().optional(),
      blocks: z.array(z.object({
        turn: z.number().int().positive(),
        kind: z.enum(["paste", "code", "tool_result", "image", "base64", "text"]),
        label: z.string().describe("Short name"),
        // Bounds are checked in the handler (SKETCH_LIMITS): each schema
        // keyword rides in every request's tool definitions.
        approx_tokens: z.number().optional(),
        approx_lines: z.number().optional(),
        approx_words: z.number().optional(),
        approx_chars: z.number().optional(),
        repeated: z.number().int().optional().describe("Times it appears (2+ = duplicate)"),
        stale: z.boolean().optional().describe("Acted on, no longer needed"),
      })).describe("Only blocks over ~500 tokens, repeated, or images."),
    }).optional().describe("For chat apps. One size hint per block: lines for code, words for prose, chars for logs."),
    model: z.string().optional().describe("e.g. claude-sonnet-5"),
  },
  // Pure: reads its input and returns text. Clients (Codex, ChatGPT) may skip approval for read-only tools.
  { title: "Profile context", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ conversation, sketch, model }, extra) => {
    if (sketch) {
      const bad = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
      if (sketch.turns > 100_000) return bad(`sketch.turns is ${sketch.turns}; the most that makes sense is 100000.`);
      if (sketch.blocks.length > 500) return bad(`sketch.blocks has ${sketch.blocks.length} blocks; list at most 500 (only those over ~500 tokens, repeated, or images).`);
      for (const [i, b] of sketch.blocks.entries()) {
        if (b.turn > 100_000) return bad(`sketch.blocks[${i}].turn is ${b.turn}; the most that makes sense is 100000.`);
        if (b.repeated !== undefined && (b.repeated < 1 || b.repeated > 1000)) return bad(`sketch.blocks[${i}].repeated is ${b.repeated}; give 1 to 1000.`);
        for (const [k, max] of Object.entries(SKETCH_MAX)) {
          const v = (b as Record<string, unknown>)[k];
          if (typeof v === "number" && !(v > 0)) return bad(`sketch.blocks[${i}].${k} is ${v}; a size is above 0.`);
          if (typeof v === "number" && v > max) {
            return bad(`sketch.blocks[${i}].${k} is ${v}; the most that makes sense is ${max}. Give a rough size of the block itself.`);
          }
        }
      }
      // Both given: the sketch is used. Say so, or the model reads a sketch
      // profile as the profile of the conversation it passed.
      const both = conversation ? "Note: both `conversation` and `sketch` were passed; profiled the sketch only. Pass one.\n\n" : "";
      const p = runSketchProfile({ ...sketch, model: sketch.model ?? model }, { record: !http });
      const full = both + renderSketchProfile(p);
      return shaped(extra?._meta, full, () => {
        const c = compactSketch(p, full);
        return { ...c, text: both + c.text };
      });
    }
    if (!conversation) {
      return {
        isError: true,
        content: [{ type: "text", text: "Pass either `conversation` (full JSON or text) or `sketch` (turns + large/repeated blocks). In a chat app, use `sketch`." }],
      };
    }
    const profile = profileConversation(parseConversation(conversation), model);
    const full = renderProfile(profile);
    return shaped(extra?._meta, full, () => compactProfile(profile, full));
  }
);

server.tool(
  "optimize_context",
  "Rewrite a conversation to reclaim tokens (dedupe, trim stale tool results, strip base64; prune-history is lossy). Returns slimmed JSON and the savings. Use after profile_context finds waste the user wants fixed; prune-history only with the user's consent, then write the summary the result asks for.",
  {
    conversation: z.string().describe("Conversation JSON"),
    strategies: z.array(z.enum(STRATEGY_IDS)).optional()
      .describe("Default: dedupe, trim-tool-results, strip-base64"),
    keep_recent: z.number().int().nonnegative().optional().describe("Tail messages kept (default 6)"),
    max_tool_result_tokens: z.number().int().positive().optional().describe("Per trimmed result (default 300)"),
  },
  // Pure: reads its input and returns text. Clients (Codex, ChatGPT) may skip approval for read-only tools.
  { title: "Optimize context", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ conversation, strategies, keep_recent, max_tool_result_tokens }) => {
    // prune-history is lossy. Where the client can show a form, the user
    // confirms it there; elsewhere the tool description asks the model to
    // get consent in the chat first, as before.
    let consentNote = "";
    if (strategies?.includes("prune-history")) {
      const c = await askConsent(
        server,
        `Prune old turns from this conversation? It is lossy: all but the last ${Math.max(2, keep_recent ?? 6)} messages are replaced by a summary the assistant writes.`,
        { prune: { type: "boolean", title: "Replace old turns with a summary", default: true } }
      );
      if (c.asked && (!c.ok || c.content.prune === false)) {
        strategies = strategies.filter((s) => s !== "prune-history");
        consentNote = `\nprune-history skipped: ${c.ok ? "the user unticked it" : c.why}.`;
      }
    }
    const result = optimizeConversation(conversation, {
      strategies: strategies as any,
      keepRecent: keep_recent,
      maxToolResultTokens: max_tool_result_tokens,
    });
    const saved = result.tokensBefore - result.tokensAfter;
    // The ledger is this machine's record; a server reachable over HTTP writes
    // nothing a caller sends (its model string included) into it.
    if (saved > 0 && !http) {
      recordLedger({ ev: "optimize", src: "mcp", saved, model: (result.conversation as { model?: string })?.model });
    }
    const summary =
      `Saved ~${formatTokens(saved)} tokens (${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)}) ` +
      `via ${result.applied.length} change(s):\n` +
      result.applied.map((c) => `- [${c.strategy}] message #${c.messageIndex}: ${c.note} (~${formatTokens(c.tokensSaved)})`).join("\n") +
      consentNote;
    // Echoing a huge optimized conversation back inline would flood the very
    // context this tool exists to save. Above the cap, return the summary and
    // point at the CLI (compact JSON keeps mid-size results affordable).
    const ECHO_CAP_CHARS = 100_000;
    const conversationJson = JSON.stringify(result.conversation);
    const content: Text[] = [
      { type: "text", text: summary },
      conversationJson.length <= ECHO_CAP_CHARS
        ? { type: "text", text: conversationJson }
        : {
            type: "text",
            text:
              `[optimized conversation is ${conversationJson.length} chars — too large to echo into this context. ` +
              `Tell the user the savings above and that \`npx context-doctor optimize <file> --out slim.json\` produces the file directly.]`,
          },
    ];
    // Host-model summarization: instead of calling an LLM ourselves (which would
    // need an API key), hand the pruned material to the model that invoked this
    // tool and ask IT to write the summary.
    if (result.prunedDigest) {
      content.push({
        type: "text",
        text:
          "ACTION REQUIRED (you, the assistant calling this tool): the pruned turns are digested below. " +
          "Write a dense factual summary of them (≤150 tokens: decisions, current state, open items, key identifiers) " +
          "and replace the '[context-doctor: ... pruned]' stub message in the conversation above with your summary " +
          "before presenting the result.\n\nPRUNED TURNS DIGEST:\n" + result.prunedDigest,
      });
    }
    return { content };
  }
  );

  // ChatGPT passes an uploaded file to a tool that names the field in
  // _meta["openai/fileParams"]: { download_url, file_id, mime_type?, file_name? }.
  // Every file schema must declare all four and require only the first two
  // (developers.openai.com/plugins/reference). Only the HTTP server offers it:
  // a local server reads files from disk instead, and stays a little smaller.
  const fileSchema = z.object({
    download_url: z.string(),
    file_id: z.string(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  }).strict();
  // Over HTTP there is no `paths` (no file is read from the server's disk) and
  // no `semantic` (local embeddings belong to a local server); `files` takes
  // their place, so the definitions stay within the same budget as stdio's.
  const packInput = {
    ...(http ? {} : { paths: z.array(z.string()).optional().describe("Files or folders, absolute paths") }),
    text: z.string().optional().describe("Raw text to pack instead of files"),
    query: z.string().optional().describe("The question; omit for an outline"),
    max_tokens: z.number().int().positive().optional().describe("Budget, default 4000"),
    ids: z.array(z.string()).optional().describe("Chunk ids, e.g. docs/guide.md#4"),
    model: z.string().optional().describe("Model to count for"),
    ...(http
      ? { files: z.array(fileSchema).optional().describe("Files the user uploaded") }
      : { semantic: z.boolean().optional().describe("Also rank by meaning (local Ollama embeddings)") }),
  };
  server.registerTool(
    "pack_context",
    {
      description: "Read only the parts of large files a question needs: the chunks that best match `query` within `max_tokens`, with ids and line ranges. No query: an outline; pick with `ids`. Use instead of reading a big doc, log or folder whole when not editing it. Text, code, PDF, Word, PowerPoint, ODT.",
      inputSchema: packInput,
      // Reads files, never writes. Clients (Codex, ChatGPT) may skip approval for read-only tools.
      annotations: { title: "Pack context", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ...(http ? { _meta: { "openai/fileParams": ["files"] } } : {}),
    },
    async (args: Record<string, any>, extra: { _meta?: Record<string, unknown> }) => {
      const { paths, text, query, max_tokens, ids, model, semantic, files } = args as {
        paths?: string[]; text?: string; query?: string; max_tokens?: number; ids?: string[]; model?: string; semantic?: boolean;
        files?: Array<{ download_url: string; file_id: string; mime_type?: string; file_name?: string }>;
      };
      const err = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
      // Bounds here, not in the schema (every keyword there rides in each request).
      if ((paths?.length ?? 0) > 50) return err(`${paths!.length} paths; pass at most 50 (a folder counts as one).`);
      if ((ids?.length ?? 0) > 200) return err(`${ids!.length} ids; ask for at most 200.`);
      if (max_tokens !== undefined && max_tokens > 200_000) return err(`max_tokens ${max_tokens}; the most is 200000.`);
      if (paths?.length && !fileAccess) {
        return err("This server runs over HTTP and does not read files. Pass the document as `text`, or attach it (`files`).");
      }
      // Asynchronous extraction under one time budget: a slow or hostile PDF
      // must not block the server (stdio serves every chat in Claude Desktop).
      const { sources, skipped } = paths?.length ? await readSourcesAsync(paths) : { sources: [], skipped: [] as string[] };
      if (http && files?.length) {
        const got = await sourcesFromOpenAiFiles(files);
        sources.push(...got.sources);
        skipped.push(...got.skipped);
      }
      if (text) sources.push({ name: "text", text });
      if (sources.length === 0) {
        return err(
          skipped.length ? `Nothing readable: ${skipped.join("; ")}`
          : fileAccess ? "Pass `paths` (files or folders) or `text`."
          : "This server runs over HTTP and reads no files from its own disk: pass the user's upload as `files`, or the document as `text`."
        );
      }
      const result = await packContextSemantic(sources, { query, budget: max_tokens, ids, model, semantic: http ? undefined : semantic });
      const note = skipped.length ? `\nSkipped: ${skipped.slice(0, 10).join("; ")}${skipped.length > 10 ? ` (+${skipped.length - 10} more)` : ""}` : "";
      const full = renderPack(result) + note;
      if (result.mode !== "outline") return { content: [{ type: "text" as const, text: full }] };
      return shaped(extra?._meta, full, () => {
        const c = compactOutline(result, full);
        return { ...c, text: c.text + note };
      });
    }
  );

  // A prompt shows up in Claude Desktop's "+" menu, so a user can run a checkup
  // with one click instead of typing a request. It is the only proactive
  // surface MCP offers besides `instructions`.
  server.prompt(
    "context_checkup",
    "Profile this conversation's context and apply the top fix. One click, no typing.",
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Run profile_context on our conversation so far: pass a `sketch` (turn count, the model you are running as, and every block over ~500 tokens, repeated, or an image; one size hint each). " +
              "Report the total, the top three findings, and the estimated recoverable tokens in under 120 words. " +
              "Then, if the top finding is recoverable, apply it: summarize the offending content into the points still needed and tell me what you dropped. " +
              "Do not re-quote the content you are summarizing.",
          },
        },
      ],
    })
  );

  // The handoff: in a chat app nothing can trim the history, so the real cut
  // is a new chat that starts from a brief the model writes now (no API key:
  // the language work happens in the host model's own turn).
  server.registerPrompt(
    "handoff",
    {
      title: "Hand off to a new chat",
      description: "Write a short brief of this chat, save it, and continue in a new chat: the only way to cut a long chat's cost.",
      argsSchema: { focus: z.string().max(200).optional().describe("What the next chat should work on (optional)") },
    },
    async ({ focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Hand this chat off to a new one. Write a dense brief of at most ${HANDOFF_LIMITS.briefTargetTokens} tokens: the goal, decisions made (with the reason in a few words), the current state, open items and the next step, and key identifiers (names, paths, IDs, versions, numbers). ` +
              "Leave out what is finished or no longer needed. Separately, list only the blocks that must stay exact (code, config, commands, figures), each with a short label. " +
              "Then call save_handoff with the brief, those blocks as `verbatim`, a short title, the model you run as, and `chat_tokens` if you have a profile_context figure (else `turns`). " +
              "Do not write the brief into this reply before the call. After it, tell me in two lines how to continue, as its result says." +
              (focus?.trim() ? ` The next chat will work on: ${focus.trim()}` : ""),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "ask_file",
    {
      title: "Ask a big file",
      description: "Answer from a big file or folder without reading it whole: pack_context returns only the parts the question needs.",
      argsSchema: {
        path: z.string().max(1000).describe("Absolute path to the file or folder"),
        question: z.string().max(2000).describe("What you want to know from it"),
      },
    },
    async ({ path, question }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Answer from ${JSON.stringify(path)} without pasting or reading it whole: ${question}\n\n` +
              `Call pack_context with paths [${JSON.stringify(path)}] and the question as \`query\`. Answer from the chunks it returns and cite their ids. ` +
              "If they do not hold the answer, call it again with the ids it names as next best, or with no query for an outline to pick from; do not read the file whole. " +
              "If pack_context cannot read paths here, ask me to attach or paste the file, and pass it as `files` or `text`.",
          },
        },
      ],
    })
  );

  server.registerTool(
    "save_handoff",
    {
      description: `Save a handoff for continuing in a new chat (a chat's history cannot be cut; a new chat can). Write \`brief\` yourself (≤${HANDOFF_LIMITS.briefTargetTokens} tokens: goal, decisions, state, open items, identifiers); put what must stay exact in \`verbatim\`. Only when the user agrees.`,
      // Bounds (sizes, counts) are checked by validateHandoff, not spelled out
      // here: every schema keyword rides in each request's tool definitions.
      inputSchema: {
        brief: z.string(),
        verbatim: z.array(z.object({ label: z.string(), text: z.string() })).optional().describe("Code, config, figures"),
        title: z.string().optional(),
        chat_tokens: z.number().optional().describe("Chat size, from profile_context"),
        turns: z.number().optional(),
        model: z.string().optional(),
      },
      // Over HTTP without --store-handoffs it writes nothing and is read-only;
      // otherwise it writes a file under the home directory (never anything else).
      annotations: { title: "Save handoff", readOnlyHint: !storeHandoffs, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ brief, verbatim, title, chat_tokens, turns, model }) => {
      const input = { brief, verbatim, title, model, chatTokens: chat_tokens, turns };
      const problems = validateHandoff(input);
      if (problems.length) return { isError: true, content: [{ type: "text" as const, text: `Not saved: ${problems.join(" ")}` }] };
      let blocks = verbatim;
      if (storeHandoffs) {
        const n = verbatim?.length ?? 0;
        // The form shows the title and block labels: masked, like what is saved.
        const c = await askConsent(
          server,
          // Masked before it is cut: a secret split at the cut would escape the patterns.
          `Save a handoff of this chat on this computer (${tildify(handoffDir())}) to start a new chat from? "${maskSecrets(title ?? brief.split("\n")[0]).text.slice(0, 80)}"${n ? `, with ${n} verbatim block(s): ${maskSecrets(verbatim!.map((b) => b.label).join(", ")).text.slice(0, 200)}` : ""}.`,
          n ? { include_verbatim: { type: "boolean", title: "Include the verbatim blocks", default: true } } : {}
        );
        if (c.asked && !c.ok) {
          return { content: [{ type: "text" as const, text: `Not saved: ${c.why}. Do not retry; ask the user in the chat if they still want a handoff.` }] };
        }
        if (c.asked && c.content.include_verbatim === false) blocks = undefined;
      }
      let saved;
      try {
        saved = saveHandoff({ ...input, verbatim: blocks }, { store: storeHandoffs });
      } catch (e) {
        // Never an absolute path in a reply: ~ for the home directory, and over
        // HTTP not even that, since the caller may be anyone with the URL.
        const why = tildifyAll((e as Error).message);
        return { isError: true, content: [{ type: "text" as const, text: `Not saved: ${http ? "the server could not store the handoff" : why}.` }] };
      }
      const m = saved.meta;
      const parts = `brief ~${formatTokens(m.briefTokens)}${m.blocks.length ? `, ${m.blocks.length} verbatim block(s) ~${formatTokens(m.blocks.reduce((t, b) => t + b.tokens, 0))}` : ""}`;
      const lines = [
        saved.dir
          ? `Handoff saved: ${m.id} (~${formatTokens(m.tokens)} tokens: ${parts}) in ${tildify(saved.dir)}.`
          : `Handoff ready (~${formatTokens(m.tokens)} tokens: ${parts}), not stored: this server runs over HTTP and keeps nothing.`,
      ];
      if (m.masked > 0) lines.push(`Masked ${m.masked} secret-looking string(s) (${saved.maskedKinds.join(", ")}) before saving; the user re-adds them by hand in the new chat if needed.`);
      if (m.briefTokens > HANDOFF_LIMITS.briefTargetTokens) lines.push(`The brief is ~${m.briefTokens} tokens; the target is ≤${HANDOFF_LIMITS.briefTargetTokens}. It is saved; tighter is cheaper next time.`);
      lines.push(renderMath(saved.math));
      if (saved.dir) {
        lines.push(
          http
            ? "Now print the brief and the verbatim blocks in one fenced block, and tell the user to start a new chat with it as the first message (or, on the machine running this server, `context-doctor handoff latest --copy`). Then stop working in this chat."
            : "Now tell the user, in two lines: open a new chat and attach the resource handoff://latest (Claude Desktop: + menu, context-doctor), or paste the handoff; `context-doctor handoff latest --copy` copies it. " +
                "Where attaching is not possible (ChatGPT, the web, phones), print the brief and the verbatim blocks in one fenced block to paste. Then stop working in this chat."
        );
        // Resources exist only on the local server (see below); tell it the list grew.
        // The notification is async: a rejection (a client gone mid-call) must
        // not become an unhandled one, which would end the process.
        if (!http) server.server.sendResourceListChanged().catch(() => {});
      } else {
        lines.push("Now print the brief and the verbatim blocks in one fenced block, and tell the user to start a new chat with it as the first message. Then stop working in this chat.");
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // Saved handoffs as resources: Claude Desktop, Cursor, VS Code and Claude
  // Code (@) let the user attach one to a new chat. Local (stdio) server only:
  // over HTTP anyone holding the URL could read them.
  if (storeHandoffs && !http) {
    const NONE = "No handoff saved yet. In a long chat, pick the `handoff` prompt (+ menu) or ask for a handoff; the assistant saves it with save_handoff.";
    server.registerResource(
      "handoff-latest",
      "handoff://latest",
      { title: "Latest handoff", description: "The newest saved handoff: attach it to a new chat to continue there.", mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: readHandoff("latest")?.markdown ?? NONE }] })
    );
    server.registerResource(
      "handoff",
      new ResourceTemplate("handoff://{id}", {
        list: async () => ({
          resources: listHandoffs().slice(0, 20).map((m) => ({
            uri: `handoff://${m.id}`,
            name: m.id,
            title: m.title,
            description: `~${formatTokens(m.tokens)} tokens, saved ${m.created.slice(0, 16).replace("T", " ")} UTC`,
            mimeType: "text/markdown",
          })),
        }),
      }),
      { title: "Saved handoff", description: "A saved handoff, by id.", mimeType: "text/markdown" },
      async (uri, { id }) => {
        const h = readHandoff(String(Array.isArray(id) ? id[0] : id));
        if (!h) throw new McpError(ErrorCode.InvalidParams, `No saved handoff at ${uri.href}. List them with resources/list, or run \`context-doctor handoff list\`.`);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: h.markdown }] };
      }
    );
  }

  // Recall reads this session's transcript from disk: a local server only
  // (over HTTP anyone holding the URL could read it).
  if (fileAccess) {
    server.registerTool(
      "recall",
      {
        description: "Search this session's transcript on disk (compacted turns, cleared tool output) for `query`: best excerpts with time and position. Use before asking the user again.",
        inputSchema: { query: z.string(), max_tokens: z.number().optional() },
        annotations: { title: "Recall", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ query, max_tokens }) => {
        // The server's CLAUDE_CODE_SESSION_ID is the session it started with: stale after /clear.
        const session = currentTranscript(process.env, process.cwd(), undefined, { envMayBeStale: true });
        if (!session) {
          return { isError: true, content: [{ type: "text" as const, text: "No transcript of this session on disk (Claude Code and Codex keep one; chat apps do not)." }] };
        }
        // Bounds checked here, not in the schema: each schema keyword rides in every request.
        const budget = Math.min(20_000, Math.max(200, Math.floor(Number(max_tokens) || 2000)));
        const r = recall(session.path, query, { budget, how: session.how });
        return { content: [{ type: "text" as const, text: renderRecall(r) }] };
      }
    );
  }

  server.tool(
    "context_best_practices",
    "Checklist for keeping context lean and prompts cacheable, optionally per provider.",
    {
      provider: z.enum(["general", "anthropic", "openai"]).optional().describe("Default: general"),
    },
    // Pure: reads its input and returns text. Clients (Codex, ChatGPT) may skip approval for read-only tools.
    { title: "Context best practices", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ provider }) => {
      const tips = [...BEST_PRACTICES.general, ...(provider && provider !== "general" ? BEST_PRACTICES[provider] : [])];
      return { content: [{ type: "text", text: tips.map((t, i) => `${i + 1}. ${t}`).join("\n") }] };
    }
  );

  dropSchemaDialect(server);
  return server;
}

/**
 * Every tool's JSON schema came with `"$schema": "http://json-schema.org/draft-07/schema#"`
 * (the SDK's converter adds it): 52 characters a tool, in every request of
 * clients that load the definitions up front, telling the model nothing. The
 * SDK builds tools/list itself, so its handler is wrapped to leave it out.
 * Should the SDK's internals change, the list goes out as the SDK makes it
 * (the budget test then says so).
 */
function dropSchemaDialect(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> })._requestHandlers;
  const list = handlers?.get("tools/list");
  if (!handlers || !list) return;
  handlers.set("tools/list", async (req, extra) => {
    const r = (await list(req, extra)) as { tools?: Array<{ inputSchema?: Record<string, unknown> }> };
    for (const t of r?.tools ?? []) if (t.inputSchema) delete t.inputSchema.$schema;
    return r;
  });
}

const BEST_PRACTICES: Record<string, string[]> = {
  general: [
    "Put stable content first (system prompt, tool definitions, reference docs) and volatile content last — prompt caches match byte-identical prefixes only.",
    "Truncate or summarize tool results before they enter history; keep only what the model actually needs downstream.",
    "Never inline base64/binary data in text content — use file/image APIs.",
    "Summarize and drop conversation history past ~30-40 turns; models lose the middle of long contexts well before the hard limit.",
    "Deduplicate: if the same document/result appears twice, replace later copies with a reference.",
    "Measure before optimizing — profile the conversation to find the actual heavy hitters.",
  ],
  anthropic: [
    "Use prompt caching with cache_control breakpoints after your stable prefix: cached reads cost 2.5-10% of input depending on the model, and cache writes 1.25x input (5-minute cache) or 2x (1-hour cache).",
    "Current Claude generations have a 1M-token window (Haiku 200k), but quality degrades under heavy fill; aim to stay under ~70%.",
    "For agents: prefer compact tool-result summaries in history and re-fetch details on demand.",
  ],
  openai: [
    "Prefix caching is automatic for prompts >1024 tokens — but only on byte-identical prefixes, so keep the front of your prompt stable.",
    "Use max_completion_tokens headroom math: input + output must fit the window together.",
  ],
};

/**
 * Set a header on a Node request so every downstream reader sees it.
 *
 * `req.headers` is a parsed convenience copy; the MCP transport reconstructs a
 * Web Request from `req.rawHeaders`, so a header written to only one of them is
 * invisible to the other.
 */
function setHeader(req: import("node:http").IncomingMessage, name: string, value: string): void {
  req.headers[name] = value;
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === name) {
      raw[i + 1] = value;
      return;
    }
  }
  raw.push(name, value);
}

// -- Transport dispatch --------------------------------------------------------
// Default: stdio (Claude Desktop, Claude Code, Cursor spawn us as a child).
// --http [--port N] [--host H]: streamable-HTTP endpoint at /mcp for clients
// that connect to a URL instead of spawning a process — ChatGPT developer-mode
// connectors (which require a reachable URL), web MCP clients, remote setups.
const argv = process.argv.slice(2);
if (argv.includes("--http")) {
  const argAfter = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number(argAfter("--port")) > 0 ? Number(argAfter("--port")) : 8808;
  const host = argAfter("--host") ?? "127.0.0.1";
  // Handoffs stay on this machine only when its owner says so: a server on a
  // shared host or behind a public tunnel must not collect other people's chats.
  const storeHandoffs = argv.includes("--store-handoffs");
  // Host and Origin checks against DNS rebinding and cross-site requests (httpguard.ts).
  const guard = makeGuard(host, argAfter("--allowed-hosts"), argAfter("--allowed-origins"));
  const { createServer: createHttpServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  createHttpServer(async (req, res) => {
    try {
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, service: "context-doctor-mcp" }));
        return;
      }
      const path = (req.url ?? "").split("?")[0];
      if (path !== "/mcp" && path !== "/mcp/") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "MCP endpoint is /mcp" }));
        return;
      }
      const deny = (status: number, code: number, message: string) => {
        const send = () => {
          if (res.writableEnded) return;
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          if (status === 413 || status === 408) res.setHeader("connection", "close");
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
          // Stop reading an oversized or stalled upload, but only after the
          // client has had a moment to read the answer: destroying the socket at
          // once resets it, and the client never sees the 413.
          if (status === 413 || status === 408) setTimeout(() => req.destroy(), 1000).unref();
        };
        // A chunked upload found over the cap mid-stream: drain (discard) the
        // rest until the client stops sending, at most 5 s, then answer.
        // Answering and closing while it still sends leaves unread bytes on
        // the socket, the kernel answers them with a reset, and a client that
        // gets the reset before it reads the 413 never sees it (flaky under
        // the full test suite's load).
        if (status === 413 && req.headers["content-length"] === undefined && !req.complete) {
          req.resume();
          const timer = setTimeout(send, 5000);
          timer.unref();
          req.once("end", () => { clearTimeout(timer); send(); });
          req.once("error", () => { clearTimeout(timer); send(); });
          return;
        }
        send();
      };
      const refused = refusal(guard, req.headers);
      if (refused) return deny(403, -32000, `Forbidden: ${refused}.`);
      if (req.method !== "POST") {
        // Stateless mode: no standalone SSE stream, no sessions to delete.
        res.statusCode = 405;
        res.setHeader("allow", "POST");
        res.end(JSON.stringify({ error: "Stateless server: POST /mcp only" }));
        return;
      }
      // Read (capped) and parse the body here; the transport gets it parsed.
      const body = await readJsonBody(req);
      if (!("value" in body)) return deny(body.status, body.code, body.message);
      // The streamable-HTTP spec says a client MUST accept both
      // application/json and text/event-stream, and the SDK answers anything
      // else with a 406. Plenty of real callers send only application/json, or
      // `*/*`, or no Accept at all — and to them a 406 looks like the server
      // being broken. Our replies are single JSON-RPC responses with nothing to
      // stream, so those clients get a plain JSON body instead of a refusal.
      const accept = String(req.headers.accept ?? "");
      const askedForSse = accept.includes("text/event-stream");
      if (!askedForSse || !accept.includes("application/json")) {
        // The transport rebuilds the request from rawHeaders (via Hono), so
        // setting req.headers alone changes nothing it will ever look at.
        setHeader(req, "accept", "application/json, text/event-stream");
      }

      // Fresh server + transport per request (stateless — nothing shared).
      const server = createServer({ http: true, storeHandoffs });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // A client that never asked for a stream gets plain JSON back.
        enableJsonResponse: !askedForSse,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body.value);
    } catch (e) {
      if (!res.headersSent) res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  }).listen(port, host, () => {
    console.error(`context-doctor MCP (streamable HTTP) on http://${host}:${port}/mcp`);
    console.error(`ChatGPT developer-mode connectors need a URL their servers can reach — expose this via your host or a tunnel.`);
    console.error(
      guard.hosts === "*"
        ? "Host check off (--allowed-hosts '*')."
        : `Answering Host: ${[...guard.hosts].join(", ")}. Behind a tunnel, add its host name: --allowed-hosts <name>.`
    );
  });
} else {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
