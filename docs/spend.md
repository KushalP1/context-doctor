# Spend: `spend` and `budget`

[← README](../README.md)

Claude Code, Codex, Gemini CLI and Cursor each keep a record of what they sent, and none adds them up. `spend` reads all four from this machine and prints one bill: by tool, project, model and day, with what drives it, at list prices. `budget` sets a limit on it that the every-prompt hook applies while you work.

## One bill: `context-doctor spend`

```bash
context-doctor spend                 # the last 30 days (--days n), 8 rows per list (--limit n)
context-doctor spend --json          # everything, every day and session
context-doctor spend --share         # totals only, no paths or project names, to post (--copy)
```

### What it reads

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

### Fast on a second run

Claude Code, Codex and Gemini CLI are read through the shared transcript cache (`~/.cache/context-doctor`, see CONTRIBUTING.md): a second run reads only what was appended since. Cursor is read by key range, only the chats updated in the window, and each chat's replies are kept until the chat changes.

**On the author's machine** (read-only, 2026-11-02, a throwaway cache): last 30 days, **$4,237**: Claude Code $4,237 over 25,090 requests (subagents $1,658, 39%), Codex $0.05; nothing from Cursor in the window. Cache writes are 53% of it, cache reads 36%, output 11%. The first run took 3.7 s, a second 0.3-0.5 s. Over 365 days: $17,262, of which Cursor ~$137 for its 163 replies on a named model, with 968 more on Auto (118M tokens) not priced; 9.1 s cold, 0.56 s warm.

## A budget the hook applies: `context-doctor budget`

Every report is after the fact. A budget is said while you work: before each prompt, the every-prompt hook adds up what today (or this week) has cost across Claude Code, Codex and Gemini CLI, priced as `spend` prices it, and tells you once when it reaches 50%, 80% and 100%.

```bash
context-doctor budget 50/day            # or 200/week (from Monday); dollars at list prices
context-doctor budget 50/day --block    # over it, hold prompts instead of only saying so
context-doctor budget                   # where today (or this week) stands; --json
context-doctor budget off               # remove it
```

What you see, once per threshold per period:

```
context-doctor: $41.20 spent today (Claude Code $40.10, Codex $1.10): 82% of your $50/day budget.
```

**Holding prompts.** With `--block`, over the budget every prompt is held, with the reason and how to lift it: `context-doctor budget off`, or a higher budget (`context-doctor budget 75/day --block`; without `--block` a new budget only warns); it lifts by itself at midnight (Monday for a week). Each host's documented way:

| Host | Hook | Says so | Holds the prompt |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` | `systemMessage` | `decision: "block"` with the reason: the prompt is erased and the reason shown |
| Codex | `UserPromptSubmit` (trust the hook once: `/hooks`) | `systemMessage` | `decision: "block"` with the reason |
| Gemini CLI | `BeforeAgent` | `systemMessage` | `decision: "deny"` with the reason |
| Cursor | `postToolUse` only | no | no: its prompt hook cannot add a line, and its spend is not counted (its history is a database too slow to read on every prompt; `spend` shows it) |

The status line (`install --statusline`) shows `$12/$50 today` in place of the session's cost while a budget is set, and `doctor` reports the budget and whether a hook is there to apply it.

**Where it lives.** `~/.claude/.context-doctor-budget.json` holds the budget, `~/.claude/.context-doctor-budget-state.json` the period's ledger (in `CLAUDE_CONFIG_DIR` when set); `budget off` and `uninstall` remove both.

**Kept fast.** The hook runs on every prompt, so the period's spend is a ledger: per transcript, its size, time and inode, and the period's requests in it (a short key and the dollars). The first prompt of a period reads each transcript written in it once, through the transcript cache; after that a prompt reads only what was appended to the ones that changed, and a fork's copy of its parent's replies counts once, by key. The ledger's total equals `spend`'s full read of the same period (`src/test/budget.test.ts`, and on the author's history after 45 appended replies: $63.9947 both). With no budget set the hook pays one failed file read.

**On the author's machine** (read-only: the real transcripts, a throwaway Claude config folder and cache, today's 86 MB transcript copied and grown one reply per prompt): the budget check adds **~5 ms** to a hook run (median of 25 interleaved runs, 115 ms without a budget, 120 ms with one), 2.9 ms measured in-process (max 14 ms); a prompt with nothing changed, 2.6 ms. The first prompt of a day with nothing cached at all takes ~0.35 s more, once. The ledger: 39 files, 32 KB.
