---
name: context-doctor
description: Keep the LLM context window lean and fast. Use when the conversation grows long, large content is pasted or produced by tools, the user asks "what's eating my context/tokens", asks to reduce cost or latency of LLM calls, or asks to profile/optimize/compact a conversation. Also triggers on "context doctor", "token usage", "context window", "prompt caching".
---

# Context Doctor — context hygiene for this session and the user's LLM apps

You have two jobs when this skill triggers: (1) keep **this session's** context lean, and (2) help the user profile and optimize **their own** LLM conversations and apps using the context-doctor toolkit.

## Principles of a healthy context window

1. **Tool results are the #1 context killer.** After using a large tool result, carry forward only the extracted facts; never re-quote large outputs. If a tool returns >2k tokens and you need <10% of it, summarize the relevant part immediately in one sentence.
2. **Never duplicate.** If a document, file, or result already appears earlier in the conversation, reference it ("the pricing doc from earlier") instead of re-pasting it.
3. **Stable first, volatile last.** Prompt caches match byte-identical prefixes. Anything reusable (system prompts, tool definitions, reference docs) belongs before anything per-request. One changed byte early invalidates the cache for everything after it — this alone can be a 10x cost difference.
4. **No base64 in text.** Images and files go through file/image APIs, never inline as base64 text.
5. **Summarize old history.** Past ~30-40 turns, models lose the middle of the context. Proactively offer to compact: write a tight summary of the older turns, keep the recent ones verbatim.
6. **Fewer input tokens = faster responses.** Time-to-first-token scales with input size. Every token trimmed is latency and money saved on EVERY subsequent call.

## When the conversation you are in grows long

Proactively (do not wait to be asked):
- Summarize large tool outputs right after consuming them.
- When the session passes roughly 30 turns or contains several large pastes, offer: "This conversation is getting heavy — want me to compact the older history into a summary so responses stay fast and cheap?"
- When asked to summarize/compact, produce a dense factual summary (decisions made, current state, open items, key identifiers) — not a narrative.

## Using the context-doctor tools

If the `context-doctor` MCP tools are available:
- `profile_context` — pass a conversation JSON (OpenAI or Anthropic format) or raw text; returns a token breakdown, largest messages, findings with estimated savings.
- `optimize_context` — applies deterministic fixes (dedupe, trim stale tool results, strip base64; opt-in `trim-tool-calls` for big inline file writes and `prune-history`). When the result contains pruned-turn source material and asks for a summary, **you write that summary** (≤150 tokens, dense, factual) and place it where the stub indicates — this is how summarization works without any API key.
- `context_best_practices` — provider-specific checklist to share with the user.

If the tools are not connected, the CLI does the same: `npx context-doctor analyze <file> --model <model>` and `npx context-doctor optimize <file>`. For always-on optimization of the user's own apps: `npx context-doctor proxy` then point `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at it.

## When the user pastes a conversation or asks about their token usage

1. Run `profile_context` (or suggest the CLI) rather than eyeballing.
2. Lead with the top finding and its dollar/latency impact, not the full dump.
3. Offer to apply the safe fixes via `optimize_context`; only suggest `prune-history` when the user confirms losing old detail is acceptable (and then write the replacement summary yourself).
