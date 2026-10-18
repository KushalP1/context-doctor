# context-doctor 🩺

[![CI](https://github.com/KushalP1/context-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/KushalP1/context-doctor/actions) [![npm](https://img.shields.io/npm/v/context-doctor)](https://www.npmjs.com/package/context-doctor) [![npm downloads](https://img.shields.io/npm/dm/context-doctor)](https://www.npmjs.com/package/context-doctor) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.KushalP1%2Fcontext--doctor-blue)](https://registry.modelcontextprotocol.io) [![AgentHub 已收录：context-doctor](https://myagenthub.cn/badge/io.github.KushalP1/context-doctor)](https://myagenthub.cn/p/io.github.KushalP1/context-doctor) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE) ![macOS | Linux | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

**See where your AI agent's tokens go, and stop paying for the ones that do nothing.**

AI agents re-send their whole context on every message: old tool output, pasted files, long instructions. A 500k-token session pays for all of it again each time, and at full price after a coffee break, when the prompt cache has expired. context-doctor measures that waste on your own sessions, in dollars, and removes it at the moments it pays: before it enters the context, while it sits there, and on every request. It runs on your machine, needs no API key, sends no telemetry, and works with **Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI**, any app on the **Anthropic, OpenAI or Gemini API**, and **CI**. MIT licensed, Node 20+, macOS, Linux and Windows.

```bash
npx context-doctor savings     # what your recent sessions cost, and what each fix would have saved
```

<img src="https://raw.githubusercontent.com/KushalP1/context-doctor/main/assets/savings.svg" alt="npx context-doctor savings: input billed, what /compact at cold resumes, autopilot and an earlier auto-compact window would have saved" width="640">

> **Which context-doctor is this?** Several projects share the name. This one is [`context-doctor` on npm](https://www.npmjs.com/package/context-doctor) and `io.github.KushalP1/context-doctor` in the [official MCP Registry](https://registry.modelcontextprotocol.io). Built and maintained by [gAI Ventures](https://gai.ventures).

## Quick start

Pick where you work. Each takes about a minute and is fully reversible.

| You use | Do this |
|---|---|
| **Claude Code** (terminal, IDE, desktop app) | Inside Claude Code: `/plugin marketplace add KushalP1/context-doctor`, then `/plugin install context-doctor@context-doctor`. You get the every-prompt check, the compaction hook, the MCP tools and `/context-doctor:savings`, `:checkup`, `:overhead`, `:pack`, `:autopilot`, `:compact-window` |
| **Everything on this machine at once** | `npm install -g context-doctor && context-doctor install` wires Claude Code, Claude Desktop, Cursor, Codex and Gemini CLI: MCP server, skill and hooks ([what it writes](./docs/install.md)). `context-doctor doctor` checks it; `context-doctor uninstall` removes it. Then, for Claude Code in a terminal or IDE, `context-doctor autopilot on` |
| **Claude Desktop, Cursor or any MCP client** | Add the server to the client's MCP config (or install the one-click `.mcpb` from the [latest release](https://github.com/KushalP1/context-doctor/releases/latest) in Claude Desktop):<br>`{"mcpServers": {"context-doctor": {"command": "npx", "args": ["-y", "context-doctor", "mcp"]}}}` |
| **claude.ai, ChatGPT, phone apps** | `npx context-doctor instructions --copy`, then paste into the app's personal preferences (it tells you where). ChatGPT can also reach the MCP server at a URL ([how](./docs/chat-apps.md#chatgpt)) |
| **Your own app on an LLM API** | Run `npx context-doctor proxy --autopilot` and point `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` (add `/v1`) or `GOOGLE_GEMINI_BASE_URL` at `http://localhost:8787`. No proxy possible? Wrap the SDK client: `withContextDoctor(new Anthropic())` ([library](./docs/library.md)) |
| **Python / RAG pipelines** | `pip install "git+https://github.com/KushalP1/context-doctor#subdirectory=python"` (PyPI release coming), then `pack_documents(retrieved_docs, question, budget=4000)` trims LangChain or LlamaIndex results to the chunks that matter. [Python README](./python/README.md) |
| **GitHub pull requests** | `uses: KushalP1/context-doctor@v0.32.0` comments how much a PR grows CLAUDE.md, AGENTS.md and rules, and can fail over a budget ([setup](./docs/ci.md)) |

## What it does

**Measure, in dollars, on your own history** ([profiling](./docs/profiling.md))
- `savings`: what your recent Claude Code sessions cost and what each fix below would have saved, replayed request by request against what you were billed.
- `overhead`: what every request re-reads before your message (system prompt, tools, MCP servers, CLAUDE.md, rules, memory), each file priced per month.
- `tasks`, `reads`, `subagents`, `compactions`: cost per commit; files read into session after session; whether each subagent was cheaper than the same steps in the parent; whether sessions work worse after compacting.
- `cache-plan <request.json>`: where an Anthropic API request should carry `cache_control`, and what it saves over N calls.
- `session`, `watch`, `analyze`, `report`, `dashboard`: token breakdown and wasted-context findings for any session, conversation file or agent trace.

**Keep waste out of the context** ([pack and overhead](./docs/pack-and-overhead.md))
- `pack` (and the `pack_context` MCP tool): only the chunks of a big document, PDF, log or codebase that a question needs, within a token budget, instead of the whole thing.
- `overhead split`: turns a heavy CLAUDE.md or memory file into a lean one plus a reference file the agent opens when needed, word for word, nothing lost.
- `ci` and the GitHub Action: review memory-file growth like any other cost.

**Remove waste automatically**
- A compaction hook (`PreCompact`) tells each Claude Code compaction what the session cannot lose (files changed, open tasks, your instructions, failing tests), so compacting saves tokens without losing the thread.
- An every-prompt hook (Claude Code, Codex, Gemini CLI; Cursor after each tool call) tells the model its real context size and the largest waste, and offers `/compact` when you return to a big session after the cache expired.
- `compact-window`: sets Claude Code's own auto-compact window, measured on your history first. Works in the desktop app too.
- [Autopilot](./docs/autopilot.md): a local proxy (or SDK wrapper) that clears stale tool output only when the prompt cache is cold, so a request never costs more.

## What it saves

Measured, not modelled, on every Claude Code session on the author's machine (mostly Opus 5 and Fable 5 with the 1M window), priced the way the prompt cache bills it (cached reads at each model's read rate, 2.5-10% of input; writes 1.25x input for the 5-minute cache, 2x for the hour) at API list prices. Re-measured on 2026-10-13 with each request at its own model and current prices (Opus 5.5 is $4 per million input tokens with $0.20 reads). `context-doctor savings` runs the same measurement on yours.

**1. Compacting when you come back** (every Claude Code surface, desktop app included). 133 days, 479 returns to a session over 150k tokens after its prompt cache expired (65 idle minutes on the 1-hour cache, 10 on the 5-minute one that Claude Code 2.1.295 often writes); median context at the return, 522k tokens.

| | |
|---|---|
| Net saving had you run `/compact` after the first reply | **$2,993 (about $675 a month)** |
| Returns where it paid off | 342 of 479 |
| Worst single case | −$1.79 (a session left a few messages later) |

Each return counts only the messages up to the next return, and the compaction request is charged as a cost. Not counted: files the model may re-read after compacting, and what the summary leaves out. That is why this is advice with the numbers attached, not something done for you.

**2. Autopilot** (Claude Code in a terminal or IDE, API apps). 133 days, 67 sessions, replayed through the shipped autopilot code with real timestamps:

| | Without autopilot | With autopilot | Saved |
|---|---|---|---|
| Input cost at API list price | $11,347 | $9,905 | **$1,442 (12.7%, about $325 a month)** |
| Sessions made more expensive | | | **0 of 67** |

30 of 67 sessions save something, the best 34.9%: long sessions that go idle are where the money is. These sessions ran in the desktop app, which autopilot cannot reach, so for the author this is what the same sessions would have saved in a terminal; `context-doctor savings` separates the two for you. [How it works →](./docs/autopilot.md)

**3. Compacting earlier** <a id="3-compacting-earlier-automatic"></a>(automatic, every Claude Code surface, desktop app included). The offer in 1 is advice, and on the author's machine it was followed 1 time in 33. Claude Code has a native setting that needs nobody to follow anything: `autoCompactWindow` in `~/.claude/settings.json` makes it compact as if the window were that size. `context-doctor compact-window` replays each session request by request at several sizes, priced as the cache bills (each simulated compaction pays its own request and a 20k-token summary at the output rate), and changes nothing until you pick one:

| Window | Input cost, last 30 days | Saved | Compactions a week |
|---|---|---|---|
| as now (~970k) | $3,648 | | 4.7 |
| 600k | $2,242 | $1,405 (39%) | 6.5 |
| **400k** | **$1,814** | **$1,833 (50%)** | **14.2** |
| 300k | $1,664 | $1,983 (54%) | 25.2 |
| 200k | $1,501 | $2,146 (59%) | 48.1 |

41 sessions. The cost is real: each compaction replaces the session's history with a summary, so a smaller window trades detail for money. That is why the command shows the table first and sets a window only when you name one (`context-doctor compact-window 400k`; `off` undoes it, and a backup of settings.json is kept).

**Also measured:**
- **pack:** 9 of 10 questions about this repository answered from **0.6% of its tokens**. [How →](./docs/pack-and-overhead.md)
- **Counting Claude correctly:** current Claude models pack 2.75 characters per token on prose (2.4 on code), not the 4 most tools assume: Claude counts about 40% more tokens than the usual 4-characters rule (~45% on prose, ~33% on code). `context-doctor accuracy` re-checks the ratio on your own sessions. [Why →](./docs/tokenizer.md)

On a Claude subscription you do not pay list price; the same tokens come out of your usage limit instead. Anthropic does not publish how limits weight cached tokens, so read the dollars as the size of the effect, not as your bill.

## Where it works

| Where you work | Automatic, every request | What you get on top |
|---|---|---|
| **Claude Code** in the terminal, VS Code or JetBrains | **Autopilot** clears stale tool output (cold cache only, never more expensive). **Hook** on every prompt: real context size, largest waste, and a `/compact` offer when you return to a large session after the cache expired. **Compaction hook** on every compaction. **`compact-window`**, if you set one | Install via npm or as a **plugin**. Status bar context meter, `/context-doctor:savings`, `session`, `watch`, `report`, dashboard, MCP tools |
| **Claude Code** in the desktop app's Code tab | **Hooks**, as above, the cold-resume `/compact` offer shown to you as well as the model. **`compact-window`**, if you set one: Claude Code compacts earlier by itself. Not autopilot: the app sets its own API address and ignores the one in settings | Same as above |
| **Cursor** (agent) | A native **after-tool-call hook** (`~/.cursor/hooks.json`): in a heavy chat the agent gets the same hygiene guidance and the largest waste, once per 40% of growth. (Cursor's prompt hook can only allow or block a prompt, so this is the event where guidance reaches the model) | MCP tools, editor status bar extension, `cursor` profiler. With your own OpenAI key, autopilot too via a tokened tunnel ([how](./docs/proxy.md#putting-the-proxy-on-a-public-url-cursor-with-your-own-openai-key-remote-apps)) |
| **Codex** (ChatGPT app's Codex tab, IDE extension, CLI) | Every-prompt hook with the API's own token counts | MCP tools, skill, `session` reads Codex rollouts. On an API key, autopilot too (`OPENAI_BASE_URL`) |
| **Gemini CLI** | Every-prompt hook (`BeforeAgent`) with the API's own token counts. On an API key, autopilot too: `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787` (Google sign-in traffic goes elsewhere) | MCP tools, `session` and `watch` read its chats, `overhead` sizes GEMINI.md |
| **Your own apps on the Anthropic, OpenAI or Gemini API** | Autopilot on `/v1/messages`, `/v1/chat/completions`, `/v1/responses` and Gemini's `generateContent` (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GOOGLE_GEMINI_BASE_URL`), or the optimizing proxy (which can cost more on cached traffic); no proxy possible (serverless, edge)? `withContextDoctor(client)` runs autopilot inside the SDK client | Exact usage and cache hit rates in `/stats`, prompt-cache placement advice ([proxy](./docs/proxy.md)) |
| **Claude Desktop chat** | The five standing rules below in every chat; one cheap `profile_context` call the model makes once at ~30 turns and on any cost question; `pack_context` instead of reading a big local file whole | One-click `.mcpb` install, `context_checkup` prompt ([chat apps](./docs/chat-apps.md)) |
| **claude.ai, ChatGPT, the phone apps** | Your account's standing preferences, pasted once ([Quick start](#quick-start)) | Profile an exported chat with `analyze` or `session` |
| **CI** | `analyze --fail-over-budget` fails a build whose prompts outgrow a budget; the GitHub Action gates memory-file growth | `.contextdoctorrc` budgets and presets ([CI](./docs/ci.md)) |

Not claimed, because no process on your machine sends those requests: trimming inside Claude Desktop chat, claude.ai, ChatGPT, Cursor's own subscription models, or Codex signed in with ChatGPT. Those get the rules and the measurements above, not autopilot.

The MCP server hands these standing rules, verbatim, to every chat where it is enabled (Claude Desktop, Cursor and Claude Code put them in front of the model):

> 1. Summarize any paste or tool result over ~2k tokens into the points you need; don't carry it verbatim unless you will edit or quote it exactly.
> 2. Refer to earlier content by name; never re-quote it or inline base64.
> 3. Once, at ~30 turns or 3+ large pastes, and when asked about tokens, cost, speed or limits: call profile_context BEFORE answering; act on its top finding. In a chat app pass a `sketch` (turns + big blocks). Do not estimate token counts yourself.
> 4. If optimize_context returns a pruned-turns digest, write its ≤150-token summary.
> 5. To answer from a big file or folder you won't edit, call pack_context with the question; don't read it whole.

## Commands

| Command | What it does |
|---|---|
| `context-doctor install` / `uninstall` | Wire (or remove) everything it finds: the MCP server for Claude Desktop, Claude Code, Cursor, Codex and Gemini CLI; the Agent Skill (Claude Code, Codex); the every-prompt hook (Claude Code, Codex, Gemini CLI's `BeforeAgent`, Cursor's `postToolUse`); Claude Code's `PreCompact` and `SessionStart` hooks. `--statusline` adds the status bar line ([details](./docs/install.md)) |
| `context-doctor doctor` | Self-check the whole installation — one pasteable ✓/✗ diagnosis with fixes |
| `context-doctor savings [--days n] [--share [--copy]]` | What your recent Claude Code sessions cost, and what `/compact` at cold resumes, autopilot and an earlier auto-compact window would save, replayed through the shipped code against your actual billed usage. `--share` prints totals only (no project names or paths) to post. A bare `context-doctor` in a terminal shows the same |
| `context-doctor autopilot on\|off\|pause\|resume\|status` | Every new Claude Code session started in a terminal or IDE goes through the local proxy, which clears stale tool output only when the prompt cache is cold: measured 12.7% less input cost, no session worse ([details](./docs/autopilot.md)) |
| `context-doctor proxy --autopilot` | Local proxy for your own Anthropic, OpenAI and Gemini API apps: clears stale tool output only when the prompt cache is cold, so it never costs more. Plain `proxy` runs the optimizing strategies (dedupe, trim, strip base64), which can cost more on cached traffic. `--token` for a public URL; `/stats` for cumulative savings ([details](./docs/proxy.md)) |
| `context-doctor compact-window [status\|off\|<size>]` | Replay your last 30 days at auto-compact windows from 200k to 800k: input cost, saving, and how many more compactions each means. `400k` (or `250000`, `0.4m`) sets Claude Code's `autoCompactWindow`, with a backup; `off` removes it. Works in every Claude Code surface, the desktop app included |
| `context-doctor instructions [--copy]` | The ~185-token standing rules (~125 on GPT) for claude.ai / ChatGPT preferences, for web and phones where no server runs |
| `context-doctor mcp [--http]` | The MCP server as a subcommand, for clients and registries that launch `npx -y context-doctor mcp` |
| `context-doctor-mcp` | The MCP server itself — stdio by default (what the installer wires); `--http [--port 8808] [--host H]` serves streamable HTTP at `/mcp` for URL-based clients like ChatGPT developer-mode connectors |
| `context-doctor session [file]` | Profile a Claude Code session: live context, findings, **measured tokens and prompt-cache economics**, **where the wall clock went** per tool, and **what its subagents cost** (their own windows, your bill; never in the parent's profile). Also reads Codex rollouts, Gemini CLI chats and ChatGPT data exports (`conversations.json`); `--list` to browse |
| `context-doctor watch [file]` | Live monitor of a growing session transcript or agent trace (Claude Code / Codex JSONL, or a plain OpenAI/Anthropic conversation JSON file): token/cost line per change, findings as they appear |
| `context-doctor cursor [--list]` | Profile a chat from Cursor's local history (both storage formats) |
| `context-doctor analyze <file>` | Profile a conversation: token breakdown, findings, cost + latency estimates. `--exact` adds a true count; `--fail-over-budget` exits 1 on a breach, for CI |
| `context-doctor optimize <file>` | Apply the safe fixes; add `--strategy trim-tool-calls` for big inline file writes, `--strategy prune-history` for consented lossy compaction ([what each does](./docs/detectors.md)) |
| `context-doctor diff <before> <after>` | Compare two profiles: what moved by category, which findings were resolved or introduced, and what it saves in money and latency |
| `context-doctor overhead [--days n] [--mcp]` | What every request re-reads before your message: measured first-request size (Claude Code, Codex and Gemini CLI sessions), each memory file (CLAUDE.md and imports, rules, auto memory, AGENTS.md, Cursor rules, GEMINI.md) priced per month, MCP calls per server; `--mcp` sizes each configured server's tool definitions and flags unused ones |
| `context-doctor overhead split <file> [--min-tokens n] [--write]` | Move a memory file's big or code-heavy sections word for word to `<name>.reference.md`, leaving pointers; indexes stay. A plan until `--write`, which backs up first |
| `context-doctor pack <files\|dirs\|-> -q "…"` | Only the chunks of big documents, logs or code a question needs, ranked and fit to `--max-tokens` (default 4000). No query: an outline; `--ids a#2,b#5` picks chunks from it. `--semantic` also ranks by meaning with a local Ollama model. Offline, no key |
| `context-doctor tasks [--days n]` | Cost per commit, per project: each session priced from its recorded usage against the commits it made |
| `context-doctor reads [--days n] [--limit n]` | Files read into session after session: reads, tokens, cost, and whether a CLAUDE.md summary or `pack` pays |
| `context-doctor subagents [--days n]` | Which subagents paid for themselves: each one's bill vs the same steps run in the parent session |
| `context-doctor compactions [--days n]` | Do sessions work worse right after compacting? Re-reads, tool errors and your corrections, before vs after each compaction |
| `context-doctor cache-plan <request.json> [--calls n] [--out file]` | Where an Anthropic API request should carry `cache_control`, and what it saves over n calls; `--out` writes it applied |
| `context-doctor accuracy` | How much of what you are billed for is visible in your transcript (the fixed harness baseline, per-turn injected content), plus a tokenizer check: real chars/token per model from the API's own counts, next to the ratio the estimator uses |
| `context-doctor report` | Machine-wide impact report (proxy savings persist across restarts): exact proxy savings, hook activity, how often the cold-resume `/compact` offer was followed by a compaction, recoverable waste in recent sessions |
| `context-doctor dashboard` | Local savings dashboard on 127.0.0.1: tokens saved per day, sessions by context in use vs recoverable, budget status |
| `context-doctor ci [--base <ref>] [--max-tokens n] [--max-increase n] [--markdown]` | Memory files (CLAUDE.md, AGENTS.md, GEMINI.md, rules, their imports) at HEAD vs a base commit; exit 1 over budget. What the GitHub Action runs ([details](./docs/ci.md)) |
| `context-doctor init [preset]` | Write a `.contextdoctorrc` from a preset (`chat`, `agent`, `batch`) — a budget you can adopt in one command and tune later |
| `context-doctor experiment --task "…"` | Run one task twice from the same commit, in a fresh session and forked from an `--existing` one, same model and tools; compare bill, cache split, wall clock, and whether `--check` passed. The only command here that spends money, so it caps spend per arm and refuses a dirty tree ([details](./docs/experiment.md)) |
| `context-doctor statusline` | Claude Code status bar: live context vs window, cache share, cost. Wired by `install --statusline`; never overwrites a statusLine you already have ([details](./docs/editor-and-statusline.md)) |
| `context-doctor hook` | The every-prompt hook (Claude Code, Codex, Gemini CLI, Cursor) and Claude Code's compaction hook, registered by `install`; you never run this yourself. Warning threshold tunable via `CONTEXT_DOCTOR_WARN_TOKENS` (default 80000) |
| `context-doctor --version` | Print the installed version. `--help` lists every flag |

**Privacy:** everything runs on your machine. No API key is needed for anything core, nothing is sent anywhere, and no telemetry is collected; the proxy forwards your app's own credentials untouched and holds none of its own.

## What's new

- **0.33 Easier to start, fewer tokens behind a proxy**: `npx context-doctor` now installs one package and starts in under a second (the MCP SDK is bundled; it took 4.5 to 9 s). A bare `context-doctor` opens on a short "Start here" screen, `--help` is grouped, and unknown flags are errors with a suggestion. With autopilot on, Claude Code keeps MCP tool search on (it turned it off behind a non-Anthropic address, loading every tool definition into every request). `install` no longer duplicates an enabled plugin, `session` profiles the current session, `doctor` exits 1 on failures, `uninstall` removes only what install added, and `savings`, `compact-window` and `overhead` report the same session count and billed baseline. A 1-hour cache marked at the top level of a request is treated as 1 hour. The README is a 185-line front page with the detail in docs/.
- **0.32 A full audit, fixed**: five reviewers read every module against real data; each finding was reproduced, fixed and tested (list in [ROADMAP.md](./ROADMAP.md#fixed-by-a-local-audit-2026-10-13)). The ones that mattered most: `npx context-doctor install` wrote an MCP launcher for a package that does not exist; `uninstall` left Claude Code pointed at a dead proxy port; the optimizer could move one parallel tool result under another's id and drop the note beside them; autopilot could clear output the model had not read; edited histories now respect thinking-block signatures; current prices (Opus 5.5 $4, Sonnet 5.x $2, Haiku 5.5 $0.10) and 1-hour cache writes at 2x; replies counted once and `--days` applied per request. The cold-resume offer follows the cache lifetime a session writes. The figures above were re-measured with it.

Every release: [docs/whats-new.md](./docs/whats-new.md).

## Documentation

- [What `install` does](./docs/install.md): every file it writes, what runs in each session after, and when you need MCP
- [Autopilot](./docs/autopilot.md): how it clears stale tool output, and why it never costs more
- [The proxy](./docs/proxy.md): autopilot and the optimizing mode for your API apps, `/stats`, cache advice, a public URL for Cursor
- [Chat apps](./docs/chat-apps.md): Claude Desktop, ChatGPT, claude.ai and the phone apps; what acts by itself and what only nudges; the MCP tools
- [Profiling](./docs/profiling.md): conversations, sessions, prompt-cache economics, subagents, `report`, sharing a profile safely
- [Pack and overhead](./docs/pack-and-overhead.md): keep big documents and fixed overhead out of the context
- [Detectors and fixes](./docs/detectors.md): what the profiler finds and what each optimizer strategy changes
- [Library](./docs/library.md): `profileConversation`, `optimizeConversation`, `packContext`, `withContextDoctor`
- [Budgets and CI](./docs/ci.md): the GitHub Action and `.contextdoctorrc`
- [Editor and status line](./docs/editor-and-statusline.md): the VS Code / Cursor extension and Claude Code's status bar
- [Token counts](./docs/tokenizer.md): why counts are "~", how the Claude ratios were measured, exact counts
- [Performance](./docs/performance.md): what context-doctor itself costs
- [Experiment](./docs/experiment.md): does a smaller context actually help? Measure it
- [What's new](./docs/whats-new.md), [Roadmap](./ROADMAP.md), [Python package](./python/README.md)

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the rules that keep this tool trustworthy, how to run the checks, and how releases are made. What comes next is in [ROADMAP.md](./ROADMAP.md): the [research items](./ROADMAP.md#later--research) and the [steps waiting on the owner's accounts](./ROADMAP.md#waiting-on-the-owners-accounts) (PyPI, the editor extension's marketplaces, a signed Desktop bundle, the Glama listing).

## License

MIT © [gAI Ventures](https://gai.ventures)
