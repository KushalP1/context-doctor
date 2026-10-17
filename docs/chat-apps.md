# Chat apps and agents: what runs by itself, and what only nudges

[← README](../README.md)

context-doctor ships an MCP server, so the AI itself can profile and slim context on demand. The honest question is **on which surfaces it acts by itself, and on which it only nudges**. MCP gives a server no way to see the conversation or intercept a turn; only a hook or a place in the data path can do that. The README's [platform table](../README.md#where-it-works) is the summary; this page has the detail behind each row.

## Which surfaces act by itself

**Claude Code: yes.** The hook runs on every prompt and the status line on every refresh. Past ~80k tokens the model receives hygiene guidance naming the largest waste, and compaction is offered. Measured: 115 automatic checks, 48 warnings, across 32 sessions on one machine.

**Cursor: yes, since 0.26.** `install` adds a native `postToolUse` hook to `~/.cursor/hooks.json`; Cursor passes it the agent transcript, and its `additional_context` reaches the model. In a heavy chat the agent gets hygiene guidance and the largest recoverable waste, once per 40% of growth. Cursor's transcript records tool calls but not their output, and keeps turns Cursor has since summarized, so the note gives the chat's accumulated size, with no window share or price. Corrected in 0.26: Cursor also runs Claude Code's hook, but as `beforeSubmitPrompt`, whose output can only allow or block the prompt, so from 0.15 to 0.25 the guidance never reached Cursor's model.

