/**
 * Optional exact token counting (`analyze --exact`). Zero-config heuristic
 * remains the default; this upgrades the TOTAL where an exact source exists:
 *
 *   Claude models — Anthropic's count-tokens API when ANTHROPIC_API_KEY is
 *   set (opt-in network call; the key is read from env, never stored).
 *   GPT models   — tiktoken, when the user has installed it alongside us
 *   (optional peer; we never ship the WASM weight by default).
 *
 * Anything else falls back to the heuristic with a note saying why.
 */

export interface ExactResult {
  tokens?: number;
  source?: string;
  note?: string;
}

export async function exactTokenCount(conversationJson: string, model?: string): Promise<ExactResult> {
  let conv: { model?: string; system?: unknown; messages?: unknown[] };
  try {
    conv = JSON.parse(conversationJson);
  } catch {
    return { note: "exact counting needs a JSON conversation" };
  }
  const targetModel = model ?? conv.model;
  if (!targetModel) return { note: "pass --model to enable exact counting" };
  if (!Array.isArray(conv.messages) || conv.messages.length === 0) {
    return { note: "no messages array — exact counting skipped" };
  }

  if (/claude/i.test(targetModel)) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { note: "set ANTHROPIC_API_KEY to get exact Claude counts (count-tokens API)" };
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: targetModel,
          messages: conv.messages,
          ...(conv.system != null ? { system: conv.system } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json()) as { input_tokens?: number; error?: { message?: string } };
      if (!res.ok || typeof data.input_tokens !== "number") {
        return { note: `count-tokens API: ${data.error?.message ?? `HTTP ${res.status}`} — using heuristic` };
      }
      return { tokens: data.input_tokens, source: "Anthropic count-tokens API" };
    } catch (e) {
      return { note: `count-tokens API unreachable (${(e as Error).message}) — using heuristic` };
    }
  }

  if (/gpt|^o\d/i.test(targetModel)) {
    try {
      // Optional peer — resolves only if the user installed it next to us.
      // @ts-expect-error optional dependency without bundled types
      const tiktoken = await import("tiktoken");
      const enc = tiktoken.get_encoding("o200k_base");
      try {
        const text = conv.messages
          .map((m) => {
            const c = (m as { content?: unknown }).content;
            return typeof c === "string" ? c : JSON.stringify(c ?? "");
          })
          .join("\n");
        // +4/message structural overhead, mirroring OpenAI's chat format math.
        const tokens = enc.encode(text).length + conv.messages.length * 4;
        return { tokens, source: "tiktoken (o200k_base)" };
      } finally {
        enc.free();
      }
    } catch {
      return { note: "install tiktoken next to context-doctor for exact GPT counts (npm i tiktoken)" };
    }
  }

  return { note: `no exact tokenizer for ${targetModel} — using heuristic` };
}
