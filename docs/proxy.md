# The proxy: autopilot for your own API apps

[← README](../README.md)

Run the proxy in autopilot mode and every Anthropic, OpenAI or Gemini API call your apps make goes through the same cold-cache clearing as autopilot, with no code changes:

```bash
npx context-doctor proxy --autopilot
```

Then point your app or SDK at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787      # Anthropic SDKs / tools
export OPENAI_BASE_URL=http://localhost:8787/v1      # OpenAI SDKs / tools
export GOOGLE_GEMINI_BASE_URL=http://localhost:8787  # Gemini CLI / Google SDKs
```

**The optimizing mode, and its cost.** Without `--autopilot`, the proxy dedupes repeated content, trims stale tool results, and strips base64 blobs from the message history of each request, then forwards it to the real API. It edits history the prompt cache holds, so on cached traffic it can cost more than it saves: in the replay before autopilot shipped it saved 6.7% overall but made one session 13% more expensive. Use it where requests are not cached, and prefer `--autopilot` everywhere else. Either way, your API key passes through in headers untouched, streaming (SSE) works unchanged, and per-request savings are logged with upstream latency:

```
[context-doctor] POST /v1/messages → 200 in 842ms | optimized 7.3k → 518 tokens (2 changes) | session total: 6.9k tokens ≈ $0.021 saved
```

Only conversation requests are ever rewritten: `/v1/messages`, `/v1/chat/completions` and `/v1/responses`, plus Gemini's `generateContent` under `--autopilot`. Every other endpoint a client uses through the proxy (listing models, uploading files, counting tokens) is forwarded untouched: Gemini requests (an `x-goog-api-key` header or a `/v1beta` path) to Google, requests carrying `anthropic-version`, `x-api-key`, `anthropic-beta` or an `sk-ant-` key to Anthropic, and the rest to OpenAI (under `--autopilot`, only an `sk-` key goes to OpenAI and the rest to Anthropic). Request bodies the proxy does not rewrite reach upstream byte for byte.

**`prompt_cache_key` for OpenAI.** OpenAI routes a request to a cache by its first tokens and, on models before GPT-5.6, by a `prompt_cache_key` when there is one ([guide](https://developers.openai.com/api/docs/guides/prompt-caching)). A request to api.openai.com with no key gets one derived from its conversation (instructions plus first user message), the same on every turn, so a conversation's requests land on one cache. A key the app set is never touched; GPT-5.6 and later (where the key only separates accounting), `previous_response_id` and `conversation` requests are left alone; Codex sets its own key. The trade-off: conversations that share a long system prompt are routed apart instead of by that prefix, so an app that serves many short conversations over one big prompt may prefer its own key per tenant, or `CONTEXT_DOCTOR_CACHE_KEY=0`. `/stats` counts the keys added (`cacheKeysAdded`) and OpenAI's own `cached_tokens` (`openaiCachedTokens`).

`GET http://localhost:8787/stats` returns cumulative savings (requests, tokens, estimated USD), **exact upstream usage** read from every response (JSON and SSE), and **prompt-cache advisories** — the proxy watches your real traffic and flags big stable prefixes missing `cache_control` or prefix churn that silently re-bills the cache. The advisor says *where*: for a large system/tools prefix it names the block to mark (the last tool definition, or the last system block), and when the older messages were byte-identical to the previous request it names the exact message to put `cache_control` on, with the token count that run is re-billing each turn. Anyone who already placed breakpoints is left alone. For a request you have not sent yet, `context-doctor cache-plan <request.json>` places the breakpoints and prices them: the stable parts get block-level breakpoints, and the conversation's moving end gets Anthropic's automatic caching (one top-level `cache_control`, which the API moves forward each turn), except on Bedrock's legacy integration, which rejects it.

Per-model behavior of the optimizing mode via `--config`:

```json
{ "routes": [{ "modelPrefix": "gpt", "strategies": ["strip-base64"], "keepRecent": 4 }] }
```

Because prompt caching matches byte-identical prefixes, the optimizing mode's strategies are deterministic so repeated requests stay as stable as they can; if you rely on cached prefixes, use `--autopilot`, or start with `--strategy strip-base64 --strategy dedupe` and add more as you verify.

## Putting the proxy on a public URL (Cursor with your own OpenAI key, remote apps)

Some apps let you set a base URL but call it from *their* servers, not your machine. Cursor is one: with your own OpenAI key, "Override OpenAI Base URL" is sent to Cursor's backend inside the model configuration, and Cursor's servers make the request (only the key-verification ping is client-side; we checked the app bundle, 3.18.25). So `127.0.0.1` cannot work there; the proxy has to be reachable from the internet, and an open relay on the internet is a bad idea. Hence the token:

```bash
npx context-doctor proxy --autopilot --token "$(openssl rand -hex 16)"   # or CONTEXT_DOCTOR_PROXY_TOKEN=...
ngrok http 8787                                               # or any HTTPS tunnel / reverse proxy
```

With `--token`, every path except `/health` must start with `/t/<token>/`; anything else gets 401 before any upstream call, and the comparison is constant time. Then in Cursor: Settings > Models > OpenAI API Key > Override OpenAI Base URL = `https://<your-host>/t/<token>/v1`. Every agent request Cursor makes with your key now passes through the proxy: with `--autopilot`, stale tool output is cleared when the cache is cold (without it, the optimizing strategies run, which can cost more on cached traffic), and real usage is counted in `/t/<token>/stats`. This is the one Cursor path that is model-independent and needs no hook. It applies only to BYO-key traffic; Cursor's own subscription models never leave Cursor's servers.

Your API key still rides in the request headers, as before. The token protects the relay, not the key; keep the tunnel HTTPS.

> **Note on desktop chat apps:** Claude Desktop and the ChatGPT app talk to their own backends — no tool can sit in that path. For those, use the [MCP integration](./chat-apps.md) (Claude Desktop gets the standing rules and a cheap `profile_context` sketch call) and the [per-account preferences](./chat-apps.md#claudeai-on-the-web-and-the-phone-apps).
