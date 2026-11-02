# Spend: `spend`

[← README](../README.md)

Claude Code, Codex, Gemini CLI and Cursor each keep a record of what they sent, and none adds them up. `spend` reads all four from this machine and prints one bill: by tool, project, model and day, with what drives it, at list prices.

```bash
context-doctor spend                 # the last 30 days (--days n), 8 rows per list (--limit n)
context-doctor spend --json          # everything, every day and session
context-doctor spend --share         # totals only, no paths or project names, to post (--copy)
```

## What it reads

| Tool | From | Counted |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` (`CLAUDE_CONFIG_DIR` honoured) and each session's `subagents/agent-*.jsonl` | every reply's `usage`, once: a reply written as several rows is one request (its output settled on the last row), and a forked session's copy of its parent is counted once |
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions` | each `token_count` event whose running total moved (one that only refreshed the limits repeats the last request); the model from `turn_context`, the project from the session's folder |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.json[l]` | each `gemini` message's `tokens`, its last copy; a message later rewound was still billed, so it is counted; thoughts bill as output |
| Cursor | its `state.vscdb` (`cursorDiskKV`), needs SQLite (Node 22.13+ or the `sqlite3` command) | each agent reply's `tokenCount`, at the chat's model (`modelConfig.modelName`); the project from the workspace that lists the chat |

A tool with nothing on disk is left out. Prices are pricing.ts's list prices, cache writes by their TTL, the same code every other report prices with.

**Cursor is an estimate.** Its history keeps a prompt's size and the reply's, with no cache split, so every input token is priced uncached: an upper bound. Replies on Auto (`"default"`) have no list price (Cursor bills Auto from your plan): they are counted, with their tokens, and not priced. The report says both.

**Against `savings`.** `savings` bills a narrower slice of the same Claude Code requests: the main conversation's input (cache writes and reads, not output), in sessions with 10+ requests. `spend` counts every request in the window, output and subagents too. On the requests both count the dollars are the same, to the cent; `src/test/spend.test.ts` checks it, and on the author's history the 36 sessions `savings` counts come to $2,332.37 in both. `spend`'s Claude Code total equals what `limits` reads for the same window.

**On a subscription** the same tokens come out of your plan's limits instead of a bill: the dollars say which tool and project use the most, not what you paid.

## Fast on a second run

Claude Code, Codex and Gemini CLI are read through the shared transcript cache (`~/.cache/context-doctor`, see CONTRIBUTING.md): a second run reads only what was appended since. Cursor is read by key range, only the chats updated in the window, and each chat's replies are kept until the chat changes.

**On the author's machine** (read-only, 2026-11-02, a throwaway cache): last 30 days, **$4,237**: Claude Code $4,237 over 25,090 requests (subagents $1,658, 39%), Codex $0.05; nothing from Cursor in the window. Cache writes are 53% of it, cache reads 36%, output 11%. The first run took 3.7 s, a second 0.3-0.5 s. Over 365 days: $17,262, of which Cursor ~$137 for its 163 replies on a named model, with 968 more on Auto (118M tokens) not priced; 9.1 s cold, 0.56 s warm.
