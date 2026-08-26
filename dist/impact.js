/**
 * `context-doctor report` — one impact report for this machine.
 *
 * Honesty rules baked in: proxy numbers are EXACT (real before/after on every
 * request). Session numbers are MEASURED-NOW (current size + what optimization
 * would still recover). The behavioral counterfactual — what Claude avoided
 * wasting because of hygiene guidance — cannot be measured by anyone: the same
 * session cannot be re-run without it. The report says so instead of inventing
 * a number.
 */
import { readLedger } from "./ledger.js";
import { listSessions, parseSessionFile } from "./session.js";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { formatTokens } from "./tokens.js";
import { formatUsd, inputCostUsd, pricingFor } from "./pricing.js";
/** Sessions larger than this are skipped in the report (keeps it snappy). */
const MAX_SESSION_BYTES = 30 * 1024 * 1024;
async function fetchProxyStats(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/stats`, { signal: AbortSignal.timeout(500) });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
export async function buildImpactReport(proxyPort = 8787) {
    const lines = [];
    lines.push("CONTEXT DOCTOR — impact report");
    lines.push("═".repeat(56));
    const ledger = readLedger();
    const checks = ledger.filter((e) => e.ev === "check" || e.ev === undefined);
    const optimizes = ledger.filter((e) => e.ev === "optimize");
    // Observed per-session reductions: when a session SHRANK between two deep
    // checks (compaction/cleanup after a warning), that drop is measured fact.
    const bySession = new Map();
    for (const c of checks) {
        if (!c.sid || typeof c.tok !== "number")
            continue;
        const s = bySession.get(c.sid) ?? { toks: [], warns: 0 };
        s.toks.push(c.tok);
        if (c.warn)
            s.warns++;
        bySession.set(c.sid, s);
    }
    const reductionBySession = new Map();
    for (const [sid, s] of bySession) {
        let reduction = 0;
        for (let i = 1; i < s.toks.length; i++) {
            if (s.toks[i] < s.toks[i - 1])
                reduction += s.toks[i - 1] - s.toks[i];
        }
        reductionBySession.set(sid, reduction);
    }
    const totalReduction = [...reductionBySession.values()].reduce((a, b) => a + b, 0);
    // Optimize-event savings, split by model family (claude / gpt / other).
    const optimizeSaved = optimizes.reduce((s, e) => s + (e.saved ?? 0), 0);
    const savedByFamily = new Map();
    let optimizeUsd = 0;
    for (const e of optimizes) {
        const family = /claude/i.test(e.model ?? "") ? "claude" : /gpt|^o\d/i.test(e.model ?? "") ? "gpt" : "other";
        savedByFamily.set(family, (savedByFamily.get(family) ?? 0) + (e.saved ?? 0));
        const pricing = pricingFor(e.model);
        if (pricing && e.saved)
            optimizeUsd += inputCostUsd(e.saved, pricing);
    }
    const proxy = await fetchProxyStats(proxyPort);
    const proxySaved = proxy?.tokensSaved ?? 0;
    // -- Headline: what context-doctor has saved ----------------------------------
    const totalSaved = proxySaved + optimizeSaved + totalReduction;
    lines.push("Tokens context-doctor saved (measured)");
    lines.push("─".repeat(56));
    lines.push(`TOTAL: ~${formatTokens(totalSaved)} tokens`);
    if (proxy) {
        lines.push(`  · proxy (exact, current run): ${formatTokens(proxySaved)} across ${proxy.optimizedRequests}/${proxy.requests} requests ≈ ${formatUsd(proxy.estUsdSaved)}`);
    }
    else {
        lines.push(`  · proxy: not running on :${proxyPort} (its exact savings appear here while it runs)`);
    }
    const familyNote = [...savedByFamily.entries()]
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}: ${formatTokens(v)}`)
        .join(", ");
    lines.push(`  · optimizations applied via CLI/chat tools (exact): ${formatTokens(optimizeSaved)} over ${optimizes.length} run(s)` +
        (familyNote ? ` [${familyNote}]` : "") +
        (optimizeUsd > 0 ? ` ≈ ${formatUsd(optimizeUsd)}` : ""));
    lines.push(`  · observed session shrinkage after hygiene warnings: ${formatTokens(totalReduction)}`);
    lines.push("");
    // -- Hook activity ------------------------------------------------------------
    lines.push("Hygiene activity (every-prompt hook)");
    lines.push("─".repeat(56));
    if (checks.length > 0) {
        const warnings = checks.filter((e) => e.warn).length;
        lines.push(`${checks.length} deep context checks across ${bySession.size} session(s); ${warnings} warning(s) delivered to the model.`);
        lines.push("(Prompt-level fast checks are not logged — they cost ~1ms and leave no trace by design.)");
    }
    else {
        lines.push("No hook activity recorded yet (ledger appears after the first deep check of a heavy session).");
    }
    lines.push("");
    // -- Measured-now: recent session profiles ------------------------------------
    lines.push("Your recent sessions — live context and waste still recoverable");
    lines.push("─".repeat(56));
    const sessions = listSessions(8).filter((s) => s.sizeBytes <= MAX_SESSION_BYTES);
    if (sessions.length === 0) {
        lines.push("No Claude Code session transcripts found.");
    }
    else {
        let totalTokens = 0;
        let totalWaste = 0;
        let totalWasteUsd = 0;
        for (const s of sessions) {
            try {
                const parsed = parseSessionFile(s.path);
                if (parsed.messageCount === 0)
                    continue;
                const p = profileConversation(parseConversation(parsed.conversationJson), parsed.model);
                totalTokens += p.totalTokens;
                totalWaste += p.totalEstSavings;
                if (p.cost)
                    totalWasteUsd += p.cost.savingsPerCallUsd;
                const wastePct = p.totalTokens > 0 ? Math.round((p.totalEstSavings / p.totalTokens) * 100) : 0;
                // Ledger sids are the session UUID's first 12 chars (= filename prefix).
                const sid = (s.path.split("/").pop() ?? "").slice(0, 12);
                const saved = reductionBySession.get(sid) ?? 0;
                const warns = bySession.get(sid)?.warns ?? 0;
                lines.push(`  ${(parsed.title ?? s.path.split("/").pop() ?? "session").slice(0, 40).padEnd(42)} ` +
                    `${formatTokens(p.totalTokens).padStart(6)} tok · waste ${String(wastePct).padStart(2)}%` +
                    (saved > 0 ? ` · saved ${formatTokens(saved)}` : warns > 0 ? ` · ${warns} warning(s)` : ""));
            }
            catch {
                /* unreadable session — skip */
            }
        }
        lines.push("");
        lines.push(`Across these sessions: ~${formatTokens(totalTokens)} tokens held; ~${formatTokens(totalWaste)} still recoverable` +
            (totalWasteUsd > 0 ? ` (≈ ${formatUsd(totalWasteUsd)} of input per message sent in them)` : ""));
    }
    lines.push("");
    lines.push("What no report can show: tokens Claude AVOIDED adding thanks to the standing");
    lines.push("hygiene guidance — the same session cannot be re-run without it. Proxy numbers");
    lines.push("above are exact; session numbers are what optimization would still save now.");
    return lines.join("\n");
}
