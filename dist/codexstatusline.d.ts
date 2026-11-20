/**
 * Codex's footer, drawn by our MCP server (ROADMAP G5).
 *
 * Codex 0.171.0 lets an MCP tool be a status line, behind its
 * `tui_extensions_statusline` experiment (`/experimental`, Custom status
 * line). The shapes here are Codex's own (openai/codex, codex-rs, read
 * 2026-11-20): `tui/src/statusline_provider/descriptor.rs` takes a tool
 * whose `_meta["openai/ui"].entrypoints` holds exactly one
 * `{ type: "statusline", resourceUri: "ui://..." }`, the tool's title being
 * its name in the `/statusline` picker; `tui/src/chatwidget/statusline_reader.rs`
 * then reads that resource with the displayed thread's snapshot in
 * `params._meta["com.openai/codex-statusline-state"]`, gives each read one
 * second, waits a second and reads again; `statusline_reader/resource.rs`
 * wants exactly one text content at the advertised URI, `application/json`,
 * holding a UI tree (`tui/src/ui_tree.rs`: unknown fields refused, 64 KiB,
 * 256 non-null nodes, depth 16, 16 KiB of text; `null` clears the footer).
 * An error or a timeout stops the polling until the person picks the
 * provider again, so a read here never fails: at worst it answers the last
 * line it drew, or `null`.
 *
 * What it shows, short and plain, only what is known:
 *   context 412k of 1.0M (41%)   $3.21 this session   limits: 5h 23%, weekly 41%
 * The context and the plan's windows are the snapshot's own figures. The
 * dollars are the session's price as `spend` and the every-prompt hook count
 * it, at list prices, the agents the thread spawned included (sessionTotal,
 * sharing the hook's per-session entries). That reads the thread's rollout,
 * whole on a change, which on a 70 MB rollout takes longer than a footer
 * may wait, so it runs in a worker thread, at most one at a time, cached
 * per thread and refreshed when the thread's token totals move; a read
 * waits for it at most READ_BUDGET_MS and otherwise draws the last price
 * it had, or, before the first, the snapshot's own totals priced at the
 * model's rates (the thread alone).
 *
 * Nothing is drawn unasked: Codex shows it only to someone who turned the
 * experiment on and picked it in `/statusline`, and the tool is listed only
 * to Codex (mcp.ts).
 */
import type { Worker } from "node:worker_threads";
/** The resource Codex reads; the tool advertises it. */
export declare const CODEX_STATUSLINE_URI = "ui://context-doctor/statusline";
/** Where Codex puts the displayed thread's snapshot in a read's `params._meta`. */
export declare const CODEX_STATUSLINE_STATE = "com.openai/codex-statusline-state";
/** The tool's `_meta`: exactly one statusline entrypoint (Codex ignores a tool with two). */
export declare const CODEX_STATUSLINE_META: {
    "openai/ui": {
        entrypoints: {
            type: string;
            resourceUri: string;
        }[];
    };
};
/** The worker thread's role, passed as its `workerData`. */
export declare const PRICE_WORKER_ROLE = "context-doctor/codex-statusline-price";
/** Codex gives a read one second; this answers well inside it. */
export declare const READ_BUDGET_MS = 200;
type Color = string;
export type UiNode = string | {
    type: "text";
    props?: {
        color?: Color | null;
        weight?: "normal" | "bold" | null;
    };
    children: Array<UiNode | null>;
} | {
    type: "row";
    props: {
        gap: number;
        wrap?: "nowrap" | "wrap";
        justify?: "start" | "center" | "end" | "between";
    };
    children: Array<UiNode | null>;
};
/** Codex's limits on a tree's JSON (ui_tree/decode.rs). */
export declare const TREE_LIMITS: {
    bytes: number;
    nodes: number;
    depth: number;
    textBytes: number;
};
/** A tree's JSON measured as Codex measures it; `ok` when it is within every limit. */
export declare function measureTree(json: string): {
    ok: boolean;
    bytes: number;
    nodes: number;
    depth: number;
    textBytes: number;
};
interface RateLimitWindow {
    used_percent?: number;
    window_minutes?: number | null;
    resets_at?: number | null;
}
/** The parts of Codex's `StatuslineState` this reads. Everything optional: a field Codex leaves out is simply not shown. */
export interface CodexStatuslineState {
    account?: {
        rate_limits?: Array<{
            limit_id?: string;
            primary_limit?: RateLimitWindow | null;
            secondary_limit?: RateLimitWindow | null;
        }>;
    };
    thread?: {
        id?: string;
        model?: {
            id?: string;
            display_name?: string;
        };
        usage?: {
            context?: {
                context_window_size?: number;
                used_tokens?: number;
                used_percentage?: number;
            };
            total?: {
                total_input_tokens?: number;
                cache_read_input_tokens?: number;
                cache_write_input_tokens?: number;
                other_input_tokens?: number;
                output_tokens?: number;
            };
            cost?: {
                total_cost_usd?: number;
                total_credits?: number;
            };
        };
    };
}
/**
 * The thread's own token totals priced at its model's list rates, the tier
 * of its current context: the price before the rollout's is known. The
 * thread alone (no spawned agents); undefined for a model with no price.
 */
export declare function snapshotUsd(state: CodexStatuslineState, at?: number): number | undefined;
/**
 * The footer for one snapshot, or null when nothing is known (Codex then
 * clears it). `sessionUsd`: the session's price, when known; otherwise the
 * snapshot's totals priced, then Codex's own figure.
 */
export declare function renderCodexStatusline(state: CodexStatuslineState | undefined, sessionUsd?: number, nowMs?: number): UiNode | null;
/**
 * The rollout of a Codex thread: `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`
 * in the day folders around the time its id was made (local and UTC), then
 * the archive, then every session folder.
 */
export declare function rolloutFor(threadId: string, home?: string): string | undefined;
/** The worker side: prices a thread's session on request (sessionprice.ts), one at a time. */
export declare function servePriceWorker(): Promise<void>;
/**
 * One per server process: what each thread's session has cost, kept, and
 * the worker that reads it. `spawn` starts the worker (mcp.ts knows the
 * file it runs from); undefined, or a worker that fails, leaves the
 * snapshot's own figures.
 */
export declare class CodexStatusline {
    private spawn?;
    private worker;
    private broken;
    private next;
    private waiting;
    private inFlight;
    private prices;
    private lastGood;
    constructor(spawn?: (() => Worker) | undefined);
    private ask;
    /** The thread's session price: cached, refreshed in the background, waited for at most `budgetMs`. */
    private price;
    /**
     * The resource's text for one read: a UI tree's JSON, or "null". Never
     * throws and answers within about `budgetMs`: a failure answers the last
     * line drawn for the thread.
     */
    read(rawState: unknown, budgetMs?: number): Promise<string>;
    /** Stops the worker (tests). */
    close(): Promise<void>;
}
export {};
