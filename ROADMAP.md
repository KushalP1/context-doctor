# context-doctor roadmap

**Goal:** no one pays for tokens that do nothing. context-doctor measures where context goes on your own machine, in every app you use, and removes the waste at the moments it pays: before it enters the context (pack, overhead), while it sits there (hook, autopilot, compact-window) and after the fact (profile, optimize, savings).

Guiding principles, in priority order: **dead simple for everyone** · **works always, everywhere** · **provably saves tokens, dollars, latency** · **never needs an API key for core function**. Every claim in the README is a measurement on real sessions; an idea that does not survive measurement is closed here with the numbers (see [Closed by measurement](#closed-by-measurement)).

Feedback and votes: [open an issue](https://github.com/KushalP1/context-doctor/issues).

## Where it works today

| Surface | Runs by itself | On request | Gap |
|---|---|---|---|
| Claude Code, terminal and IDE | every-prompt hook, autopilot proxy, compact-window, status line | savings, session, watch, report, pack, overhead, MCP tools, plugin | — |
| Claude Code, desktop app Code tab | hook (incl. cold-resume `/compact` offer), compact-window | same as above | autopilot: the app sets its own API address |
| Claude Desktop chat | standing MCP instructions (now incl. pack_context) | profile_context sketch, pack_context on local files, checkup prompt | no hook API, no transcript on disk ; Desktop's log shows the tools offered on every launch and called once; `doctor` reports both |
| Cursor agent | native postToolUse, postToolUseFailure and sessionStart hooks (delivered from Cursor 3.17) | MCP tools, cursor profiler, editor extension | Cursor's own models never pass through a local process |
| Codex (app, IDE, CLI) | every-prompt hook; autopilot on an API key (`openai_base_url`) | MCP tools (read-only, no approval needed), session | autopilot only with an API key |
| Gemini CLI | every-prompt hook (`BeforeAgent`, with the API's own token counts); autopilot on an API key (`GOOGLE_GEMINI_BASE_URL`) | MCP tools, session, watch, overhead (GEMINI.md and the measured start-of-session cost) | autopilot cannot see Google sign-in traffic |
| claude.ai, ChatGPT, phone apps | standing preferences (`instructions --copy`) | analyze an exported chat | nothing runs there |
| Your own API apps (Anthropic, OpenAI, Gemini) | autopilot or the optimizing proxy; `withContextDoctor(client)` without a proxy (Anthropic, OpenAI and Google Gen AI SDKs) | library: profile, optimize, pack | — |
| CI | `analyze --fail-over-budget`; the GitHub Action (`uses: KushalP1/context-doctor@<tag>`) comments memory-file growth on PRs and gates on a budget | `ci` locally | Not listed in the GitHub Marketplace: it lists only repositories with no workflow files, and the owner chose to keep context-doctor one repository (no separate Marketplace copy) |

## Verified 2026-10-18

- `npm test`: 468 of 468 pass locally (CI runs the suite on macOS, Linux and Windows, Node 20/22/24).
- `scripts/verify-local.sh` for 0.34.0: 43 of 43 checks: build, tests, MCP smoke over stdio and streamable HTTP, OpenAI (now with `prompt_cache_key`) and Gemini proxy smokes, the real Codex binary (0.153.4) through autopilot against a local mock, the published package, Python 3.9/3.11/3.14 with parity fixtures current, every CLI command on the author's real history (no crash, no NaN), install/doctor/uninstall round trip in a throwaway HOME with nothing of ours left, and the GitHub Action's steps; the real ledger was left untouched.

## Next: the cross-platform plan (2026-10-17)

From an audit of the first-run experience, the docs against the code, and each platform's current documentation (sources in the items). Ranked by tokens saved for many users x feasibility; every item ships with a measurement, and anything that does not pay is closed by measurement.

### Usability first (every platform)

| # | Item | Why | How we will know it works |
|---|---|---|---|
| U1 | ✅ **One first screen** (0.33.0) | A bare `npx context-doctor` with no history printed 139 lines of help; the two first commands need a JSON file a newcomer does not have. Show "Start here": plugin, `install`, `savings`, `doctor` | A new user reaches `savings` or `install` without reading the help |
| U2 | ✅ **Plugin and install never both** (0.33.0) | With the plugin enabled, `install` added a second MCP server and skill: every session carried the instructions and tools twice | `install` skips Claude Code when the plugin is on; `doctor` warns on duplicates |
| U3 | ✅ **Fast `npx` start** (0.33.0) | A cold `npx` took 4.5–9.4 s (99–187 packages, mostly the MCP SDK) | Measured after bundling: 0.84–0.95 s cold, one package, no runtime dependencies |
| U4 | ✅ **Strict, helpful CLI** (0.33.0) | Unknown flags were ignored, typos ran the default, bad JSON reported "in good shape", `doctor` exited 0 with failures | Errors name the flag with a suggestion; per-command `--help`; non-zero exits on failure |
| U5 | ✅ **One set of numbers** (0.33.0) | `savings`, `compact-window` and `overhead` counted sessions and the baseline differently (37 vs 80 vs 85 sessions; $3,458 vs $3,173) | The same window gives the same session count and baseline everywhere |
| U6 | ✅ **The right session** (0.33.0) | `session` and the checkup profiled the newest transcript on the machine, not the current one | `$CLAUDE_CODE_SESSION_ID`, then the cwd's project, then newest |

### Claude Code (terminal, IDE, desktop app)

| # | Item | Why | How we will know it works |
|---|---|---|---|
| C1 | ✅ **Autopilot keeps MCP tool search on** (0.33.0) | Claude Code turns tool search off behind a non-Anthropic `ANTHROPIC_BASE_URL`, so autopilot loaded every MCP tool definition on every request ([docs](https://code.claude.com/docs/en/mcp); confirmed in the 2.1.295 binary) | `ENABLE_TOOL_SEARCH=auto` set by `autopilot on` and by the self-heal for existing installs |
| C2 | ✅ **Step aside for native idle compaction** (0.34.0) | Claude Code ≥2.1.290 can compact an idle session itself (`idleCompaction`, account-gated; none on the author's 36 compactions). Read from the 2.1.295/2.1.299 binaries: it fires at 90% of a **1-hour** cache's life (~54 min) on contexts of `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` or more (default 200k, floor 100k); it writes trigger `"auto"`, like a full window, then an informational row "Compacted while idle, before the prompt cache expired". SessionStart on `resume`/`fork` carries `prompt_cache_likely_expired` and `estimated_cache_write_usd` | Shipped: the offer is silent after that row (as after any compaction), and keeps covering 5-minute caches and 150k-200k sessions; a SessionStart hook keeps Claude Code's verdict and price for the first prompt ("still warm" silences the offer); silent past the auto-compact window; the note tells the model to say nothing if a compaction came first (1 of 516 cold returns on the author's history: a 964k session compacted, then the reply offered `/compact`; a 95% gate was dropped because returns at 95-99% went on 2-51 requests before compacting). `compactions` names idle compactions; `compact-window` counts them and keeps a simulated session the idle threshold would not have touched |
| C3 | ✖ **Server-side clearing for API traffic**: closed by measurement (2026-10-18, [below](#2026-10-18-server-side-tool-result-clearing-clear_tool_uses_20250919)) | Anthropic's context editing (`clear_tool_uses_20250919`, `exclude_tools`, `clear_at_least`) clears on the server, which keeps thinking signatures valid where rewriting messages cannot ([docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)) | Replayed with `scripts/replay-server-clearing.mjs`: 7 to 14 of 37 sessions more expensive in every configuration, against none for autopilot |
| C4 | ✅ **`cache-plan` for automatic caching** (0.34.0) | Top-level `cache_control` (automatic caching) and the lower minimum on 5.x models change where breakpoints go. Checked against the prompt-caching docs (2026-10-18): the automatic breakpoint lands on the last cacheable block and moves forward, takes one of the 4 slots (4 explicit + top level, or a different TTL on the last block, is a 400), and is missing only on Bedrock's legacy integration (Opus 4.6 and earlier); the per-model minimums (512 / 1,024 / 2,048 / 4,096) already matched; reads are 0.05x on Opus/Sonnet 5.5 and 0.025x on Fable/Mythos 5.1; a run of tool_use or tool_result blocks is one lookback position | Shipped: the conversation's end is planned as automatic caching (`--explicit` for a block-level one), an app's own top-level field is counted and kept, its 400s are named, legacy Bedrock ids get block-level breakpoints, reads are priced at the model's rate (the sample request on Opus 5.5: $0.080 for 10 calls, not $0.101), the anchor counts lookback positions; the proxy's advisor names automatic caching too |
| C5 | ✅ **`cache-misses`: the cache re-written while warm** (0.35.0) | A request within the cache lifetime that writes most of the context again pays 1.25x (2x at 1 h) instead of the read rate. Definition: consecutive main-chain requests, no `compact_boundary` between, gap under the TTL of both (1 h when `usage.cache_creation.ephemeral_1h_input_tokens` > 0, else 5 min), previous context > 20k, `cache_creation_input_tokens` > 60% of it | Measured on the author's history (every request in the 85 transcripts touched in the last 30 days, back to July): 390 misses in 28,480 warm requests, $1,925 above cache-read price, 28% of $6,851 of cache writes. Rate by model: claude-sonnet-5 10.4%, claude-fable-5 2.8%, claude-opus-4-8 2.2%, claude-opus-5 0.92%, claude-opus-4-7 0.67%, claude-fable-5-1 0.22%, claude-opus-5-5 0.11%; 1.7% above 300k context vs 0.77% below. 381 with nothing visible in the transcript (no model switch, compaction, context edit, API error or >20 new blocks; read share at a miss ~8%, i.e. only the system/tools prefix matched), 8 model switches, 1 after an API error. Counted by request date, the last 30 days alone: 18 misses, $122 (6% of cache writes): the newer models miss far less. The report recommends the version with fewer misses per family when a two-proportion test supports it, `savings` adds one line when misses are significant (10+ and $5+), `--json` gives each model's rate |

### ChatGPT, Codex and the OpenAI API

| # | Item | Why | How we will know it works |
|---|---|---|---|
| O1 | ✅ **Verify and fix Codex autopilot** (0.34.0) | Verified on codex-cli 0.153.4 (ChatGPT app) and 0.154.0-alpha (IDE extension) and openai/codex main: the address is `openai_base_url`, top level of the user's config.toml; `OPENAI_BASE_URL` no longer routes Codex (only the env var set: Codex went to wss://api.openai.com); the key applies to every sign-in, so ChatGPT traffic would follow it. Codex tries Responses over WebSocket first and retried 5 times (~15 s) on the proxy's 502 before falling back | Shipped: `autopilot on` writes `openai_base_url` only when auth.json says `apikey` (not over another address or provider), `off` and the self-heal (sign-in changed) remove it; the proxy answers upgrades with 426 (Codex switches to HTTP at once) and relays a ChatGPT-signed-in Codex to chatgpt.com unedited; `doctor` and `autopilot status` report it. Live: `codex exec` (0.153.4, API key) through autopilot against a local mock of OpenAI exited 0 with the mock's answer, 1 request and 4,000 input tokens in `/stats`, Codex's own `prompt_cache_key` intact |
| O2 | ✅ **ChatGPT connector instructions in the first 512 characters** (0.34.0); `server/discover` open | ChatGPT's MCP guide (checked 2026-10-18): "Keep the most important details in the first 512 characters" of a server's instructions; the page cites the 2025-06-18 spec and says nothing of `server/discover` | Shipped: the three rules that matter in chat already ended inside 512 (at 501 of 698, with 11 to spare); the profile_context rule (with "BEFORE answering", "~30 turns", "Do not estimate token counts yourself") now leads, the three end at 485 of 682, and a test pins them inside 512 so a later edit cannot push them out. `server/discover` waits for the MCP SDK to ship the 2026-07-28 spec |
| O3 | ✅ **`prompt_cache_key` in the OpenAI proxy** (0.34.0); server compaction still open | OpenAI's guide (2026-10-18): on models before GPT-5.6 (GPT-5.5 included) a stable key routes related requests to one cache; from 5.6 on it is optional and only separates accounting. Server compaction (`context_management`) only as an opt-in, since it is lossy | Shipped: a request to api.openai.com with no key gets one per conversation (instructions + first user message), stable across turns; the app's key, GPT-5.6+, `previous_response_id`/`conversation` requests and other upstreams are left alone (`CONTEXT_DOCTOR_CACHE_KEY=0/1`); `/stats` shows `cacheKeysAdded` and OpenAI's `cached_tokens`. Smoke: 15/15 checks. Not measured: the cached-share gain needs keyless traffic on a real key, and Codex, the one OpenAI client on the author's machine, already sends its own key (seen in the live run). Compaction not started |

### Cursor, Copilot, Devin/Windsurf, Gemini/Antigravity

| # | Item | Why | How we will know it works |
|---|---|---|---|
| X1 | ✅ **Cursor: check the guidance arrives** (0.34.0) | Cursor staff confirmed `postToolUse` `additional_context` was dropped (forum, March 2026; still reported on 3.7.36 in June). Since then: Cursor confirmed `postToolUseFailure` delivery on 3.17.8 (August), and the installed 3.18.25's agent runtime turns preToolUse/postToolUse/postToolUseFailure `additional_context` (≤10,000 chars) into carriers attached to the tool result. `sessionStart` takes `additional_context` per the docs (a timing bug dropped it on 3.1.15) | Shipped: `install` adds `postToolUseFailure` and `sessionStart` beside `postToolUse` (the hook answers all three); the hook records the Cursor version it ran under; `doctor` says what that version does (warns below 3.17, asks for a re-install when the fallbacks are missing, and says Cursor does not log what the model saw). `updated_mcp_tool_output` capping closed by measurement (below). Still needs a person: a Cursor agent quoting the guidance in a heavy chat |
| X2 | **GitHub Copilot target** (researched 2026-10-18, not built) | VS Code agent hooks (Preview; `~/.copilot/hooks/*.json`, `.github/hooks/*.json`; reads `~/.claude/settings.json` only with `chat.useClaudeHooks`, off by default) and Copilot CLI hooks (`~/.copilot/hooks/*.json`, `version: 1`). Copilot CLI's `userPromptSubmitted` cannot add context (only `modifiedPrompt`, which config-file hooks lose); `sessionStart`, `postToolUse` and `postToolUseFailure` can (`additionalContext`; `postToolUse` also `modifiedResult`). Neither payload carries a `transcript_path`, so the hook has nothing to measure ([VS Code](https://code.visualstudio.com/docs/copilot/customization/hooks), [CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference)) | Needs Copilot's session store (location and format) before a check can run; then `install` wires `postToolUse`; `doctor` checks it |
| X3 | **Devin Desktop (formerly Windsurf) and Antigravity CLI** (researched 2026-10-18, not built) | Devin's hooks take Claude Code's shape (`UserPromptSubmit`, `hookSpecificOutput.additionalContext`) but give no `transcript_path` and document no user-level file ([docs](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)). Antigravity (CLI, IDE, app) reads `~/.gemini/config/hooks.json`; `SessionStart`/`PreInvocation`/`PostInvocation` inject through `injectSteps` and get a `transcriptPath` (`brain/<id>/.system_generated/logs/transcript.jsonl`), whose format is undocumented; MCP lives in `~/.gemini/config/mcp_config.json` ([hooks](https://www.antigravity.google/docs/hooks/), [migration](https://www.antigravity.google/docs/cli/gcli-migration)). The Antigravity on the author's machine predates both (no transcript.jsonl, MCP in `~/.gemini/antigravity/mcp_config.json`) | Antigravity first: parse a real transcript.jsonl, then `install` wires `PreInvocation`; Devin when it exposes a transcript |

### Measure "no quality loss" directly

| # | Item | Why | How we will know it works |
|---|---|---|---|
| Q1 | **A/B task suite** | Quality is measured indirectly today (re-reads, tool errors, corrections). A small suite of real tasks run with and without each lever, scored on tests passing, turns "no quality loss" into a number. Needs an API key with credit (owner) | Pass rates with vs without, per lever, published with the savings |

## Later / research

- **Claude Desktop chat tool use.** Desktop's log on the author's machine: tools offered in 42 of 44 launches, called once (2026-08-24). Desktop does not log which pages are opened, so chat activity cannot be measured locally; the author's Desktop use shows up as Code-tab sessions (32 this week), which context-doctor serves through the hook. `doctor` now reports these numbers for anyone. Next step needs a person in Desktop: in a chat, ask "what's eating my context?" or run the `context_checkup` prompt, and the log shows whether the call happened

## Closed by measurement

Ideas that were built or specified, measured on real sessions, and dropped because the numbers did not justify them. Newest first.

### 2026-10-18: server-side tool-result clearing (`clear_tool_uses_20250919`)

The idea: let the API clear old tool results itself (context editing, beta `context-management-2025-06-27`), in the proxy and `withContextDoctor`, which keeps thinking signatures valid where autopilot's rewrite can be refused. `scripts/replay-server-clearing.mjs` replays the author's last 30 days (37 Claude Code sessions with 10+ requests, $3,345 billed) three ways, priced as the prompt cache bills: as sent; with autopilot; and with the API's rule simulated (past `trigger`, every request clears all but the last `keep` re-runnable results, so each newly cleared result rewrites the cache from that point on). Autopilot: 11.0% saved, no session more expensive. The API's defaults (100k, keep 3): 9.4% saved, 12 sessions more expensive (worst 47% more). With `clear_at_least` 20k: 9.4%, 7 more expensive (worst 48%). 200k, keep 5, at least 50k: 2.4%, 14 more expensive (worst $27). The rule ignores whether the cache is warm, which is the one thing that makes clearing safe. Not shipped.

### 2026-10-18: capping oversized MCP results in Cursor (`updated_mcp_tool_output`)

The idea: Cursor's postToolUse hook may replace an MCP tool's output, so oversized MCP results could be cut before they enter the context. Cursor's transcripts never record tool output, so the measurement used the author's Claude Code history, which runs the same kinds of MCP servers: 9,064 MCP results in the last 30 days (1,306 transcripts), median ~600 tokens, p99 ~4.3k, largest ~20k; 29 exceeded 10k tokens, and capping them at 10k would have removed ~137k tokens, 1.6% of MCP result tokens. Most of the volume is browser screenshots, which a text cap cannot shrink. Not shipped: a lossy rewrite of content the model asked for, for a saving that small.

### 2026-10-13: distilling noisy tool output in a PostToolUse hook

The idea: Claude Code 2.1.295 lets a PostToolUse hook replace a tool's output (`updatedToolOutput`), so a hook could strip the noise from large results before they enter the context: ANSI codes, carriage-return and progress-bar lines, repeated identical lines, blank-line runs, runs of passing tests, install chatter. Measured on the author's last 30 days (455 transcripts including subagents, 50,803 tool results, ~61M tokens, ~$5.1k at list price counting each result's cache write and every later re-read until compaction), those rules remove 130k tokens (0.2%), about $19. On results over 4k tokens, where the hook would act, they remove 34k tokens, about $3. The large results are content the model asked for and may edit from: `sed -n` and `cat -n` file reads (8.0M of the 13.3M tokens in Bash results over 4k), grep, `git diff` and `git show`. Rules that keep exact text must leave those alone, and the rest is screenshots. Test, build and install output is already trimmed at the command: 96% of 1,226 such commands went through `tail`, `head`, `grep` or a quiet flag, median 95 tokens, none over 4k. The hook would add a ~80 ms process start to ~1,700 tool calls a day to save about $3 a month.

### 2026-10-12: telling the model a re-read file is unchanged

The idea: before a `Read`, say "you already have this, unchanged since turn N". Across 998 reads in 78 sessions (30 days), one returned content identical to an earlier read of the same range in the same session, about $0.10 at list price. Repeated reads of one file were different ranges of a large file. Nothing to save.

### 2026-10-08: a large-paste notice in the hook

The idea: when a prompt itself carries a big paste, tell the model to work from extracted points. Across 2,233 prompts in 75 local Claude Code sessions, 51 carried 5k+ tokens and 10 carried 10k+ (largest 14k), in sessions that run to hundreds of thousands of tokens. A notice cannot take a paste back out of history, so the most it could save is a few percent of a few sessions, paid for with a line of context on every large prompt. `pack` is the better answer: the document never needs pasting.

### 0.18.0: Cursor `beforeReadFile` trimming

The item assumed the hook could rewrite file content. In Cursor 3.18.25 the `beforeReadFile` response validator accepts only `permission: allow|deny` and `user_message`; the local agent runtime reads the same two fields and nothing else. The only inherent action is to deny a read and tell the agent why. Then the measurement, on 735 `Read` calls across 13 real Cursor agent transcripts: Cursor's agent already ranges 82% of its reads (`offset`/`limit`); whole-file reads have a median size of 4.6 KB and a p90 of 26 KB; 6 of 735 reads exceeded ~10k tokens and none exceeded 200 KB. A deny guard would fire on under 1% of reads, save 10-25k tokens each time, and break a workflow whenever its threshold was wrong. Not shipped. Cursor's transcript also never contains tool results, which is why the hook there reports estimated sizes only.

### 0.13.8: `trim-tool-calls` stays opt-in

The question was whether trimming a completed tool call can confuse a live agent.
Across 42 sessions: 73 large writes, 18 later edited, and 16 of those edits had no
read in between — the model built `old_string` from its own `Write` input, at a
median distance of 43 messages (p90: 181). So yes, in about 22% of cases, and far
outside any recent-message window. Default stays off. What shipped instead: the
offline optimizer, which can see the rest of the conversation, now keeps exactly
those writes and trims the 63% that are never touched again.

### 0.13.0: calibrating the heuristic from transcripts

**"Calibrate the heuristic from ground truth"** assumed transcripts record what is
sent. They do not. A turn with 5,595 characters of visible content is billed
14,002 tokens, which would imply 0.4 characters per token — denser than any real
tokenizer. Claude Code injects per-turn content (reminders, skill and file text)
that never reaches the transcript, so transcript-derived calibration would fit
the estimator to noise. Calibration needs a real tokenizer, not this data.

## Waiting on the owner's accounts

| Item | State | Owner's step |
|---|---|---|
| **Sign the `.mcpb`** | Signing is in `build:mcpb` and the release workflow; `mcpb verify` gates the release. Tested end to end with a self-signed certificate | Obtain a code-signing certificate from a trusted CA; add `MCPB_CERT` / `MCPB_KEY` |
| **Publish the extension** | Marketplace metadata, icon, listing and changelog ready; the `vscode-v*` workflow publishes to both marketplaces and attaches the `.vsix` | Create the `gai-ventures` publisher and an Open VSX account; add `VSCE_PAT` / `OVSX_PAT`; push a `vscode-v*` tag |
| **Claim the Glama listing** | A `Dockerfile` at the repo root runs the published MCP server, which passes the full MCP smoke test on both entry points | Sign in to glama.ai with GitHub, claim `KushalP1/context-doctor`; Glama builds the Dockerfile and scores it; the open awesome-mcp-servers PR #15213 then passes its check |
| **Publish the Python package to PyPI** | `publish-python.yml` publishes `python/` by trusted publishing on a `py-v*` tag; the name `context-doctor` is free on PyPI | On pypi.org, add a pending trusted publisher: project `context-doctor`, owner `KushalP1`, repo `context-doctor`, workflow `publish-python.yml`; then push tag `py-v0.1.0` |
| Move repo to the **gAI-ventures org** | Redirects keep old links working | The org owner transfers it on GitHub |

## Non-goals

- **Cloud service / accounts / telemetry**: everything stays on the user's machine, permanently.
- **Silent history rewriting**: lossy changes remain consent-only, with the host model writing summaries.
- **API keys for core function**: optional adapters may accept a key; nothing core ever requires one.

## History: what shipped, newest first

Each release with the measurements behind it. Dollar figures are as measured when the release shipped, with the prices and counting of the time; the 0.32 audit fixed both, and the README's headline figures are the re-measured ones.

## Shipped in 0.32.0: fixed by a local audit (2026-10-13)

<a id="fixed-by-a-local-audit-2026-10-13"></a>

Five reviewers read every module against real data on the author's machine (throwaway HOME for anything that writes); each finding was reproduced before it was fixed and has a test that failed before the fix. Dollar figures in the older releases below were measured with the old prices and the counting bugs listed here; the README's headline figures were re-measured with the fixes (cold-resume offer: 479 returns in 133 days, $2,993 net; autopilot: 12.7% of $11,347, no session worse; a 400k compact window: 50% over 30 days).

| Found | Fix |
|---|---|
| `npx context-doctor install` wrote `npx -y context-doctor-mcp` into every app: no such package exists (404), so the MCP server failed to start wherever a global install did not happen to provide the command; `doctor` said ✓ | The launcher is `npx -y context-doctor mcp`; `doctor` fails the old one (warns when a global install still answers it) |
| `uninstall` left `ANTHROPIC_BASE_URL` on the autopilot port and the service installed, with the hook that restarts the proxy gone: after `npm uninstall -g`, every Claude Code request went to a dead port | Uninstall switches autopilot off (only a service whose plist or unit is in this home), restores the previous base URL, removes state files |
| The optimizer rewrote a message as one string: two parallel tool results and a user's note came out with both outputs under the first call's id and the note gone. Default strategy, so it ran in the optimizing proxy on live requests | Every strategy edits one block at a time; dedupe hashes exact text (indentation is content); OpenAI tool arguments stay valid JSON; prune-history keeps system/developer messages |
| On current Claude models a thinking block's signature binds the history before it: an autopilot clearing makes accounts created on or after 2026-08-31 get a 400 that retrying cannot fix, and cleared ids are re-applied on every later request | The proxy resends the unedited request once on that 400, remembers the account (a hash, never the key), and from then on edits nothing a thinking block follows |
| Autopilot could clear tool results the model had not read yet (the conversation key changed between the first two requests, so the second looked cold); a proxy restart made every warm conversation look cold | Results after the model's last turn are never eligible; the key is stable from the first request; last-request times persist; a conversation with no record counts as warm |
| The proxy kept streaming from upstream after the client left (Esc still paid for the whole answer), and a mid-stream upstream failure ended as a clean 200 with a corrupt body | The upstream request is aborted ~3 ms after the client leaves; a failure after headers destroys the connection |
| The hook started a second, unmanaged proxy when `/health` was slow; the managed one then crash-looped on EADDRINUSE (45 crashes in the author's log) | The hook starts the service through launchd/systemd; EADDRINUSE exits once, cleanly when our proxy already holds the port (`KeepAlive {SuccessfulExit: false}`, `Restart=on-failure`; re-run `autopilot on` to update an existing service) |
| Under autopilot a request with only a Bearer token went to OpenAI: a Claude Code OAuth token could leave for the wrong provider | `sk-ant-` keys and `anthropic-beta` always route to Anthropic; unknown paths under autopilot go to Anthropic |
| Prices were a generation old: Opus 5.5 is $4/$20 with $0.20 reads (priced $5/$0.50), Sonnet 5.x $2/$10 ($3), Haiku 5.5 $0.10/$0.50 ($1), Fable 5.1 reads $0.25 ($1); every cache write was priced 1.25x, while 97% of the author's main-thread writes are 1-hour writes at 2x | Price rows per model; one `usageCost()` prices recorded usage with the 5-minute/1-hour write split; simulations use each session's own write mix. Cache minimums per model in `cache-plan` (512 on 5.x, 4,096 on Opus 4.5/4.6 and Haiku 4.5) |
| Claude Code writes one API reply as several rows: `cache` counted 1,201 requests where there were 541, `subagents` 6,156 calls where there were 3,228 | One request per reply everywhere; a subagent reply's output is its final count, not the first row's partial one |
| `--days` counted any session file touched in the window whole (`tasks --days 1`: $771 printed, $162 in the window); a forked session was counted twice; a session was priced at its first model (a `<synthetic>` first row priced it at $0) | Each request, read, subagent and compaction is filtered by its own time; rows are counted once across files; each request at its own model |
| `report` counted the live proxy's checkpointed savings twice; the dashboard ignored saved proxy history; the dashboard answered any Host header (DNS rebinding) | One lifetime figure for both; loopback Host only |
| `--redact` printed bare file names, subagent briefs, and the session title and path | All masked |
| `pack` followed symlinks out of the folder (a tracked link to `/etc/hosts` was read) and looped on a link to a parent; the Python CLI also ignored `.gitignore` (`.env` included) | Links inside a folder are not followed; each file is read once; the Python CLI reads folders as the TypeScript does |
| The hook's warning never came back after a compaction (the stored level never went down); with a budget under ~80k the file-size fast path hid it; the status line could show a session total as the context | The level follows the context down; the fast path allows for the system prompt and tools; the status line uses only the current request's usage |
| The cold-resume offer assumed the 1-hour cache (65 idle minutes), but Claude Code 2.1.295 often writes the 5-minute one (1,307 main-thread replies in the author's last 3 days), so returns between 10 and 65 minutes to those sessions went unnoticed; `savings` printed a token-weighted share beside a dollar figure | The gate is the last write's lifetime plus 5 minutes (65 minutes when nothing records it); last 14 days: 84 returns and $341 → 94 and $360. The share is a share of dollars (11.4% → 12.7% on the author's 133 days) |
| Smaller ones: Codex `config.toml` edits could duplicate a table; the settings backup was overwritten by our own edits; `doctor` crashed on a damaged autopilot config and missed plugin installs and `disableAllHooks`; `ci` crashed on a folder `@import` and treated an unknown `--base` as empty; OpenAI image parts counted as text (300 KB image → 100k tokens); `OLLAMA_HOST=0.0.0.0` pointed at port 80; `split` collapsed blank lines inside kept code; `session --json --fail-over-budget` never failed; `analyze --json --exact` printed invalid JSON; `cursor <id>` profiled another chat; prompts typed while the agent works were not counted as user turns | All fixed, each with a test |

## Shipped in 0.31.0: save tokens without losing quality

| Item | Why | Status |
|---|---|---|
| **PreCompact hook: compactions keep what the work needs** | Compacting earlier saves tokens only if the summary keeps what the session needs to continue. Claude Code adds a PreCompact hook's output to the compaction instructions (auto and manual; checked in 2.1.295). The hook reads the transcript since the last compaction and pins: files changed, open todos, the user's own instructions and corrections, and build/test/lint commands still failing; it asks for exact identifiers and drops raw tool output already acted on. Facts only, under 2,400 characters. `install` registers it; the plugin carries it | ✅ Tested on fixtures and on a live 500k-token session transcript; installed on the author's machine (`doctor`: Compaction hook ✓) |
| **`context-doctor compactions`: does a session work worse after compacting?** | Before recommending more compactions, measure their cost in quality. For every compaction, the 15 requests before and after on three signals: files re-read that were read before (forgotten), tool errors, user corrections; sample sizes shown | ✅ Author's 90 days: 33 compactions. Tool errors 3.9% → 3.8%, no corrections on either side: no sign of worse work. Re-reads 22% → 52% of reads, but on only 9 and 27 reads (flagged as a weak signal), ~1.2k tokens per compaction |
| **compact-window charges the re-reads** | Its savings left out the files a session fetches again after a compaction | ✅ Each simulated compaction now writes and carries the measured re-read tokens; on the author's 30 days 400k still saves 53% |

## Shipped in 0.30.0

| Item | Why | Status |
|---|---|---|
| **`context-doctor subagents`**: which subagents paid for themselves | The work costs money either way; the question is where it is cheaper. Per subagent, from its transcript and `meta.json` (which names the parent's tool call): its bill, against the same steps done in the parent at the parent's model price, with the parent's context re-read on every step and the subagent's reads carried through the parent's later requests | ✅ Author's last 30 days: 409 subagents cost $2,476 at list price; the same work in the parent ~$14.0k, 408 of 409 cheaper as subagents. Why: subagents start when the parent is already large (median 306k tokens, median 35 steps). A first version that compared the subagent's whole bill to the carried reads alone showed the opposite and was wrong; the test pins the corrected arithmetic |
| **Placeholder models ignored** | Claude Code writes `<synthetic>` as the model of messages it generates itself; five modules took the last model seen, so a session ending on one lost its pricing and window (92 subagents priced at $0 net) | ✅ `realModel()` used everywhere a transcript's model is read |
| **`context-doctor cache-plan <request.json>`** | API apps leave caching on the table or place breakpoints where they cache nothing. Following Anthropic's rules (prefix order tools → system → messages, 1,024-token minimum, 2,048 on Haiku, at most 4 breakpoints, 20-block lookback) it places breakpoints at the end of the tools and the system prompt when each reaches the minimum, on the last block of the conversation, and an anchor when the conversation outruns the lookback; prices the request sent N times; `--out` writes it applied (a string system prompt becomes a block). OpenAI requests get the ordering and `prompt_cache_key` advice instead, since OpenAI caches without markers | ✅ Tests cover placement, the anchor, the 4-breakpoint cap, applying, small and OpenAI requests; the dollar figures match a hand calculation (sample conversation, 20 calls on Sonnet: $0.703 → $0.111) |

### Fixed by a local audit (2026-10-12)

| Found | Fix |
|---|---|
| The autopilot service kept serving the code it started with: on the author's machine v0.25 answered for days after 0.29 was installed | The every-prompt self-heal compares the running proxy's version with the installed build and restarts the service (launchd `kickstart`, `systemctl --user restart`) at most once an hour; `doctor` flags a mismatch |
| `doctor` wrote a fake hook check into the ledger on every run (36 on the author's machine, counted in `report` and the dashboard), and its "Ledger writable" probe could never fail because the writer swallows errors | Write access is tested directly, with no entry; `report` and the dashboard ignore old `doctor-probe` entries |
| `doctor` printed "All good." under a `!` warning | It says "No problems; N note(s)" when there are warnings |
| A verification run wrote a fixture optimize into the real ledger | `scripts/verify-local.sh` runs every ledger-writing command in a throwaway HOME, checked to leave the real ledger byte-identical |

## Shipped in 0.29.0 (the Python package awaits the owner's PyPI step)

| Item | Why | Status |
|---|---|---|
| **`context-doctor tasks`**: cost per commit, per project | Dollars per session say little alone. Each session priced from its recorded usage (input, cache writes 1.25x, reads 0.1x, output) against the commits it made: its own successful `git commit` calls, in whichever repository. A `git log` time window was tried first and dropped: a parent folder's repo showed no commits, a busy repo's unrelated history showed 1,111 | ✅ Author's last 30 days: $10.4k at list price, 40 sessions, 919 commits, $9-20 per commit across projects; 23 of 31 sessions started in `~/tech` committed nothing (research, deploys, browser work) |
| **`context-doctor reads`**: files read into session after session | Agents re-read the same orientation files every session. Counted from transcripts per file: sessions, reads, tokens (images billed as images, not their base64) and the floor of the cost; a file read in most of its project's sessions is flagged as worth a few lines in CLAUDE.md, the rest pointed at `pack` | ✅ Measured on the author's last 30 days: 1,435 reads in 76 sessions, ~2.6M tokens; only 7 files were read in 3+ sessions, 8% of read tokens and about $1.70 at the floor. Cross-session repetition is small there; the larger waste is re-reading within a session (one file read 100 times in 3 sessions), which `session` already flags as `repeated_file_read` |
| **Python package** (`python/`, `pip install context-doctor` once published) | RAG pipelines chunk and stuff context in Python. The port gives them `pack_context`, `pack_documents` (LangChain documents, LlamaIndex nodes, strings, duck-typed: no dependencies), `estimate_tokens`, a message `profile_messages`, and `python -m context_doctor pack` | ✅ Parity with the TypeScript, byte for byte: 42 token estimates, 19 number formats, 579 chunks across 14 chunkings (markdown, code, logs, Unicode, one-line logs), 7 full packs and their rendered output. Tested on Python 3.9, 3.11 and 3.14 here; CI runs 3.9 and 3.13 on Linux, macOS and Windows and fails if the fixtures fall behind the TypeScript. Wheel built and installed in a clean venv. Publishing waits on the owner's PyPI trusted publisher |

## Shipped in 0.28.0

| Item | Why | Status |
|---|---|---|
| **Plugin skills** `/context-doctor:overhead` and `/context-doctor:pack` | Most Claude Code users install the plugin; the two newest levers were CLI-only there | ✅ |
| **`pack` reads folders as git does** | A folder inside a repository is listed with `git ls-files` (tracked plus untracked-not-ignored), so `.gitignore`'d build output, data dumps and secrets never enter a pack; outside git the old walk remains | ✅ Test on a scratch repo |
| **`withContextDoctor` for Google's `@google/genai`** | `models.generateContent` / `generateContentStream` get autopilot in process. Only the history field is cloned now, so an `AbortSignal` or callable tools in a request's config pass through | ✅ Unit test plus the real SDK against a local mock (a cold return went out at 183k of the app's 482k chars) |
| **`overhead` for Codex and Gemini CLI** | Each agent's start-of-session cost from the API's own counts (Codex token_count events, Gemini promptTokenCount); Codex's AGENTS.md-as-user-message counted as overhead; priced with each provider's cache rules (no write premium on OpenAI or Google); memory files and `overhead split` priced at the loading agent's rate | ✅ Tests; on the author's machine 2 Codex sessions start at ~15k tokens |

## Shipped in 0.27.0

| Item | Why | Status |
|---|---|---|
| **`pack` / `pack_context`**: only the chunks of big files a question needs | The cheapest token never enters the context. A 60k-token manual pasted to answer one question is paid on that message and every one after it. Chunks follow the document (headings, code declarations, paragraphs), BM25 ranks them, a budget caps them, ids and line ranges let the model ask for more; no query returns an outline. Offline, no key. Over HTTP the tool reads no files | ✅ CLI + MCP tool + library. On this repo (README + src, ~305k tokens): 9 of 10 questions answered from a 2k-token pack (0.6%) |
| **`overhead`**: what every request re-reads before your message | Front matter (system prompt, tools, MCP schemas, skills, CLAUDE.md, rules, auto memory) is re-read on every request and re-written after every cold start; transcripts never show it. Measured from each session's first request, memory files found per agent (Claude Code, Codex, Cursor, Gemini CLI) and priced per month from your own request and cold-start counts | ✅ On the author's last 30 days: 71 sessions start at a median ~54k tokens; re-measured on 2026-10-17 at current list prices, each 1k tokens of it costs ~$5.89 a month and the auto-memory index (~3.6k tokens by then) ~$21 a month |
| **pack reads PDFs, Word, PowerPoint and ODT** | Most big documents people paste are PDFs and Word files. No new dependency: `pdftotext` where installed, PDFKit (via `osascript`) and `textutil` on macOS, `unzip` for docx/pptx/odt elsewhere; a reason naming what to install when nothing works | ✅ Tested with a generated PDF through both pdftotext and the PDFKit fallback, and a docx through textutil |
| **MCP schema tax in `overhead`** | Each MCP server's tool definitions ride on every request; transcripts never show them. Calls per server come from the transcripts (including servers the app or connectors provide, which no config lists); `--mcp` launches each configured server once and sizes its definitions; unused servers are flagged with their monthly cost. Claude Code's tool search defers definitions, and the report says when it does | ✅ Author's machine: tool search in 49 of 75 sessions, so definitions are mostly deferred; 15 app-provided servers seen. context-doctor's own definitions trimmed to stay under a tested 2,400-token cap |
| **`overhead split <file>`** | Turns a finding into a fix: a memory file's large or code-heavy sections move word for word to `<name>.reference.md`, leaving one pointer per run of moved sections (a plain path, read on demand, not an @import). Link-list sections are indexes and stay; an auto-memory `MEMORY.md` keeps only its index. A plan first; `--write` backs up the original | ✅ On a copy of the author's auto-memory index: ~3.4k → ~1.7k tokens a request (~$10 a month at ~$5.89 per 1k tokens), every line kept |
| **`withContextDoctor(client)`**: autopilot inside the app | API apps that cannot route through a local proxy (serverless, edge, managed hosts) wrap their Anthropic or OpenAI SDK client instead. Same AutoClearer as the proxy; the request is cloned first so the app's own history is never rewritten; a conversation the process has not seen counts as warm, so a fresh instance never clears blind | ✅ Unit tests plus a run with the real `@anthropic-ai/sdk` and `openai` packages against a local mock: create and stream, chat and responses; a cold return went out at 135k of the app's 354k chars |
| **Gemini CLI** | Gemini CLI 0.63 has hooks in Claude Code's shape (`BeforeAgent` is its prompt hook, `hookSpecificOutput.additionalContext` reaches the model) and records the API's promptTokenCount on every reply. `install` wires the MCP server and the hook in `~/.gemini/settings.json` (detected by settings.json, `~/.gemini/tmp` or `gemini` on PATH, not by `~/.gemini` alone, which Antigravity also creates); `session`, `watch` and the hook read its chats, rewrites by id and `$rewindTo` included; `doctor` checks it | ✅ Formats read from the 0.63.0 package; tests cover parsing, the hook's BeforeAgent answer, install and uninstall |
| **Gemini API in the proxy and autopilot** | The proxy routes Google's API (by `x-goog-api-key`, `/v1beta` paths or `models/<m>:generateContent`) to `generativelanguage.googleapis.com`, reads exact usage from `usageMetadata`, and autopilot clears stale `functionResponse` parts on `generateContent` / `streamGenerateContent` when the cache is cold (Gemini CLI's tools added to the clearable list; ids derived per conversation when Gemini gives none; implicit caching's lifetime is unpublished, so an hour is assumed, the longer guess). Reaches Gemini CLI on an API key via `GOOGLE_GEMINI_BASE_URL`; Google sign-in traffic goes to another endpoint | ✅ `scripts/smoke-gemini-proxy.mjs` against a local mock: 8 checks (routing, key header, streaming, 5 of 8 stale results cleared, calls kept paired, usage). All three smoke scripts now run in CI |
| **GitHub Action + `context-doctor ci`** | Memory files are a standing cost nobody reviews. `ci --base <ref>` compares CLAUDE.md, AGENTS.md, GEMINI.md, `.claude/rules`, always-applied Cursor rules and their `@imports` at HEAD against the base commit (via `git show`), prints a table and exits 1 over `--max-tokens` / `--max-increase`. `uses: KushalP1/context-doctor@<tag>` runs it on pull requests: job summary, one PR comment it keeps updating (found by a hidden marker), optional dollar figure from `requests-per-day` | ✅ Unit tests on a scratch repo; the action's step simulated locally; `memory-check.yml` runs the action on this repo's own PRs from the local build. Not listed in the GitHub Marketplace (see the CI row under Where it works) |
| **`pack --semantic`**: rank by meaning too, with a local Ollama | Keyword ranking misses paraphrase. With Ollama and an embedding model installed, the question and chunks are embedded and the two rankings merged by reciprocal rank fusion; chunk vectors are cached on disk by model and text hash. Opt-in, never required: without an embedding model pack stays lexical and names the command to run. Also `semantic: true` on `pack_context` | ✅ Tests against a fake Ollama: a query sharing no word with the answer is found, the second run embeds only the query, missing model and missing Ollama are notes. Real-model eval pending an embedding model on the author's machine |
| Standing MCP instruction 5 | Chat apps and agents learn to call pack_context instead of reading a big file whole; the instructions stay under their 700-char cap | ✅ |

## Shipped in 0.26.0 — checked on every platform

Each surface driven for real, not only through unit tests: the MCP server on every launch path (local build, plugin bundle, `mcp` subcommand, the published npm package, HTTP, the `.mcpb`), Claude Desktop's own MCP log, Claude Code 2.1.62 and 2.1.288 with the plugin installed from GitHub, Codex 0.153 running a real `codex exec` on GPT-5.5, Cursor 3.18, VS Code 1.133 activating the extension, and the proxy against a mock of OpenAI's Chat Completions and Responses APIs.

- **Cursor's agent never received the guidance.** Cursor runs Claude Code's `UserPromptSubmit` hook as `beforeSubmitPrompt`, whose output can only allow or block a prompt (Cursor's hook docs); the 0.15 claim that its output was accepted was wrong. `install` now adds a native `postToolUse` hook to `~/.cursor/hooks.json`, whose `additional_context` reaches the model; the hook answers in Cursor's format, ignores Cursor's other events (so the once-per-growth warning is not spent on output Cursor drops), and `doctor` checks it. Cursor's transcript records tool calls but not their output (1,163 calls, no results, in the author's largest chat), so the note gives the accumulated size without a window share or price.
- **Codex would not run the MCP tools non-interactively.** `codex exec` found the server and the model called `context_best_practices`, but Codex refused: "MCP tool call requires approval, but approval policy is never". Every tool is now annotated `readOnlyHint`, non-destructive, idempotent and closed-world; the same run completed.
- **Autopilot skipped the tools agents use most now.** Codex's code mode runs everything from one `exec` cell (its most-used tool on the author's machine, 284 calls) and polls with `wait`; Cursor uses `SemanticSearch`, `ReadLints` and `AwaitShell`. All added to the re-runnable list.
- **"~8.5M tokens (2136% of the window)".** A history imported into Codex carries no API token counts, so the hook estimated from the transcript and quoted a share and price. An estimate past the window (or 1M with no known model) now says the app is already trimming.
- **Chat-app settings paths**: claude.ai keeps preferences under Settings > General, and ChatGPT's field is "What traits should ChatGPT have?".
- `proxy --autopilot` printed the optimizing mode's banner. `scripts/smoke-mcp.mjs` and `scripts/smoke-openai-proxy.mjs` make the end-to-end checks repeatable.

## Shipped in 0.25.0 — compact earlier, without anyone following advice

Measured first: since 0.22 the hook had offered `/compact` 33 times on the author's machine when a large session came back after the cache expired. It was followed once. The offer went only to the model, which mostly did not raise it, and advice that is not taken saves nothing.

- **The cold-resume offer is shown to you.** The hook now returns a `systemMessage` beside the model's note, with what the message you just sent cost (the whole context re-sent at the cache-write rate) and how much cheaper each later message gets after `/compact`.
- **`context-doctor compact-window`**: Claude Code auto-compacts near the full window (median 970k tokens over 31 compactions, measured), and has a native setting, `autoCompactWindow`, to compact as if the window were smaller. It is a settings key, not an environment variable, so the desktop app honours it, unlike autopilot's `ANTHROPIC_BASE_URL`. The command replays every session request by request at 200k-800k, both arms priced as the cache bills, each simulated compaction charged its request and a 20k-token summary at the output rate, and real compactions and rewinds keeping the arms in step. On the author's last 30 days: 55% less input cost at 400k, for 14.7 compactions a week instead of 5.1. It sets a window only when you name one, keeps a backup, and `off` undoes it. The replay's baseline came within 9% of billed usage, on the low side.
- **`savings` shows it as a third lever**, using the window you have set or 400k as an example.
- **`report` shows whether the offer is acted on**: offers, and how many a compaction followed within the hour (3 of 34 on the author's machine, counting Claude Code's own auto-compactions), and points to `compact-window` when it is rarely followed. Also fixed: on Windows, `report` never matched recent sessions to their hook history (it split paths on `/` only).
- **Plugin skill `/context-doctor:compact-window`**: compare sizes and set one from inside Claude Code, only on the user's say-so.

## Shipped in 0.24.0 — a module-by-module audit

Each module checked against real data and hostile input, not only its tests:

- **Session parser rebuilt API messages.** Claude Code writes one transcript row per content block; the parser emitted one message per row (3,604 rows for 1,765 replies in one session). Exported conversations broke tool_use/tool_result pairing in 9 of 13 real sessions, profiles carried extra per-message overhead, and `keepRecent` protected fewer real turns. Consecutive same-role rows now merge as the API merges them, and rows of a reply rejoin it by message id even when parallel tool calls interleave with their results. 12 of 13 sessions now pair cleanly; the 13th has a tool call interrupted before it returned. Usage is sampled once per reply.
- **Optimizer verified**: across those sessions and the sample, 4 strategy sets x 2 settings, it introduced no pairing errors.
- **Proxy**: non-conversation endpoints (`/v1/models`, `/v1/files`) returned 404 through it, so a client under autopilot lost those features; they are now forwarded by the request's own headers. Every body was decoded as UTF-8 and re-sent, corrupting binary uploads; untouched bodies now pass byte for byte. Streaming, client aborts and an unreachable upstream (502) were already correct.
- **Dashboard and report overclaimed**: MCP sketches shared one session id, so a big sketch followed by a small one of another chat counted as savings; and compaction shrinkage was added into "tokens context-doctor saved". Both fixed; shrinkage is shown on its own.
- **`watch`** read plain conversation JSON files as empty sessions; it now follows them.
- **MCP**: sketch inputs bounded (1e9 turns produced "1000515000.0M tokens"); `keep_recent: 0` accepted as on the CLI; token counts read billions as B.
- **Tests**: a savings fixture used fixed September dates and fell out of the 30-day window on 3 October; fixtures are relative now, and the watch test waits for output instead of sleeping.
- **Checked clean**: all 178 local sessions and rollouts and 20 Cursor chats parse and profile without error; MCP tools reject malformed arguments with clear errors; the dashboard, `experiment --dry-run` and the editor extension work.

## Shipped in 0.23.0 — audit fixes and the share loop

- **Security:** 4 transitive vulnerabilities under the MCP SDK patched (fast-uri high; hono, qs, ip-address moderate). hono's `parseBody` memory exhaustion applied to `context-doctor-mcp --http`. `npm audit`: 0.
- **Cold resume after /compact:** the hook read the last reply's usage even when the session had been compacted since, so coming back hours after `/compact` warned about the old (e.g. 800k) size of a now-small context. It now stops at a compact boundary. (Found by reading the code; the live note fired correctly on this session at 807k after 43 idle hours.)
- **Autopilot's cleared-output note** no longer says "run the tool again": a cleared Bash result can be from a push or a delete. It now says to repeat only read-only calls.
- **CLI input:** numeric flags validated (`--days abc` printed "NaN days"; a bad `--port` started the proxy on a random port); unknown commands are named.
- **`savings` fits 80 columns** (it ran to ~95 and wrapped); **`savings --share [--copy]`** prints totals only, tested to contain no project names or paths; the README shows the real output as a rendered terminal image (`scripts/render-terminal-svg.mjs`).
- **Checked:** every CLI command in a clean home (no crashes, no stack traces); install/doctor/uninstall round trip with existing user settings (kept intact, ours fully removed); README and roadmap anchors; hook time on the three largest real sessions (0.12–0.16 s per prompt, 0.8–1.7 s on a full re-parse of 86–343 MB).

## Shipped in 0.22.0 — an audit of what actually works, and a lever that does in the desktop app

Asked: "make it better, make sure everything works." Audited on the author's machine first:

- **Autopilot had seen 0 requests in 4 days.** Every session there runs in the desktop app's Code tab, and Claude Code there (2.1.284) is host-orchestrated: the app sets `ANTHROPIC_BASE_URL` from its own account config and `filterSettingsEnv` drops the same key from settings files. `doctor` reported ✓ regardless. Now `autopilot on`, `status` and `doctor` read which surface recent sessions ran in and say when autopilot cannot reach them; the README no longer claims the desktop app.
- **Cold-resume advice (new).** The every-prompt hook does run in the desktop app. When a prompt arrives more than 65 minutes after the last reply on a session over 150k tokens, the cache has expired and the message re-sends everything at the write rate; the hook gives the model the numbers and it offers `/compact` once. Replayed over 133 days: 401 such returns, $4,053 net saving had the user compacted after the first reply ($914 a month), positive in 296, worst −$2.30. Claude Code 2.1.284 ships a flag-gated server-side "tool result clearing after idle" with the same 65-minute rule; this is the user-side version that works today.
- **`savings` window fixed**: "last 30 days" counted the whole history of any file touched in the window (0.21 showed $11,205; the true 30-day figure was $6,006). It now also separates surfaces autopilot can and cannot reach and reports the cold-resume opportunity.
- **Cost quoted at the wrong rate**: the hook priced a cached session's per-message cost at the uncached rate (10x too high), and `report` and autopilot's counter priced cached tokens at the full input rate. Both now use the cached rate.
- **Checked live on every surface**: this Claude Code session's MCP tool (sketch), the published npm package in a clean home (`savings`, `doctor`, `npx -y context-doctor mcp`), Codex (`codex mcp list` shows it enabled), Cursor's config, a fresh plugin install from GitHub (MCP `✓ Connected`), the Claude Desktop MCP server (connected; the model has not called it since 0.17, so chat apps remain a nudge). `--version` was missing, and is added.

## Shipped in 0.21.0 — see it before you install it, install it where you already are

Asked: "can we make anything better so more people download and use this?" Measured first: downloads were rising (350 on 25 Sep), but npm search ranked context-doctor outside the top 50 for every generic query ("claude code context", "context window", "token usage"), so new users were not finding it by searching, and a first run printed help text.

- **`context-doctor savings`**, and a bare `context-doctor` in a terminal: every recent Claude Code session replayed through the shipped AutoClearer; the share it would save is applied to the input the transcripts show was actually billed, so the headline is a fraction of the user's real spend. 53 sessions in ~9 s here: $11,205 billed, $1,396 (12.5%) cut, 0 sessions worse.
- **Claude Code plugin.** The repo is its own marketplace. Found by installing from GitHub into a sandboxed Claude Code 2.1.62: older versions reject unknown manifest keys (`displayName`) and do not install a plugin's npm dependencies, so the MCP server ships as one self-contained bundle (`dist/mcp.bundle.js`, 417 KB, not in the npm package), and Claude Code reported it `✓ Connected` with zero node_modules. Plugin-only skills `/context-doctor:savings`, `:checkup`, `:autopilot`; the plugin hook stays silent when the npm install's hook is also present.
- **Official MCP Registry.** `server.json` (validated by the registry's own tool), `mcpName` in package.json, a `context-doctor mcp` subcommand so `npx -y context-doctor mcp` works, and a release job that publishes by GitHub OIDC after npm, with no secret.
- **`npm version` syncs every version string** (server.json, the MCP server, the proxy), rebuilds `dist/` and stages it, so a release is one command.
- **Fixed:** with autopilot off, the every-prompt hook health-checked port `undefined` and printed a Node deprecation warning, and `autopilot status` would have reported a dead proxy instead of "off".

## Shipped in 0.20.1 — releases that finish themselves

- **One tag, every channel.** `v*` tags run the suite, publish to npm through trusted publishing (npm is restricting tokens that bypass 2FA, so the workflow authenticates by OIDC and needs no stored token), and create a GitHub release with the Claude Desktop bundle attached, its notes taken from this file. A missing secret is a notice, not a red run (the v0.17.0 tag failed red for exactly that).
- **Signed Desktop bundle, when a certificate exists.** `build:mcpb` signs with `MCPB_CERT` / `MCPB_KEY` (PEM files or text) and requires `mcpb verify` to pass, which chains the certificate to the OS trust store the way Desktop does. Found while testing: a self-signed certificate never passes `verify` by design, so the self-signed mode (`MCPB_SELF_SIGNED=1`) checks the signature block instead and is for pipeline tests only. The bundle now carries an icon.
- **Extension 0.2.0, marketplace-ready**: icon, categories, listing README and changelog; `vscode-v*` tags publish to the VS Code Marketplace and Open VSX when their tokens exist and always attach the `.vsix` to a release.

## Shipped in 0.20.0 — autopilot: lean context in every terminal and IDE Claude Code session, never more expensive

Asked: "auto-optimize every session I run, and make sure performance only improves." Measured before building:

- **The existing proxy strategies failed the bar.** Replayed over 33 real sessions with cache pricing they saved 6.7% overall but made one session 13% more expensive: editing history the cache holds re-bills everything after the edit.
- **Where the cost is:** 94% of input cost came from requests above 200k tokens (53% above 600k), in 1M-context sessions.
- **Claude Code already contains the right idea**: a "microcompact" that clears old tool output (keep 3, clear 40k+ batches), switched off by a server-side flag on this account (42 unexplained prompt drops in 19,769 requests), and an API context-management option compiled out.
- **AutoClearer** follows that design with one change for "never worse": batches are taken only when the cache is cold anyway (idle past the request's own TTL, 1 hour here; 444 of 19,824 gaps). Replaying every session through the shipped class: 9.8% less cache-weighted input, no session worse. Warm-cache payback rules gained 0.1% and lost on one session, so they are opt-in.
- **Service + wiring**: launchd / systemd --user / logon task; `/health` must answer before settings.json is touched; the hook restarts a dead proxy before the prompt's request (0.6 s, measured); `pause` is an instant passthrough. Overhead 7 ms on a 2.9 MB request. Verified that settings.json `env` overrides the base URL the desktop app injects.

## Shipped in 0.19.0 — Claude counts ~40% more tokens than the estimator assumed

Picked up as "calibrate the sketch against exact usage"; the calibration found a bigger problem underneath.

- **Measured, with no key.** Two exact signals already sit in Claude Code transcripts: a reply with no thinking block is billed as exactly its `output_tokens` (504 replies: 2.75 chars/token on prose), and a single large appended block is exactly the prompt growth minus the previous reply (474 blocks: 2.4 on code and tool output). They agree across Opus 4.7 to 5.x, Fable 5.x and Sonnet 5 within ±9%. The provider-neutral 4.0 / 3.2 the tool used undercounted Claude by ~1.45x on prose and ~1.33x on code.
- **Codex was the planned source and could not be one**: rollouts truncate tool output before the model sees it, so prompt growth does not isolate a block. OpenAI keeps 4.0 / 3.2, labelled as not re-measured.
- **Per-provider estimator** (`estimateTokens(text, model)`), with the model taken from the request's own `model` field when not given; profile, optimize (savings and trim budgets), accuracy and the sketch use it.
- **Three behaviours the old constant broke**: the hook's byte fast path assumed 4 bytes/token and could skip Claude sessions already past the warning line; the proxy gated cache advice on 4,000 chars and missed 1,024 to ~1,670-token prefixes; `accuracy` blamed the estimator's gap on invisible content (coverage now 56%, was 39%).
- **Calibration files are versioned** so a factor learned against the old heuristic is not stacked on the new one.
- **`accuracy` gained a tokenizer check** that re-runs both measurements per model on the user's own sessions.
- **The sketch** now sizes in measured chars (exchange 2,060, code line 42, log line 56, word 6.3) converted per model, and states its measured error (total from turn count -20% to +9%; code by lines ±25%) instead of ±30%.

## Shipped in 0.18.0 — the proxy on a public URL

- **`proxy --token <secret>`** (also `CONTEXT_DOCTOR_PROXY_TOKEN`). Every path except `/health` must start with `/t/<secret>/`, compared in constant time, stripped before routing; a wrong or missing prefix is a 401 with no upstream call. This is the prerequisite for the Cursor BYO-key item: in Cursor 3.18.25 the OpenAI base-URL override is sent to Cursor's backend inside the model configuration and Cursor's *servers* call it (only the key-verification ping is client-side), so the proxy must be on a public URL, and an unauthenticated relay must not be. Cursor can set a URL but not a header, so the secret rides in the path. README documents the tunnel + Cursor settings path.
- Not available to us: Cursor's "local mode" (`CURSOR_LOCAL_AGENT_BASE_URL`, client-side inference against any OpenAI-compatible gateway) is compiled to `localMode: false` in the consumer build.

## Shipped in 0.17.0 — Claude Desktop, as far as it can go

- **Why the tool was never called from chat.** Desktop's log showed zero `tools/call` in a month with the server loaded. The instruction said "call profile_context", but the tool's only input was the full conversation JSON, which a chat model cannot export and would have to re-type. An impossible instruction is not a nudge.
- **`sketch` input**: turn count plus the blocks that matter (large, repeated, stale, image, base64) with one size hint each, ~120 output tokens. The server sizes it, prices the per-turn re-read, ranks findings and tells the model to apply the top one. Server instructions, tool description and the `context_checkup` prompt all point chat apps at it.
- **Confirmed in the app bundle (v2.2553)** that Desktop's `LocalMcpServerManager` reads server `instructions`, so the standing rules do reach the model. Also confirmed, again, that there is no hook API and no transcript on disk; the README now says "the rules ride in every chat and the checkup is one cheap call away", not "inherent".
- **`context-doctor instructions --copy`**: the same rules for claude.ai / ChatGPT per-account preferences, read on every turn on web and phones where no server runs.
- **`.mcpb` bundle** (`npm run build:mcpb`, 3.1 MB, validated in CI and uploaded as an artifact): one-click install through Desktop's Extensions UI on Desktop's own Node, no npm.

## Shipped in 0.16.0 — GPT, through Codex

| Item | Why |
|---|---|
| **Codex support** | Asked: "can we make it work for GPT?" The ChatGPT chat UI cannot be made inherent (no MCP, no hooks, no data path; checked). Codex can: the agent bundled in ChatGPT.app (binary 0.153.4), the IDE extension and the CLI implement Claude Code's hook contract almost verbatim (`hooks.json`, `hookSpecificOutput.additionalContext`, `transcript_path`), `[mcp_servers.*]` in `config.toml`, and `SKILL.md`. `install` wires all three; rollouts parse with the API's own usage (40/40 real sessions, tool timings via `call_id`); `session --list` includes them; `doctor` checks them. Codex's one-time hook trust (`/hooks`) is stated at install |
| **`config.toml` editing without a TOML library** | The file is the user's. Everything outside `[mcp_servers.context-doctor]` is copied byte for byte; re-running replaces rather than duplicates; removal restores the file. Tested with our table first, last and in the middle |

## Shipped in 0.15.0 — what actually runs by itself, and one surface that now does

| Item | Why |
|---|---|
| **Cursor inherent** | Cursor's Hooks Service loads `~/.claude/settings.json`, maps `UserPromptSubmit` onto `beforeSubmitPrompt`, passes a `transcript_path`, and accepts Claude's nested `additionalContext` (compat hard-coded on, 10k cap). Our hook had been firing on every Cursor prompt and returning nothing, because Cursor's `{role, message:{content}}` transcript shape did not parse. One parser addition: against a real 976KB Cursor transcript, 691 messages and guidance naming a 283k-token context |
| **Desktop instruction is action-shaped** | From "offer to run profile_context" to "past ~30 turns / 3+ large pastes / any cost question, call profile_context BEFORE answering". Still ~150 tokens. Plus a `context_checkup` MCP prompt in Desktop's + menu |
| **README says which surfaces are inherent** | Claude Code, Cursor and the proxy act without the model's cooperation; Claude Desktop is a strong nudge; ChatGPT is on-demand only. The previous "every chat inherently better" was true for fewer surfaces than it implied |

## Shipped in 0.14.3 — the editor extension

| Item | Why |
|---|---|
| **VS Code / Cursor extension** (`vscode/`) | The last roadmap item. Live context, share of window and cache share in the editor's status bar, from the newest Claude Code transcript for the open folder; warning colour past a configurable threshold; click to run `session`. Self-contained (no dependency on the npm package, so it works on a machine that never installed it), pure core with its own tests, built and packaged in CI, installed and verified in both VS Code and Cursor locally. Marketplace publishing is the owner's step |

## Shipped in 0.14.2 — subagents were never in the transcript

| Item | Why |
|---|---|
| **Subagent accounting** | Blocked for weeks on "no sidechain entries in any transcript". Wrong place to look: Claude Code writes each subagent to its own file under `<session>/subagents/`. 195 of them on one machine, 19 sessions, final contexts summing to 28M tokens, about $1,844 at list price, none of it ever shown. `session` now lists them with task, calls, final context, duration and cache-aware cost, compares the total against the parent's own total input cost, and flags subagents that ended above 200k tokens |

## Shipped in 0.14.1 — context health where the work happens

| Item | Why |
|---|---|
| **Claude Code status line** | `install --statusline` wires `context-doctor statusline` into Claude Code's `statusLine`, so live context vs window, a warning from 70%, cache share and cost sit in the status bar while you type. Reads the status payload when Claude Code provides the size, else the last 256KB of the transcript (~1ms; 80ms end to end). Never overwrites a status line you already have; uninstall removes only its own; any failure prints nothing. The roadmap's "editor status bar", for the editor most users of this tool are in |

## Shipped in 0.14.0 — the experiment the critics asked for

| Item | Why |
|---|---|
| **`context-doctor experiment`** | The one honest answer to "does a smaller context actually help": the same task, from the same commit, in a fresh session and forked from an existing one (`--resume --fork-session`, so the real session is untouched), same model and tools, with the bill, cache split, wall clock and a `--check` pass/fail side by side. The verdict weighs cost against passing, because a cheaper failure is not a saving. It is the only command that spends money, so it caps spend per arm, refuses a dirty tree, refuses to run inside Claude Code, and has a dry run. Tested end to end against a stub `claude` |

## Shipped in 0.13.9 — the estimator learns from your own exact counts

| Item | Why |
|---|---|
| **Calibration from `--exact`** | Shipping a tokenizer would break the no-key, no-dependency default, and transcript deltas cannot calibrate anything (see 0.13.0). What can: the one clean comparison a user makes when they run `analyze --exact`, a true count for the exact bytes just estimated. That ratio is now remembered per model family on this machine and applied to later estimates, printed in the profile header so scaled numbers never pass as raw. Out-of-range samples are ignored; an env switch disables it. Tests run with it disabled by construction, via a runner script that also stops a new test file from being left out of the suite |

## Shipped in 0.13.7 — the advisor says where

| Item | Why |
|---|---|
| **Cache breakpoint placement** | The proxy used to say a breakpoint was missing. It now says where: for a large system/tools prefix, the last tool definition (or last system block); for the conversation, it fingerprints each message across consecutive requests, finds the run that was byte-identical to the previous call, and names the exact message to mark along with the tokens that run re-bills each turn. Only when the run clears Anthropic's ~1024-token caching floor, and never for a request that already carries `cache_control` |

## Shipped in 0.13.6 — two small roadmap items, one measured

| Item | Why |
|---|---|
| **Trim step is a documented knob, not a magic number** | Tried to find "the right" step as a function of conversation size. Measured instead: at 400 turns, step 10 → 21% of turns invalidate the cache with ~2 stale results waiting; 20 → 12% and ~4; 40 → 10% and ~9. Adaptive steps were worse everywhere because a changing step moves the boundary itself. So: default stays 10, `trimBoundaryStep` in `.contextdoctorrc` and `OptimizeOptions`, numbers in the README |
| **Windows sandboxing is structural** | One shared `sandboxEnv`/`withSandboxHome` helper and a guard test that reads every test source and fails the suite if any sets HOME without USERPROFILE. Verified it bites by planting an offender |

## Shipped in 0.13.5 — the two things r/ClaudeCode asked for

| Item | Why |
|---|---|
| **Where the time goes** | `session` now reports wall clock per tool from the timestamps on every transcript entry (tool_use → tool_result). On one real session: Bash was 87% of 146 minutes of waiting, median 1.3s, slowest 22.5m. The caveat travels with the number: the gap includes waiting on permission prompts. The concern that it would also contain model generation turned out not to apply: the model has finished emitting the call before the call's own timestamp is written, and its next turn starts after the result's |
| **Retry vs re-read** | Identical tool calls split by what happened to the previous attempt. Measured across 42 sessions: 15 retries (1 loop of 3+) against 151 re-reads, so ~90% of "repeated calls" were the model forgetting it already had the answer, and the old advice ("cache results") was right for those and wrong for the retries, where the answer is in the first error |

## Shipped in 0.13.0 — measurement, presets, and a cache bug

| Item | Why |
|---|---|
| **`context-doctor accuracy`** | Answers "why is my bill bigger than the profile?" with evidence: the fixed harness baseline (~51k tokens here) and the per-turn injected content the transcript never records. The roadmap asked for a tokenizer benchmark instead; that turned out to be unbuildable from transcripts alone, and [Closed by measurement](#0130-calibrating-the-heuristic-from-transcripts) says why |
| **`context-doctor diff`** | Two profiles side by side — category movement, findings resolved or introduced, money and latency. Optimization no longer has to be taken on trust |
| **`context-doctor init <preset>`** | `chat`, `agent`, `batch`. The budget feature went unused because an empty rc file is useless until you already know your numbers |
| **Shell file reads** | `cat`/`head`/`tail`/`less` count as reads. 16 real findings across 6 local sessions that were previously invisible |
| **Cache-aware trimming** | The trim boundary moved every turn, invalidating the prompt cache on 22 of 24 turns and paying the 1.25x write price to save a few hundred tokens. Quantized: 8 of 24, trimming undiminished |

**Subagent accounting** was blocked at this point, waiting for a sample: none of the 39 local sessions contained sidechain traffic, so the field shapes would have been guesswork. (Resolved in 0.14.2: Claude Code writes each subagent to its own file.)

## Shipped in 0.12.0 — durability and the biggest real waste

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

## Shipped in 0.9.x: since v1.0 planning

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

## Shipped in 0.8.0: platform (planned as v1.0)

| Item | Why | Status |
|---|---|---|
| **Context budgets** (`.contextdoctorrc`) | Per-project thresholds; nearest-file discovery, enforced by the hook, reported by analyze/session, defaults feeding optimize/proxy | ✅ |
| **Local dashboard** (`context-doctor dashboard`) | Loopback-only page: tokens saved per day, sessions split into in-use vs recoverable, budget banner, proxy stats | ✅ |
| **Launch** | CONTRIBUTING.md + good-first-issues ✅ · demo GIF and the Show HN / r/LocalLLaMA posts ⏳ (owner's call on timing) | partial |

The **1.0.0 version tag is deliberately not taken yet**: it should mean "the CLI
surface and rc schema are stable and we will not break them", and that promise is
worth making after real-world use, not on the day the features land.

## Shipped in 0.7.0: proxy pro

| Item | Why | Status |
|---|---|---|
| **Response token accounting** | `usage` read from responses flowing through (JSON + SSE, both providers) — `/stats` exact on both sides of every call | ✅ |
| **Prompt-cache advisor** | Watches real Anthropic sequences: flags large stable prefixes without `cache_control` and prefix churn that silently re-bills the cache; advisories in `/stats.advice` + logs | ✅ |
| **Per-route/per-model strategy config** | `proxy --config file.json` with `routes[]` (modelPrefix → strategies/keepRecent/maxToolResultTokens); first match wins | ✅ |

## Shipped in 0.6.0: accuracy

| Item | Why | Status |
|---|---|---|
| **Exact tokenizer adapters** (optional) | `analyze --exact`: Anthropic count-tokens API for Claude (BYO key, opt-in), tiktoken for GPT (when installed alongside); heuristic remains the zero-config default and reports its drift | ✅ |
| **Semantic near-duplicate detection** | Exact-hash dedupe misses "same doc pasted with a different lead-in"; sampled-shingle Jaccard flags ≥60%-similar pairs with estimated savings | ✅ |
| **More session formats** | ChatGPT data-export (conversations.json) ✅ and Cursor chat history (`context-doctor cursor`, both SQLite shapes) ✅ | ✅ |

## Shipped in 0.5.0: trust and automation

| Item | Why | Status |
|---|---|---|
| **Tag-based auto-publish** (GitHub Actions + npm granular token) | Releases currently need a maintainer's 2FA round-trip; `git tag` → published removes the friction and speeds every future item below | ✅ workflow shipped; needs the `NPM_TOKEN` repo secret |
| **`context-doctor doctor`** — self-check command | Verifies an install end to end: hook registered, MCP reachable in each app config, skill present, ledger writable, real stdio handshake. Turns "it doesn't work" reports into one pasteable output | ✅ |
| **`context-doctor watch`** — live session monitor | Tail a running session/agent trace; status line per growth event, findings surfaced as they appear. The real-time counterpart to `session` | ✅ |

Claiming the Glama listing and moving the repository to the gAI-ventures org were planned here; both wait on the owner (see [Waiting on the owner's accounts](#waiting-on-the-owners-accounts)).
