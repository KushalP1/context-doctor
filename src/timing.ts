/**
 * Where the wall clock went: per-tool latency from transcript timestamps.
 *
 * Tokens say what a tool call put INTO the context; this says how long it made
 * the user wait. Both are needed to decide what to fix first: a Read that
 * costs 9k tokens but returns instantly is a different problem from a Bash
 * call that costs 200 tokens and takes 40 seconds.
 */

import type { ToolTiming } from "./session.js";

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function renderToolTimings(timings: ToolTiming[], top = 6): string | null {
  if (timings.length === 0) return null;
  const total = timings.reduce((s, t) => s + t.totalMs, 0);
  if (total <= 0) return null;

  const lines: string[] = [];
  lines.push("Where the time goes (tool wall clock)");
  lines.push("─".repeat(56));
  lines.push(`Tool calls waited ${fmtMs(total)} in total across ${timings.reduce((s, t) => s + t.calls, 0)} calls.`);
  // MCP tool names run long (mcp__server__tool); fit the column to what is
  // shown, capped so one long name cannot push the numbers off the screen.
  const shown = timings.slice(0, top);
  const width = Math.min(32, Math.max(...shown.map((t) => t.tool.length)));
  const name = (tool: string): string => (tool.length > width ? tool.slice(0, width - 1) + "…" : tool).padEnd(width);
  for (const t of shown) {
    const share = Math.round((t.totalMs / total) * 100);
    lines.push(
      `  ${name(t.tool)} ${fmtMs(t.totalMs).padStart(7)}  ${String(share).padStart(3)}%  ` +
        `${String(t.calls).padStart(4)} calls · median ${fmtMs(t.medianMs)} · slowest ${fmtMs(t.maxMs)}`
    );
  }
  if (timings.length > top) lines.push(`  … and ${timings.length - top} more tool(s)`);
  // The caveat has to travel with the number or the number lies.
  lines.push("Measured from tool_use to tool_result timestamps. Includes any time spent waiting on a");
  lines.push("permission prompt, so interactive sessions read slower than unattended ones.");
  return lines.join("\n");
}
