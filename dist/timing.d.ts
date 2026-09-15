/**
 * Where the wall clock went: per-tool latency from transcript timestamps.
 *
 * Tokens say what a tool call put INTO the context; this says how long it made
 * the user wait. Both are needed to decide what to fix first: a Read that
 * costs 9k tokens but returns instantly is a different problem from a Bash
 * call that costs 200 tokens and takes 40 seconds.
 */
import type { ToolTiming } from "./session.js";
export declare function renderToolTimings(timings: ToolTiming[], top?: number): string | null;
