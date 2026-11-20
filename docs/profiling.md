# Profiling conversations and sessions

[← README](../README.md)

## A conversation file

No install needed:

```bash
npx context-doctor analyze conversation.json --model claude-sonnet-5
npx context-doctor optimize conversation.json --out slimmed.json
```

Input is any of: OpenAI chat format, Anthropic messages format (with `system` and content blocks), or a bare `[{role, content}]` array. Use `-` to pipe from stdin. A profile shows where the tokens go and what is wasted:

```
Where the tokens go
────────────────────────────────────────────────────────
Tool results      ████████████████░░░░░░░░░░░░  57%  ~41k
System prompt     ██████░░░░░░░░░░░░░░░░░░░░░░  21%  ~15k
Assistant replies ████░░░░░░░░░░░░░░░░░░░░░░░░  13%  ~9.4k
User messages     ██░░░░░░░░░░░░░░░░░░░░░░░░░░   9%  ~6.5k

Findings (4)
────────────────────────────────────────────────────────
✖ Message #12 contains a base64/binary blob (~8.2k tokens). [save ~7.4k]
   → Never put base64 in text content — use the provider's file/image APIs.
▲ Tool result at message #7 (web_search) is ~6.1k tokens. [save ~4.9k]
   → Truncate or summarize large tool outputs before they enter history.
```

Reports include **dollar and latency estimates**, not just tokens (`analyze examples/sample-conversation.json --model claude-sonnet-5`):

```
Cost:  ~$0.023 input per call · ~$23.40 per 1k calls · ~0.5s of latency per call (estimates)
...
Potential recovery: ~7.9k tokens (~67% of context) ≈ $15.79 per 1k calls, 0.3s faster per call
```

What the findings mean and what `optimize` changes: [detectors and fixes](./detectors.md). `diff <before> <after>` compares two profiles; `analyze --exact` adds a true token count ([token counts](./tokenizer.md)).

## Your Claude Code sessions

```bash
npx context-doctor session            # profile your most recent session
npx context-doctor session --list    # browse sessions
```

Parses the transcripts Claude Code writes locally (and Codex rollouts, Gemini CLI chats and ChatGPT data exports) and answers "where did my tokens go today?" — it will happily tell you that one giant skill load is 67% of your context. It uses the token counts the API recorded, reports where the wall clock went per tool, and what the session's subagents cost. `watch` follows a session live; `cursor` profiles a chat from Cursor's local history.

### Prompt-cache economics

Caching is the largest lever on LLM cost, and transcripts record exactly how it went — so `session` reports it as fact rather than estimate:

```
Prompt cache: 95.6% of input served from cache across 1117 requests
  read 558.6M · written 25.5M · uncached 2k
  input cost $438.88 — caching saved $2481.89 against $2920.76 uncached (list prices)
```

A cache read bills at 2.5-10% of input depending on the provider and model, while a write bills 1.25x input (5-minute cache) or 2x (1-hour cache) on Anthropic, and on OpenAI's GPT-5.6 and later 1.25x (30 minutes) or 2.5x (12 hours) (earlier OpenAI models charge no writes). Codex rollouts record one `cache_write_input_tokens` count with no split by lifetime, so Codex writes are priced as 30-minute writes (Codex sets no `prompt_cache_options` on the author's machine; a 12-hour write there would be underpriced by half). So a session that keeps invalidating its prefix can cost *more* than one with no caching at all. context-doctor warns on the two failure modes: a **low hit rate** (something early in the prompt changes every request) and **cache churn** (writes rivalling reads). For an API request of your own, `cache-plan <request.json>` says where `cache_control` belongs and prices it.

### Subagents: their own windows, your bill

A subagent has its own context window, so its tokens are correctly absent from the parent's profile. They are not absent from the bill. Claude Code writes each one to `<session>/subagents/agent-<id>.jsonl`, and `session` reads them:

