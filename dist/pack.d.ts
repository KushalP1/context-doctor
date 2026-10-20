/**
 * Pack: put only the parts of a document that matter into the context.
 *
 * Everything else in context-doctor slims a conversation after the fact. The
 * cheapest token is the one that never goes in: a 60k-token manual pasted to
 * answer one question costs 60k tokens on that message and on every message
 * after it. Pack splits files into chunks along their own structure (markdown
 * headings, top-level code declarations, paragraphs), ranks the chunks against
 * a question with BM25, and returns the best ones that fit a token budget, with
 * an id and line range on each so the model can ask for more.
 *
 * Offline and keyless like the rest of the tool: lexical ranking, no embeddings
 * and no model calls. Lexical ranking misses pure paraphrase; the outline that
 * comes with every result lets the model pick sections by heading when it does.
 */
export interface PackSource {
    /** Name shown in chunk ids, e.g. a path relative to where the user is. */
    name: string;
    text: string;
}
export interface Chunk {
    /** `name#n`, stable for the same file and chunk size. */
    id: string;
    source: string;
    /** 1-based, inclusive. */
    startLine: number;
    endLine: number;
    /** Markdown heading path or the chunk's first declaration line. */
    heading: string;
    text: string;
    tokens: number;
    /** BM25 score against the query; 0 when there is none. */
    score: number;
}
export interface PackOptions {
    /** The question the context is for. Without one, pack returns an outline. */
    query?: string;
    /** Token budget for the packed text (default 4000). */
    budget?: number;
    /** Chunks by id (from an earlier outline or result), packed in this order of priority. */
    ids?: string[];
    /** Upper bound for one chunk (default 400 tokens). */
    maxChunkTokens?: number;
    /** Model whose tokenizer the budget is in. Default: Claude's ratios, the conservative ones. */
    model?: string;
}
export interface PackResult {
    mode: "query" | "ids" | "outline";
    query?: string;
    budget: number;
    /** Tokens across every source, i.e. the cost of pasting them whole. */
    totalTokens: number;
    packedTokens: number;
    /** Selected chunks, in source and line order. */
    selected: Chunk[];
    /** Every chunk, scored, in source and line order. */
    chunks: Chunk[];
    /** Ids asked for that do not exist. */
    missingIds: string[];
    /**
     * Chunks that were asked for by id, or matched the query, but did not fit
     * what was left of the budget, in priority order. With nothing selected,
     * this is the difference between "nothing matched" and "the budget is too
     * small for what matched".
     */
    unfit: Array<{
        id: string;
        tokens: number;
        requested: boolean;
    }>;
    /** What semantic ranking did, or why it was off (packContextSemantic only). */
    semanticNote?: string;
    sources: Array<{
        name: string;
        tokens: number;
        chunks: number;
        selected: number;
    }>;
}
/** Split one source into chunks of at most `maxTokens`, along its own structure. */
export declare function chunkSource(source: PackSource, opts?: {
    maxChunkTokens?: number;
    model?: string;
}): Chunk[];
/** Lowercased terms: camelCase and snake_case split, stopwords dropped, plural -s folded. */
export declare function terms(text: string): string[];
/** BM25 (k1 1.2, b 0.75); heading terms count twice, as a heading says what a section is about. */
export declare function scoreChunks(chunks: Chunk[], query: string): void;
/** Chunk, rank and select. Pure: give it text, get the plan back. */
export declare function packContext(sources: PackSource[], opts?: PackOptions): PackResult;
/**
 * packContext with optional semantic re-ranking through a local Ollama
 * (`semantic: true`, or a model name). Falls back to keyword ranking, with
 * the reason in `semanticNote`, when no embedding model is available.
 */
export declare function packContextSemantic(sources: PackSource[], opts?: PackOptions & {
    semantic?: boolean | string;
}): Promise<PackResult>;
/** Plain-text rendering for a model or a terminal. */
export declare function renderPack(r: PackResult, { outlineLimit }?: {
    outlineLimit?: number;
}): string;
export declare const PACK_LIMITS: {
    files: number;
    fileBytes: number;
    totalBytes: number;
};
/** Why `path` looks like a secrets file, or undefined when it does not. */
export declare function secretFileReason(path: string): string | undefined;
export interface ReadSourcesOptions {
    /** Names are shown relative to this (default: the working directory). */
    cwd?: string;
    /**
     * Pack secrets files (.env, .npmrc, private keys, …) and paths in credential
     * folders (~/.ssh, ~/.aws, …) too. CLI `--include-secrets` only; the MCP
     * tool has no way to set it.
     */
    includeSecrets?: boolean;
    /** How the caller can opt in, appended to a "secret, skipped" note. */
    secretsHint?: string;
}
/**
 * Read files and directories (recursively, skipping build and dependency
 * folders, hidden entries, binaries, secrets files, and anything past the size
 * limits) into sources. `skipped` says what was left out and why, so nothing
 * vanishes silently.
 *
 * A path named here is read even through a symlink; a symlink met inside a
 * folder is not followed, as git does not follow one either. A link out of
 * the folder would pack files nobody named (a tracked link to /etc/hosts, or
 * to a secret beside the repo), a link to a parent loops, and what a link
 * inside points at is read under its own name (or left out by .gitignore).
 *
 * An unreadable entry (permission denied, a device, /dev/fd) is reported as
 * skipped, never thrown: one locked file must not lose the rest of a folder.
 */
export declare function readSources(paths: string[], cwdOrOptions?: string | ReadSourcesOptions): {
    sources: PackSource[];
    skipped: string[];
};
