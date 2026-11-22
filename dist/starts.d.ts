/**
 * The start of every session and every subagent: the first request's prompt
 * before the first message, per Claude Code entrypoint (the Desktop app, the
 * terminal, the SDK) and per subagent type, priced across the period.
 *
 * Every later request re-reads that start: from the cache at the read price
 * on a warm step, written again at the write price on a cold one. On the
 * author's machine a Desktop-app session starts at a median ~70k tokens and a
 * general-purpose subagent at ~52k, re-read at each of its steps (#105328:
 * a terminal session starts at ~13k, because the tools the terminal defers
 * behind tool search the app sends whole).
 *
 * Claude Code records what it sent: each transcript's `api-request-shape`
 * rows carry the request's system prompt and every tool definition, with
 * `defer_loading` on the ones held behind tool search, and the
 * `deferred_tools_delta` attachments name the ones announced as deferred. So
 * the part of a start that could be deferred, MCP tool definitions sent whole,
 * is read from the request itself; its tokens are estimated from its length
 * (Claude's ratios), the start itself is the API's own count.
 */
import { type Extractor } from "./scan.js";
/**
 * What a start's measurement takes from a transcript: the entrypoint, the
 * first request's query source (it names a subagent's type), the first user
 * message's length (never its text), the tools announced as deferred before
 * the first reply, and the first request's shape as names and lengths. A
 * handful of records per transcript, read once (scan.ts).
 */
export declare const START_ROWS: Extractor<{
    e?: 1;
    q?: 1;
    s?: 1;
    u?: 1;
    r?: 1;
}>;
/**
 * The MCP servers a transcript called a tool of, by name only: which starts
 * needed a server whose tools could have waited behind tool search (fix's
 * desktop-tools-defer prices only the starts that never called it).
 */
export declare const CALL_ROWS: Extractor<{
    seen: string[];
}>;
/** An entrypoint as people call it. */
export declare function entrypointName(e: string | undefined): string;
/** The MCP server a tool name belongs to (`mcp__<server>__<tool>`), or undefined for a built-in. */
export declare function mcpServerOf(name: string): string | undefined;
export interface StartServer {
    name: string;
    /** Starts it went whole into. */
    starts: number;
    tools: number;
    /** Its definitions' tokens on a start (an estimate from their length). */
    tokens: number;
    /** In the user's own MCP config (~/.claude.json, the folder's .mcp.json): `alwaysLoad: false` there defers it. */
    configured?: "user" | "project" | ".mcp.json";
    /** Of `starts`, the ones whose session or subagent called one of its tools. */
    calledStarts: number;
    /** Its definitions' part of the starts that never called it, each start at its own rates: what keeping it behind tool search would have saved there. */
    unusedUsd: number;
    /** The same in the starts that did call it: with `unusedUsd`, its definitions' whole part of its starts, counted alike. */
    calledUsd: number;
}
export interface StartGroup {
    kind: "session" | "subagent";
    /** The entrypoint as recorded ("claude-desktop", "cli", "sdk-cli"). */
    entrypoint: string;
    agentType?: string;
    /** Starts measured (a first request over 1k tokens). */
    starts: number;
    median: number;
    p10: number;
    p90: number;
    /** Requests in the period, every one of which re-read the start. */
    requests: number;
    /** The start's price over the period: read on warm steps, written on cold ones. */
    usd: number;
    /** Starts whose model has no price: `usd` undercounts. */
    unpriced: number;
    /** Starts with a recorded request shape (Claude Code 2.1.308 and later). */
    shaped: number;
    /** Median tokens of tool definitions sent whole, and of MCP tool definitions sent whole (estimates). */
    wholeTokens?: number;
    mcpTokens?: number;
    wholeTools?: number;
    /** The MCP part's share of `usd`: what deferring those definitions would have saved, at most. */
    deferrableUsd?: number;
    servers: StartServer[];
}
export interface StartsReport {
    days: number;
    groups: StartGroup[];
    /** Desktop-app sessions against terminal ones, when both are in the period. */
    gap?: {
        desktop: number;
        terminal: number;
        tokens: number;
        usd: number;
    };
}
/**
 * Every session's and subagent's start in the period, grouped by entrypoint
 * and subagent type, each priced on every request that re-read it.
 * `paths`: the main transcripts (subagents are found beside each).
 */
export declare function measureStarts(opts?: {
    days?: number;
    paths?: string[];
    cwd?: string;
    home?: string;
}): StartsReport;
/** The servers whose tools went whole into some start and that the user's own config holds: `alwaysLoad: false` defers them. */
export declare function deferrableConfigured(r: StartsReport): Array<{
    name: string;
    scope: NonNullable<StartServer["configured"]>;
    tokens: number;
    usd: number;
}>;
/** Every server whose tools went whole into some start, across the groups: its share of each group's deferrable part, as `overhead` lists it. */
export declare function startServers(r: StartsReport): Array<StartServer & {
    usd: number;
}>;
/**
 * The Desktop app's own servers (Claude_Browser, ccd_session, visualize,
 * terminal) whose tools went whole into some start, and no config file of the
 * user's holds: fix's desktop-tools-defer, which context-doctor's mod applies.
 */
export declare function deferrableApp(r: StartsReport): Array<StartServer & {
    usd: number;
}>;
/** Every start's cost over the period as billed, and the subagents' part of it; `unpriced` when a start had a model with no price. */
export declare function startsTotal(r: StartsReport): {
    usd: number;
    subagentUsd: number;
    subagents: boolean;
    unpriced: boolean;
};
/** The starts section of `overhead`. */
export declare function renderStarts(r: StartsReport, applied?: ReadonlySet<string>): string[];
