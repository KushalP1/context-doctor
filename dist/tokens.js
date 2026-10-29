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
    // Every Gemini 3 text model (3 Flash, 3.1 Pro, 3.1/3.5 Flash-Lite, 3.6/3.8
    // Flash): 1,048,576 input tokens (ai.google.dev/gemini-api/docs/models, Oct 2026).
    [/gemini-?3/i, 1_048_576],
    [/llama.*3/i, 128_000],
    [/mistral|mixtral/i, 32_000],
];
/** The largest window any model above has: no live context can exceed it. */
export const LARGEST_WINDOW = Math.max(...MODEL_WINDOWS.map(([, w]) => w));
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
/**
 * Characters per token, by provider and by content type.
 *
 * Anthropic: measured 2026-09 against the API's own counts in 59 Claude Code
 * sessions (Opus 4.7 to 5, Fable 5.x), two independent ways that agree.
 * Prose: 504 assistant replies with no thinking block, visible text divided by
 * the exact output_tokens: median 2.75 (p10 2.4, p90 3.0). Code and tool
 * output: 474 single appended blocks over 6k chars, sized by the exact growth
 * of the billed prompt between consecutive calls: median 2.4 (p10 2.1, p90 2.8).
 * The ratios this tool used before (4.0 / 3.2) undercounted current Claude
 * models by about 1.45x on prose and 1.33x on code.
 *
 * OpenAI, Google and unknown models keep 4.0 / 3.2, the usual figures for
 * o200k-class tokenizers on English and code. They are not re-measured here:
 * Codex rollouts truncate tool output before the model sees it, so the same
 * delta method does not isolate a block. `analyze --exact` calibrates any
 * provider from its own tokenizer on your machine.
 */
export const CHARS_PER_TOKEN = {
    anthropic: { prose: 2.75, code: 2.4 },
    openai: { prose: 4.0, code: 3.2 },
    google: { prose: 4.0, code: 3.2 },
    generic: { prose: 4.0, code: 3.2 },
};
/** True when text is dense with code/JSON symbols and tokenizes more finely. */
export function isCodeLike(text) {
    return symbolDensity(text) > 0.08;
}
/** Chars per token to use for this text under this model's tokenizer. */
export function charsPerTokenFor(text, model) {
    const ratios = CHARS_PER_TOKEN[providerFor(model)];
    return isCodeLike(text) ? ratios.code : ratios.prose;
}
/**
 * Estimated tokens for `text`. Pass the model when you know it: Claude's
 * tokenizer produces ~40% more tokens than the provider-neutral default.
 */
export function estimateTokens(text, model) {
    // Public API: callers outside this package pass whatever they have, and a
    // TypeError from a token estimator is never the useful answer.
    if (typeof text !== "string")
        text = String(text ?? "");
    if (!text)
        return 0;
    return tokensForLength(text.length, isCodeLike(text), model);
}
/**
 * `estimateTokens` from what it reads of a text: its length and whether it
 * is code-like. What a cache keeps instead of the text itself (scan.ts).
 */
export function tokensForLength(length, codeLike, model) {
    if (!(length > 0))
        return 0;
    const ratios = CHARS_PER_TOKEN[providerFor(model)];
    return Math.ceil(length / (codeLike ? ratios.code : ratios.prose));
}
/** Per-message structural overhead (role markers, delimiters) is roughly constant. */
export const MESSAGE_OVERHEAD_TOKENS = 4;
export function formatTokens(n) {
    // A NaN reaching a report renders literally as "NaN tokens"; show nothing
    // rather than something false.
    if (!Number.isFinite(n))
        return "0";
    if (n < 0)
        return `-${formatTokens(-n)}`;
    // Round to what is shown BEFORE choosing the unit: choosing first printed
    // 999,999.9 as "1000k" and 9,999 as "10.0k".
    const r = Math.round(n);
    if (r < 1_000)
        return String(r);
    const tenthsK = Math.round(r / 100);
    if (tenthsK < 100)
        return `${(tenthsK / 10).toFixed(1)}k`;
    const k = Math.round(r / 1_000);
    if (k < 1_000)
        return `${k}k`;
    const tenthsM = Math.round(r / 100_000);
    if (tenthsM < 10_000)
        return `${(tenthsM / 10).toFixed(1)}M`;
    return `${(Math.round(r / 100_000_000) / 10).toFixed(1)}B`;
}
/**
 * A transcript's model field, unless it is a placeholder: Claude Code writes
 * "<synthetic>" on messages it generates itself (errors, interruptions), and
 * taking the last model seen made a session's model unknown to pricing and
 * window math whenever one came last.
 */
export function realModel(model) {
    return typeof model === "string" && model && !model.startsWith("<") ? model : undefined;
}