**Codex (ChatGPT.app's Codex tab, the Codex IDE extension, the `codex` CLI): yes, since 0.16.** `install` writes the hook to `~/.codex/hooks.json`, the MCP server to `~/.codex/config.toml`, and the skill to `~/.codex/skills/`. Codex uses Claude Code's hook contract almost verbatim and passes its own rollout transcript, which carries the API's real usage figures, so the guidance comes from measured tokens. One extra step, Codex's rule not ours: a new hook runs only after you trust it once (type `/hooks` in Codex). The MCP tools are marked read-only, so Codex runs them without an approval prompt, `codex exec` included. `session` and `session --list` read Codex rollouts too.

**API traffic through the proxy: yes.** Every request passes through it with no model involved; with `--autopilot`, stale tool output is cleared whenever the cache is cold ([the proxy](./proxy.md)).

**Claude Desktop: a nudge.** It gets the standing rules in every chat (we confirmed in the app bundle that Desktop's `LocalMcpServerManager` reads them), a one-click `context_checkup` prompt, and since 0.17 a `profile_context` the model can actually afford to call from chat. Until 0.17 the tool wanted the whole conversation as its argument, so calling it from chat meant re-typing 50k tokens; nobody did, and Desktop's log showed zero calls in a month. Now the model passes a ~120-token **sketch** (turn count, the large or repeated blocks) and gets a sized estimate, findings and the fix to apply. Still a nudge, not a hook: Desktop chat has no hook API and no transcript on disk.

**The ChatGPT chat UI: no.** No MCP, no hooks, no data path in the chat product itself. Use Codex, or a developer-mode connector at a URL you host (below).

So "every chat inherently better" is true for Claude Code, Cursor, Codex and the proxy; for Claude Desktop it is "the rules ride in every chat and the checkup is one cheap tool call away"; and not a claim we make for the ChatGPT chat UI.

## Claude Desktop, step by step

1. Run `context-doctor install` and restart Claude Desktop, or open the `.mcpb` from the [latest release](https://github.com/KushalP1/context-doctor/releases/latest) (Settings > Extensions): same server, no npm, it runs on Desktop's own Node.
2. From then on, **every conversation carries the [five standing rules](../README.md#where-it-works)**. The MCP server hands them to Desktop on connect and Desktop puts them in front of Claude: summarize big pastes instead of re-quoting them, refer to earlier content by name, never inline base64, call `profile_context` once at ~30 turns and before answering any question about tokens, cost, speed or limits, and use `pack_context` for big local files.
3. That call is cheap on purpose. Claude cannot export a Desktop chat, so it passes a **sketch**: how many turns, which blocks are large, repeated, stale or images, with one size hint each (~120 tokens). The server sizes it (usually within ±20%, measured; see [token counts](./tokenizer.md)), prices the per-turn re-read (on a subscription that is what spends your usage limit), and returns ranked findings with the action for each: "summarize *the nginx config* into the points still needed", "refer to *test output* by name", "offer a 300-token handoff summary for a fresh chat". The reply ends with an instruction to apply the top one, not just suggest it.
4. One click instead of asking: the `context_checkup` prompt in the **+** menu sends that request for you.
5. Say *"optimize it"* on an exported conversation and Claude applies the safe fixes; if you agree to pruning old history, **Claude itself writes the replacement summary** (that's the no-API-key summarization).

What this does not do: read the chat behind Claude's back or trim it for you. Desktop chat has no hook API and no transcript on disk (checked in the app bundle, v2.2553). The model does the trimming, when the rules and the checkup tell it to.

## ChatGPT

ChatGPT's MCP support differs fundamentally from Claude Desktop's: **it never launches a local process**. Its custom connectors (developer mode) have OpenAI's servers connect to a **URL**, so the MCP server must be reachable from the internet.

1. **Normal ChatGPT (no developer mode): no MCP at all.** context-doctor still helps via the CLI: export the conversation and run `npx context-doctor analyze chat.json --model gpt-5` / `optimize` (or `session conversations.json` on a full data export). The standing rules go in your preferences (next section).
2. **ChatGPT developer mode**: run the HTTP transport somewhere reachable — `context-doctor-mcp --http --port 8808` on a small host (bind `--host 0.0.0.0` there), or expose your machine temporarily with a tunnel (`ngrok http 8808`). Then Settings → Connectors → Advanced → Developer mode → add a connector with the URL `https://<your-host>/mcp`.
3. Once connected, GPT gets the same four tools, each marked read-only (they only read their input and return text; over HTTP `pack_context` reads no files, only `text` you pass), with the same trigger guidance: ask *"what's eating my context?"* → it calls `profile_context`; *"optimize it"* works the same, including GPT writing the pruning summary itself.

Security note for step 2: the HTTP endpoint is unauthenticated — put it behind your tunnel's auth or a reverse proxy if it stays up long-term.

## claude.ai on the web and the phone apps

Where there is no hook and no MCP at all (claude.ai on the web, the Claude and ChatGPT phone apps, plain ChatGPT), the app's per-account preferences are read on every turn, which is the closest those surfaces have to a hook. `context-doctor instructions --copy` puts the ~185-token rules on your clipboard and tells you where to paste them: claude.ai Settings > General > personal preferences (applies everywhere you are signed in, phone included); ChatGPT Settings > Personalization > Custom instructions, "What traits should ChatGPT have?". On claude.ai you can instead upload `skills/context-doctor/SKILL.md` under Settings → Capabilities → Skills. Either way web and mobile conversations gain the same standing habits: summarize, don't re-quote, offer a handoff once a chat is heavy.

## MCP tools

| Tool | What it does |
|---|---|
| `profile_context` | Token breakdown by category, largest messages, findings with estimated savings. Takes either `conversation` (full JSON or text) or `sketch` (turns + large/repeated blocks, for chat apps) |
| `optimize_context` | Rewrites the conversation: dedupe, trim stale tool results, strip base64, optional history pruning. A result over 100k characters is not echoed back; you get the summary and the CLI command instead |
| `pack_context` | Only the chunks of large local files or folders (absolute paths, or passed `text`) that a question needs, within `max_tokens`; outline without a query; `ids` to fetch more. Reads no files over HTTP |
| `context_best_practices` | Curated checklist, optionally specialized for Anthropic / OpenAI |

Plus one prompt, `context_checkup`, in clients that show prompts (Claude Desktop's **+** menu).
