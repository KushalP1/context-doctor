# context-doctor 🩺

**See what's eating your LLM context window — and fix it.**

Every long-running LLM conversation slowly fills up with junk: duplicated documents, 10k-token tool outputs nobody reads again, base64 blobs, stale history. You pay for those tokens on **every single call**, and model quality drops as the window fills.

`context-doctor` is a zero-config profiler + optimizer for LLM contexts. It works with **Claude, GPT, Gemini** message formats, and plugs into **Claude Desktop, ChatGPT (developer mode), Cursor, Claude Code** — any MCP-capable app — or runs standalone from the terminal.

Built and maintained by [gAI Ventures](https://gai.ventures).

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

**One command sets up everything** — detects Claude Desktop, Claude Code, and Cursor on your machine, wires in the MCP server, installs the Agent Skill, and registers the Claude Code every-prompt hook:

```bash
npx context-doctor install
```

Until the package lands on npm, install straight from GitHub instead (needs Node 18+):

```bash
npm install -g github:KushalP1/context-doctor && context-doctor install
```

That pair of commands is also all it takes to **set up context-doctor on anyone else's machine**.

Restart your apps, then just ask Claude: *"what's eating my context?"* (`npx context-doctor uninstall` reverses it.)

**No API keys, ever.** Everything is deterministic local code; when an LLM is needed (summarizing pruned history), the model already running in your app does it. The proxy forwards *your app's* credentials untouched — context-doctor itself holds nothing.

## What `install` actually does — and what happens in every session after

One run of `npx context-doctor install` writes five things (each config edit makes a `.backup` first; `uninstall` reverses all of it):

1. **Claude Desktop config** (`claude_desktop_config.json`) — registers the MCP server
2. **Claude Code config** (`~/.claude.json`) — registers the MCP server
3. **Cursor config** (`~/.cursor/mcp.json`) — registers the MCP server
4. **Agent Skill** → `~/.claude/skills/context-doctor/` — context-hygiene playbook for Claude Code
5. **Every-prompt hook** → `~/.claude/settings.json` — the per-query context check for Claude Code

**In every chat afterward (Claude Desktop, Cursor):** when the conversation starts, the app launches the MCP server, which hands the model standing instructions that stay in force for the whole chat:

- summarize large pastes and tool results instead of carrying them verbatim,
- reference earlier content instead of re-quoting it, never inline base64,
- once the chat passes ~30 turns or accumulates big pastes, *proactively offer to profile it*,
- answer any "what's eating my context / cost / latency" question by calling `profile_context`, not by guessing.

**In every Claude Code / Cowork session afterward:** all of the above via MCP, plus two more layers:

- the **skill** loads whenever context work is relevant, and
- the **hook runs on every single prompt you send**: it measures the session's real size in ~100ms. Under 80k tokens it stays completely silent. Above, it injects a note the model sees with your message — actual token count, cost per message, the single largest recoverable waste — with instructions to work leaner and offer you compaction. It re-fires only after ~40% further growth, and can never break a prompt (any failure exits silently).

**What it never does:** delete or rewrite your history without asking (pruning is consent-only, and the model writes the replacement summary so nothing is lost silently), send data anywhere (everything runs on your machine), or touch an API key.

## Do you need MCP? Only sometimes — all the ways to use context-doctor

MCP is just one of six delivery mechanisms. It's only required when you want the AI **inside a chat app** to run the tools itself. Everything else works without it:

| How you use it | MCP needed? | What it requires |
|---|---|---|
| **CLI** — `analyze`, `optimize`, `session` on files/transcripts | ❌ No | Nothing but `npx` — works in any terminal, scripts, CI |
| **Proxy** — always-on optimization of your API apps | ❌ No | `context-doctor proxy` + one env var in your app |
| **Claude Code every-prompt hook** | ❌ No | Written by `install`; Claude Code invokes it directly |
| **Agent Skill** — hygiene behavior in Claude Code / claude.ai | ❌ No | A markdown file; `install` places it (or upload to claude.ai) |
| **Library** — `import { profileConversation } from "context-doctor"` | ❌ No | `npm install context-doctor` in your project |
| **In-chat tools** — Claude Desktop, ChatGPT desktop, Cursor chat | ✅ Yes | This is the only MCP piece — so the model itself can call `profile_context` / `optimize_context` mid-conversation |

Practical upshot: a developer who only wants cheaper, faster API calls never touches MCP (proxy + CLI). A Claude Code user gets the hook and skill without MCP either — the MCP server just adds in-chat tools on top. `install` sets up all of it at once precisely so you don't have to think about which mechanism is which.

## What "always-on" means, per surface

| Where you run LLMs | Mechanism | Guarantee |
|---|---|---|
| Your own apps/agents (API) | `context-doctor proxy` rewrites every request in flight | **Every call, automatic** |
| Claude Code / Cowork sessions | `install` registers a **UserPromptSubmit hook**: every query measures the session; heavy sessions get injected hygiene guidance (silent when lean, rate-limited, never blocks a prompt) | **Every query checked** |
| Claude Desktop chat / Cursor | **MCP server instructions** — standing hygiene directives injected into every conversation where the server is enabled, plus prescriptive tool triggers | **Every conversation carries the rules** |
| claude.ai (web) / ChatGPT app | Upload `skills/context-doctor/SKILL.md` in the app's Skills settings for the same standing behavior | Manual one-time upload |

Nothing runs in the background for the Claude apps — the hook, skill, MCP server, and its instructions are all delivered by the app itself at the right moment. The proxy is the only long-running piece, and only your API-calling apps need it.

Optional belt-and-braces for any chat app: add one line to your profile preferences — *"Practice context hygiene: summarize large content instead of re-quoting it, and use context-doctor's tools when conversations get heavy."*

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

## Use with the Claude & ChatGPT apps

`context-doctor` ships an MCP server, so the AI itself can profile and slim context on demand.

**Do you need to configure anything by hand? Usually no:**

| App | Setup |
|---|---|
| Claude Desktop | `npx context-doctor install` writes the config — just restart the app |
| Claude Code | Same command — MCP + skill + every-prompt hook, all automatic |
| Cursor | Same command — writes `~/.cursor/mcp.json` |
| ChatGPT desktop | **Manual, one time** (ChatGPT's connectors live inside its own settings): Settings → Connectors → Developer mode → add local server, command `npx`, args `-y context-doctor-mcp` |

For any other MCP client, the server entry is:

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

### How it works in Claude Desktop, step by step

1. Run `npx context-doctor install` (writes the config above for you) and restart Claude Desktop.
2. From then on, **every conversation automatically carries context-doctor's standing instructions** — the MCP server hands Claude hygiene rules on connect: summarize big pastes instead of re-quoting them, offer profiling when the chat gets long, never inline base64.
3. Chat normally. When a conversation grows heavy, Claude proactively offers: *"this chat is getting large — want me to profile it?"* — or you ask *"what's eating my context?"* and it calls `profile_context` and shows the token/cost breakdown.
4. Say *"optimize it"* and Claude applies the safe fixes; if you agree to pruning old history, **Claude itself writes the replacement summary** (that's the no-API-key summarization).

### How it works in ChatGPT, step by step

1. ChatGPT's desktop app supports MCP in **developer mode**: Settings → Connectors → Advanced → Developer mode, then add a local MCP server with command `npx` and args `-y context-doctor-mcp`.
2. Enable the connector in a chat. GPT sees the same three tools with the same trigger guidance baked into their descriptions.
3. Ask *"profile this conversation"* or paste an exported chat and ask *"what's eating my context?"* — GPT calls `profile_context` and reports the breakdown; *"optimize it"* works the same, including GPT writing the pruning summary itself.
4. Caveat: how prominently standing server instructions surface varies by ChatGPT version — the tool descriptions carry the trigger rules regardless, so profiling still fires on the right questions.

For ChatGPT on the web (no MCP): export the conversation and use the CLI — `npx context-doctor analyze chat.json --model gpt-5`.

### claude.ai on the web

Your local MCP server can't reach the website, but the behavior can: upload `skills/context-doctor/SKILL.md` under Settings → Capabilities → Skills, and web conversations gain the same standing context-hygiene habits (summarize-don't-requote, offer compaction when heavy).

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

## Releasing (maintainers)

```bash
npm version patch        # or minor/major — bumps package.json + git tag
npm test                 # 14 tests must pass; CI runs the same on 3 OSes
npm publish              # prompts for the npm 2FA code
git push --follow-tags
```

Known gotcha: if `npm publish` fails with **`404 Not Found - PUT …/context-doctor`** on a package that clearly exists, the real cause is an **expired npm login token** — npm reports unauthenticated publishes as a 404, not a 401. Check with `npm whoami`; if that errors, run `npm login` and publish again.

Also keep the MCP server version in `src/mcp.ts` in sync with `package.json`, and remember `dist/` is committed — run `npm run build` before committing so the CI dist-sync check passes.

## License

MIT © [gAI Ventures](https://gai.ventures)
