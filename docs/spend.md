# Spend: `spend` and `budget`

[← README](../README.md)

Claude Code, Codex, Gemini CLI and Cursor each keep a record of what they sent, and none adds them up. `spend` reads all four from this machine and prints one bill: by tool, project, model and day, with what drives it, each request as billed at list rates (its tier, fast mode, US-only, web searches; below). `budget` sets a limit on it that the every-prompt hook applies while you work.

## One bill: `context-doctor spend`

```bash
context-doctor spend                 # the last 30 days (--days n), 8 rows per list (--limit n)
context-doctor spend --json          # everything, every day and session
context-doctor spend --share         # totals only, no paths or project names, to post (--copy)
```

### What it reads

| Tool | From | Counted |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` (`CLAUDE_CONFIG_DIR` honoured) each session's `subagents/agent-*.jsonl`, and its workflow agents' `subagents/workflows/<run>/agent-*.jsonl` | every reply's `usage`, once: a reply written as several rows is one request (its output settled on the last row), and a forked session's copy of its parent is counted once. Workflow agents get their own line (`workflows $X (N runs)`); a session last written before the window still counts its subagents written in it |
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions` (`CODEX_HOME` honoured) | each `token_count` event whose running total moved (one that only refreshed the limits repeats the last request), a forked rollout's copy of its parent's events counted once; the model from `turn_context`, the project from the session's folder |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.json[l]` | each `gemini` message's `tokens`, its last copy; a message later rewound was still billed, so it is counted; thoughts bill as output |
| Cursor | its `state.vscdb` (`cursorDiskKV`), needs SQLite (Node 22.13+ or the `sqlite3` command) | each agent reply's `tokenCount`, at the chat's model (`modelConfig.modelName`); the project from the workspace that lists the chat |

A tool with nothing on disk is left out. Prices are pricing.ts's list prices, cache writes by their TTL, the same code every other report prices with (`requestCost`: `spend`, the budget, the session price, `subagents`, `overhead`, `fix`'s replays). Claude Fable 5.2 and Mythos 5.2 are $8 / $40 per million, writes $10 (5 minutes) and $16 (1 hour), cache reads $0.20 (the page read 2026-11-10); 0.45 priced `claude-fable-5-2` by the Fable family's fallback row ($10 / $50, reads $1), an estimate five times too high on reads.

