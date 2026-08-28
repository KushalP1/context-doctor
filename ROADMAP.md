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

## Next candidates

| Item | Why | Size |
|---|---|---|
| **`context-doctor accuracy`** | Turn the ground-truth audit into a command: compare the heuristic against recorded API counts on local transcripts and report drift, so accuracy regressions surface automatically | S |
| **Calibrate the heuristic from ground truth** | Those same recorded counts can fit chars-per-token per content type, replacing a hand-picked constant with a measured one | M |
| **Cache-aware optimize** | Optimization currently ignores cache boundaries; rewriting a cached prefix can cost more than it saves. Teach the optimizer to leave stable prefixes alone | M |
| **Bash-based file reads** | The repeated-read detector sees explicit read tools; `cat`/`sed` inside shell commands are invisible to it | S |

## Non-goals

- **Cloud service / accounts / telemetry** — everything stays on the user's machine, permanently.
- **Silent history rewriting** — lossy changes remain consent-only, with the host model writing summaries.
- **API keys for core function** — optional adapters may accept a key; nothing core ever requires one.
