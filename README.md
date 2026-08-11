# context-doctor 🩺

**See what's eating your LLM context window — and fix it.**

Every long-running LLM conversation slowly fills up with junk: duplicated documents, 10k-token tool outputs nobody reads again, base64 blobs, stale history. You pay for those tokens on **every single call**, and model quality drops as the window fills.

`context-doctor` is a zero-config profiler + optimizer for LLM contexts. It works with **Claude, GPT, Gemini** message formats, and plugs into **Claude Desktop, ChatGPT (developer mode), Cursor, Claude Code** — any MCP-capable app — or runs standalone from the terminal.

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

## Quick start (30 seconds)

No install needed:

```bash
npx context-doctor analyze conversation.json --model claude-sonnet-5
```

Apply the safe fixes:

```bash
npx context-doctor optimize conversation.json --out slimmed.json
```

Input is any of: OpenAI chat format, Anthropic messages format (with `system` and content blocks), or a bare `[{role, content}]` array. Use `-` to pipe from stdin.

## Use it inside your AI app (MCP)

`context-doctor` ships an MCP server, so the AI itself can profile and slim context on demand.

**Claude Desktop** — add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "context-doctor": {
      "command": "npx",
      "args": ["-y", "context-doctor-mcp"]
    }
  }
}
```

**ChatGPT desktop** (developer mode), **Cursor**, **Claude Code** (`claude mcp add context-doctor -- npx -y context-doctor-mcp`), and any other MCP client: same command, their config syntax.

Then just ask: *"profile this conversation with context-doctor"* or paste an exported chat and say *"what's eating my context?"*

### MCP tools

| Tool | What it does |
|---|---|
| `profile_context` | Token breakdown by category, largest messages, findings with estimated savings |
| `optimize_context` | Rewrites the conversation: dedupe, trim stale tool results, strip base64, optional history pruning |
| `context_best_practices` | Curated checklist, optionally specialized for Anthropic / OpenAI |

## Use it as a library

```ts
import { parseConversation, profileConversation, optimizeConversation } from "context-doctor";

const profile = profileConversation(parseConversation(chatJson), "claude-sonnet-5");
console.log(profile.totalTokens, profile.findings);

const { conversation, tokensBefore, tokensAfter } = optimizeConversation(chatJson, {
  strategies: ["dedupe", "trim-tool-results", "strip-base64"],
});
```

## What it detects

- **Oversized tool results** — the #1 context killer in agent loops
- **Duplicate content** — the same doc/result pasted twice
- **Repeated identical tool calls** — a signal your agent forgot earlier results
- **Base64 / binary blobs** in text content
- **Long history** past the point where models track the middle
- **Cache-hostile ordering** — volatile content before stable content breaks prompt caching (Anthropic `cache_control`, OpenAI automatic prefix caching)
- **Window pressure** — usage % against the target model's real context window

## What it fixes (deterministically — no LLM calls, no API keys)

| Strategy | Lossy? | Default |
|---|---|---|
| `dedupe` — replace repeated content with a reference | No | ✅ |
| `trim-tool-results` — truncate stale tool outputs | Mostly no | ✅ |
| `strip-base64` — remove inline binary blobs | No (for the model) | ✅ |
| `prune-history` — collapse old turns into a stub for summarization | Yes | opt-in |

Everything the optimizer does is inspectable: it prints exactly which messages changed and how many tokens each change saved.

## Why token counts are "~"

Exact counts require each provider's private tokenizer. `context-doctor` uses a calibrated chars-per-token heuristic (denser for code/JSON) that lands within ~10% — plenty accurate for finding what's heavy and measuring savings, and it keeps the tool fully offline with zero configuration.

## Roadmap

- [ ] LLM-powered summarization strategy (bring your own key) for `prune-history` stubs
- [ ] `context-doctor watch` — live profiling of an agent's JSONL trace
- [ ] Exact tokenizer adapters (tiktoken, Anthropic count-tokens API) as optional plugins
- [ ] Session import from Claude Code / Cursor transcript formats

Contributions welcome — this project is small on purpose. Open an issue before a big PR.

## License

MIT
