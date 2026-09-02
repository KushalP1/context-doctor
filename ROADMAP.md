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

## Next candidates

Grouped by the question each one answers. Sizes are S/M/L; nothing here is
committed until it ships.

### Make the numbers trustworthy

| Item | Why | Size |
|---|---|---|
| **`context-doctor accuracy`** | Turn the ground-truth audit into a command: compare the heuristic against recorded API counts on local transcripts and report drift, so accuracy regressions surface automatically instead of by inspection | S |
| **Calibrate the heuristic from ground truth** | Those same recorded counts can fit chars-per-token per content type, replacing a hand-picked constant with a measured one | M |
| **Bash-based file reads** | The repeated-read detector sees explicit read tools; `cat`/`sed`/`head` inside shell commands are invisible to it, so agent sessions that read via the shell look cleaner than they are | S |
| **Windows coverage that means something** | Windows CI failed for a day because tests overrode `HOME`, which `os.homedir()` ignores there. Fixed — but nothing stops the next test from sandboxing only the POSIX half | S |
| **Subagent accounting** | Sidechain traffic is excluded from session profiles because it has its own window — but it still costs money, and nothing currently reports what subagents spent | M |

### Turn advice into action

| Item | Why | Size |
|---|---|---|
| **Cache-aware optimize** | Optimization ignores cache boundaries today; rewriting a cached prefix can cost more than it saves. The optimizer should leave stable prefixes alone | M |
| **Cache breakpoint suggestions** | The proxy advisor says the cache is churning; the useful next step is saying *where* to place `cache_control` given the observed traffic | M |
| **`trim-tool-calls` in the proxy** | The new strategy is the biggest win in agent sessions but is CLI/MCP-only: the proxy applies its default set, so live traffic never benefits from it | S |
| **`context-doctor diff`** | Compare two profiles — before/after an optimization, or two sessions — so an improvement can be demonstrated rather than asserted | S |

### Fit into how people actually work

| Item | Why | Size |
|---|---|---|
| **Editor status bar** | A VS Code / Cursor extension showing live context health where the work happens, rather than in a separate terminal | L |
| **Config presets** | `.contextdoctorrc` starts empty; shipping sensible presets (chat app, coding agent, batch pipeline) would make budgets adoptable without tuning | S |

## Non-goals

- **Cloud service / accounts / telemetry** — everything stays on the user's machine, permanently.
- **Silent history rewriting** — lossy changes remain consent-only, with the host model writing summaries.
- **API keys for core function** — optional adapters may accept a key; nothing core ever requires one.
