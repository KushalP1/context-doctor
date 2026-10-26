# Before it enters the context: pack and overhead

[← README](../README.md)

Autopilot, the hooks and compaction slim context that is already there. Two commands stop it getting in.

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

**`overhead`: what every request re-reads before your message.** The system prompt, tool and MCP schemas, skills and your memory files ride on every request: cached, so each read is cheap, but read on every request of every session and written again at full price after each cold start. Transcripts never show them. `overhead` measures the fixed part from the first request of each recent Claude Code session (the API's own count, minus your first message), lists every memory file each agent loads in the current directory (Claude Code's CLAUDE.md with its `@imports`, rules and auto memory; Codex's AGENTS.md; Cursor's always-applied rules; GEMINI.md), and prices each per month from your own request and cold-start counts.

```
Claude Code, last 30 days: 80 sessions start at a median ~57k tokens (p90 ~67k) before the first message.
Memory files loaded here are ~3.6k of that; the rest is Claude Code's system prompt, tools, skills and MCP schemas.
At your usage (12,023 requests, 238 cold starts, claude-opus-5-5 list prices) every 1k tokens of it costs ~$5.89 a month;
the whole overhead ~$335.94 a month.
```

Findings point at files over 2k tokens, paragraphs loaded twice from two files, and long code blocks that could live in a file the agent opens when it needs them.

To act on a finding, `context-doctor overhead split <file>` plans the fix: sections over ~400 tokens (or mostly code) move word for word to `<name>.reference.md`, each run of them leaving one pointer the agent follows when a task needs it. Lists of links are indexes and stay, and an auto-memory `MEMORY.md` keeps only its index, as Claude Code intends. Nothing is written until you add `--write`, which backs up the original first. On a copy of the author's auto-memory index: ~3.4k to ~1.7k tokens on every request, about $10 a month at the ~$5.89 per 1k tokens measured above, nothing lost.

`context-doctor overhead prune [--days 30]` does the same for MCP servers and skills: per project (the `cwd` its Claude Code sessions record, subagents included), the servers configured in `~/.claude.json` or the project's `.mcp.json` and the personal and project skills that no session of it used in the period (an MCP call is `mcp__<server>__<tool>`; a skill is the `Skill` tool or a typed `/<name>`), once the project has 3 or more sessions. `--write`, run in the project's folder, switches them off for that project only, in its own `.claude/settings.local.json`: `.mcp.json` servers through `disabledMcpjsonServers`, servers from `~/.claude.json` through `deniedMcpServers` (they show as blocked in `/mcp`), skills through `skillOverrides: "off"` (Claude Code 2.1.129+). The file's original is kept as `.context-doctor.backup`, a choice already made there stands (a skill set to `"on"` stays on), and every entry added is recorded, so `--undo` takes out exactly those. Never proposed: the app's own servers and claude.ai connectors (no config file here lists them), plugin servers and skills, and context-doctor's own server, whose standing rules work without a call. On the author's machine (30 days, 6 projects, 3,799 MCP calls to 16 servers) there was nothing to prune: every server called was app-provided (the Chrome extension 2,418 calls, the desktop browser 977, connectors), and the only configured server and personal skill are context-doctor's own.

MCP servers are part of the same overhead: each one's tool definitions ride on every request. `overhead` counts calls per server from your transcripts, including servers the app or its connectors provide, and `overhead --mcp` launches each configured server once to size its definitions, flagging the ones you never call with what they cost a month. When Claude Code's tool search is on (the report says how often it was used), definitions are deferred and an idle server costs about its tool names instead.
