# context-doctor roadmap

Guiding principles, in priority order: **dead simple for everyone** · **works always, everywhere** · **provably saves tokens, dollars, latency** · **never needs an API key for core function**.

Feedback and votes: [open an issue](https://github.com/KushalP1/context-doctor/issues).

## v0.5 — Trust & automation (shipped in 0.5.0 unless noted)

| Item | Why | Status |
|---|---|---|
| **Tag-based auto-publish** (GitHub Actions + npm granular token) | Releases currently need a maintainer's 2FA round-trip; `git tag` → published removes the friction and speeds every future item below | ✅ workflow shipped; needs the `NPM_TOKEN` repo secret |
| **`context-doctor doctor`** — self-check command | Verifies an install end to end: hook registered, MCP reachable in each app config, skill present, ledger writable, real stdio handshake. Turns "it doesn't work" reports into one pasteable output | ✅ |
| **`context-doctor watch`** — live session monitor | Tail a running session/agent trace; status line per growth event, findings surfaced as they appear. The real-time counterpart to `session` | ✅ |
| Move repo to the **gAI-ventures org** | Attribution home; auto-redirects keep old links working | ⏳ needs the org owner to transfer on GitHub |

## v0.6 — Accuracy (shipped in 0.6.0 unless noted)

| Item | Why | Status |
|---|---|---|
| **Exact tokenizer adapters** (optional) | `analyze --exact`: Anthropic count-tokens API for Claude (BYO key, opt-in), tiktoken for GPT (when installed alongside); heuristic remains the zero-config default and reports its drift | ✅ |
| **Semantic near-duplicate detection** | Exact-hash dedupe misses "same doc pasted with a different lead-in"; sampled-shingle Jaccard flags ≥60%-similar pairs with estimated savings | ✅ |
| **More session formats** | ChatGPT data-export (conversations.json) ✅ and Cursor chat history (`context-doctor cursor`, both SQLite shapes) ✅ | ✅ |

## v0.7 — Proxy pro (shipped in 0.7.0)

| Item | Why | Status |
|---|---|---|
| **Response token accounting** | `usage` read from responses flowing through (JSON + SSE, both providers) — `/stats` exact on both sides of every call | ✅ |
| **Prompt-cache advisor** | Watches real Anthropic sequences: flags large stable prefixes without `cache_control` and prefix churn that silently re-bills the cache; advisories in `/stats.advice` + logs | ✅ |
| **Per-route/per-model strategy config** | `proxy --config file.json` with `routes[]` (modelPrefix → strategies/keepRecent/maxToolResultTokens); first match wins | ✅ |

## v1.0 — Platform (code shipped in 0.8.0)

| Item | Why | Status |
|---|---|---|
| **Context budgets** (`.contextdoctorrc`) | Per-project thresholds; nearest-file discovery, enforced by the hook, reported by analyze/session, defaults feeding optimize/proxy | ✅ |
| **Local dashboard** (`context-doctor dashboard`) | Loopback-only page: tokens saved per day, sessions split into in-use vs recoverable, budget banner, proxy stats | ✅ |
| **Launch** | CONTRIBUTING.md + good-first-issues ✅ · demo GIF and the Show HN / r/LocalLLaMA posts ⏳ (owner's call on timing) | partial |

The **1.0.0 version tag is deliberately not taken yet**: it should mean "the CLI
surface and rc schema are stable and we will not break them", and that promise is
worth making after real-world use, not on the day the features land.

## Shipped since v1.0 planning (0.9.x)

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

## Closed by measurement in 0.13.8 — `trim-tool-calls` stays opt-in

The question was whether trimming a completed tool call can confuse a live agent.
Across 42 sessions: 73 large writes, 18 later edited, and 16 of those edits had no
read in between — the model built `old_string` from its own `Write` input, at a
median distance of 43 messages (p90: 181). So yes, in about 22% of cases, and far
outside any recent-message window. Default stays off. What shipped instead: the
offline optimizer, which can see the rest of the conversation, now keeps exactly
those writes and trims the 63% that are never touched again.

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
| **`context-doctor accuracy`** | Answers "why is my bill bigger than the profile?" with evidence: the fixed harness baseline (~51k tokens here) and the per-turn injected content the transcript never records. The roadmap asked for a tokenizer benchmark instead; that turned out to be unbuildable from transcripts alone, and the note below says why |
| **`context-doctor diff`** | Two profiles side by side — category movement, findings resolved or introduced, money and latency. Optimization no longer has to be taken on trust |
| **`context-doctor init <preset>`** | `chat`, `agent`, `batch`. The budget feature went unused because an empty rc file is useless until you already know your numbers |
| **Shell file reads** | `cat`/`head`/`tail`/`less` count as reads. 16 real findings across 6 local sessions that were previously invisible |
| **Cache-aware trimming** | The trim boundary moved every turn, invalidating the prompt cache on 22 of 24 turns and paying the 1.25x write price to save a few hundred tokens. Quantized: 8 of 24, trimming undiminished |

### One roadmap item did not survive contact with the data

**"Calibrate the heuristic from ground truth"** assumed transcripts record what is
sent. They do not. A turn with 5,595 characters of visible content is billed
14,002 tokens, which would imply 0.4 characters per token — denser than any real
tokenizer. Claude Code injects per-turn content (reminders, skill and file text)
that never reaches the transcript, so transcript-derived calibration would fit
the estimator to noise. Calibration needs a real tokenizer, not this data.

**Subagent accounting** is unblocked only by a sample: none of the 39 local
sessions contain sidechain traffic, so the field shapes would be guesswork.

## Next candidates

Grouped by the question each one answers. Sizes are S/M/L; nothing here is
committed until it ships.

### Make the numbers trustworthy

| Item | Why | Size |
|---|---|---|

### Turn advice into action

| Item | Why | Size |
|---|---|---|

### Make more surfaces inherent (2026-09-19 research)

Research into the Claude Desktop and Cursor app bundles, looking for a hook or a data path on each. Claude Desktop chat has neither: the Bedrock/`ANTHROPIC_BASE_URL` strings belong to the embedded Claude Code, chat goes to claude.ai's backend, and the only "before send" is an Electron header handler. Cursor has both a hook (it loads Claude Code's hook config) and, for BYO-key users, an OpenAI base-URL override.

| Item | Why | Size |
|---|---|---|
| **Cursor `beforeReadFile` trimming** | Cursor's hooks can rewrite file content before the agent sees it (that is how secret-redaction hooks work). Oversized reads are the second biggest drain; capping them at the hook is inherent, model-independent, and needs no new UI | M |
| **Cursor BYO-key → proxy** | Cursor's "Override OpenAI Base URL" puts our proxy in the data path for OpenAI-compatible traffic. Document it; consider `install --cursor-proxy` to set it | S |
| **`.mcpb` bundle for Claude Desktop** | One-click install through Desktop's extensions UI instead of `npx … install`. Adoption lever for non-technical users; the app supports `.mcpb`/`.dxt` | S |

### Fit into how people actually work

| Item | Why | Size |
|---|---|---|
| **Publish the extension to the marketplaces** | Built, tested and installed locally in both VS Code and Cursor (0.14.3 below). Publishing needs a VS Code Marketplace publisher token and an Open VSX account for Cursor, both the owner's to create | S |

## Non-goals

- **Cloud service / accounts / telemetry** — everything stays on the user's machine, permanently.
- **Silent history rewriting** — lossy changes remain consent-only, with the host model writing summaries.
- **API keys for core function** — optional adapters may accept a key; nothing core ever requires one.
