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
function flattenContent(content) {
    if (typeof content === "string")
        return { text: content, hasBinary: false };
    if (!Array.isArray(content))
        return { text: JSON.stringify(content ?? ""), hasBinary: false };
    let text = "";
    let hasBinary = false;
    let toolName;
    let kind;
    let toolCallText = "";
    for (const block of content) {
        if (block == null || typeof block !== "object") {
            text += String(block ?? "");
            continue;
        }
        const b = block;
        switch (b.type) {
            case "text":
                text += b.text ?? "";
                break;
            case "tool_use": {
                kind = "tool_call";
                toolName = b.name ?? toolName;
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
                text += b.thinking ?? "";
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
function normalizeMessage(raw, index) {
    const role = String(raw.role ?? "user");
    const flat = flattenContent(raw.content);
    let kind = flat.kind ?? (["system", "user", "assistant"].includes(role) ? role : "other");
    let toolName = flat.toolName;
    let text = flat.text;
    let toolCallText = flat.toolCallText;
    // OpenAI-style tool plumbing lives outside `content`.
    if (role === "tool") {
        kind = "tool_result";
    }
    const toolCalls = raw.tool_calls;
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
export function parseConversation(input) {
    let data;
    try {
        data = JSON.parse(input);
    }
    catch {
        // Not JSON — treat the whole thing as one user message so profiling still works.
        return {
            sourceFormat: "text",
            messages: [{ index: 0, role: "user", kind: "user", text: input, hasBinary: false }],
        };
    }
    if (Array.isArray(data)) {
        return {
            sourceFormat: "array",
            messages: data.map((m, i) => normalizeMessage(m, i)),
        };
    }
    const obj = data;
    const rawMessages = obj.messages ?? [];
    const messages = [];
    // Anthropic keeps the system prompt outside the messages array.
    if (obj.system != null) {
        const flat = flattenContent(obj.system);
        messages.push({ index: -1, role: "system", kind: "system", text: flat.text, hasBinary: flat.hasBinary });
    }
    messages.push(...rawMessages.map((m, i) => normalizeMessage(m, i)));
    const isAnthropic = obj.system != null ||
        rawMessages.some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_use" || b?.type === "tool_result"));
    return { sourceFormat: isAnthropic ? "anthropic" : "openai", messages };
}
