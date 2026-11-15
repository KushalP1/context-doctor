/**
 * `spend --export` and `spend merge`: a team's spend without a dashboard.
 *
 * Each developer runs `spend --export` and puts the file in a folder the
 * team already shares (a drive, a repository); `spend merge <folder>` adds
 * the files up. Nothing is sent anywhere: the files go where people put them.
 *
 * An export holds totals only: per local day, tool, model and repository
 * (and branch, with `--by branch`), the requests, tokens and dollars. No
 * prompt, no path, no project or session name: a repository is its folder's
 * base name, or with `--anonymize` a hash of it (the same name hashes the
 * same on every machine, so merged files still line up). The developer is a
 * label the person chooses (`--as`), by default their OS user name.
 *
 * Merging: a developer's files that cover the same day (an export run twice)
 * count that day once, from the newest file. Developers are listed in
 * alphabetical order, not by spend: the per-repository and per-tool views
 * are the ones meant for decisions.
 */
import { type SpendItem, type Tool } from "./spend.js";
export declare const EXPORT_KIND = "context-doctor spend export";
export declare const EXPORT_VERSION = 1;
export interface ExportRow {
    /** A local day, "YYYY-MM-DD". */
    day: string;
    tool: Tool;
    model: string;
    repo: string;
    branch?: string;
    requests: number;
    /** At list price; requests with no list price are counted in `unpriced`, not in it. */
    usd: number;
    unpriced: number;
    tokens: {
        input: number;
        read: number;
        write: number;
        output: number;
    };
    /** Copilot CLI's AI credits and premium requests, as it counted them. */
    credits?: number;
    premium?: number;
}
export interface SpendExport {
    kind: typeof EXPORT_KIND;
    version: number;
    developer: string;
    exportedAt: string;
    days: number;
    /** The local days the export covers, first and last: a day in it with no row cost nothing. */
    from: string;
    to: string;
    basis: string;
    anonymized: boolean;
    byBranch: boolean;
    rows: ExportRow[];
}
/** The OS user name, the default developer label. */
export declare function defaultDeveloper(): string;
/** "repo-" or "branch-" and 10 hex: the same name, the same hash, on every machine. */
export declare function anonymize(kind: "repo" | "branch", name: string): string;
/**
 * An export of `items` (collectSpend's, with `by: "repo"` or `"branch"`).
 * A request's repository is its folder's (spendplace.ts); Gemini CLI, which
 * records no folder, keeps its project's name (a folder's base name or a
 * hash Gemini made); anything else with no folder is "(no folder)".
 */
export declare function buildExport(items: SpendItem[], o: {
    developer: string;
    days: number;
    since: number;
    until: number;
    basis: string;
    anonymize?: boolean;
    branches?: boolean;
    now?: number;
}): SpendExport;
/** A file name for an export: the developer's label made safe, and its last day. */
export declare function exportFileName(e: SpendExport): string;
/** What `spend --export` says after writing the file. */
export declare function renderExportDone(e: SpendExport, file: string): string;
/** An export file's content, or why it is not one. */
export declare function parseExport(text: string): SpendExport | string;
/** Every export in `folder` (its own files, not its subfolders), and the files that are not. */
export declare function readExports(folder: string): {
    exports: Array<{
        file: string;
        data: SpendExport;
    }>;
    skipped: Array<{
        file: string;
        reason: string;
    }>;
};
export interface MergeRow {
    name: string;
    usd: number;
    requests: number;
    unpriced: number;
    tools?: Tool[];
}
export interface MergeReport {
    files: number;
    developers: Array<MergeRow & {
        from: string;
        to: string;
        files: number;
    }>;
    from: string;
    to: string;
    usd: number;
    requests: number;
    unpriced: number;
    tokens: {
        input: number;
        read: number;
        write: number;
        output: number;
    };
    repos: MergeRow[];
    tools: MergeRow[];
    models: MergeRow[];
    branches?: MergeRow[];
    daily: Array<{
        day: string;
        usd: number;
    }>;
    /** Copilot CLI's AI credits and premium requests, as counted, across everyone. */
    credits?: number;
    premium?: number;
    /** The month of the last day: what it has cost so far, the pace over the last (up to) 14 days, and the month at that pace. An estimate. */
    forecast?: {
        month: string;
        soFar: number;
        perDay: number;
        paceDays: number;
        daysLeft: number;
        usd: number;
    };
    /** Developers whose files end before the last day: the days after count nothing for them. */
    endsEarly: Array<{
        developer: string;
        to: string;
    }>;
    /** Days two of a developer's files both covered: counted once, from the newer file. */
    overlaps: number;
    bases: string[];
    anonymized: boolean;
    skipped: Array<{
        file: string;
        reason: string;
    }>;
}
/** Add up exports: each developer's day once (their newest file that covers it), then by developer, repository, tool, model and day. */
export declare function mergeExports(exports: Array<{
    file: string;
    data: SpendExport;
}>, skipped?: MergeReport["skipped"]): MergeReport;
/** `spend merge`'s text, within 80 columns. `top`: rows per list. */
export declare function renderMerge(r: MergeReport, folder: string, top?: number): string;
