/**
 * Profile a conversation from a SKETCH instead of the conversation itself.
 *
 * Why this exists: in a chat app (Claude Desktop, ChatGPT) the model cannot
 * export the conversation, so asking it to call profile_context with the full
 * JSON means re-typing 50k+ tokens as a tool argument. No model does that, and
 * it would double the context it is meant to measure. A sketch is ~100 output
 * tokens: turn count plus the handful of blocks that matter (pastes, tool
 * results, images, repeats). The estimate is coarse (±30%) and says so, but it
 * turns "call profile_context" from an impossible instruction into a cheap one.
 */
import { contextWindowFor } from "./tokens.js";
import { formatTokens } from "./tokens.js";
import { formatUsd, inputCostUsd, pricingFor } from "./pricing.js";
import { recordLedger } from "./ledger.js";
// A plain chat turn without attachments: a short user message and a normal
// assistant reply. Measured across Claude Code transcripts the median user turn
// is ~120 tokens and the median assistant turn ~450; chat apps run similar.
const BASELINE_TOKENS_PER_TURN = 570;
// Tokens per unit when the model reports size in lines/words/chars. Code and
// tool output are denser per line than prose; words are ~1.35 tokens each.
const TOKENS_PER_LINE = {
    code: 12, tool_result: 12, paste: 14, text: 14, base64: 40, image: 0,
};
const TOKENS_PER_WORD = 1.35;
const CHARS_PER_TOKEN = 4;
// When a block carries no size at all. Images are billed at a near-fixed rate.
const DEFAULT_TOKENS = {
    image: 1500, paste: 800, code: 800, tool_result: 800, base64: 4000, text: 300,
};
const LARGE_BLOCK_TOKENS = 2000;
const LONG_HISTORY_TURNS = 30;
const HANDOFF_SUMMARY_TOKENS = 300;
const RECENT_TURNS_KEPT = 6;
export function blockTokens(b) {
    if (b.kind === "image")
        return b.approx_tokens ?? DEFAULT_TOKENS.image;
    if (b.approx_tokens && b.approx_tokens > 0)
        return Math.round(b.approx_tokens);
    if (b.approx_lines && b.approx_lines > 0)
        return Math.round(b.approx_lines * TOKENS_PER_LINE[b.kind]);
    if (b.approx_words && b.approx_words > 0)
        return Math.round(b.approx_words * TOKENS_PER_WORD);
    if (b.approx_chars && b.approx_chars > 0)
        return Math.round(b.approx_chars / CHARS_PER_TOKEN);
    return DEFAULT_TOKENS[b.kind];
}
export function profileSketch(sketch) {
    const turns = Math.max(0, Math.floor(sketch.turns || 0));
    const blocks = Array.isArray(sketch.blocks) ? sketch.blocks : [];
    const baselineTokens = turns * BASELINE_TOKENS_PER_TURN;
    // A repeated block costs its size every time it appears.
    const sized = blocks.map((b) => ({ block: b, tokens: blockTokens(b), copies: Math.max(1, Math.floor(b.repeated ?? 1)) }));
    const blockTotal = sized.reduce((n, s) => n + s.tokens * s.copies, 0);
    const totalTokens = baselineTokens + blockTotal;
    const findings = [];
    for (const { block, tokens, copies } of sized) {
        if (copies > 1) {
            findings.push({
                id: "duplicate_block",
                severity: "warn",
                estSavings: tokens * (copies - 1),
                message: `"${block.label}" appears ${copies} times (~${formatTokens(tokens)} each).`,
                action: `Refer to "${block.label}" by name from now on; never re-quote it.`,
            });
        }
        if (block.kind === "base64") {
            findings.push({
                id: "base64_blob",
                severity: "high",
                estSavings: Math.max(0, tokens - 50),
                message: `"${block.label}" is inline base64 (~${formatTokens(tokens)}), which the model cannot read anyway.`,
                action: `Drop it: describe "${block.label}" in one line and ask the user to attach it as a file if needed.`,
            });
            continue;
        }
        if (block.kind !== "image" && tokens >= LARGE_BLOCK_TOKENS) {
            // A summary keeps roughly 30% of a block that is still in use; a stale
            // block needs only a one-line pointer.
            const est = block.stale ? Math.max(0, tokens - 100) : Math.round(tokens * 0.7);
            findings.push({
                id: "large_block",
                severity: tokens >= 4 * LARGE_BLOCK_TOKENS ? "high" : "warn",
                estSavings: est,
                message: `"${block.label}" (turn ${block.turn}, ${block.kind}) is ~${formatTokens(tokens)}${block.stale ? " and already acted on" : ""}.`,
                action: block.stale
                    ? `Replace "${block.label}" with a one-line note of what it was and what came of it.`
                    : `Summarize "${block.label}" into the points still needed (facts, identifiers, decisions) and work from the summary.`,
            });
        }
    }
    const images = sized.filter((s) => s.block.kind === "image");
    if (images.length >= 3) {
        const imgTokens = images.reduce((n, s) => n + s.tokens * s.copies, 0);
        findings.push({
            id: "many_images",
            severity: "info",
            estSavings: 0,
            message: `${images.length} images (~${formatTokens(imgTokens)}) ride along on every turn.`,
            action: "Once an image has been read, describe what it showed in a sentence so it need not be looked at again; new chats should get only the images still needed.",
        });
    }
    if (turns >= LONG_HISTORY_TURNS) {
        const afterHandoff = RECENT_TURNS_KEPT * BASELINE_TOKENS_PER_TURN + HANDOFF_SUMMARY_TOKENS;
        findings.push({
            id: "long_history",
            severity: totalTokens > 100_000 ? "high" : "warn",
            estSavings: Math.max(0, totalTokens - afterHandoff),
            message: `${turns} turns: every new message re-reads ~${formatTokens(totalTokens)}.`,
            action: `Offer a handoff: write a ≤${HANDOFF_SUMMARY_TOKENS}-token summary (decisions, current state, open items, key identifiers) for the user to start a new chat with. A fresh chat re-reads ~${formatTokens(afterHandoff)} instead.`,
        });
    }
    const contextWindow = contextWindowFor(sketch.model);
    const usagePct = contextWindow ? Math.round((totalTokens / contextWindow) * 100) : undefined;
    if (usagePct !== undefined && usagePct >= 70) {
        findings.push({
            id: "near_window_limit",
            severity: "high",
            estSavings: 0,
            message: `~${usagePct}% of the ${formatTokens(contextWindow)} window. Quality drops and the app may start dropping early turns.`,
            action: "Do the handoff now rather than at the next problem.",
        });
    }
    const order = { high: 0, warn: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || b.estSavings - a.estSavings);
    // Savings overlap (a duplicate block is also a large block); report the sum
    // capped at what is actually there.
    const totalEstSavings = Math.min(totalTokens, findings.reduce((n, f) => n + f.estSavings, 0));
    const pricing = pricingFor(sketch.model);
    return {
        totalTokens, baselineTokens, blockTokens: blockTotal, turns, model: sketch.model, contextWindow, usagePct,
        findings, totalEstSavings,
        perTurnUsd: pricing ? inputCostUsd(totalTokens, pricing) : undefined,
        perTurnCachedUsd: pricing ? (totalTokens / 1_000_000) * pricing.cacheReadPerM : undefined,
    };
}
export function renderSketchProfile(p) {
    const lines = [];
    const window = p.usagePct !== undefined ? ` (~${p.usagePct}% of ${formatTokens(p.contextWindow)})` : "";
    lines.push(`Context estimate from sketch: ~${formatTokens(p.totalTokens)} tokens${window}, ${p.turns} turns.`);
    lines.push(`  ${formatTokens(p.baselineTokens)} plain conversation + ${formatTokens(p.blockTokens)} in pastes, tool output and images. Estimate, ±30%.`);
    if (p.perTurnUsd !== undefined) {
        lines.push(`  Re-read on every turn: ${formatUsd(p.perTurnUsd)} at list price, ${formatUsd(p.perTurnCachedUsd)} when cached. On a subscription this is what spends the usage limit.`);
    }
    else {
        lines.push("  Re-read on every turn. On a subscription this is what spends the usage limit.");
    }
    if (p.findings.length === 0) {
        lines.push("No findings: nothing large, repeated, or stale in the sketch. Keep going.");
        return lines.join("\n");
    }
    lines.push("");
    lines.push(`Findings (recoverable ~${formatTokens(p.totalEstSavings)} tokens):`);
    p.findings.forEach((f, i) => {
        const save = f.estSavings > 0 ? ` [~${formatTokens(f.estSavings)}]` : "";
        lines.push(`${i + 1}. ${f.severity.toUpperCase()}${save} ${f.message}`);
        lines.push(`   → ${f.action}`);
    });
    lines.push("");
    lines.push("Act on #1 in your reply (do it, do not just suggest it), and tell the user in one line what you dropped and roughly what it saves per turn.");
    return lines.join("\n");
}
/** Profile a sketch, log it to the ledger like a hook check, and render. */
export function runSketch(sketch) {
    const profile = profileSketch(sketch);
    recordLedger({ ev: "check", sid: "mcp-sketch", src: "mcp", tok: profile.totalTokens, warn: profile.findings.some((f) => f.severity !== "info"), model: sketch.model });
    return renderSketchProfile(profile);
}
