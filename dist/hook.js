/**
 * Claude Code UserPromptSubmit hook: runs on EVERY query in Claude Code.
 *
 * Claude Code pipes hook input as JSON on stdin ({session_id, transcript_path,
 * prompt, ...}). We profile the session transcript; when the context is lean
 * we print nothing (zero noise, near-zero cost). When it crosses thresholds we
 * emit additionalContext with targeted hygiene guidance — so every query in a
 * heavy session gets nudged toward a leaner context automatically.
 *
 * Registered by `context-doctor install` under hooks.UserPromptSubmit in
 * ~/.claude/settings.json; removed by `context-doctor uninstall`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { parseSessionFile } from "./session.js";
import { formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";
/** Start nudging at 80k tokens of context. */
const WARN_TOKENS = 80_000;
/** Re-nudge only after the context grows another 40% — one reminder, not a nag. */
const REGROWTH_FACTOR = 1.4;
function statePath() {
    return process.env.CONTEXT_DOCTOR_HOOK_STATE ?? join(homedir(), ".claude", ".context-doctor-hook-state.json");
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
export async function runHook() {
    // A hook must never break the user's prompt: any failure exits silently.
    try {
        const input = JSON.parse(await readStdin());
        const transcriptPath = input.transcript_path;
        if (!transcriptPath || !existsSync(transcriptPath))
            return;
        const parsed = parseSessionFile(transcriptPath);
        if (parsed.messageCount === 0)
            return;
        const profile = profileConversation(parseConversation(parsed.conversationJson), parsed.model);
        if (profile.totalTokens < WARN_TOKENS)
            return;
        // Per-session rate limit so the nudge fires on growth, not on every prompt.
        const sessionId = input.session_id ?? transcriptPath;
        let state = {};
        try {
            state = JSON.parse(readFileSync(statePath(), "utf8"));
        }
        catch {
            /* first run */
        }
        const lastWarnedAt = state[sessionId] ?? 0;
        if (profile.totalTokens < lastWarnedAt * REGROWTH_FACTOR)
            return;
        const entries = Object.entries({ ...state, [sessionId]: profile.totalTokens });
        writeFileSync(statePath(), JSON.stringify(Object.fromEntries(entries.slice(-100))));
        const lines = [
            `This session's context is at ~${formatTokens(profile.totalTokens)} tokens` +
                (profile.usagePct ? ` (${profile.usagePct.toFixed(0)}% of the window)` : "") +
                (profile.cost ? `, costing ~${formatUsd(profile.cost.perCallUsd)} of input per message` : "") +
                ".",
            "Practice context hygiene from here on: summarize large tool results instead of keeping them verbatim, reference earlier content rather than re-reading or re-quoting it, and keep responses lean.",
        ];
        const topFinding = profile.findings.find((f) => f.estSavings > 0);
        if (topFinding) {
            lines.push(`Largest recoverable waste: ${topFinding.message} (${topFinding.suggestion})`);
        }
        if (profile.totalTokens > WARN_TOKENS * 2) {
            lines.push("If it fits the flow, offer the user a compaction of the older history.");
        }
        console.log(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: `<context-doctor>\n${lines.join("\n")}\n</context-doctor>`,
            },
        }));
    }
    catch {
        /* silent — never disturb the prompt */
    }
}
