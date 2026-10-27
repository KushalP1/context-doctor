# Use it as a library

[← README](../README.md)

```bash
npm install context-doctor
```

```ts
import { parseConversation, profileConversation, optimizeConversation } from "context-doctor";

const profile = profileConversation(parseConversation(chatJson), "claude-sonnet-5");
console.log(profile.totalTokens, profile.findings);

const { conversation, tokensBefore, tokensAfter } = optimizeConversation(chatJson, {
  strategies: ["dedupe", "trim-tool-results", "strip-base64"],
});

// Autopilot without a proxy: wrap the SDK client (Anthropic, OpenAI or Google Gen AI)
import Anthropic from "@anthropic-ai/sdk";
import { withContextDoctor, contextDoctorStats } from "context-doctor";
const client = withContextDoctor(new Anthropic());       // use exactly as before
await client.messages.create({ model, max_tokens, messages });
console.log(contextDoctorStats(client));                 // { requests, changed, tokensRemoved }

// RAG-style context packing: chunk, rank, fit a budget (no embeddings, no key)
import { packContext, renderPack } from "context-doctor";
const packed = packContext([{ name: "manual.md", text: manual }], { query: "rotate the signing key", budget: 3000 });
console.log(packed.selected.map((c) => `${c.id} L${c.startLine}-${c.endLine}`), renderPack(packed));
```

## Autopilot inside your app: `withContextDoctor`

For apps that cannot send traffic through a local proxy (serverless and edge functions, managed hosts), wrap the SDK client. `messages.create` / `stream`, `chat.completions.create` / `stream` / `parse` and `responses.create` / `stream` / `parse` (beta namespaces too) and Google's `models.generateContent` / `generateContentStream` go through the same autopilot as the proxy: stale tool output is cleared only when the prompt cache is cold. Each request is cloned before it changes, so the history your app holds is never rewritten; only the copy on the wire is slimmer. State lives in the process: one long-lived process per conversation stream behaves like the proxy, and a conversation the process has not seen counts as warm, so a fresh serverless instance never clears blind (pass `statePath` on shared storage if many instances serve the same conversations). Tested with the real `@anthropic-ai/sdk` and `openai` packages.

For Python (RAG pipelines, LangChain and LlamaIndex results), see the [Python package](../python/README.md).
