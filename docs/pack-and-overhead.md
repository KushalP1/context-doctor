# Before it enters the context: pack and overhead

[← README](../README.md)

Autopilot, the hooks and compaction slim context that is already there. `pack` and `overhead` stop it getting in, and `recall` gets back one detail of what was cleared instead of all of it.

**`pack`: only the parts of a document a question needs.** A 60k-token manual pasted to answer one question is paid on that message and re-read on every message after it. `pack` splits files and folders along their own structure (markdown headings, top-level code declarations, paragraphs; one-line logs and minified files are cut too), ranks the chunks against your question with BM25, and returns the best ones that fit a budget. Every chunk carries an id and its line range, and the result names the next-best ids, so asking for more is one call. Without a question you get an outline to pick from.

```bash
context-doctor pack docs/ README.md --query "how do I rotate the signing key" --max-tokens 3000
context-doctor pack big-manual.md                     # outline: id, lines, tokens, heading per chunk
context-doctor pack big-manual.md --ids big-manual.md#12,big-manual.md#13
cat server.log | context-doctor pack - -q "timeout upstream"
```

```
$ context-doctor pack README.md src -q "how is the ledger kept from growing" --max-tokens 2000
PACKED ~1.9k of ~315k tokens (1%) from 80 files: 7 of 1026 chunks for "how is the ledger kept from growing", budget 2.0k.

── src/ledger.ts#6 · L108-128 · export function recordLedger(entry: Omit<LedgerEntry, "ts">): void { · ~404
...
── src/test/ledger.test.ts#1 · L1-22 · The ledger is capped, and everything it feeds is a LIFETIME total. · ~409
...
Not included: 1019 chunk(s). Next best: src/watch.ts#1 (...); src/test/compactwindow.test.ts#4 (...)
```

In Claude Desktop, Claude Code, Cursor and Codex the same thing is the `pack_context` MCP tool, and the standing instructions tell the model to use it when it needs to answer from a large file it is not editing. Ranking is lexical, offline and keyless; it misses pure paraphrase, which is what the outline is for. If you run [Ollama](https://ollama.com) with an embedding model (`ollama pull nomic-embed-text`), `--semantic` (or `semantic: true` on the MCP tool) also ranks by meaning and merges the two rankings; chunk vectors are cached, so repeat packs are fast. Without one it says so and stays lexical. Measured on this repository (README plus source, ~305k tokens): 9 of 10 factual questions were answered from a 2k-token pack. PDFs, Word (`.docx`, `.doc`, `.rtf`), PowerPoint and ODT files are read with tools the OS already has (`pdftotext` where installed, PDFKit and `textutil` on macOS, `unzip` elsewhere); when none is available, pack says what to install. Over HTTP (the ChatGPT connector mode) the tool reads no files, only text you pass.

**`recall`: what this session already saw, without re-reading it.** Autopilot clears old tool output and a compaction summarises old turns; when the model needs one detail back, re-running the command or re-reading the file puts the whole thing in again. `recall` searches the session's own transcript on disk instead (Claude Code, or Codex's newest rollout started in that folder; compacted turns and cleared output included) and returns only the best excerpts with their time and position, within `--max-tokens` (default 2,000), secret-looking strings masked. It is also the `recall` MCP tool on the local server, and autopilot's notes for Claude Code point to it. It reads the current session (`CLAUDE_CODE_SESSION_ID`, else the newest transcript of this folder), never another project's unless you name one with `--session <id|path>`. Transcripts are streamed: 300 MB in 1.1 s on the author's machine.

```bash
context-doctor recall "which port did the test server use"
```

**`overhead`: what every request re-reads before your message.** The system prompt, tool and MCP schemas, skills and your memory files ride on every request: cached, so each read is cheap, but read on every request of every session and written again at full price after each cold start. Transcripts never show them. `overhead` measures the fixed part from the first request of each recent Claude Code session (the API's own count, minus your first message), lists every memory file each agent loads in the current directory (Claude Code's CLAUDE.md with its `@imports`, rules and auto memory; Codex's AGENTS.md; Cursor's always-applied rules; GEMINI.md), and prices each per month from your own request and cold-start counts.

