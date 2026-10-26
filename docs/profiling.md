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
- `cache-misses`: requests that re-wrote the prompt cache while it should still have been warm (within the lifetime of both requests, no compaction between, previous context over 20k, over 60% of it written again), priced above the cache-read rate, by model and context size, with the cause where the transcript shows one; recommends model versions that miss less when the numbers support it. It also groups every request by the Claude Code `version` its transcript line records (first request of a new session, cache writes per request, the share written at the 1-hour TTL, the miss rate) and flags step changes from one well-measured version to the next: the 1-hour share moving 30+ points, the median first request moving 15% and 3k tokens, or one model's miss rate doubling beyond chance. On the author's history (120 days) it found the 1-hour share falling from 76% on 2.1.293 to 37% on 2.1.295 and back to 70% on 2.1.308, a Fable 5 miss spike on 2.1.219 (6.5% against 1.6%) and on 2.1.255 (9.9%, back to 0.9% on 2.1.258), and Sonnet 5 missing 41.5% of warm requests on 2.1.219.
- `accuracy`: how much of what you are billed for the transcript shows, and the tokenizer check ([token counts](./tokenizer.md)).

## Output and polling

`session` (for one session) and `savings` (for the period) also show two costs the levers above do not touch. **Output**: its share of the cost at list price, and the share of output tokens that was reasoning (Claude's `output_tokens_details.thinking_tokens`, Codex's `reasoning_output_tokens`), per model. Shown, not claimed: whether shorter output keeps quality is a question for `context-doctor ab`. **Polling**: a tool call identical to the one before it (the same tool with the same input: BashOutput on one shell, Codex's `wait`, a screenshot taken again while a page loads) is a whole request that re-reads the context; each is priced at the request that made it. On the author's last 30 days: output 9% of $3,071, reasoning 26% of output tokens; 16 repeated calls re-read ~7.0M tokens, $8.60, mostly browser screenshots and batches waiting on a page (120 days: 99 repeats, $115).

## Your plan's limits: `context-doctor limits`

On a subscription the bill is a percentage: Claude Pro and Max have a 5-hour and a weekly window, Codex meters credits per token. Two local sources record it:

- Claude Code gives its status line command `rate_limits.five_hour` and `.seven_day` (`used_percentage` in 0.1% steps, `resets_at`), for Pro and Max, after the session's first reply ([status line docs](https://code.claude.com/docs/en/statusline)). With `context-doctor install --statusline`, each new reading is appended to `~/.claude/.context-doctor-limits.jsonl`: only when a window moves (at most once a minute), or every 15 minutes while it stands still, never a lower figure of the same period (a parallel session's stale one), and never past 2 MB (the newest 1.5 MB, over a week of the heaviest use, are kept). Nothing is written without `rate_limits` (an API key, Bedrock, Vertex); `CONTEXT_DOCTOR_NO_LIMITS_LOG=1` turns it off.
- Codex records `rate_limits.primary` / `.secondary` (`used_percent` in whole percents, `window_minutes`, `resets_at`, the plan) on every `token_count` event of its rollouts, next to that request's usage. Read in place from `~/.codex/sessions`.

`limits` shows each window's current %, its pace (the last hour of a 5-hour window, the last day otherwise), and when it runs out at that pace if that comes before the reset. Then it fits each rise in % against the usage recorded on this machine over the same stretch (Claude Code transcripts with their subagents, or Codex's own events), two ways: per token type (uncached input, cache read, cache write, output; non-negative least squares) and by list price (one number, % per dollar). Stretches are cut by time (half an hour on Claude's 0.1% steps, three hours on Codex's whole percents), so busy and quiet ones teach the fit. Each fit shows how much of the rises it explains, its cross-validated error per stretch and, for the price fit, how well the rate itself is known. A rate is quoted only with 8+ stretches, its standard error under 15%, busier stretches clearly rising more (a slope test with an intercept), and under 10% of the rise with no local usage to match (a robust pass drops the few stretches that rose far beyond their usage first); readings lower than an earlier one of the same period come from another session's stale status line and are dropped; then `savings`, `cache-misses` and `compact-window` add each saving in the limit's unit (points of the weekly limit a week, or whole 5-hour windows), with the error. Usage elsewhere (claude.ai in a browser, another computer) moves the % without a transcript here: rises with no local usage are counted apart, and use elsewhere that runs in step with use here cannot be told apart at all: it makes the rate, and savings in %, too high by its share.

Measured on the author's Codex history (team plan, monthly window, July-August 2026: 9 stretches of 3 hours, 32 points, 347 requests, mostly gpt-5.6-sol): per 1M tokens, uncached input 5.6% of the month, cache reads 0.46% (8.2% of input's weight; OpenAI's rate card says 10%), output 49%; list price alone explains 99% of the rises, the rate known to ±3%. No Claude readings yet: the status line starts recording them with this release.

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
