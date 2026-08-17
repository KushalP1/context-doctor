/**
 * Normalize conversations from different providers into one shape.
 *
 * Accepted inputs:
 *  - OpenAI chat format:    { messages: [{ role, content, tool_calls?, tool_call_id? }] }
 *  - Anthropic format:      { system?, messages: [{ role, content: string | Block[] }] }
 *    where Block = { type: "text" | "tool_use" | "tool_result" | "image", ... }
 *  - Bare message array:    [{ role, content }, ...]
 *  - Raw text:              treated as a single user message (last-resort fallback)
 */

export type MessageKind =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "image"
  | "other";

export interface NormalizedMessage {
  /** Index in the original message array (-1 for extracted system prompt). */
  index: number;
  role: string;
  kind: MessageKind;
  /** Flattened text content used for token estimation and analysis. */
  text: string;
  /** Tool name when kind is tool_call/tool_result and it is known. */
  toolName?: string;
  /** Just the tool-call portion (name + args), for repeat-call detection. */
  toolCallText?: string;
  /** True when the content contained non-text blocks (images, documents). */
  hasBinary: boolean;
}

export interface NormalizedConversation {
  messages: NormalizedMessage[];
  /** Format detected, for reporting. */
  sourceFormat: "openai" | "anthropic" | "array" | "text";
}

function flattenContent(content: unknown): { text: string; hasBinary: boolean; toolName?: string; kind?: MessageKind; toolCallText?: string } {
  if (typeof content === "string") return { text: content, hasBinary: false };
  if (!Array.isArray(content)) return { text: JSON.stringify(content ?? ""), hasBinary: false };

  let text = "";
  let hasBinary = false;
  let toolName: string | undefined;
  let kind: MessageKind | undefined;
  let toolCallText = "";
  for (const block of content) {
    if (block == null || typeof block !== "object") {
      text += String(block ?? "");
      continue;
    }
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text":
        text += (b.text as string) ?? "";
        break;
      case "tool_use": {
        kind = "tool_call";
        toolName = (b.name as string) ?? toolName;
        const call = `[tool call: ${b.name}] ${JSON.stringify(b.input ?? {})}`;
        text += call;
        toolCallText += call;
        break;
      }
      case "tool_result": {
        kind = "tool_result";
        const inner = flattenContent(b.content);
        hasBinary = hasBinary || inner.hasBinary;
        text += inner.text;
        break;
      }
      case "image":
      case "document":
        hasBinary = true;
        text += `[${b.type}]`;
        break;
      case "thinking":
        // Count the thinking text but NOT the signature — it is an opaque
        // base64 blob the API requires, not something the user can trim.
        text += (b.thinking as string) ?? "";
        break;
      case "redacted_thinking":
        text += "[redacted thinking]";
        break;
      default:
        text += JSON.stringify(b);
    }
  }
  return { text, hasBinary, toolName, kind, toolCallText: toolCallText || undefined };
}

function normalizeMessage(raw: Record<string, unknown>, index: number): NormalizedMessage {
  const role = String(raw.role ?? "user");
  const flat = flattenContent(raw.content);
  let kind: MessageKind = flat.kind ?? (["system", "user", "assistant"].includes(role) ? (role as MessageKind) : "other");
  let toolName = flat.toolName;
  let text = flat.text;
  let toolCallText = flat.toolCallText;

  // OpenAI-style tool plumbing lives outside `content`.
  if (role === "tool") {
    kind = "tool_result";
  }
  const toolCalls = raw.tool_calls as Array<Record<string, any>> | undefined;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    kind = "tool_call";
    toolName = toolCalls[0]?.function?.name ?? toolCalls[0]?.name;
    const calls = toolCalls
      .map((tc) => `[tool call: ${tc.function?.name ?? tc.name}] ${tc.function?.arguments ?? JSON.stringify(tc.input ?? {})}`)
      .join("\n");
    text += calls;
    toolCallText = (toolCallText ?? "") + calls;
  }

  return { index, role, kind, text, toolName, toolCallText, hasBinary: flat.hasBinary };
}

export function parseConversation(input: string): NormalizedConversation {
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    // Not JSON — treat the whole thing as one user message so profiling still works.
    return {
      sourceFormat: "text",
      messages: [{ index: 0, role: "user", kind: "user", text: input, hasBinary: false }],
    };
  }

  if (Array.isArray(data)) {
    return {
      sourceFormat: "array",
      messages: data.map((m, i) => normalizeMessage(m as Record<string, unknown>, i)),
    };
  }

  const obj = data as Record<string, unknown>;
  const rawMessages = (obj.messages as Array<Record<string, unknown>>) ?? [];
  const messages: NormalizedMessage[] = [];

  // Anthropic keeps the system prompt outside the messages array.
  if (obj.system != null) {
    const flat = flattenContent(obj.system);
    messages.push({ index: -1, role: "system", kind: "system", text: flat.text, hasBinary: flat.hasBinary });
  }
  messages.push(...rawMessages.map((m, i) => normalizeMessage(m, i)));

  const isAnthropic =
    obj.system != null ||
    rawMessages.some((m) => Array.isArray(m.content) && (m.content as any[]).some((b) => b?.type === "tool_use" || b?.type === "tool_result"));

  return { sourceFormat: isAnthropic ? "anthropic" : "openai", messages };
}