```
Claude Code, last 30 days: 55 of 61 sessions (any length; the rest had no first request to measure) start at a median ~71k tokens (p90 ~75k) before the first message.
Memory files loaded here are ~0 of that; the rest is Claude Code's system prompt, tools, skills and MCP schemas.
At your usage (8,898 requests, 265 cold starts, claude-opus-5-5 list prices) every 1k tokens added to it costs ~$4.36 a month (what the memory files below are priced at).
The whole of it, every session and subagent start as billed: $443.29 over the last 30 days (subagents $241.60), itemised below.
```

Two figures, two questions. The rate per 1k tokens is what one more token at the start costs: every request of your main conversations reads it, and each cold start (over an hour idle) writes it again; the memory files are priced with it. The whole is one total, the same as the starts section's "Every start, re-read at each step": each session's and subagent's own start, at the rates each request paid. The median start times the rate is not shown beside it (it leaves out subagents and sessions begun before the period, and it read as a second, different total); with no start measured it is shown alone, said to be an estimate.

Findings point at files over 2k tokens, paragraphs loaded twice from two files, and long code blocks that could live in a file the agent opens when it needs them.

**The start of every session and every subagent.** The same first-request measurement, per Claude Code entrypoint (the transcript's `entrypoint`: the Desktop app, the terminal, `claude -p` and the SDK) and per subagent type (the subagent's `.meta.json`, else its first request's query source), each start priced on every step of the period that re-read it: the start's tokens on each request at the rates that request paid for them, read from the cache on a warm step, written again on a cold one (the 5-minute or 1-hour mix it recorded). A subagent's brief is not part of its start. Claude Code 2.1.308 and later record each request's shape in the transcript (`api-request-shape`: the system prompt and every tool definition, `defer_loading` on the ones behind tool search, and `deferred_tools_delta` naming the ones announced as deferred), so the report names the part that could be deferred: MCP tool definitions sent whole, per server, sized from their length (an estimate; the start itself is the API's count). When both are in the period, it prices the Desktop app's start above a terminal-sized one ([#105328](https://github.com/anthropics/claude-code/issues/105328): ~79k against ~13k).

```
Session and subagent starts (the first request, before the first message)
  Desktop app sessions             38  median   ~71k (p10 ~67k, p90 ~74k)  6,911 steps re-read it: $178.87
                                       tools sent whole ~43k (49 tools), of which MCP ~15k: $37.05 of the $178.87
  general-purpose (subagent)      166  median   ~51k (p10 ~49k, p90 ~56k)  15,372 steps re-read it: $265.91
                                       tools sent whole ~34k (40 tools), of which MCP ~15k: $55.24 of the $265.91
  …
  MCP tool definitions sent whole (not deferred behind tool search):
    Claude_Browser                19 tools  ~7.9k    $50.86  provided by the app or a connector
    ccd_session                    5 tools  ~5.0k    $17.73  provided by the app or a connector
```

**What reaches it.** Tool search is on by default, and MCP tools are deferred behind it, except the ones loaded upfront: a server configured with `"alwaysLoad": true`, a tool its server marks `_meta["anthropic/alwaysLoad"]`, and the Desktop app's own servers and connectors, which the app hands to Claude Code in-process with their tools loaded upfront ([MCP docs](https://code.claude.com/docs/en/mcp): "no MCP setting or `managed-mcp.json` reaches them"). For a server in your own `~/.claude.json`, `"alwaysLoad": false` defers all its tools, author-marked ones too (Claude Code 2.1.287+): `fix --apply mcp-defer` sets it ([fix](fix.md#mcp-servers-sent-whole-mcp-defer)). For the app's servers there is no setting: `ENABLE_TOOL_SEARCH` changes nothing for them (on the author's 2.1.325 binary, a tool marked to load upfront is never deferred, whatever its value; only a mod's `tool.describe` hook, which can answer `isDeferred`, is consulted before that mark). context-doctor's mod uses that hook for the app's own four (`Claude_Browser`, `ccd_session`, `visualize`, `terminal`) once you apply `fix --apply desktop-tools-defer` (Claude Code 2.1.326+, new sessions only; [fix](fix.md#the-desktop-apps-own-tools-desktop-tools-defer)), and the starts section then names the lever; `fix` and `doctor` say whether the hook reaches them here, from the servers the mod saw in your newest Desktop session ([Desktop](desktop.md#the-desktop-apps-own-tools-behind-tool-search)). A subagent definition's `tools:` list or `disallowedTools: mcp__*` keeps them out of that agent's start, and out of its reach; a user or project agent named like a built-in one replaces it, prompt included. On the author's machine (30 days to 2026-11-15, read-only) the app's six servers sent whole cost $94.85 of $455 in starts, and general-purpose subagents called the browser server in 15 of 257, so dropping MCP tools from them is not free.

To act on a finding, `context-doctor overhead split <file>` plans the fix: sections over ~400 tokens (or mostly code) move word for word to `<name>.reference.md`, each run of them leaving one pointer the agent follows when a task needs it. Lists of links are indexes and stay, and an auto-memory `MEMORY.md` keeps only its index, as Claude Code intends. Nothing is written until you add `--write`, which backs up the original first. On a copy of the author's auto-memory index: ~3.4k to ~1.7k tokens on every request, about $10 a month at the ~$5.89 per 1k tokens measured above, nothing lost.

`context-doctor overhead prune [--days 30]` does the same for MCP servers and skills: per project (the `cwd` its Claude Code sessions record, subagents included), the servers configured in `~/.claude.json` or the project's `.mcp.json` and the personal and project skills that no session of it used in the period (an MCP call is `mcp__<server>__<tool>`; a skill is the `Skill` tool or a typed `/<name>`), once the project has 3 or more sessions. `--write`, run in the project's folder, switches them off for that project only, in its own `.claude/settings.local.json`: `.mcp.json` servers through `disabledMcpjsonServers`, servers from `~/.claude.json` through `deniedMcpServers` (they show as blocked in `/mcp`), skills through `skillOverrides: "off"` (Claude Code 2.1.129+). The file's original is kept as `.context-doctor.backup`, a choice already made there stands (a skill set to `"on"` stays on), and every entry added is recorded, so `--undo` takes out exactly those. Never proposed: the app's own servers and claude.ai connectors (no config file here lists them), plugin servers and skills, and context-doctor's own server, whose standing rules work without a call. On the author's machine (30 days, 6 projects, 3,799 MCP calls to 16 servers) there was nothing to prune: every server called was app-provided (the Chrome extension 2,418 calls, the desktop browser 977, connectors), and the only configured server and personal skill are context-doctor's own.

MCP servers are part of the same overhead: each one's tool definitions ride on every request. `overhead` counts calls per server from your transcripts, including servers the app or its connectors provide, and `overhead --mcp` launches each configured server once to size its definitions (a server in the folder's `.mcp.json` only once you approved it in Claude Code: the file comes with the repository, and so can `.claude/settings.json`, whose approvals count, as in Claude Code, only in a folder you trusted, and not at all while `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` is set), flagging the ones you never call with what they cost a month. When Claude Code's tool search is on (the report says how often it was used), definitions are deferred and an idle server costs about its tool names instead. It also lists each server's tools twice in a row and flags one whose list changes, in order or in what reaches the model (a name, a description, an input schema; a timestamp or counter in a description, say; `_meta`, annotations and output schemas do not count): a client that lists again then sends different tool definitions, and everything cached after them is written again, which Claude Code reports as the miss cause `tools_changed` ([cache-misses](./profiling.md)). The 2026-07-28 MCP spec asks servers for a deterministic `tools/list` order for this reason; context-doctor's own list is byte-identical across listings and launches, pinned by a test.
