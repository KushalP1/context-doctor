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

## v0.6 — Accuracy

| Item | Why | Size |
|---|---|---|
| **Exact tokenizer adapters** (optional) | tiktoken for GPT models and the Anthropic count-tokens API (BYO key, opt-in) replace the ~10% heuristic with exact counts where available; heuristic remains the zero-config default | M |
| **Semantic near-duplicate detection** | Today's dedupe is exact-hash; shingle-based similarity catches the common "same doc pasted with a different lead-in" case | M |
| **More session formats** — Cursor transcripts, ChatGPT data-export JSON | `session` and `report` should read whatever the user's tools write | M |

## v0.7 — Proxy pro

| Item | Why | Size |
|---|---|---|
| **Response token accounting** | Read `usage` from responses flowing through, making `/stats` and `report` exact on both sides of every call | S |
| **Prompt-cache advisor** | The proxy sees real request sequences — it can detect cache-hostile patterns (volatile prefixes, changed tool orders) and report the exact cache hits being lost, in dollars | M |
| **Per-route/per-model strategy config** | e.g. aggressive trimming for a batch route, conservative for chat | S |

## v1.0 — Platform

| Item | Why | Size |
|---|---|---|
| **Context budgets** (`.contextdoctorrc`) | Per-project thresholds and policies; the hook and proxy enforce/warn against the budget you set | M |
| **Local dashboard** (`context-doctor dashboard`) | The ledger + sessions already hold the data; a localhost page with savings-over-time charts makes the value visible daily | L |
| **Launch** | CONTRIBUTING.md, good-first-issues, demo GIF, Show HN / r/LocalLLaMA posts | M |

## Non-goals

- **Cloud service / accounts / telemetry** — everything stays on the user's machine, permanently.
- **Silent history rewriting** — lossy changes remain consent-only, with the host model writing summaries.
- **API keys for core function** — optional adapters may accept a key; nothing core ever requires one.
