# context-doctor 🩺

[![CI](https://github.com/KushalP1/context-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/KushalP1/context-doctor/actions) [![npm](https://img.shields.io/npm/v/context-doctor)](https://www.npmjs.com/package/context-doctor)

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

That single command is also all it takes to **set up context-doctor on anyone else's machine**. Prefer a global install, or want the unreleased `main`? Both work (Node 18+):

```bash
npm install -g context-doctor && context-doctor install
```

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
- the **hook runs on every single prompt you send**: lean sessions cost a ~1ms file-size check; once a session is heavy it profiles on growth events and injects a note the model sees with your message — actual token count, cost per message, the single largest recoverable waste — with instructions to work leaner and offer you compaction. It re-fires only after ~40% further growth, can never break a prompt (any failure exits silently), and logs each deep check to a small local ledger that feeds `context-doctor report`.

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

## All commands at a glance

| Command | What it does |
|---|---|
| `context-doctor install` / `uninstall` | Wire (or remove) everything: MCP for Claude Desktop/Code/Cursor, the Agent Skill, the every-prompt hook |
| `context-doctor analyze <file>` | Profile a conversation: token breakdown, findings, cost + latency estimates |
| `context-doctor optimize <file>` | Apply the safe fixes; `--strategy prune-history` for consented lossy compaction |
| `context-doctor session [file]` | Profile a Claude Code session: live context, findings, **measured tokens and prompt-cache economics**. Also reads ChatGPT data exports (`conversations.json`) |
| `context-doctor cursor [--list]` | Profile a chat from Cursor's local history (both storage formats) |
| `context-doctor report` | Machine-wide impact report: exact proxy savings, hook activity, recoverable waste in recent sessions |
| `context-doctor proxy` | Always-on local proxy that optimizes every Anthropic/OpenAI API request in flight (`/stats` for cumulative savings) |
| `context-doctor watch [file]` | Live monitor of a growing session/agent trace: token/cost line per change, findings as they appear |
| `context-doctor doctor` | Self-check the whole installation — one pasteable ✓/✗ diagnosis with fixes |
| `context-doctor dashboard` | Local savings dashboard on 127.0.0.1: tokens saved per day, sessions by context in use vs recoverable, budget status |
| `context-doctor hook` | The every-prompt Claude Code hook (registered by `install`; you never run this yourself). Warning threshold tunable via `CONTEXT_DOCTOR_WARN_TOKENS` (default 80000) |
| `context-doctor-mcp` | The MCP server itself — stdio by default (what the installer wires); `--http [--port 8808] [--host H]` serves streamable HTTP at `/mcp` for URL-based clients like ChatGPT developer-mode connectors |

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

`GET http://localhost:8787/stats` returns cumulative savings (requests, tokens, estimated USD), **exact upstream usage** read from every response (JSON and SSE), and **prompt-cache advisories** — the proxy watches your real traffic and flags big stable prefixes missing `cache_control` or prefix churn that silently re-bills the cache. Per-model behavior via `--config`:

```json
{ "routes": [{ "modelPrefix": "gpt", "strategies": ["strip-base64"], "keepRecent": 4 }] }
```

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
| ChatGPT (developer mode) | **Manual + a reachable URL** — ChatGPT connects to servers over the internet, never local commands. Run `context-doctor-mcp --http` on a host/tunnel, then add the URL as a connector. Normal ChatGPT (no dev mode) has no MCP — use the CLI |

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

### How it works in ChatGPT, step by step (honest version)

ChatGPT's MCP support differs fundamentally from Claude Desktop's: **it never spawns local processes**. Its custom connectors (developer mode) have OpenAI's servers connect to a **URL** — so the MCP server must be reachable from the internet.

1. **Normal ChatGPT (no developer mode): no MCP at all.** context-doctor still helps via the CLI: export the conversation and run `npx context-doctor analyze chat.json --model gpt-5` / `optimize` — no account settings required.
2. **ChatGPT developer mode**: run our HTTP transport somewhere reachable — `context-doctor-mcp --http --port 8808` on a small host (bind `--host 0.0.0.0` there), or expose your machine temporarily with a tunnel (`ngrok http 8808`). Then Settings → Connectors → Advanced → Developer mode → add connector with URL `https://<your-host>/mcp`.
3. Once connected, GPT gets the same three tools with the same trigger guidance: ask *"what's eating my context?"* → it calls `profile_context`; *"optimize it"* works the same, including GPT writing the pruning summary itself.

Security note for step 2: the HTTP endpoint is unauthenticated — put it behind your tunnel's auth or a reverse proxy if it stays up long-term.

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
- **Near-duplicates** — the same doc re-pasted with different surrounding words (shingle similarity, ≥60%)
- **Repeated file reads** — the same file pulled in three or more times, every copy still in context
- **Retained error output** — stack traces and failed commands kept verbatim long after the fix landed
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

## Measuring the impact: `context-doctor report`

```bash
npx context-doctor report
```

One report for your whole machine, led by a headline of **tokens context-doctor saved**, built only from measured sources:

- **exact** proxy savings (real before/after on every request),
- **exact** savings from every optimization applied via the CLI or the in-chat tools — split by model family (Claude vs GPT), with dollar estimates,
- **observed per-session shrinkage**: real context reductions recorded between the hook's deep checks after hygiene warnings — shown per session in the table alongside remaining waste.

Honest measurement note: proxy numbers are exact. Session numbers are measured-now. What no tool can report is the counterfactual — tokens Claude *avoided* adding because of the hygiene guidance — since the same session can't be re-run without it. The report says so instead of inventing a number.

## Context budgets (`.contextdoctorrc`)

Drop a `.contextdoctorrc` in a project (or your home directory) and context-doctor enforces your limits instead of its defaults:

```json
{
  "budget": { "maxTokens": 120000, "maxCostPerMessageUsd": 0.5, "maxWindowPct": 60 },
  "strategies": ["dedupe", "trim-tool-results"],
  "keepRecent": 6
}
```

The nearest file wins (walking up from the working directory, then `~`). `analyze` and `session` print a budget verdict, the every-prompt hook uses `maxTokens` as its warning threshold and names the breach to the model, and `optimize`/`proxy` pick up the defaults when you do not pass flags.

## Prompt-cache economics (Claude Code sessions)

Caching is the largest lever on LLM cost, and transcripts record exactly how it went — so `session` reports it as fact rather than estimate:

```
Prompt cache: 95.6% of input served from cache across 1117 requests
  read 558.6M · written 25.5M · uncached 2k
  input cost $438.88 — caching saved $2481.89 against $2920.76 uncached (list prices)
```

A cache read bills at ~10% of input while a write bills at ~125%, so a session that keeps invalidating its prefix can cost *more* than one with no caching at all. context-doctor warns on the two failure modes: a **low hit rate** (something early in the prompt changes every request) and **cache churn** (writes rivalling reads).

## Enforce a budget in CI

```bash
npx context-doctor analyze conversation.json --fail-over-budget
```

Exits 1 when the `.contextdoctorrc` budget is breached, so a pull request can be gated on context size the same way it is gated on tests.

## Performance: what context-doctor itself costs

A tool that promises speed must be near-free. Measured overhead per touchpoint:

| Touchpoint | When it runs | Overhead |
|---|---|---|
| Every-prompt hook (Claude Code) | Every prompt | **~80ms** (Node startup; logic ~1ms). Lean sessions exit on a single `stat()` — the transcript is never read. Full profiling (~200ms on a 4MB session) happens only when the transcript has grown ~40% since last checked |
| MCP server | Spawned once per app session | Tools run only when called; standing instructions cost **~110 tokens per conversation** — deliberately terse |
| Proxy | Per API request | ~1–3ms of CPU (parse → optimize → re-serialize) against typical model latencies of hundreds of ms; responses stream through chunk-by-chunk, never buffered |
| Skill | Loads only when relevant | ~1k tokens while active; its always-present description is ~60 tokens |
| CLI / library | Only when you run it | Not in any hot path |

Net effect is strongly negative overhead: the tokens these touchpoints save on every subsequent call dwarf what they cost.

## Why token counts are "~" (and where they are exact)

Counting exactly needs each provider's tokenizer, so the default is a calibrated chars-per-token heuristic (denser for code and JSON). It is good enough to rank what is heavy and to measure the effect of a fix, and it keeps the tool offline and zero-config.

Two ways to get real numbers instead:

- **`analyze --exact`** uses the Anthropic count-tokens API for Claude models (set `ANTHROPIC_API_KEY`; opt-in network call, key never stored) or tiktoken for GPT models (install it alongside), and reports how far the heuristic drifted.
- **Sessions report measured tokens automatically.** Claude Code transcripts record what the API actually charged, so `session`, the hook and the reports use that figure when it is present — no key, no estimate.

One honest caveat worth knowing: a transcript stores the conversation, **not** the harness's system prompt, tool schemas or skills. Measured against the API's own numbers here, a message-only estimate undercounts the true context by roughly 60%. That is why sessions prefer the reported figure, and why the message breakdown is labelled as covering messages only.



Exact counts require each provider's private tokenizer. `context-doctor` uses a calibrated chars-per-token heuristic (denser for code/JSON) that lands within ~10% — plenty accurate for finding what's heavy and measuring savings, and it keeps the tool fully offline with zero configuration.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full plan with rationale. Headlines: **v0.5** trust & automation (tag-based publishing, `doctor` self-check, live `watch`), **v0.6** accuracy (exact tokenizers, semantic dedupe, more session formats), **v0.7** proxy pro (response accounting, prompt-cache advisor), **v1.0** budgets + local dashboard. Non-goals, permanently: cloud services, telemetry, silent history rewriting, mandatory API keys.

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