**At your organization's rates.** Where an administrator has set Claude Code's `modelPricing` in managed settings (contracted rates; [settings reference](https://code.claude.com/docs/en/settings-reference#modelpricing)), Claude Code reports `/cost`, the status line and `total_cost_usd` at those rates, and so does context-doctor: every Claude request is priced as Claude Code prices it, and the reports say "at your organization's rates" with a line naming the multiplier, the rows and the file. What it applies, read from the 2.1.321 binary and the reference:

| Field | Applied |
|---|---|
| `multiplier` (greater than 0, at most 10) | every Claude request's cost, a row's included: its tokens, fast mode, US-only, a long prompt's tier and its web searches |
| `overrides` (model id to `input`, `output`, `cacheRead`, `cacheWrite` per million, all four, each 0 to 10000) | the rates as written: `cacheWrite` for 5-minute and 1-hour writes alike, no fast-mode or US-only surcharge, no long-prompt tier; a web search keeps its $10 per 1,000. A key that names a Claude model (`claude-sonnet-4-6`) covers its dated, `[1m]`, Bedrock and Vertex spellings; any other key (a gateway alias) only that exact id, and wins over a model's row |

It is read only from the managed settings files Claude Code reads (`managed-settings.json` in `/Library/Application Support/ClaudeCode`, `/etc/claude-code` or `C:\Program Files\ClaudeCode`, then `managed-settings.d/*.json` in alphabetical order, merged key by key; `CLAUDE_CODE_MANAGED_SETTINGS_PATH` names one file instead), never from user, project or local settings, as Claude Code ignores it there. MDM profiles and server-managed settings are not read. Claude Code takes its managed settings from server-managed settings when there are any, else from an MDM profile, else from the files, and only from the first it finds (read from the 2.1.321 binary): on a machine with either of the others, Claude Code's own figures may use rates context-doctor cannot see, and may ignore the files' rates it applies. When Claude Code's copy of the server-managed settings (`remote-settings.json` in its folder) or a macOS managed-preferences profile (`com.anthropic.claudecode.plist`) is there, `spend` and `doctor` say so. Codex, Gemini CLI and Cursor stay at list prices. The budget's ledger and a session's price remember which rates and which price table priced them, and are priced again when either changes (a newer context-doctor that corrects a price re-prices the period, not only what comes after). `CONTEXT_DOCTOR_NO_MANAGED_SETTINGS=1` ignores managed settings altogether.

**Priced as billed, per request.** What a request recorded can bill it above its model's row, and each is applied where it is recorded (the providers' pages, read 2026-11-08):

| Modifier | Recorded as | Billed |
|---|---|---|
| Anthropic fast mode | `usage.speed: "fast"` | Fable 5.2 and Mythos 5.2 $16 / $80 (read 2026-11-10), Opus 5.5 $8 / $40, Opus 5 and Opus 4.8 $10 / $50 per million, over the whole context window; cache writes and reads keep their multipliers of that input |
| US-only inference | `usage.inference_geo: "us"` | 1.1x on every token category, for Claude 4.6 and later (earlier models reject it), on top of fast mode and Haiku 5.5's higher tier |
| Haiku 5.5's long prompts | a prompt over 100,000 tokens, cache reads and writes counted | the whole request at $0.50 / $2.50, cache reads $0.05 |
| Claude's web search | `usage.server_tool_use.web_search_requests` | $10 per 1,000 searches (web fetch is free; code execution bills container hours, which usage does not record per request: not counted) |
| OpenAI's long context | a prompt over 272k input tokens | 2x input, cached input and cache writes, 1.5x output, on the models the page gives a long-context price |
| Gemini Pro's long prompts | a prompt over 200k tokens | 3.1 Pro $4 / $18 / $0.40, 2.5 Pro $2.50 / $15 / $0.25 |

`spend` says what they added when anything did: "Of it, billed above list rates: fast mode +$X, US-only +$Y, web searches $Z (n), long-prompt tier +$W" under "Where it goes", the same line in `--share`, and `modifiers` (with `parts.webSearchUsd`) in `--json`. Not modelled: OpenAI's Fast mode (Codex records only its thread's `service_tier`, not each request's) and regional endpoints, the Batch API (no tool here uses it).

**Prices that end on a day.** A few rows hold until a known day: gpt-5.6-sol's promotion until November 30, 2026; Gemini 4 Argon's price until then (it doubles on December 1); Gemini 3.6 and 3.8 Flash until December 31, 2026 (doubling January 1, 2027); gemini-2.5-pro, routed to 3.8 Flash and billed at its rates from December 1. A request on or after that day is priced at what the page said would follow (the old price when it said nothing) and labelled an estimate: its model's row says "estimate: price changed 2026-12-01", and a note, `--share`, `budget` and `doctor` say "price changed on 2026-12-01; a newer context-doctor knows the new one". A request made before the day keeps its price, whenever the report runs. A request recorded with no time of its own is priced as of when the report runs, as one priced past the day would be: it fits no day or period, so `spend`, the budget and `limits` leave it out, and the session price, `subagents`, `tasks` and the lens count it. A request on a model with no list price (a new or local model) is counted with its tokens and marked "not priced" (its tool's row, its model's row, a note; `--share` says it is left out), never shown as a free $0.00. A model the table knows only by its family (a release newer than the table, `claude-opus-9`) is priced at that family's row and said to be an estimate: its model's row, a note with the dollars, `--share`'s "Of it, $x is on models priced as their family", and `budget`. Replies Claude Code writes itself on `<synthetic>` (an error, an interruption) never reached the API: they are not counted at all. Cursor's own names for Claude (`claude-4.6-opus-high-thinking`) are priced as the Claude version they stand for (`claude-opus-4-6`), shown as Cursor wrote them.

**Cursor is an estimate.** Its history keeps a prompt's size and the reply's, with no cache split, so every input token is priced uncached: an upper bound. Replies on Auto (`"default"`) have no list price (Cursor bills Auto from your plan): they are counted, with their tokens, and not priced. The report says both.

**Against `savings`.** `savings` bills a narrower slice of the same Claude Code requests: the main conversation's input (cache writes and reads, not output), in sessions with 10+ requests. `spend` counts every request in the window, output and subagents too. On the requests both count the dollars are the same, to the cent; `src/test/spend.test.ts` checks it, and on the author's history the 36 sessions `savings` counts come to $2,332.37 in both. `spend`'s Claude Code total equals what `limits` reads for the same window.

**On a subscription** the same tokens come out of your plan's limits instead of a bill: the dollars say which tool and project use the most, not what you paid.

### Fast on a second run

Claude Code, Codex and Gemini CLI are read through the shared transcript cache (`~/.cache/context-doctor`, see CONTRIBUTING.md): a second run reads only what was appended since. Cursor is read by key range, only the chats updated in the window, and each chat's replies are kept until the chat changes.

**On the author's machine** (read-only, 2026-11-02, a throwaway cache): last 30 days, **$4,237**: Claude Code $4,237 over 25,090 requests (subagents $1,658, 39%), Codex $0.05; nothing from Cursor in the window. Cache writes are 53% of it, cache reads 36%, output 11%. The first run took 3.7 s, a second 0.3-0.5 s. Over 365 days: $17,262, of which Cursor ~$137 for its 163 replies on a named model, with 968 more on Auto (118M tokens) not priced; 9.1 s cold, 0.56 s warm. The modifiers on that machine (read-only, 2026-11-08, last 140 days): no fast-mode request (every row that records `speed` says "standard"), no US-only one (`inference_geo` "global", "" or "not_available"), no web search (every `server_tool_use` count 0), no OpenAI or Gemini prompt over its tier; 15 Haiku 5.5 requests over 100k tokens, +$0.16. Every other figure is unchanged to the cent ($18,604 over 80,722 requests).

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

Requests on a model with no list price cannot count toward a dollar budget: the hook says so once a period (`3 requests are on gpt-7, with no list price, so the budget does not count them.`), and `budget` on every run.

**Holding prompts.** With `--block`, over the budget every prompt is held, with the reason and how to lift it: `context-doctor budget off`, or a higher budget (`context-doctor budget 75/day --block`; without `--block` a new budget only warns); it lifts by itself at midnight (Monday for a week). Each host's documented way:

| Host | Hook | Says so | Holds the prompt |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` | `systemMessage` | `decision: "block"` with the reason: the prompt is erased and the reason shown |
| Codex | `UserPromptSubmit` (trust the hook once: `/hooks`) | `systemMessage` | `decision: "block"` with the reason |
| Gemini CLI | `BeforeAgent` | `systemMessage` | `decision: "deny"` with the reason |
| Cursor | `postToolUse` only | no | no: its prompt hook cannot add a line, and its spend is not counted (its history is a database too slow to read on every prompt; `spend` shows it) |

The status line (`install --statusline`) shows `$12/$50 today` in place of the session's cost while a budget is set, and `doctor` reports the budget and whether a hook is there to apply it.

**Where it lives.** `~/.claude/.context-doctor-budget.json` holds the budget, `~/.claude/.context-doctor-budget-state.json` the period's ledger (in `CLAUDE_CONFIG_DIR` when set); the thresholds said this period are marker files in `.context-doctor-budget-said.d` beside them, so of several prompts at once exactly one says each; `budget off` and `uninstall` remove all three. On a machine without `~/.claude` (Codex or Gemini CLI alone) they, and the hook's other files, go to `~/.local/state/context-doctor` (`$XDG_STATE_HOME`, `%LOCALAPPDATA%` on Windows) instead: a `~/.claude` made for them read as Claude Code to `install`. A budget is in whole cents (`50.555/day` is $50.56, and says so).

**Kept fast.** The hook runs on every prompt, so the period's spend is a ledger: per transcript, its size, time and inode, and the period's requests in it (a short key and the dollars). The first prompt of a period reads each transcript written in it once, through the transcript cache; after that a prompt reads only what was appended to the ones that changed, and a fork's copy of its parent's replies counts once, by key. Codex's rollouts are found in the period's own date folders on every prompt, and by a full walk of its folders every five minutes (a resumed session is appended in its older folder, so its spend can be up to five minutes late): with 3,000 rollouts the walk took 16 ms a prompt, now 0.6 ms. The ledger's total equals `spend`'s full read of the same period (`src/test/budget.test.ts`, and on the author's history after 45 appended replies: $63.9947 both). With no budget set the hook pays one failed file read.

**On the author's machine** (read-only: the real transcripts, a throwaway Claude config folder and cache, today's 86 MB transcript copied and grown one reply per prompt): the budget check adds **~5 ms** to a hook run (median of 25 interleaved runs, 115 ms without a budget, 120 ms with one), 2.9 ms measured in-process (max 14 ms); a prompt with nothing changed, 2.6 ms. The first prompt of a day with nothing cached at all takes ~0.35 s more, once. The ledger: 39 files, 32 KB.

## A session's own price, while it runs

The budget counts a day; one session can cost hundreds of dollars on its own without anyone noticing that each message now re-reads half a million tokens. So the same every-prompt hook (Claude Code, Codex, Gemini CLI; budget or not) adds up what this session has cost, its subagents and workflow agents included (they bill to it), and says so once when it passes **$25, $100 and $500**:

```
context-doctor: this session has cost $112 so far ($30.00 of it subagents); each message now re-reads ~470k tokens (~$0.118). /compact, or a handoff to a new session, cuts that.
```

The per-message price is the main conversation's context at its last request, at its model's cache-read rate as the next request bills it (fast mode and US-only as the last one recorded, the tier of that context's length). After an idle long enough for the prompt cache to expire, it says what this message pays to write the context again instead (`the cache expired while it was idle, so this message re-writes its ~470k tokens (~$9.40), and each one after re-reads them`), and the hook's own cold-resume line is then left out, so the re-write is said once. Right after a compaction, or when Claude Code is about to compact this very prompt, it says the cost alone. Gemini CLI is told `/compress`.

- **Once per threshold per session.** A session first seen past $100 hears $100, not $25 as well. Each threshold is claimed by creating a file that must not exist yet, so of several hooks running at once for one session exactly one says it.
- **To you, not the model.** It is a `systemMessage`, like the budget's lines: compacting or moving to a new session is your decision about your money, and only you can run `/compact`. The cold-resume offer, while it lived only in the model's reply, was acted on 1 time in 33; and a note in the model's context is paid for on every later request. (Past its token threshold the hook's note to the model already asks it to offer a compaction.)
- **Thresholds**: `CONTEXT_DOCTOR_SESSION_PRICE=50,200` (dollars; set it in the hook's environment, e.g. Claude Code's `env` setting). **Off**: `CONTEXT_DOCTOR_NO_SESSION_PRICE=1`. `doctor` shows which are in force.
- **The status line's cost** is Claude Code's own `cost.total_cost_usd`, at its prices; the hook's figure is `spend`'s for the session's transcripts, at list prices (equal by test, `src/test/sessionprice.test.ts`). They can differ: Claude Code prices with a managed price table when one is set (context-doctor reads the one in managed settings files, above, but not one from MDM or server-managed settings), and after a resume its running total may start again. A session resumed or forked into a new one starts with a copy of the old one's rows, which keep the old session's id: the hook counts only the rows of its own session, so the copy is the old session's cost, not this one's.
- **Codex's spawned agents** bill to the thread that spawned them and are in its figure, as its subagents: each one's rollout names the thread in its first `session_meta` (`parent_thread_id`, also under `source.subagent.thread_spawn`; Codex Desktop 0.146), so the hook reads only that first line of the rollouts written since the thread began (in its day folders and the archive), each once: what it named is kept with the session's state, and a later prompt reads only rollouts new since (2,000 candidates: 0.6-1.1 s a prompt before, 17-28 ms after, in a throwaway home), and a forked agent's copy of the thread's history counts once. `spend` counts those requests in the thread's session too (equal by test, `src/test/codex-subagents.test.ts`); a thread you forked yourself (`forked_from_id` only) stays a session of its own. On the author's machine, the one thread that spawned agents (three, July 31) is $0.73 with them, $0.33 without.
- **What the figure holds** is said briefly beside it: the subagents' and workflow agents' part, a part on a model the price table knows only by its family (an estimate), and requests on a model with no list price, which are not counted. When the line has told you to `/compact`, the model is not also asked to offer it.
- **Kept fast.** The cost is the budget ledger's per-transcript entry, with the period starting at the session's first request: a prompt reads only what was appended to the session's transcript and its subagents'. The entries go beside the hook's per-session state, and only once 512 KB has been read since they were last written, or a threshold is said: a session below $25 with a short transcript writes nothing. Codex's and Gemini CLI's files are read through the transcript cache. Once $500 is said, the check is one `stat()`.

**On the author's machine** (read-only, 2026-11-04, a throwaway cache): of the 45 sessions active in the last 30 days, **15 passed $25** in the window and went on to spend **$3,369** after it (median $54 a session; the largest, $2,031), **5 passed $100** ($2,639 after; median $93) and **2 passed $500** ($1,688 after: $1,556 and $133). The median session passing $25 re-read ~303k tokens a message (~$0.07), $100 ~706k (~$0.14), $500 ~765k (~$0.19): most of the money after a threshold is the count of messages, subagents and cache writes, not one message's read. Latency on a copy of the largest session (97 MB, 274 subagent transcripts), each prompt after a 150 KB append: the check adds **~13 ms** to a hook run (median of 9 interleaved runs, 170 ms without it, 183 ms with it), 7.3 ms in-process (max 10 ms). The first prompt on a long session the hook has not seen reads it whole, once: 1.65 s for that one.
