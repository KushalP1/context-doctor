# What it detects, and what it fixes

[← README](../README.md)

## What it detects

- **Oversized tool results** — the #1 context killer in agent loops
- **Oversized tool calls** — a `Write` or a `cat > file <<EOF` puts the whole file in context permanently. In file-heavy agent work these outweigh every tool result combined, and `--strategy trim-tool-calls` reclaims them
- **Duplicate content** — the same doc/result pasted twice
- **Near-duplicates** — the same doc re-pasted with different surrounding words (shingle similarity, ≥60%)
- **Repeated file reads** — the same file pulled in three or more times, every copy still in context. Counts shell reads too (`cat`, `head`, `tail`, `less`), which is where most of them hide in agent sessions
- **Retained error output** — stack traces and failed commands kept verbatim long after the fix landed
- **Repeated identical tool calls**, split into the two things they can mean: a **retry** (the same call after a failure, where the fix is in the error text, and three or more is a loop) and a **re-read** (the same call after a success, where the model forgot it already had the answer). Across 42 local sessions that was 15 retries against 151 re-reads, so the old combined advice was wrong for most of them
- **Base64 / binary blobs** in text content — checked by character distribution, not just alphabet, so hex digests and long identifiers are not mistaken for encoded binary
- **Long history** past the point where models track the middle
- **Cache-hostile ordering** — volatile content before stable content breaks prompt caching (Anthropic `cache_control`, OpenAI automatic prefix caching)
- **Window pressure** — usage % against the target model's real context window

## What it fixes (deterministically — no LLM calls, no API keys)

| Strategy | Lossy? | Default |
|---|---|---|
| `dedupe` — replace repeated content with a reference | No | ✅ |
| `trim-tool-results` — truncate stale tool outputs | Mostly no | ✅ |
| `strip-base64` — remove inline binary blobs | No (for the model) | ✅ |
| `trim-tool-calls` — shrink the arguments of calls that already ran | Mostly no | opt-in |
| `prune-history` — collapse old turns into a stub for summarization | Yes | opt-in |

`trim-tool-calls` is the big one for agent sessions. Writing a file through a tool call puts the entire file in context permanently, so in file-heavy work the calls outweigh every tool result combined — on a real 278k-token session, the default set reached 248k and adding `trim-tool-calls` reached 102k. It is opt-in because it edits what the model itself wrote, and that is measured, not cautious: across 42 real sessions, of 73 large writes 18 were later edited and **16 of those edits had no read in between**, meaning the model built the edit from its own earlier `Write` input, at a median distance of 43 messages. Trimming those would turn each into a failed edit plus a recovery read. In the offline optimizer the rest of the conversation is known, so exactly those writes are left intact and the 63% never touched again are trimmed; in the live proxy the future is not known, which is why it stays off there unless you turn it on.

**Optimization is cache-aware.** Prompt caches match a byte-identical prefix, so editing a message in the middle invalidates everything after it — and the naive "trim everything older than the last N messages" boundary moves every single turn. On a 25-turn agent conversation that invalidated the cached prefix on 22 of 24 turns, paying the 1.25x cache-write price on the whole prefix to save a few hundred tokens. The trim boundary is quantized so it holds still between steps (8 of 24 on the same fixture), while still reaching 15 of 20 tool results.

The step size is a trade-off, not a formula, and it is yours to set: `"trimBoundaryStep": 20` in `.contextdoctorrc` (default 10). Measured on a growing agent session at 400 turns: a step of 10 invalidated the cache on 21% of turns with ~2 stale results waiting on average; 20 gave 12% and ~4; 40 gave 10% and ~9. Adaptive steps were worse everywhere, because a step that changes size moves the boundary by itself. Heavy API users who lean on caching want a bigger step; interactive users who want stale output gone promptly want a smaller one.

Everything the optimizer does is inspectable: it prints exactly which messages changed and how many tokens each change saved.

**Summarization without an API key:** when `prune-history` runs through the MCP tools, context-doctor hands a digest of the pruned turns back to the model that called it (the Claude/GPT already running in your app) and asks *it* to write the replacement summary — LLM-quality compaction, zero extra cost, no keys.
