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

**One command sets up everything** — detects Claude Desktop, Claude Code, and Cursor on your machine, wires in the MCP server, and installs the Agent Skill:

```bash
npx context-doctor install
```

Restart your apps, then just ask Claude: *"what's eating my context?"* (`npx context-doctor uninstall` reverses it.)

Or use the CLI directly, no install needed:

```bash
npx context-doctor analyze conversation.json --model claude-sonnet-5
```

```bash
npx context-doctor optimize conversation.json --out slimmed.json
```

Input is any of: OpenAI chat format, Anthropic messages format (with `system` and content blocks), or a bare `[{role, content}]` array. Use `-` to pipe from stdin.

Reports include **dollar and latency estimates**, not just tokens:

```
Cost:  ~$3.30 input per call · ~$3302 per 1k calls · ~13.2s of latency per call (estimates)
...
Potential recovery: ~5.9k tokens (~73% of context) ≈ $17.69 per 1k calls, 0.2s faster per call
```

## Profile your actual Claude Code sessions

```bash
npx context-doctor session            # profile your most recent session
npx context-doctor session --list    # browse sessions
```

Parses the transcripts Claude Code writes locally and answers "where did my tokens go today?" — it will happily tell you that one giant skill load is 67% of your context.

## Always-on: optimize every request automatically

Run the proxy and every Anthropic/OpenAI API call your apps make gets optimized in flight — no code changes:

```bash
npx context-doctor proxy
```

Then point your app or SDK at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787      # Anthropic SDKs / tools
export OPENAI_BASE_URL=http://localhost:8787/v1      # OpenAI SDKs / tools
```

The proxy dedupes repeated content, trims stale tool results, and strips base64 blobs from the message history of each request, then forwards it to the real API. Your API key passes through in headers untouched, streaming (SSE) works unchanged, and per-request savings are logged with upstream latency:

```
[context-doctor] POST /v1/messages → 200 in 842ms | optimized 7.3k → 518 tokens (2 changes) | session total: 6.9k tokens ≈ $0.021 saved
```

`GET http://localhost:8787/stats` returns cumulative savings (requests, tokens, estimated USD) since launch.

Because prompt caching matches byte-identical prefixes, deterministic strategies are chosen so repeated requests stay stable — but if you rely on aggressive cache prefixes, start with `--strategy strip-base64 --strategy dedupe` and add more as you verify.

> **Note on desktop chat apps:** Claude Desktop and the ChatGPT app talk to their own backends — no tool can sit in that path. For those, use the MCP integration below and add a line to your custom instructions like: *"When a conversation gets long or includes large pasted content, proactively use context-doctor's profile_context tool and tell me what to trim."* The model will then invoke it on its own.

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

**Summarization without an API key:** when `prune-history` runs through the MCP tools, context-doctor hands a digest of the pruned turns back to the model that called it (the Claude/GPT already running in your app) and asks *it* to write the replacement summary — LLM-quality compaction, zero extra cost, no keys.

## The Agent Skill

`skills/context-doctor/SKILL.md` (installed by `npx context-doctor install`) teaches Claude to practice context hygiene proactively: summarize big tool results after consuming them, never re-paste duplicated content, keep stable content cache-friendly, and offer compaction when a session gets heavy — so sessions get inherently leaner without you asking.

## Why token counts are "~"

Exact counts require each provider's private tokenizer. `context-doctor` uses a calibrated chars-per-token heuristic (denser for code/JSON) that lands within ~10% — plenty accurate for finding what's heavy and measuring savings, and it keeps the tool fully offline with zero configuration.

## Roadmap

- [x] ~~Session import from Claude Code transcript formats~~ (`context-doctor session`)
- [x] ~~LLM summarization for prune-history~~ (host-model summarization via MCP — no key needed)
- [ ] Proxy: per-route strategy config + response token accounting
- [ ] `context-doctor watch` — live profiling of a running agent's JSONL trace
- [ ] Exact tokenizer adapters (tiktoken, Anthropic count-tokens API) as optional plugins
- [ ] Cursor / ChatGPT-export transcript formats for `session`

Contributions welcome — this project is small on purpose. Open an issue before a big PR.

## License

MIT
