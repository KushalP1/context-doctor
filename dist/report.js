/**
 * Render a ContextProfile as a readable terminal/markdown report.
 * Plain text with ASCII bars — no color deps, so output pastes cleanly
 * anywhere (terminals, issues, chat).
 */
import { formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";
const CATEGORY_LABELS = {
    system: "System prompt",
    user: "User messages",
    assistant: "Assistant replies",
    tool_calls: "Tool calls",
    tool_results: "Tool results",
    other: "Other",
};
const SEVERITY_MARK = { high: "✖", warn: "▲", info: "ℹ" };
function bar(fraction, width = 28) {
    const filled = Math.round(fraction * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
}
export function renderProfile(profile) {
    const lines = [];
    const p = profile;
    lines.push("CONTEXT DOCTOR — profile");
    lines.push("═".repeat(56));
    lines.push(`Total: ~${formatTokens(p.totalTokens)} tokens across ${p.messageCount} messages (${p.sourceFormat} format)`);
    if (p.model) {
        const windowNote = p.contextWindow
            ? ` of ${formatTokens(p.contextWindow)} window (${p.usagePct.toFixed(1)}%)`
            : " (unknown window size)";
        lines.push(`Model: ${p.model}${windowNote}`);
    }
    if (p.cost) {
        lines.push(`Cost:  ~${formatUsd(p.cost.perCallUsd)} input per call · ~${formatUsd(p.cost.per1kCallsUsd)} per 1k calls · ` +
            `~${p.cost.ttftSeconds.toFixed(1)}s of latency per call (estimates)`);
    }
    lines.push("");
    // Category breakdown, largest first
    lines.push("Where the tokens go");
    lines.push("─".repeat(56));
    const cats = Object.entries(p.categories)
        .filter(([, t]) => t > 0)
        .sort((a, b) => b[1] - a[1]);
    const maxLabel = Math.max(...cats.map(([c]) => CATEGORY_LABELS[c].length));
    for (const [cat, tokens] of cats) {
        const frac = p.totalTokens > 0 ? tokens / p.totalTokens : 0;
        lines.push(`${CATEGORY_LABELS[cat].padEnd(maxLabel)}  ${bar(frac)} ${String(Math.round(frac * 100)).padStart(3)}%  ~${formatTokens(tokens)}`);
    }
    lines.push("");
    // Largest messages
    lines.push("Largest messages");
    lines.push("─".repeat(56));
    for (const m of p.largestMessages) {
        const label = m.toolName ? `${m.kind}:${m.toolName}` : m.kind;
        lines.push(`  #${m.index} [${label}] ~${formatTokens(m.tokens)}  ${m.preview}`);
    }
    lines.push("");
    // Findings
    if (p.findings.length > 0) {
        lines.push(`Findings (${p.findings.length})`);
        lines.push("─".repeat(56));
        for (const f of p.findings) {
            const savings = f.estSavings > 0 ? ` [save ~${formatTokens(f.estSavings)}]` : "";
            lines.push(`${SEVERITY_MARK[f.severity]} ${f.message}${savings}`);
            lines.push(`   → ${f.suggestion}`);
        }
        lines.push("");
        if (p.totalEstSavings > 0) {
            const pct = p.totalTokens > 0 ? Math.round((p.totalEstSavings / p.totalTokens) * 100) : 0;
            let recovery = `Potential recovery: ~${formatTokens(p.totalEstSavings)} tokens (~${pct}% of context)`;
            if (p.cost && p.cost.savingsPerCallUsd > 0) {
                recovery += ` ≈ ${formatUsd(p.cost.savingsPer1kCallsUsd)} per 1k calls, ${p.cost.ttftSavedSeconds.toFixed(1)}s faster per call`;
            }
            lines.push(recovery);
            lines.push(`Run \`context-doctor optimize <file>\` to apply the safe fixes automatically.`);
        }
    }
    else {
        lines.push("No issues found — this context is in good shape.");
    }
    return lines.join("\n");
}
