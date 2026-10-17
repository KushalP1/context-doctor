# Why token counts are "~" (and where they are exact)

[← README](../README.md)

Counting exactly needs each provider's tokenizer, so the default is a chars-per-token heuristic, with ratios per provider and denser ones for code and JSON. It keeps the tool offline and zero-config.

| Model | Prose | Code / tool output | Source |
|---|---|---|---|
| Claude (Opus 4.7 to 5.x, Fable 5.x, Sonnet 5) | 2.75 chars/token | 2.4 | Measured from the API's own counts, below |
| GPT, Gemini, unknown | 4.0 | 3.2 | Usual figures for o200k-class tokenizers; not re-measured here |

Which row applies: the model you pass, else the request's own `model` field, else the request's shape (Anthropic's `system` field or `tool_use` blocks mean Claude). Cursor transcripts record no model and use Anthropic-style blocks, so Cursor sessions are counted at Claude density; for a GPT model in Cursor that reads about 40% high.

**How the Claude figures were measured, with no key.** Claude Code transcripts record what the API billed, and two things in them are exact. A reply with no thinking block is billed as exactly its `output_tokens`, and all of it is visible text: 504 replies gave a median of 2.75 chars/token (p10 2.4, p90 3.0). Between two consecutive API calls the prompt grows by exactly what was appended; when that is one large block, its size is the growth minus the previous reply: 474 blocks of code and tool output gave 2.4 (p10 2.1, p90 2.8). The ratios this tool used until 0.19 (4.0 / 3.2 for everything) **undercounted current Claude models**: Claude counts about 40% more tokens than that rule (~45% on prose, ~33% on code), so estimates read ~31% low on prose; hook warnings came late, savings and costs read low, and the proxy stayed silent on cacheable prefixes between 1,024 and ~1,670 tokens. `context-doctor accuracy` re-runs both measurements on your own sessions and prints them per model beside the ratio in use, so the next tokenizer change shows up as a number, not a surprise. On this machine every model lands within ±9%.

Two ways to get real numbers instead of estimates:

- **`analyze --exact`** uses the Anthropic count-tokens API for Claude models (set `ANTHROPIC_API_KEY`; opt-in network call, key never stored) or tiktoken for GPT models (install it alongside), and reports how far the heuristic drifted.
- **Sessions report measured tokens automatically.** Claude Code transcripts record what the API actually charged, so `session`, the hook and the reports use that figure when it is present — no key, no estimate.

One honest caveat worth knowing: a transcript stores the conversation, **not** the harness's system prompt, tool schemas or skills (about 54k tokens before the first turn in Claude Code here), nor the reminders it injects each turn. With the corrected ratios the transcript accounts for a median 56% of each turn's billed growth; before 0.19 this read 39%, and about a third of that "invisible" gap was the estimator. That is why sessions prefer the reported figure, and why the message breakdown is labelled as covering messages only.

**The chat-app sketch** ([Claude Desktop](./chat-apps.md#claude-desktop-step-by-step)) is coarser by design, because the model describes the chat instead of sending it. Its sizes are measured, not assumed: a plain exchange is 2,060 chars (median of 1,283), a code line 42 chars (719 source files), a log line 56 (2,095 tool outputs), a word 6.3, all converted with the model's own ratio. Measured error: the total for a chat of 30+ exchanges from its turn count alone is within -20% to +9% (p10 to p90); a code block sized by lines is within about ±25%, by chars about ±15%. Logs vary from 38 to 100 chars a line, so the tool asks for their size in chars.

## Exact counts, and what they teach the estimator

The default token count is a chars-per-token heuristic so everything runs with no key and no tokenizer, with ratios per provider (above). `analyze --exact` fetches a true count for the exact bytes just estimated (Anthropic's count-tokens API with `ANTHROPIC_API_KEY`; tiktoken for GPT if installed) and prints the drift.

Since 0.13.9 it also **remembers the comparison**, per model family, on this machine, and later estimates for that family are scaled by it. Nothing about this is silent: the profile header says `estimates calibrated +12% from 3 exact count(s) you ran on this machine`. No exact count ever run means no calibration and unchanged numbers; out-of-range samples are ignored; `CONTEXT_DOCTOR_NO_CALIBRATION=1` returns to the raw heuristic. Samples are tied to the heuristic they were taken against: after 0.19 changed Claude's ratios, older samples are ignored and learning restarts, rather than stacking an old correction on a fixed estimator.
