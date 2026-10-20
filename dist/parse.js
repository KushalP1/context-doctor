/**
 * Normalize conversations from different providers into one shape.
 *
 * Accepted inputs:
 *  - OpenAI chat format:    { messages: [{ role, content, tool_calls?, tool_call_id? }] }
 *  - Anthropic format:      { system?, messages: [{ role, content: string | Block[] }] }
 *    where Block = { type: "text" | "tool_use" | "tool_result" | "image", ... }
 *  - Bare message array:    [{ role, content }, ...]
 *  - Gemini (generateContent): { systemInstruction?, contents: [{ role, parts }] }
 *  - OpenAI Responses:      { instructions?, input: string | Item[] }
 *  - Raw text:              treated as a single user message (last-resort fallback)
 */
function flattenContent(content) {
    if (typeof content === "string")
        return { text: content, hasBinary: false };
    // OpenAI sends `content: null` on an assistant message that only calls
    // tools. It is no text, not the two-character string `""`.
    if (content == null)
        return { text: "", hasBinary: false };
    if (!Array.isArray(content))
        return { text: JSON.stringify(content ?? ""), hasBinary: false };
    let text = "";
    let hasBinary = false;
    let toolName;
    let kind;
    let toolCallText = "";
    let isError;
    for (const block of content) {
        if (block == null || typeof block !== "object") {
            text += String(block ?? "");
            continue;
        }
        const b = block;
        switch (b.type) {
            case "text":
            // OpenAI Responses' text parts.
            case "input_text":
            case "output_text":
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
                if (b.is_error === true)
                    isError = true;
                break;
            }
            case "image":
            case "document":
                hasBinary = true;
                text += `[${b.type}]`;
                break;
            // OpenAI's media blocks (Chat Completions and Responses). Stringified,
            // a 300 KB base64 data URL counted as ~75k text tokens and tripped the
            // base64 finding; it is an attachment, counted like Anthropic's above.
            case "image_url":
            case "input_image":
                hasBinary = true;
                text += "[image]";
                break;
            case "input_audio":
                hasBinary = true;
                text += "[audio]";
                break;
            case "file":
            case "input_file":
                hasBinary = true;
                text += "[file]";
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
    return { text, hasBinary, toolName, kind, toolCallText: toolCallText || undefined, isError };
}
function normalizeMessage(rawInput, index) {
    // A null or non-object entry appears in truncated and hand-edited files.
    // Treat it as an empty message rather than throwing a stack at the user.
    const raw = rawInput && typeof rawInput === "object" ? rawInput : {};
    const role = String(raw.role ?? "user");
    const flat = flattenContent(raw.content);
    // OpenAI's "developer" role is the system prompt under its newer name (o1 onward).
    let kind = flat.kind ?? (role === "developer" ? "system" : ["system", "user", "assistant"].includes(role) ? role : "other");
    let toolName = flat.toolName;
    let text = flat.text;
    let toolCallText = flat.toolCallText;
    // OpenAI-style tool plumbing lives outside `content`.
    if (role === "tool") {
        kind = "tool_result";
    }
    const rawToolCalls = raw.tool_calls;
    // Entries can be null or malformed in hand-edited or truncated exports.
    const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls.filter((tc) => tc && typeof tc === "object") : undefined;
    if (toolCalls && toolCalls.length > 0) {
        kind = "tool_call";
        toolName = toolCalls[0]?.function?.name ?? toolCalls[0]?.name;
        const calls = toolCalls
            .map((tc) => `[tool call: ${tc.function?.name ?? tc.name}] ${tc.function?.arguments ?? JSON.stringify(tc.input ?? {})}`)
            .join("\n");
        text += calls;
        toolCallText = (toolCallText ?? "") + calls;
    }
    return { index, role, kind, text, toolName, toolCallText, hasBinary: flat.hasBinary, isError: flat.isError };
}
/** Raw text: the whole input as one user message, so profiling still works for raw prompts. */
function rawText(input, parseError) {
    // If it LOOKS like JSON, the user handed us a broken conversation file and
    // deserves to be told, not given a report about a single 9-token "message".
    const head = input.trimStart()[0];
    const parseWarning = input.trim() === ""
        ? "Input is empty — nothing to profile."
        : parseError && (head === "{" || head === "[")
            ? `Input starts like JSON but does not parse (${parseError.message}), so it is not a conversation file.`
            : undefined;
    return {
        sourceFormat: "text",
        parseWarning,
        // Empty input has no message: reporting "1 message, ~4 tokens" for it
        // would be inventing content that is not there.
        messages: input.trim() === "" ? [] : [{ index: 0, role: "user", kind: "user", text: input, hasBinary: false }],
    };
}
/** A Gemini part: text, an attachment, or a function call or response. */
function geminiPart(part) {
    if (typeof part === "string")
        return { text: part, hasBinary: false };
    if (!part || typeof part !== "object")
        return { text: "", hasBinary: false };
    const p = part;
    if (typeof p.text === "string")
        return { text: p.text, hasBinary: false };
    if (p.inlineData || p.fileData)
        return { text: "[file]", hasBinary: true };
    if (p.functionCall) {
        const call = `[tool call: ${p.functionCall.name}] ${JSON.stringify(p.functionCall.args ?? {})}`;
        return { text: call, hasBinary: false, kind: "tool_call", toolName: p.functionCall.name, call };
    }
    if (p.functionResponse) {
        const r = p.functionResponse.response;
        const out = typeof r?.output === "string" ? r.output : typeof r?.content === "string" ? r.content : JSON.stringify(r ?? {});
        return { text: out, hasBinary: false, kind: "tool_result", toolName: p.functionResponse.name };
    }
    if (p.executableCode)
        return { text: String(p.executableCode.code ?? ""), hasBinary: false };
    if (p.codeExecutionResult)
        return { text: String(p.codeExecutionResult.output ?? ""), hasBinary: false };
    return { text: JSON.stringify(p), hasBinary: false };
}
function geminiMessage(raw, index) {
    const c = raw && typeof raw === "object" ? raw : {};
    const role = c.role === "model" ? "assistant" : String(c.role ?? "user");
    const parts = Array.isArray(c.parts) ? c.parts : [];
    let text = "";
    let hasBinary = false;
    let kind;
    let toolName;
    let toolCallText = "";
    for (const part of parts) {
        const f = geminiPart(part);
        text += (text && f.text ? "\n" : "") + f.text;
        hasBinary ||= f.hasBinary;
        if (f.kind)
            kind = f.kind;
        toolName ??= f.toolName;
        if (f.call)
            toolCallText += f.call;
    }
    const fallback = ["system", "user", "assistant"].includes(role) ? role : "other";
    return { index, role, kind: kind ?? fallback, text, toolName, toolCallText: toolCallText || undefined, hasBinary };
}
/** One OpenAI Responses input item: a message, a function or shell call, its output, or reasoning. */
function responsesItem(raw, index) {
    if (typeof raw === "string")
        return { index, role: "user", kind: "user", text: raw, hasBinary: false };
    const it = raw && typeof raw === "object" ? raw : {};
    const type = it.type;
    if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
        const name = it.name ?? (type === "local_shell_call" ? "local_shell" : undefined);
        const args = typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.input ?? it.action ?? {});
        const call = `[tool call: ${name}] ${args}`;
        return { index, role: "assistant", kind: "tool_call", text: call, toolName: name, toolCallText: call, hasBinary: false };
    }
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "local_shell_call_output") {
        const out = it.output;
        const flat = typeof out === "string" ? { text: out, hasBinary: false } : flattenContent(out);
        return { index, role: "tool", kind: "tool_result", text: flat.text, hasBinary: flat.hasBinary };
    }
    if (type === "reasoning") {
        const summary = Array.isArray(it.summary) ? it.summary.map((p) => p?.text ?? "").join("\n") : "";
        return { index, role: "assistant", kind: "assistant", text: summary, hasBinary: false };
    }
    return normalizeMessage(it, index);
}
export function parseConversation(input) {
    // Library callers sometimes hand over the object itself, or nothing at all;
    // a stack trace from inside JSON.parse helps neither.
    if (typeof input !== "string") {
        if (input !== null && typeof input === "object") {
            try {
                input = JSON.stringify(input);
            }
            catch {
                return rawText("");
            }
        }
        else {
            input = input === undefined || input === null ? "" : String(input);
        }
    }
    let data;
    try {
        data = JSON.parse(input);
    }
    catch (e) {
        return rawText(input, e);
    }
    // A prompt can happen to be valid JSON ("2024", a quoted sentence, null):
    // that is still a raw prompt, not a conversation with no messages.
    if (data === null || typeof data !== "object")
        return rawText(input);
    if (Array.isArray(data)) {
        const looksLikeMessages = data.length === 0 || data.some((m) => m && typeof m === "object" && ("role" in m || "parts" in m));
        // A bare Gemini `contents` array: role/parts entries.
        if (data.length > 0 && data.every((m) => m && typeof m === "object" && Array.isArray(m.parts))) {
            return { sourceFormat: "gemini", messages: data.map((m, i) => geminiMessage(m, i)) };
        }
        return {
            sourceFormat: "array",
            parseWarning: looksLikeMessages ? undefined : "This is a JSON array, but no element has a `role` field — it does not look like a conversation.",
            messages: data.map((m, i) => normalizeMessage(m, i)),
        };
    }
    const obj = data;
    const model = typeof obj.model === "string" && obj.model ? obj.model : undefined;
    // Gemini generateContent: `contents` of role/parts, the system prompt in `systemInstruction`.
    if (obj.messages == null && Array.isArray(obj.contents)) {
        const messages = [];
        const sys = (obj.systemInstruction ?? obj.system_instruction);
        if (sys != null) {
            const m = typeof sys === "string" ? { text: sys, hasBinary: false } : geminiMessage(sys, -1);
            messages.push({ index: -1, role: "system", kind: "system", text: m.text, hasBinary: m.hasBinary });
        }
        messages.push(...obj.contents.map((c, i) => geminiMessage(c, i)));
        return { sourceFormat: "gemini", messages, model };
    }
    // OpenAI Responses: `input` (a string or a list of items), the system prompt in `instructions`.
    if (obj.messages == null && (typeof obj.input === "string" || Array.isArray(obj.input))) {
        const messages = [];
        if (typeof obj.instructions === "string" && obj.instructions) {
            messages.push({ index: -1, role: "system", kind: "system", text: obj.instructions, hasBinary: false });
        }
        const items = typeof obj.input === "string" ? [obj.input] : obj.input;
        messages.push(...items.map((it, i) => responsesItem(it, i)));
        return { sourceFormat: "responses", messages, model };
    }
    const rawField = obj.messages;
    const rawMessages = Array.isArray(rawField)
        ? rawField
        : [];
    // `messages` present but not an array is a malformed file, not an empty chat.
    const malformedMessages = rawField != null && !Array.isArray(rawField);
    const messages = [];
    // Anthropic keeps the system prompt outside the messages array.
    if (obj.system != null) {
        const flat = flattenContent(obj.system);
        messages.push({ index: -1, role: "system", kind: "system", text: flat.text, hasBinary: flat.hasBinary });
    }
    messages.push(...rawMessages.map((m, i) => normalizeMessage(m, i)));
    const isAnthropic = obj.system != null ||
        rawMessages.some((m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === "tool_use" || b?.type === "tool_result"));
    const parseWarning = malformedMessages
        ? `\`messages\` is a ${typeof rawField}, not an array — this file is malformed.`
        : messages.length === 0
            ? "This JSON has no `messages` array (and no `system`) — it does not look like a conversation. Expected {\"messages\":[{\"role\":…,\"content\":…}]}."
            : undefined;
    return { sourceFormat: isAnthropic ? "anthropic" : "openai", parseWarning, messages, model };
}
