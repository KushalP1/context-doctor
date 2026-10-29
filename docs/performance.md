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
| History reports (`fix`, `savings`, a bare `context-doctor`, `cache-misses`, `compact-window`, `cache-ttl`, `overhead`) | Only when you run them | Each transcript is read once per run for every report that needs it, and what each report takes from it (per-request records, no message text) is kept in `~/.cache/context-doctor`: the next run reads only what was appended since. On the author's 2.7 GB history, `fix` 23 s → 5.2 s the first time and 0.4 s after, `savings` 41 s → 17.6 s and 0.5 s ([details](#the-transcript-cache)) |
| CLI / library | Only when you run it | Not in any hot path |

Net effect is strongly negative overhead: the tokens these touchpoints save on every subsequent call dwarf what they cost.

## The transcript cache

`fix`, `savings` (a bare `context-doctor`), `compact-window`, `cache-ttl`, `cache-misses`, `compactions` and `overhead` replay your history. Each used to read and parse every transcript on its own, so `fix` and `savings`, which run up to six of those replays, read 2.7 GB five or six times on the author's machine. Now each transcript is read once per run, each row parsed once for every replay that needs it, and the records each replay takes from it (a request's usage, time and ids, a compaction, a file read, a tool call's name) are kept, one file per transcript and replay, keyed by the transcript's path, size, modification time and inode:

- A transcript that only grew, as Claude Code writes them, is read from where the last run stopped. Autopilot's replay keeps the whole conversation as it goes, so a transcript it has seen change is replayed again in full (2 s for the author's largest, 360 MB).
- The figures do not change: golden tests run every report, text and JSON, on a fixture history with no cache, a cold cache, a warm one and after the history grew, against what the code before the cache printed, byte for byte; `scripts/verify-local.sh` does the same with and without the cache on a copy of your real history.
- No message text is kept: a prompt only as its length, a tool call's input only as a hash. The files are yours alone (0600, folders 0700), like the transcripts.
- Where: `~/.cache/context-doctor`, or `$XDG_CACHE_HOME/context-doctor`, or `CONTEXT_DOCTOR_CACHE_DIR`. `CONTEXT_DOCTOR_NO_CACHE=1` keeps nothing on disk (each run still reads every transcript only once). A new version starts empty; once a day, entries of transcripts gone or untouched for 120 days go, and the oldest go while the cache is over 256 MB (`CONTEXT_DOCTOR_CACHE_MAX_MB`). `context-doctor uninstall` removes it.
- Runs at the same time are safe: each entry is written whole and renamed into place, and a damaged entry is read as missing.

| On the author's history (2.7 GB, 1,422 transcripts; a busy machine) | Before | First run | Later runs |
|---|---|---|---|
| `fix` | 23.5 s | 5.2 s | 0.4 s |
| `savings` (and a bare `context-doctor`) | 41.1 s | 17.6 s | 0.5 s |
| `cache-misses` | 4.9 s | 3.6 s | 0.2 s |
| `compact-window` | 9.6 s | 3.1 s | 0.3 s |
| `overhead` | 9.3 s | 4.9 s | 0.3 s |
| `cache-ttl` | 7.5 s | 4.3 s | 0.3 s |
| `limits` | 0.4 s | 0.1 s | 0.1 s |

The first run is mostly autopilot's replay itself (`savings`); `fix` skips it when autopilot is already on.
