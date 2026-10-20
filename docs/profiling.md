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

A cache read bills at 2.5-10% of input depending on the provider and model, while a write bills 1.25x input (5-minute cache) or 2x (1-hour cache) on Anthropic, so a session that keeps invalidating its prefix can cost *more* than one with no caching at all. context-doctor warns on the two failure modes: a **low hit rate** (something early in the prompt changes every request) and **cache churn** (writes rivalling reads). For an API request of your own, `cache-plan <request.json>` says where `cache_control` belongs and prices it.

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
- `cache-misses`: requests that re-wrote the prompt cache while it should still have been warm (within the lifetime of both requests, no compaction between, previous context over 20k, over 60% of it written again), priced above the cache-read rate, by model and context size, with the cause where the transcript shows one; recommends model versions that miss less when the numbers support it.
- `accuracy`: how much of what you are billed for the transcript shows, and the tokenizer check ([token counts](./tokenizer.md)).

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
