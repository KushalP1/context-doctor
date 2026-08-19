/**
 * Token estimation without provider tokenizer dependencies.
 *
 * Exact token counts require each provider's tokenizer (tiktoken, Anthropic's
 * API, etc.). For profiling purposes an estimate within ~10% is enough to rank
 * what's eating the window, so we use a calibrated chars-per-token heuristic:
 * prose averages ~4 chars/token, code and JSON are denser (~3.2), and
 * whitespace-heavy content is cheaper. This keeps the tool zero-config and
 * fully offline.
 */
/** Known context window sizes (tokens) by model-name substring, checked in order. */
const MODEL_WINDOWS = [
    [/claude.*haiku/i, 200_000],
    // Current-generation Claude (Fable/Mythos 5, Opus 4.6+, Sonnet 4.6+) is 1M.
    [/claude.*(fable|mythos)|claude.*opus-?(5|4-[678])|claude.*sonnet-?(5|4-6)/i, 1_000_000],
    [/claude.*sonnet|claude.*opus|claude-\d/i, 200_000],
    [/gpt-5/i, 400_000],
    [/gpt-4o|gpt-4-turbo|gpt-4\.1|o[134](-|$)/i, 128_000],
    [/gpt-4(?!o|\.|-turbo)/i, 8_192],
    [/gpt-3\.5/i, 16_385],
    [/gemini.*(1\.5|2\.|2-5)/i, 1_000_000],
    [/llama.*3/i, 128_000],
    [/mistral|mixtral/i, 32_000],
];
export function contextWindowFor(model) {
    if (!model)
        return undefined;
    for (const [pattern, window] of MODEL_WINDOWS) {
        if (pattern.test(model))
            return window;
    }
    return undefined;
}
export function providerFor(model) {
    if (!model)
        return "generic";
    if (/claude/i.test(model))
        return "anthropic";
    if (/gpt|^o\d/i.test(model))
        return "openai";
    if (/gemini/i.test(model))
        return "google";
    return "generic";
}
/** Fraction of characters that are code-ish symbols — used to pick density. */
function symbolDensity(text) {
    if (text.length === 0)
        return 0;
    const symbols = text.match(/[{}[\]()<>;:=_\/\\|"'`#$%&*+^~-]/g);
    return (symbols?.length ?? 0) / text.length;
}
export function estimateTokens(text) {
    if (!text)
        return 0;
    // Denser tokenization for code/JSON-like content, lighter for plain prose.
    const density = symbolDensity(text);
    const charsPerToken = density > 0.08 ? 3.2 : 4.0;
    return Math.ceil(text.length / charsPerToken);
}
/** Per-message structural overhead (role markers, delimiters) is roughly constant. */
export const MESSAGE_OVERHEAD_TOKENS = 4;
export function formatTokens(n) {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000)
        return `${Math.round(n / 1000)}k`;
    if (n >= 1_000)
        return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}
