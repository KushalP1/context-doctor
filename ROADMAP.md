# context-doctor roadmap

**Goal:** no one pays for tokens that do nothing. context-doctor measures where context goes on your own machine, in every app you use, and removes the waste at the moments it pays: before it enters the context (pack, overhead), while it sits there (hook, autopilot, compact-window) and after the fact (profile, optimize, savings).

Guiding principles, in priority order: **dead simple for everyone** · **works always, everywhere** · **provably saves tokens, dollars, latency** · **never needs an API key for core function**. Every claim in the README is a measurement on real sessions; an idea that does not survive measurement is closed here with the numbers (see "Closed by measurement" in the history).

Feedback and votes: [open an issue](https://github.com/KushalP1/context-doctor/issues).

## Where it works today

| Surface | Runs by itself | On request | Gap |
|---|---|---|---|
| Claude Code, terminal and IDE | every-prompt hook, autopilot proxy, compact-window, status line | savings, session, watch, report, pack, overhead, MCP tools, plugin | — |
| Claude Code, desktop app Code tab | hook (incl. cold-resume `/compact` offer), compact-window | same as above | autopilot: the app sets its own API address |
| Claude Desktop chat | standing MCP instructions (now incl. pack_context) | profile_context sketch, pack_context on local files, checkup prompt | no hook API, no transcript on disk |
| Cursor agent | native postToolUse hook | MCP tools, cursor profiler, editor extension | Cursor's own models never pass through a local process |
| Codex (app, IDE, CLI) | every-prompt hook | MCP tools (read-only, no approval needed), session | autopilot only with an API key |
| Gemini CLI | every-prompt hook (`BeforeAgent`, with the API's own token counts); autopilot on an API key (`GOOGLE_GEMINI_BASE_URL`) | MCP tools, session, watch, overhead (GEMINI.md) | autopilot cannot see Google sign-in traffic |
| claude.ai, ChatGPT, phone apps | standing preferences (`instructions --copy`) | analyze an exported chat | nothing runs there |
| Your own API apps (Anthropic, OpenAI, Gemini) | autopilot or the optimizing proxy; `withContextDoctor(client)` without a proxy | library: profile, optimize, pack | in-process wrapper covers Anthropic and OpenAI SDKs only |
| CI | `analyze --fail-over-budget` | — | no packaged GitHub Action yet |

## Verified 2026-10-08

- `npm test`: 227 of 227 pass; smoke: MCP, OpenAI proxy, Gemini proxy (Node 20/22 in CI, throwaway HOME).
- MCP smoke over stdio and over streamable HTTP: handshake 119 ms, instructions delivered (690 chars, cap 700), all four tools and the checkup prompt, malformed input rejected.
- OpenAI proxy smoke against a local mock: model listing passthrough, auth header untouched, incremental streaming, Responses API, usage capture, autopilot clearing.
- `doctor` on the author's machine: Claude Desktop, Claude Code, Cursor and Codex wired; hooks registered in Claude Code, Codex and Cursor; status line, skill, ledger, autopilot up.

## Now: shipped on main for 0.27

| Item | Why | Status |
|---|---|---|
| **`pack` / `pack_context`**: only the chunks of big files a question needs | The cheapest token never enters the context. A 60k-token manual pasted to answer one question is paid on that message and every one after it. Chunks follow the document (headings, code declarations, paragraphs), BM25 ranks them, a budget caps them, ids and line ranges let the model ask for more; no query returns an outline. Offline, no key. Over HTTP the tool reads no files | ✅ CLI + MCP tool + library. On this repo (README + src, ~305k tokens): 9 of 10 questions answered from a 2k-token pack (0.6%) |
| **`overhead`**: what every request re-reads before your message | Front matter (system prompt, tools, MCP schemas, skills, CLAUDE.md, rules, auto memory) is re-read on every request and re-written after every cold start; transcripts never show it. Measured from each session's first request, memory files found per agent (Claude Code, Codex, Cursor, Gemini CLI) and priced per month from your own request and cold-start counts | ✅ On the author's last 30 days: 71 sessions start at a median ~54k tokens; each 1k tokens of it costs ~$17/month at list price; the 3.4k-token auto-memory index alone ~$57/month |
| **pack reads PDFs, Word, PowerPoint and ODT** | Most big documents people paste are PDFs and Word files. No new dependency: `pdftotext` where installed, PDFKit (via `osascript`) and `textutil` on macOS, `unzip` for docx/pptx/odt elsewhere; a reason naming what to install when nothing works | ✅ Tested with a generated PDF through both pdftotext and the PDFKit fallback, and a docx through textutil |
| **MCP schema tax in `overhead`** | Each MCP server's tool definitions ride on every request; transcripts never show them. Calls per server come from the transcripts (including servers the app or connectors provide, which no config lists); `--mcp` launches each configured server once and sizes its definitions; unused servers are flagged with their monthly cost. Claude Code's tool search defers definitions, and the report says when it does | ✅ Author's machine: tool search in 49 of 75 sessions, so definitions are mostly deferred; 15 app-provided servers seen. context-doctor's own definitions trimmed to stay under a tested 2,400-token cap |
| **`overhead split <file>`** | Turns a finding into a fix: a memory file's large or code-heavy sections move word for word to `<name>.reference.md`, leaving one pointer per run of moved sections (a plain path, read on demand, not an @import). Link-list sections are indexes and stay; an auto-memory `MEMORY.md` keeps only its index. A plan first; `--write` backs up the original | ✅ On a copy of the author's auto-memory index: ~3.4k → ~1.7k tokens a request (~$28/month), every line kept |
| **`withContextDoctor(client)`**: autopilot inside the app | API apps that cannot route through a local proxy (serverless, edge, managed hosts) wrap their Anthropic or OpenAI SDK client instead. Same AutoClearer as the proxy; the request is cloned first so the app's own history is never rewritten; a conversation the process has not seen counts as warm, so a fresh instance never clears blind | ✅ Unit tests plus a run with the real `@anthropic-ai/sdk` and `openai` packages against a local mock: create and stream, chat and responses; a cold return went out at 135k of the app's 354k chars |
| **Gemini CLI** | Gemini CLI 0.63 has hooks in Claude Code's shape (`BeforeAgent` is its prompt hook, `hookSpecificOutput.additionalContext` reaches the model) and records the API's promptTokenCount on every reply. `install` wires the MCP server and the hook in `~/.gemini/settings.json` (detected by settings.json, `~/.gemini/tmp` or `gemini` on PATH, not by `~/.gemini` alone, which Antigravity also creates); `session`, `watch` and the hook read its chats, rewrites by id and `$rewindTo` included; `doctor` checks it | ✅ Formats read from the 0.63.0 package; tests cover parsing, the hook's BeforeAgent answer, install and uninstall |
| **Gemini API in the proxy and autopilot** | The proxy routes Google's API (by `x-goog-api-key`, `/v1beta` paths or `models/<m>:generateContent`) to `generativelanguage.googleapis.com`, reads exact usage from `usageMetadata`, and autopilot clears stale `functionResponse` parts on `generateContent` / `streamGenerateContent` when the cache is cold (Gemini CLI's tools added to the clearable list; ids derived per conversation when Gemini gives none; implicit caching's lifetime is unpublished, so an hour is assumed, the longer guess). Reaches Gemini CLI on an API key via `GOOGLE_GEMINI_BASE_URL`; Google sign-in traffic goes to another endpoint | ✅ `scripts/smoke-gemini-proxy.mjs` against a local mock: 8 checks (routing, key header, streaming, 5 of 8 stale results cleared, calls kept paired, usage). All three smoke scripts now run in CI |
| Standing MCP instruction 5 | Chat apps and agents learn to call pack_context instead of reading a big file whole; the instructions stay under their 700-char cap | ✅ |

## Next: code can finish these, in order of expected saving

| # | Item | Why | How we will know it works |
|---|---|---|---|
| 1 | **GitHub Action** on the Marketplace | Comment the context-size and overhead change on every PR that touches prompts, CLAUDE.md or agent configs; fail over a budget | Used on this repo's own PRs |
| 2 | **pack with optional local embeddings** | Lexical ranking misses paraphrase (the one miss in the eval above). Use Ollama's embeddings when it is running, never required | Same 10-question eval plus a paraphrase set: hits up, no regressions |
| 3 | **Python package** with profile and pack | RAG pipelines (LangChain, LlamaIndex) chunk and stuff context in Python; the same budgeted packing belongs there | Parity tests against the TypeScript fixtures |

## Closed by measurement (2026-10-08): a large-paste notice in the hook

The idea: when a prompt itself carries a big paste, tell the model to work from extracted points. Across 2,233 prompts in 75 local Claude Code sessions, 51 carried 5k+ tokens and 10 carried 10k+ (largest 14k), in sessions that run to hundreds of thousands of tokens. A notice cannot take a paste back out of history, so the most it could save is a few percent of a few sessions, paid for with a line of context on every large prompt. `pack` is the better answer: the document never needs pasting.

## Later / research

- Per-subagent context budgets and a report of which subagent tasks pay for themselves.
- A prompt-cache breakpoint planner for API apps: where to put `cache_control` given the measured request mix.
- Cross-session duplicate detection: the same file read into ten sessions a day.
- A cost-per-task view in `report` (session cost divided by commits or closed tasks), local only.

## Waiting on the owner's accounts

| Item | State | Owner's step |
|---|---|---|
| **Sign the `.mcpb`** | Signing is in `build:mcpb` and the release workflow; `mcpb verify` gates the release. Tested end to end with a self-signed certificate | Obtain a code-signing certificate from a trusted CA; add `MCPB_CERT` / `MCPB_KEY` |
| **Publish the extension** | Marketplace metadata, icon, listing and changelog ready; the `vscode-v*` workflow publishes to both marketplaces and attaches the `.vsix` | Create the `gai-ventures` publisher and an Open VSX account; add `VSCE_PAT` / `OVSX_PAT`; push a `vscode-v*` tag |
| Move repo to the **gAI-ventures org** | Redirects keep old links working | The org owner transfers it on GitHub |

## Non-goals

- **Cloud service / accounts / telemetry**: everything stays on the user's machine, permanently.
- **Silent history rewriting**: lossy changes remain consent-only, with the host model writing summaries.
- **API keys for core function**: optional adapters may accept a key; nothing core ever requires one.

## History: what shipped, with the measurements behind it

### v0.5 — Trust & automation (shipped in 0.5.0 unless noted)

| Item | Why | Status |
|---|---|---|
| **Tag-based auto-publish** (GitHub Actions + npm granular token) | Releases currently need a maintainer's 2FA round-trip; `git tag` → published removes the friction and speeds every future item below | ✅ workflow shipped; needs the `NPM_TOKEN` repo secret |
| **`context-doctor doctor`** — self-check command | Verifies an install end to end: hook registered, MCP reachable in each app config, skill present, ledger writable, real stdio handshake. Turns "it doesn't work" reports into one pasteable output | ✅ |
| **`context-doctor watch`** — live session monitor | Tail a running session/agent trace; status line per growth event, findings surfaced as they appear. The real-time counterpart to `session` | ✅ |
| Move repo to the **gAI-ventures org** | Attribution home; auto-redirects keep old links working | ⏳ needs the org owner to transfer on GitHub |

### v0.6 — Accuracy (shipped in 0.6.0 unless noted)

| Item | Why | Status |
|---|---|---|
| **Exact tokenizer adapters** (optional) | `analyze --exact`: Anthropic count-tokens API for Claude (BYO key, opt-in), tiktoken for GPT (when installed alongside); heuristic remains the zero-config default and reports its drift | ✅ |
| **Semantic near-duplicate detection** | Exact-hash dedupe misses "same doc pasted with a different lead-in"; sampled-shingle Jaccard flags ≥60%-similar pairs with estimated savings | ✅ |
| **More session formats** | ChatGPT data-export (conversations.json) ✅ and Cursor chat history (`context-doctor cursor`, both SQLite shapes) ✅ | ✅ |

### v0.7 — Proxy pro (shipped in 0.7.0)

| Item | Why | Status |
|---|---|---|
| **Response token accounting** | `usage` read from responses flowing through (JSON + SSE, both providers) — `/stats` exact on both sides of every call | ✅ |
| **Prompt-cache advisor** | Watches real Anthropic sequences: flags large stable prefixes without `cache_control` and prefix churn that silently re-bills the cache; advisories in `/stats.advice` + logs | ✅ |
| **Per-route/per-model strategy config** | `proxy --config file.json` with `routes[]` (modelPrefix → strategies/keepRecent/maxToolResultTokens); first match wins | ✅ |

### v1.0 — Platform (code shipped in 0.8.0)

| Item | Why | Status |
|---|---|---|
| **Context budgets** (`.contextdoctorrc`) | Per-project thresholds; nearest-file discovery, enforced by the hook, reported by analyze/session, defaults feeding optimize/proxy | ✅ |
| **Local dashboard** (`context-doctor dashboard`) | Loopback-only page: tokens saved per day, sessions split into in-use vs recoverable, budget banner, proxy stats | ✅ |
| **Launch** | CONTRIBUTING.md + good-first-issues ✅ · demo GIF and the Show HN / r/LocalLLaMA posts ⏳ (owner's call on timing) | partial |

The **1.0.0 version tag is deliberately not taken yet**: it should mean "the CLI
surface and rc schema are stable and we will not break them", and that promise is
worth making after real-world use, not on the day the features land.

### Shipped since v1.0 planning (0.9.x)

| Item | Why |
|---|---|
| **Prompt-cache economics** | Transcripts record cache reads/writes per request; `session` reports hit rate, real input cost against the uncached counterfactual, and warns on low hit rate or cache churn |
| **Agent-waste detectors** | Repeated file reads and retained error output — the two patterns that dominate tool-heavy transcripts |
| **Measured tokens over estimates** | Sessions use the API's own counts; the heuristic was measured to undercount by ~64% because transcripts omit system prompt and tool schemas |
| **Live-context accuracy** | Compacted-away history no longer counted; savings reported as a union rather than a double-counted sum |
| **Cursor support** | `context-doctor cursor` reads Cursor's SQLite history (both shapes) |
| **CI gate** | `--fail-over-budget` exits 1 so pull requests can be gated on context size |
| **Durable proxy savings** | `/stats` was memory-only, so every restart erased the record; the proxy now checkpoints to the ledger and the report separates persisted runs from live ones |
| **`--redact`** | Profiles can be pasted into issues with content and paths masked and the numbers intact |
| **Faster profiling** | Near-duplicate pairs whose shingle-set sizes make the threshold unreachable are skipped: 271ms → 160ms on an 8.5MB session, identical findings |

### Shipped in 0.12.0 — durability and the biggest real waste

| Item | Why |
|---|---|
| **Installs survive a Node upgrade** | `install` wrote `process.execPath`, which on Homebrew/nvm/asdf is version-pinned: the next Node upgrade deleted that path and every config broke silently. Configs now use `node`/`npx` from PATH, `doctor` flags any surviving pinned command, and re-running `install` repairs stale entries instead of skipping them |
| **Hooks never point into the npx cache** | `npx context-doctor install` wrote a hook path inside npm's garbage-collected `_npx` directory; when npm cleared it the every-prompt hook failed silently forever. The hook now prefers a checkout or a global binary, and says how to get the fast path |
| **Large tool calls are found and fixable** | In file-heavy agent sessions the biggest items in context are tool CALLS, not results — a Write or a heredoc carries the whole file inline. New `large_tool_call` finding plus an opt-in `trim-tool-calls` strategy: on a real 278k-token session, 278k → 102k where the default set reached 248k |
| **No more phantom base64** | A run of one repeated character or a long hex digest matched the base64 charset, so `strip-base64` replaced real content with a placeholder. Detection now also requires the character distribution of encoded binary |
| **Huge transcripts actually parse** | Sessions past V8's ~512MB string limit threw inside the hook, where the error was swallowed — the biggest sessions got no warning at all. Transcripts are now streamed line by line |
| **Broken input says so** | A truncated or non-conversation JSON file produced a confident report about one giant "user message"; the report now leads with what went wrong |
| **Readable findings** | Repeated findings of one kind collapse into a single line instead of burying the other kinds |
| **Node 20+** | Node 18 went EOL in April 2025 and its CI jobs hung indefinitely, so `engines: >=18` was a promise we could not keep. CI now covers exactly what package.json claims, on three OSes |

### Shipped in 0.26.0 — checked on every platform

Each surface driven for real, not only through unit tests: the MCP server on every launch path (local build, plugin bundle, `mcp` subcommand, the published npm package, HTTP, the `.mcpb`), Claude Desktop's own MCP log, Claude Code 2.1.62 and 2.1.288 with the plugin installed from GitHub, Codex 0.153 running a real `codex exec` on GPT-5.5, Cursor 3.18, VS Code 1.133 activating the extension, and the proxy against a mock of OpenAI's Chat Completions and Responses APIs.

- **Cursor's agent never received the guidance.** Cursor runs Claude Code's `UserPromptSubmit` hook as `beforeSubmitPrompt`, whose output can only allow or block a prompt (Cursor's hook docs); the 0.15 claim that its output was accepted was wrong. `install` now adds a native `postToolUse` hook to `~/.cursor/hooks.json`, whose `additional_context` reaches the model; the hook answers in Cursor's format, ignores Cursor's other events (so the once-per-growth warning is not spent on output Cursor drops), and `doctor` checks it. Cursor's transcript records tool calls but not their output (1,163 calls, no results, in the author's largest chat), so the note gives the accumulated size without a window share or price.
- **Codex would not run the MCP tools non-interactively.** `codex exec` found the server and the model called `context_best_practices`, but Codex refused: "MCP tool call requires approval, but approval policy is never". Every tool is now annotated `readOnlyHint`, non-destructive, idempotent and closed-world; the same run completed.
- **Autopilot skipped the tools agents use most now.** Codex's code mode runs everything from one `exec` cell (its most-used tool on the author's machine, 284 calls) and polls with `wait`; Cursor uses `SemanticSearch`, `ReadLints` and `AwaitShell`. All added to the re-runnable list.
- **"~8.5M tokens (2136% of the window)".** A history imported into Codex carries no API token counts, so the hook estimated from the transcript and quoted a share and price. An estimate past the window (or 1M with no known model) now says the app is already trimming.
- **Chat-app settings paths**: claude.ai keeps preferences under Settings > General, and ChatGPT's field is "What traits should ChatGPT have?".
- `proxy --autopilot` printed the optimizing mode's banner. `scripts/smoke-mcp.mjs` and `scripts/smoke-openai-proxy.mjs` make the end-to-end checks repeatable.

### Shipped in 0.25.0 — compact earlier, without anyone following advice

Measured first: since 0.22 the hook had offered `/compact` 33 times on the author's machine when a large session came back after the cache expired. It was followed once. The offer went only to the model, which mostly did not raise it, and advice that is not taken saves nothing.

- **The cold-resume offer is shown to you.** The hook now returns a `systemMessage` beside the model's note, with what the message you just sent cost (the whole context re-sent at the cache-write rate) and how much cheaper each later message gets after `/compact`.
- **`context-doctor compact-window`**: Claude Code auto-compacts near the full window (median 970k tokens over 31 compactions, measured), and has a native setting, `autoCompactWindow`, to compact as if the window were smaller. It is a settings key, not an environment variable, so the desktop app honours it, unlike autopilot's `ANTHROPIC_BASE_URL`. The command replays every session request by request at 200k-800k, both arms priced as the cache bills, each simulated compaction charged its request and a 20k-token summary at the output rate, and real compactions and rewinds keeping the arms in step. On the author's last 30 days: 55% less input cost at 400k, for 14.7 compactions a week instead of 5.1. It sets a window only when you name one, keeps a backup, and `off` undoes it. The replay's baseline came within 9% of billed usage, on the low side.
- **`savings` shows it as a third lever**, using the window you have set or 400k as an example.
- **`report` shows whether the offer is acted on**: offers, and how many a compaction followed within the hour (3 of 34 on the author's machine, counting Claude Code's own auto-compactions), and points to `compact-window` when it is rarely followed. Also fixed: on Windows, `report` never matched recent sessions to their hook history (it split paths on `/` only).
- **Plugin skill `/context-doctor:compact-window`**: compare sizes and set one from inside Claude Code, only on the user's say-so.

### Shipped in 0.24.0 — a module-by-module audit

Each module checked against real data and hostile input, not only its tests:

- **Session parser rebuilt API messages.** Claude Code writes one transcript row per content block; the parser emitted one message per row (3,604 rows for 1,765 replies in one session). Exported conversations broke tool_use/tool_result pairing in 9 of 13 real sessions, profiles carried extra per-message overhead, and `keepRecent` protected fewer real turns. Consecutive same-role rows now merge as the API merges them, and rows of a reply rejoin it by message id even when parallel tool calls interleave with their results. 12 of 13 sessions now pair cleanly; the 13th has a tool call interrupted before it returned. Usage is sampled once per reply.
- **Optimizer verified**: across those sessions and the sample, 4 strategy sets x 2 settings, it introduced no pairing errors.
- **Proxy**: non-conversation endpoints (`/v1/models`, `/v1/files`) returned 404 through it, so a client under autopilot lost those features; they are now forwarded by the request's own headers. Every body was decoded as UTF-8 and re-sent, corrupting binary uploads; untouched bodies now pass byte for byte. Streaming, client aborts and an unreachable upstream (502) were already correct.
- **Dashboard and report overclaimed**: MCP sketches shared one session id, so a big sketch followed by a small one of another chat counted as savings; and compaction shrinkage was added into "tokens context-doctor saved". Both fixed; shrinkage is shown on its own.
- **`watch`** read plain conversation JSON files as empty sessions; it now follows them.
- **MCP**: sketch inputs bounded (1e9 turns produced "1000515000.0M tokens"); `keep_recent: 0` accepted as on the CLI; token counts read billions as B.
- **Tests**: a savings fixture used fixed September dates and fell out of the 30-day window on 3 October; fixtures are relative now, and the watch test waits for output instead of sleeping.
- **Checked clean**: all 178 local sessions and rollouts and 20 Cursor chats parse and profile without error; MCP tools reject malformed arguments with clear errors; the dashboard, `experiment --dry-run` and the editor extension work.

### Shipped in 0.23.0 — audit fixes and the share loop

- **Security:** 4 transitive vulnerabilities under the MCP SDK patched (fast-uri high; hono, qs, ip-address moderate). hono's `parseBody` memory exhaustion applied to `context-doctor-mcp --http`. `npm audit`: 0.
- **Cold resume after /compact:** the hook read the last reply's usage even when the session had been compacted since, so coming back hours after `/compact` warned about the old (e.g. 800k) size of a now-small context. It now stops at a compact boundary. (Found by reading the code; the live note fired correctly on this session at 807k after 43 idle hours.)
- **Autopilot's cleared-output note** no longer says "run the tool again": a cleared Bash result can be from a push or a delete. It now says to repeat only read-only calls.
- **CLI input:** numeric flags validated (`--days abc` printed "NaN days"; a bad `--port` started the proxy on a random port); unknown commands are named.
- **`savings` fits 80 columns** (it ran to ~95 and wrapped); **`savings --share [--copy]`** prints totals only, tested to contain no project names or paths; the README shows the real output as a rendered terminal image (`scripts/render-terminal-svg.mjs`).
- **Checked:** every CLI command in a clean home (no crashes, no stack traces); install/doctor/uninstall round trip with existing user settings (kept intact, ours fully removed); README and roadmap anchors; hook time on the three largest real sessions (0.12–0.16 s per prompt, 0.8–1.7 s on a full re-parse of 86–343 MB).

### Shipped in 0.22.0 — an audit of what actually works, and a lever that does in the desktop app

Asked: "make it better, make sure everything works." Audited on the author's machine first:

- **Autopilot had seen 0 requests in 4 days.** Every session there runs in the desktop app's Code tab, and Claude Code there (2.1.284) is host-orchestrated: the app sets `ANTHROPIC_BASE_URL` from its own account config and `filterSettingsEnv` drops the same key from settings files. `doctor` reported ✓ regardless. Now `autopilot on`, `status` and `doctor` read which surface recent sessions ran in and say when autopilot cannot reach them; the README no longer claims the desktop app.
- **Cold-resume advice (new).** The every-prompt hook does run in the desktop app. When a prompt arrives more than 65 minutes after the last reply on a session over 150k tokens, the cache has expired and the message re-sends everything at the write rate; the hook gives the model the numbers and it offers `/compact` once. Replayed over 133 days: 401 such returns, $4,053 net saving had the user compacted after the first reply ($914 a month), positive in 296, worst −$2.30. Claude Code 2.1.284 ships a flag-gated server-side "tool result clearing after idle" with the same 65-minute rule; this is the user-side version that works today.
- **`savings` window fixed**: "last 30 days" counted the whole history of any file touched in the window (0.21 showed $11,205; the true 30-day figure was $6,006). It now also separates surfaces autopilot can and cannot reach and reports the cold-resume opportunity.
- **Cost quoted at the wrong rate**: the hook priced a cached session's per-message cost at the uncached rate (10x too high), and `report` and autopilot's counter priced cached tokens at the full input rate. Both now use the cached rate.
- **Checked live on every surface**: this Claude Code session's MCP tool (sketch), the published npm package in a clean home (`savings`, `doctor`, `npx -y context-doctor mcp`), Codex (`codex mcp list` shows it enabled), Cursor's config, a fresh plugin install from GitHub (MCP `✓ Connected`), the Claude Desktop MCP server (connected; the model has not called it since 0.17, so chat apps remain a nudge). `--version` was missing, and is added.

### Shipped in 0.21.0 — see it before you install it, install it where you already are

Asked: "can we make anything better so more people download and use this?" Measured first: downloads were rising (350 on 25 Sep), but npm search ranked context-doctor outside the top 50 for every generic query ("claude code context", "context window", "token usage"), so new users were not finding it by searching, and a first run printed help text.

- **`context-doctor savings`**, and a bare `context-doctor` in a terminal: every recent Claude Code session replayed through the shipped AutoClearer; the share it would save is applied to the input the transcripts show was actually billed, so the headline is a fraction of the user's real spend. 53 sessions in ~9 s here: $11,205 billed, $1,396 (12.5%) cut, 0 sessions worse.
- **Claude Code plugin.** The repo is its own marketplace. Found by installing from GitHub into a sandboxed Claude Code 2.1.62: older versions reject unknown manifest keys (`displayName`) and do not install a plugin's npm dependencies, so the MCP server ships as one self-contained bundle (`dist/mcp.bundle.js`, 417 KB, not in the npm package), and Claude Code reported it `✓ Connected` with zero node_modules. Plugin-only skills `/context-doctor:savings`, `:checkup`, `:autopilot`; the plugin hook stays silent when the npm install's hook is also present.
- **Official MCP Registry.** `server.json` (validated by the registry's own tool), `mcpName` in package.json, a `context-doctor mcp` subcommand so `npx -y context-doctor mcp` works, and a release job that publishes by GitHub OIDC after npm, with no secret.
- **`npm version` syncs every version string** (server.json, the MCP server, the proxy), rebuilds `dist/` and stages it, so a release is one command.
- **Fixed:** with autopilot off, the every-prompt hook health-checked port `undefined` and printed a Node deprecation warning, and `autopilot status` would have reported a dead proxy instead of "off".

### Shipped in 0.20.1 — releases that finish themselves

- **One tag, every channel.** `v*` tags run the suite, publish to npm through trusted publishing (npm is restricting tokens that bypass 2FA, so the workflow authenticates by OIDC and needs no stored token), and create a GitHub release with the Claude Desktop bundle attached, its notes taken from this file. A missing secret is a notice, not a red run (the v0.17.0 tag failed red for exactly that).
- **Signed Desktop bundle, when a certificate exists.** `build:mcpb` signs with `MCPB_CERT` / `MCPB_KEY` (PEM files or text) and requires `mcpb verify` to pass, which chains the certificate to the OS trust store the way Desktop does. Found while testing: a self-signed certificate never passes `verify` by design, so the self-signed mode (`MCPB_SELF_SIGNED=1`) checks the signature block instead and is for pipeline tests only. The bundle now carries an icon.
- **Extension 0.2.0, marketplace-ready**: icon, categories, listing README and changelog; `vscode-v*` tags publish to the VS Code Marketplace and Open VSX when their tokens exist and always attach the `.vsix` to a release.

### Shipped in 0.20.0 — autopilot: lean context in every Claude Code session, never more expensive

Asked: "auto-optimize every session I run, and make sure performance only improves." Measured before building:

- **The existing proxy strategies failed the bar.** Replayed over 33 real sessions with cache pricing they saved 6.7% overall but made one session 13% more expensive: editing history the cache holds re-bills everything after the edit.
- **Where the cost is:** 94% of input cost came from requests above 200k tokens (53% above 600k), in 1M-context sessions.
- **Claude Code already contains the right idea**: a "microcompact" that clears old tool output (keep 3, clear 40k+ batches), switched off by a server-side flag on this account (42 unexplained prompt drops in 19,769 requests), and an API context-management option compiled out.
- **AutoClearer** follows that design with one change for "never worse": batches are taken only when the cache is cold anyway (idle past the request's own TTL, 1 hour here; 444 of 19,824 gaps). Replaying every session through the shipped class: 9.8% less cache-weighted input, no session worse. Warm-cache payback rules gained 0.1% and lost on one session, so they are opt-in.
- **Service + wiring**: launchd / systemd --user / logon task; `/health` must answer before settings.json is touched; the hook restarts a dead proxy before the prompt's request (0.6 s, measured); `pause` is an instant passthrough. Overhead 7 ms on a 2.9 MB request. Verified that settings.json `env` overrides the base URL the desktop app injects.

### Shipped in 0.19.0 — the estimator was undercounting Claude by ~40%

Picked up as "calibrate the sketch against exact usage"; the calibration found a bigger problem underneath.

- **Measured, with no key.** Two exact signals already sit in Claude Code transcripts: a reply with no thinking block is billed as exactly its `output_tokens` (504 replies: 2.75 chars/token on prose), and a single large appended block is exactly the prompt growth minus the previous reply (474 blocks: 2.4 on code and tool output). They agree across Opus 4.7 to 5.x, Fable 5.x and Sonnet 5 within ±9%. The provider-neutral 4.0 / 3.2 the tool used undercounted Claude by ~1.45x on prose and ~1.33x on code.
- **Codex was the planned source and could not be one**: rollouts truncate tool output before the model sees it, so prompt growth does not isolate a block. OpenAI keeps 4.0 / 3.2, labelled as not re-measured.
- **Per-provider estimator** (`estimateTokens(text, model)`), with the model taken from the request's own `model` field when not given; profile, optimize (savings and trim budgets), accuracy and the sketch use it.
- **Three behaviours the old constant broke**: the hook's byte fast path assumed 4 bytes/token and could skip Claude sessions already past the warning line; the proxy gated cache advice on 4,000 chars and missed 1,024 to ~1,670-token prefixes; `accuracy` blamed the estimator's gap on invisible content (coverage now 56%, was 39%).
- **Calibration files are versioned** so a factor learned against the old heuristic is not stacked on the new one.
- **`accuracy` gained a tokenizer check** that re-runs both measurements per model on the user's own sessions.
- **The sketch** now sizes in measured chars (exchange 2,060, code line 42, log line 56, word 6.3) converted per model, and states its measured error (total from turn count -20% to +9%; code by lines ±25%) instead of ±30%.

### Shipped in 0.18.0 — the proxy on a public URL

- **`proxy --token <secret>`** (also `CONTEXT_DOCTOR_PROXY_TOKEN`). Every path except `/health` must start with `/t/<secret>/`, compared in constant time, stripped before routing; a wrong or missing prefix is a 401 with no upstream call. This is the prerequisite for the Cursor BYO-key item: in Cursor 3.18.25 the OpenAI base-URL override is sent to Cursor's backend inside the model configuration and Cursor's *servers* call it (only the key-verification ping is client-side), so the proxy must be on a public URL, and an unauthenticated relay must not be. Cursor can set a URL but not a header, so the secret rides in the path. README documents the tunnel + Cursor settings path.
- Not available to us: Cursor's "local mode" (`CURSOR_LOCAL_AGENT_BASE_URL`, client-side inference against any OpenAI-compatible gateway) is compiled to `localMode: false` in the consumer build.

### Closed by measurement in 0.18.0 — Cursor `beforeReadFile` trimming

The item assumed the hook could rewrite file content. In Cursor 3.18.25 the `beforeReadFile` response validator accepts only `permission: allow|deny` and `user_message`; the local agent runtime reads the same two fields and nothing else. The only inherent action is to deny a read and tell the agent why. Then the measurement, on 735 `Read` calls across 13 real Cursor agent transcripts: Cursor's agent already ranges 82% of its reads (`offset`/`limit`); whole-file reads have a median size of 4.6 KB and a p90 of 26 KB; 6 of 735 reads exceeded ~10k tokens and none exceeded 200 KB. A deny guard would fire on under 1% of reads, save 10-25k tokens each time, and break a workflow whenever its threshold was wrong. Not shipped. Cursor's transcript also never contains tool results, which is why the hook there reports estimated sizes only.

### Shipped in 0.17.0 — Claude Desktop, as far as it can go

- **Why the tool was never called from chat.** Desktop's log showed zero `tools/call` in a month with the server loaded. The instruction said "call profile_context", but the tool's only input was the full conversation JSON, which a chat model cannot export and would have to re-type. An impossible instruction is not a nudge.
- **`sketch` input**: turn count plus the blocks that matter (large, repeated, stale, image, base64) with one size hint each, ~120 output tokens. The server sizes it, prices the per-turn re-read, ranks findings and tells the model to apply the top one. Server instructions, tool description and the `context_checkup` prompt all point chat apps at it.
- **Confirmed in the app bundle (v2.2553)** that Desktop's `LocalMcpServerManager` reads server `instructions`, so the standing rules do reach the model. Also confirmed, again, that there is no hook API and no transcript on disk; the README now says "the rules ride in every chat and the checkup is one cheap call away", not "inherent".
- **`context-doctor instructions --copy`**: the same rules for claude.ai / ChatGPT per-account preferences, read on every turn on web and phones where no server runs.
- **`.mcpb` bundle** (`npm run build:mcpb`, 3.1 MB, validated in CI and uploaded as an artifact): one-click install through Desktop's Extensions UI on Desktop's own Node, no npm.

### Shipped in 0.16.0 — GPT, through Codex

| Item | Why |
|---|---|
| **Codex support** | Asked: "can we make it work for GPT?" The ChatGPT chat UI cannot be made inherent (no MCP, no hooks, no data path; checked). Codex can: the agent bundled in ChatGPT.app (binary 0.153.4), the IDE extension and the CLI implement Claude Code's hook contract almost verbatim (`hooks.json`, `hookSpecificOutput.additionalContext`, `transcript_path`), `[mcp_servers.*]` in `config.toml`, and `SKILL.md`. `install` wires all three; rollouts parse with the API's own usage (40/40 real sessions, tool timings via `call_id`); `session --list` includes them; `doctor` checks them. Codex's one-time hook trust (`/hooks`) is stated at install |
| **`config.toml` editing without a TOML library** | The file is the user's. Everything outside `[mcp_servers.context-doctor]` is copied byte for byte; re-running replaces rather than duplicates; removal restores the file. Tested with our table first, last and in the middle |

### Shipped in 0.15.0 — what actually runs by itself, and one surface that now does

| Item | Why |
|---|---|
| **Cursor inherent** | Cursor's Hooks Service loads `~/.claude/settings.json`, maps `UserPromptSubmit` onto `beforeSubmitPrompt`, passes a `transcript_path`, and accepts Claude's nested `additionalContext` (compat hard-coded on, 10k cap). Our hook had been firing on every Cursor prompt and returning nothing, because Cursor's `{role, message:{content}}` transcript shape did not parse. One parser addition: against a real 976KB Cursor transcript, 691 messages and guidance naming a 283k-token context |
| **Desktop instruction is action-shaped** | From "offer to run profile_context" to "past ~30 turns / 3+ large pastes / any cost question, call profile_context BEFORE answering". Still ~150 tokens. Plus a `context_checkup` MCP prompt in Desktop's + menu |
| **README says which surfaces are inherent** | Claude Code, Cursor and the proxy act without the model's cooperation; Claude Desktop is a strong nudge; ChatGPT is on-demand only. The previous "every chat inherently better" was true for fewer surfaces than it implied |

### Shipped in 0.14.3 — the editor extension

| Item | Why |
|---|---|
| **VS Code / Cursor extension** (`vscode/`) | The last roadmap item. Live context, share of window and cache share in the editor's status bar, from the newest Claude Code transcript for the open folder; warning colour past a configurable threshold; click to run `session`. Self-contained (no dependency on the npm package, so it works on a machine that never installed it), pure core with its own tests, built and packaged in CI, installed and verified in both VS Code and Cursor locally. Marketplace publishing is the owner's step |

### Shipped in 0.14.2 — subagents were never in the transcript

| Item | Why |
|---|---|
| **Subagent accounting** | Blocked for weeks on "no sidechain entries in any transcript". Wrong place to look: Claude Code writes each subagent to its own file under `<session>/subagents/`. 195 of them on one machine, 19 sessions, final contexts summing to 28M tokens, about $1,844 at list price, none of it ever shown. `session` now lists them with task, calls, final context, duration and cache-aware cost, compares the total against the parent's own total input cost, and flags subagents that ended above 200k tokens |

### Shipped in 0.14.1 — context health where the work happens

| Item | Why |
|---|---|
| **Claude Code status line** | `install --statusline` wires `context-doctor statusline` into Claude Code's `statusLine`, so live context vs window, a warning from 70%, cache share and cost sit in the status bar while you type. Reads the status payload when Claude Code provides the size, else the last 256KB of the transcript (~1ms; 80ms end to end). Never overwrites a status line you already have; uninstall removes only its own; any failure prints nothing. The roadmap's "editor status bar", for the editor most users of this tool are in |

### Shipped in 0.14.0 — the experiment the critics asked for

| Item | Why |
|---|---|
| **`context-doctor experiment`** | The one honest answer to "does a smaller context actually help": the same task, from the same commit, in a fresh session and forked from an existing one (`--resume --fork-session`, so the real session is untouched), same model and tools, with the bill, cache split, wall clock and a `--check` pass/fail side by side. The verdict weighs cost against passing, because a cheaper failure is not a saving. It is the only command that spends money, so it caps spend per arm, refuses a dirty tree, refuses to run inside Claude Code, and has a dry run. Tested end to end against a stub `claude` |

### Shipped in 0.13.9 — the estimator learns from your own exact counts

| Item | Why |
|---|---|
| **Calibration from `--exact`** | Shipping a tokenizer would break the no-key, no-dependency default, and transcript deltas cannot calibrate anything (see 0.13.0). What can: the one clean comparison a user makes when they run `analyze --exact`, a true count for the exact bytes just estimated. That ratio is now remembered per model family on this machine and applied to later estimates, printed in the profile header so scaled numbers never pass as raw. Out-of-range samples are ignored; an env switch disables it. Tests run with it disabled by construction, via a runner script that also stops a new test file from being left out of the suite |

### Closed by measurement in 0.13.8 — `trim-tool-calls` stays opt-in

The question was whether trimming a completed tool call can confuse a live agent.
Across 42 sessions: 73 large writes, 18 later edited, and 16 of those edits had no
read in between — the model built `old_string` from its own `Write` input, at a
median distance of 43 messages (p90: 181). So yes, in about 22% of cases, and far
outside any recent-message window. Default stays off. What shipped instead: the
offline optimizer, which can see the rest of the conversation, now keeps exactly
those writes and trims the 63% that are never touched again.

### Shipped in 0.13.7 — the advisor says where

| Item | Why |
|---|---|
| **Cache breakpoint placement** | The proxy used to say a breakpoint was missing. It now says where: for a large system/tools prefix, the last tool definition (or last system block); for the conversation, it fingerprints each message across consecutive requests, finds the run that was byte-identical to the previous call, and names the exact message to mark along with the tokens that run re-bills each turn. Only when the run clears Anthropic's ~1024-token caching floor, and never for a request that already carries `cache_control` |

### Shipped in 0.13.6 — two small roadmap items, one measured

| Item | Why |
|---|---|
| **Trim step is a documented knob, not a magic number** | Tried to find "the right" step as a function of conversation size. Measured instead: at 400 turns, step 10 → 21% of turns invalidate the cache with ~2 stale results waiting; 20 → 12% and ~4; 40 → 10% and ~9. Adaptive steps were worse everywhere because a changing step moves the boundary itself. So: default stays 10, `trimBoundaryStep` in `.contextdoctorrc` and `OptimizeOptions`, numbers in the README |
| **Windows sandboxing is structural** | One shared `sandboxEnv`/`withSandboxHome` helper and a guard test that reads every test source and fails the suite if any sets HOME without USERPROFILE. Verified it bites by planting an offender |

### Shipped in 0.13.5 — the two things r/ClaudeCode asked for

| Item | Why |
|---|---|
| **Where the time goes** | `session` now reports wall clock per tool from the timestamps on every transcript entry (tool_use → tool_result). On one real session: Bash was 87% of 146 minutes of waiting, median 1.3s, slowest 22.5m. The caveat travels with the number: the gap includes waiting on permission prompts. The concern that it would also contain model generation turned out not to apply: the model has finished emitting the call before the call's own timestamp is written, and its next turn starts after the result's |
| **Retry vs re-read** | Identical tool calls split by what happened to the previous attempt. Measured across 42 sessions: 15 retries (1 loop of 3+) against 151 re-reads, so ~90% of "repeated calls" were the model forgetting it already had the answer, and the old advice ("cache results") was right for those and wrong for the retries, where the answer is in the first error |

### Shipped in 0.13.0 — measurement, presets, and a cache bug

| Item | Why |
|---|---|
| **`context-doctor accuracy`** | Answers "why is my bill bigger than the profile?" with evidence: the fixed harness baseline (~51k tokens here) and the per-turn injected content the transcript never records. The roadmap asked for a tokenizer benchmark instead; that turned out to be unbuildable from transcripts alone, and the note below says why |
| **`context-doctor diff`** | Two profiles side by side — category movement, findings resolved or introduced, money and latency. Optimization no longer has to be taken on trust |
| **`context-doctor init <preset>`** | `chat`, `agent`, `batch`. The budget feature went unused because an empty rc file is useless until you already know your numbers |
| **Shell file reads** | `cat`/`head`/`tail`/`less` count as reads. 16 real findings across 6 local sessions that were previously invisible |
| **Cache-aware trimming** | The trim boundary moved every turn, invalidating the prompt cache on 22 of 24 turns and paying the 1.25x write price to save a few hundred tokens. Quantized: 8 of 24, trimming undiminished |

#### One roadmap item did not survive contact with the data

**"Calibrate the heuristic from ground truth"** assumed transcripts record what is
sent. They do not. A turn with 5,595 characters of visible content is billed
14,002 tokens, which would imply 0.4 characters per token — denser than any real
tokenizer. Claude Code injects per-turn content (reminders, skill and file text)
that never reaches the transcript, so transcript-derived calibration would fit
the estimator to noise. Calibration needs a real tokenizer, not this data.

**Subagent accounting** is unblocked only by a sample: none of the 39 local
sessions contain sidechain traffic, so the field shapes would be guesswork.