```
Subagents (their own windows, your bill)
────────────────────────────────────────────────────────
49 subagent(s) made 4560 API calls: 626.0M input billed, 1.0M output, ~$608.51.
That is 10% on top of the parent session's own input cost ($5846.45), and none of it appears in the profile above.
    $42.52   51 calls  ctx   319k    6m  You are auditing part of a FastAPI backend at /Users/kp/tech
    $37.48  107 calls  ctx   229k    6m  You are auditing the Turtle AI backend (FastAPI, Python) at
  … and 44 more
18 subagent(s) ended above 200k tokens of context. A subagent that big is doing a main session's job; give it a narrower brief, or split the task.
```

Per subagent: what it was asked, how many calls it made, the context it ended with, how long it ran, and its cost at list price with cache reads and writes priced correctly. Models without a price on file are counted but marked unpriced rather than costed at zero. When this shipped (0.14.2) that was 195 subagents across 19 sessions on the author's machine and about $1,844 at list price that no profile had ever shown. `context-doctor subagents` asks the next question: was each one cheaper than the same steps run in the parent session?

## Across sessions

- `savings`: what your recent sessions cost and what each lever would have saved ([the README's figures](../README.md#what-it-saves) are the author's).
- `tasks`: cost per commit, per project, from each session's recorded usage and its own `git commit` calls.
- `reads`: files read into session after session, and whether a few lines in CLAUDE.md or `pack` would pay.
- `subagents`: each subagent's bill against the same steps run in the parent.
- `compactions`: whether sessions work worse right after compacting (re-reads, tool errors, your corrections, before and after).
- `cache-misses`: requests that re-wrote the prompt cache while it should still have been warm (within the lifetime of both requests, no compaction between, previous context over 20k, over 60% of it written again), priced above the cache-read rate, by model and context size, with the cause where the transcript shows one; recommends model versions that miss less when the numbers support it. It also groups every request by the Claude Code `version` its transcript line records (first request of a new session, cache writes per request, the share written at the 1-hour TTL, the miss rate) and flags step changes from one well-measured version to the next: the 1-hour share moving 30+ points, the median first request moving 15% and 3k tokens, or one model's miss rate doubling beyond chance. On the author's history (120 days) it found the 1-hour share falling from 76% on 2.1.293 to 37% on 2.1.295 and back to 70% on 2.1.308, a Fable 5 miss spike on 2.1.219 (6.5% against 1.6%) and on 2.1.255 (9.9%, back to 0.9% on 2.1.258), and Sonnet 5 missing 41.5% of warm requests on 2.1.219. With the status line installed (Claude Code 2.1.260+), it also shows why, in Claude Code's own words: Claude Code compares each request with the one before on the client, where it sees the system prompt, the tool definitions, the betas and the TTL (none of which reach the transcript), and passes its verdict to the status line as `prompt_cache.last_miss_cause`. The status line appends each new miss to `~/.claude/.context-doctor-misses.jsonl` (once per miss however often it refreshes, a few lines a day, capped at 1 MB; `CONTEXT_DOCTOR_NO_MISS_LOG=1` turns it off), and `cache-misses` groups them by cause (when the miss count moved by two or more between two status line runs, the misses it never saw are counted as "not seen", with their share of the tokens; a miss with no recorded TTL is priced at 5 minutes, Claude Code's default) (tool definitions changed, system prompt changed, idle past the 5-minute or 1-hour TTL, likely server-side, and the rest of Claude Code's list) with the tokens re-written, their price above a cache read, and what to do about each. Claude Code counts a cache gone cold after a pause as a miss too, so these numbers are wider than the warm-cache misses above. It also counts the re-writes that came just too late: requests less than 25% past the cache's lifetime (under 75 minutes after a 1-hour entry, under 6:15 after a 5-minute one) that wrote the context again, priced the same way (the author's last 30 days: 8 of them, ~5.1M tokens, $83). Three or more in a row in one session (no other cold start between them) on the same TTL, at gaps within 90 seconds or 2% of each other, are named as a loop (a person back after 61, 67 and 73 minutes is not one) resonating with the cache, with an interval that keeps it warm (an agent that woke every 61-62 minutes on a 1-hour cache paid $248 of $285 in cache writes, [anthropics/claude-code#104736](https://github.com/anthropics/claude-code/issues/104736); Claude Code clamps `ScheduleWakeup` to at most 3600 s, and that delay counts from the end of a turn while the TTL counts from its last request).
- `cache-misses`, cold returns: a main-conversation request after the cache the previous one left expired (past its 1-hour or 5-minute lifetime, previous context over 20k, over 60% of it written again, no compaction between) re-writes the whole context. Each is replayed three ways and grouped by time away (<1h, 1-2h, 2-4h, 4-8h, >8h): **as it went** (the request as billed, the figure `spend` adds up); **compacted** (the cold-resume replay: `/compact` right after the return, net of the compaction, with what it saves on the requests after it until the next return; offered over 150k tokens only, the rest stay as billed); **kept warm** (a cache read of the whole context every 55 minutes while away, 4.5 on a 5-minute cache, at the model's read rate plus a 30-token prompt and ~100 output tokens each, so the return reads the context instead of writing it; a return on another model avoids nothing). The replay knows how long you were away; a timer does not, so keeping warm is also priced as a policy for up to 1, 2, 4 and 8 hours, with every ping it would have sent: every pause past the first ping, the returns after the cap (cold anyway) and the sessions never returned to. On the author's 30 days (2026-11-15): 183 returns, $894 billed, $864 of it above cache-read price ($763 on contexts over 300k). Kept warm was cheapest for every gap up to 8 hours (<1h $87 as billed, $7.69 kept warm; 1-2h $146 / $15.19; 2-4h $83 / $12.25; 4-8h $132 / $17.39); past 8 hours compaction was ($446 billed, $320 compacted, $1,665 kept warm). As a policy, 1 hour nets $142, 2 hours $188 (918 pings, $87; 56 returns kept warm, $275), 4 hours $187, 8 hours $166. In Claude Code with the plugin, `/context-doctor-keep-warm` does it ([Desktop app](./desktop.md)). On a subscription the pings come out of your usage limit, as the re-writes they replace do.
- `cache-misses`, a compacted segment put back: the Desktop app can append a copy of history a compaction already removed, its `compact_boundary` included with the same uuid, and a later resume rebuilds the conversation through it ([anthropics/claude-code#107157](https://github.com/anthropics/claude-code/issues/107157): one request from 390k to 862k tokens, 817k written). Found as a boundary whose uuid the transcript already holds, followed (before any real compaction) by a request whose context grew over 30% and 100k tokens; priced as the jump written to the cache, and what each later request pays to read it again. `/compact` only summarizes it again: start a new session from a handoff (`context-doctor handoff`) or `/clear`. A copy followed by a real compaction and no jump ([#102559](https://github.com/anthropics/claude-code/issues/102559)) is not counted. None on the author's last 60 days.
- `accuracy`: how much of what you are billed for the transcript shows, and the tokenizer check ([token counts](./tokenizer.md)).

## Output and polling

`session` (for one session) and `savings` (for the period) also show two costs the levers above do not touch. **Output**: its share of the cost at list price, and the share of output tokens that was reasoning (Claude's `output_tokens_details.thinking_tokens`, Codex's `reasoning_output_tokens`), per model. Shown, not claimed: whether shorter output keeps quality is a question for `context-doctor ab`. **Polling**: a tool call identical to the one before it (the same tool with the same input: BashOutput on one shell, Codex's `wait`, a screenshot taken again while a page loads) is a whole request that re-reads the context; each is priced at the request that made it. On the author's last 30 days: output 9% of $3,071, reasoning 26% of output tokens; 16 repeated calls re-read ~7.0M tokens, $8.60, mostly browser screenshots and batches waiting on a page (120 days: 99 repeats, $115).

## Your plan's limits: `context-doctor limits`

On a subscription the bill is a percentage: Claude Pro, Max and Ultra have a weekly window, and Pro and Max a 5-hour one too (since 2026-10-30 Max 5x is called Max and Max 20x Ultra; Ultra has no 5-hour window), Codex meters credits per token. Local sources record it:

- Claude Code gives its status line command `rate_limits.five_hour` and `.seven_day` (`used_percentage` in 0.1% steps, `resets_at`), for subscribers, after the session's first reply ([status line docs](https://code.claude.com/docs/en/statusline)), and the same windows to the plugin's mod after each turn (`session.measure`, in the Desktop app, the terminal and VS Code). The mod (`context-doctor install` on Claude Code 2.1.286+), the status line (`install --statusline`) and the proxy (`context-doctor autopilot on`, from the API's `anthropic-ratelimit-unified-5h-*` / `-7d-*` reply headers) each append new readings to `~/.claude/.context-doctor-limits.jsonl`, marked with which wrote them: only when a window moves (at most once a minute), or every 15 minutes while it stands still, never a lower figure of the same period (a parallel session's stale one), and never past 2 MB (the newest 1.5 MB, over a week of the heaviest use, are kept). A window that is not there (Ultra's 5-hour one) is simply not written, and every report works on the weekly window alone. Nothing is written without readings (an API key, Bedrock, Vertex); `CONTEXT_DOCTOR_NO_LIMITS_LOG=1` turns it off. With no readings, `limits` says in one line how to start recording them.
- Codex records `rate_limits.primary` / `.secondary` (`used_percent` in whole percents, `window_minutes`, `resets_at`, the plan) on every `token_count` event of its rollouts, next to that request's usage. Read in place from `~/.codex/sessions`.

`limits` shows each window's current %, its pace (the last hour of a 5-hour window, the last day otherwise), and when it runs out at that pace if that comes before the reset. Then it fits each rise in % against the usage recorded on this machine over the same stretch (Claude Code transcripts with their subagents, or Codex's own events), two ways: per token type (uncached input, cache read, cache write, output; non-negative least squares) and by list price (one number, % per dollar). Stretches are cut by time (half an hour on Claude's 0.1% steps, three hours on Codex's whole percents), so busy and quiet ones teach the fit. Each fit shows how much of the rises it explains, its cross-validated error per stretch and, for the price fit, how well the rate itself is known. A rate is quoted only with 8+ stretches, its standard error under 15%, busier stretches clearly rising more (a slope test with an intercept), and under 10% of the rise with no local usage to match (a robust pass drops the few stretches that rose far beyond their usage first); readings lower than an earlier one of the same period come from another session's stale status line and are dropped; then `savings`, `cache-misses` and `compact-window` add each saving in the limit's unit (points of the weekly limit a week, or whole 5-hour windows), with the error. Usage elsewhere (claude.ai in a browser, another computer) moves the % without a transcript here: rises with no local usage are counted apart, and use elsewhere that runs in step with use here cannot be told apart at all: it makes the rate, and savings in %, too high by its share.

**Each weekly window on its own.** One fit over a month assumes a percent of the limit always buys the same use, and it does not: people measured 1% of the week falling from ~$30 to ~$4 of API-equivalent use within a week ([claude-code#108272](https://github.com/anthropics/claude-code/issues/108272)), and `claude -p` draining ~1.8x more per token than the terminal ([#97074](https://github.com/anthropics/claude-code/issues/97074)). So `limits` also takes each weekly window, reset to reset, and gives its % used, the API-equivalent dollars (every request priced at list rates, as `spend` prices it) and tokens of every kind per 1%, over the stretches with usage here (the ratio of the sums, with its error across stretches; rises with no usage here are counted apart as "% matched"), the split of the dollars by entrypoint (`cli`, `claude-desktop`, `sdk-cli` for `claude -p`, `claude-vscode`) and by model, and the Claude Code versions the requests came from. Where the stretches tell them apart (8 or more, a mix that varies), each entrypoint and model gets its own dollars per 1%, known to ±30% or not shown. Then it says where that figure moved by 1.5x or more beyond its error: between two windows (3 standard errors, dated at the reset) and inside one (4, at the one split of its stretches that separates two rates best, dated at that stretch), with the Claude Code versions either side. `limits --json` carries all of it (`resets`, `changes`), and `limitsByReset` in `limits.ts` returns it for a pane or a script.

**Past the limit: usage credits.** With extra usage on (Claude's usage credits), Claude Code keeps working when a weekly or 5-hour limit runs out, and the requests are paid from credits: real money that the % no longer shows. `limits` then says it in one line per time it happened, for example "Your weekly limit ran out on Tue, Nov 17 at 14:05; 37 requests after that were paid from usage credits, about $41.20 at API list prices (an estimate)", and "Still past it; it resets on ..." while it lasts. Two sources say which requests: the proxy records the API's `anthropic-ratelimit-unified-overage-status`, `-overage-in-use`, `-overage-utilization` (kept as a percent) and `-overage-reset` reply headers into the same ledger, as lines of their own (`"w": "overage"`, written at once when the status or in-use flag changes, a moved utilization at most once a minute, a keepalive every 15 minutes; older versions of context-doctor skip them), and a request made while the newest such reading (at most 16 minutes old) said in use is counted, one it said not in use is not. The mod and the status line hand over only the windows' %, nothing on credits, so a request that still went through after a window read 100% and before that window reset is counted as inferred and said to be ("most likely on usage credits (inferred)"); the API's own word, where the proxy read it, comes first. With extra usage off (`~/.claude.json` `oauthAccount.hasExtraUsageEnabled: false`) nothing is inferred. Nothing is printed when no limit ran out (a peak under 100%), and nothing is drawn or sent: only `limits`, `spend` (its dollars split at the limit) and `doctor` (whether extra usage is on, from the same file and its `cachedExtraUsageDisabledReason`) say it. `limits --json` carries it as `credits` (each episode's window, when it ran out, its reset, requests, dollars, and how many came from the headers and how many were inferred), present only when there is one. **Not verified:** whether usage credits are billed at exactly API list prices; the dollars are each request at list price, as `spend` prices it, and are called an estimate everywhere. The in-use header's meaning is read from Claude Code 2.1.311's own parsing, not from a documented API.

**A block for a bug report: `context-doctor limits --report`** (`--copy` puts it on the clipboard). A markdown block to paste into a GitHub issue: per weekly window (UTC dates) the % used and matched, $ and tokens per 1%, the entrypoint split and the Claude Code versions; every move in what 1% buys, dated; each entrypoint's and model's own figure where there is one; the windows read (weekly only, on a plan with no 5-hour window); the context-doctor version. It holds figures, dates, model and entrypoint names and version numbers only: no prompt, no file path, no session, message or account id (a model id that is a cloud resource, such as a Bedrock ARN with its account number, is shown as "custom model id"); a test plants each in a history and checks that none comes out.

Measured on the author's Codex history (team plan, monthly window, July-August 2026: 9 stretches of 3 hours, 32 points, 347 requests, mostly gpt-5.6-sol): per 1M tokens, uncached input 5.6% of the month, cache reads 0.46% (8.2% of input's weight; OpenAI's rate card says 10%), output 49%; list price alone explains 99% of the rises, the rate known to ±3%. No Claude readings yet: the status line records them from 0.38 on (`install --statusline`).

## Measuring the impact: `context-doctor report`

```bash
npx context-doctor report
```

One report for your whole machine, led by a headline of **tokens context-doctor saved**, built only from measured sources:

- **exact** proxy savings (real before/after on every request),
- **exact** savings from every optimization applied via the CLI or the in-chat tools — split by model family (Claude vs GPT), with dollar estimates,
- and, **on its own line, not in the total**: sessions that got smaller after a hygiene warning. That is mostly compaction, by you or by Claude Code, and a warning may or may not be why it happened, so it is not credited to context-doctor (until 0.24 it was, which overclaimed). The dashboard (`context-doctor dashboard`, on 127.0.0.1) keeps the same split.

Honest measurement note: proxy numbers are exact. Session numbers are measured-now. What no tool can report is the counterfactual — tokens Claude *avoided* adding because of the hygiene guidance — since the same session can't be re-run without it. The report says so instead of inventing a number.

## Sharing a profile safely

A profile quotes message previews and file paths, so pasting one into an issue pastes fragments of real work. `--redact` keeps every number and the finding structure but replaces content with `[redacted]` and masks paths:

```bash
npx context-doctor session --redact
```

`context-doctor doctor` is safe to paste as-is: it reports integration status, never conversation content.
