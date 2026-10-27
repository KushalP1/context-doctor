# Performance: what context-doctor itself costs

[← README](../README.md)

A tool that promises speed must be near-free. Measured overhead per touchpoint:

| Touchpoint | When it runs | Overhead |
|---|---|---|
| Every-prompt hook (Claude Code) | Every prompt | **~80ms**, nearly all Node startup: on a lean session its own work is a single `stat()` (~1ms) and the transcript is never read. Full profiling (~200ms on a 4MB session) happens only when the transcript has grown ~40% since last checked |
| MCP server | Spawned once per app session | Tools run only when called. Standing instructions cost **~250 tokens per conversation on Claude, ~170 on GPT**. The six tool definitions ride on every request in clients that load them up front: **at most ~2,344 Claude tokens** over stdio, counted as sent at the densest measured tokenization (an upper bound, pinned under 2,400 by a test; the five over HTTP too). With Claude Code's tool search on, they are deferred until used |
| Proxy | Per API request | ~1–3ms of CPU (parse → optimize → re-serialize) against typical model latencies of hundreds of ms; responses stream through chunk-by-chunk, never buffered |
| Skill | Loads only when relevant | ~2.1k tokens while active; its always-present name and description ~140 tokens |
| Profiling a session | On demand, and on hook growth events | ~160ms for an 8.5MB / 1,855-message transcript (near-duplicate pairs that cannot clear the similarity bar are skipped without comparison) |
| CLI / library | Only when you run it | Not in any hot path |

Net effect is strongly negative overhead: the tokens these touchpoints save on every subsequent call dwarf what they cost.
