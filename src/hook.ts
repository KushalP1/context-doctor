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

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
/**
 * Fast-path gate: text tokens are at least ~4 bytes each and the transcript
 * carries JSON overhead on top, so a file smaller than this cannot possibly
 * hold WARN_TOKENS of context. Lean sessions cost one stat() call — the
 * transcript is never even read.
 */
const MIN_BYTES_FOR_WARN = WARN_TOKENS * 4;

/** Per-session state: last-warned token count + file size at last full parse. */
interface SessionState {
  t: number; // tokens at last warning (0 = parsed but never warned)
  b: number; // transcript bytes at last full parse
}

function statePath(): string {
  return process.env.CONTEXT_DOCTOR_HOOK_STATE ?? join(homedir(), ".claude", ".context-doctor-hook-state.json");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(): Promise<void> {
  // A hook must never break the user's prompt: any failure exits silently.
  try {
    const input = JSON.parse(await readStdin()) as { session_id?: string; transcript_path?: string };
    const transcriptPath = input.transcript_path;
    if (!transcriptPath || !existsSync(transcriptPath)) return;

    // Fast path 1: a small transcript cannot exceed the threshold — exit on a
    // single stat() without reading the file. This is the every-prompt cost
    // for lean sessions: ~1ms.
    const sizeBytes = statSync(transcriptPath).size;
    if (sizeBytes < MIN_BYTES_FOR_WARN) return;

    // Fast path 2: growth gate BEFORE parsing. If the file hasn't grown ~40%
    // since the last full parse, nothing new can trigger — exit without the
    // expensive read. Heavy-but-quiet sessions cost one stat + tiny state read.
    const sessionId = input.session_id ?? transcriptPath;
    let state: Record<string, SessionState | number> = {};
    try {
      state = JSON.parse(readFileSync(statePath(), "utf8"));
    } catch {
      /* first run */
    }
    const rawPrev = state[sessionId];
    // Migrate pre-0.3.5 numeric entries ({tokens only}) to the new shape.
    const prev: SessionState = typeof rawPrev === "number" ? { t: rawPrev, b: 0 } : rawPrev ?? { t: 0, b: 0 };
    if (prev.b > 0 && sizeBytes < prev.b * REGROWTH_FACTOR) return;

    // Slow path (growth events only): full parse + profile.
    const parsed = parseSessionFile(transcriptPath);
    if (parsed.messageCount === 0) return;
    const profile = profileConversation(parseConversation(parsed.conversationJson), parsed.model);

    // Record this parse so the next prompts take fast path 2.
    const shouldWarn = profile.totalTokens >= WARN_TOKENS && profile.totalTokens >= prev.t * REGROWTH_FACTOR;
    const nextState: SessionState = { t: shouldWarn ? profile.totalTokens : prev.t, b: sizeBytes };
    const entries = Object.entries({ ...state, [sessionId]: nextState });
    writeFileSync(statePath(), JSON.stringify(Object.fromEntries(entries.slice(-100))));
    if (!shouldWarn) return;

    const lines: string[] = [
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

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `<context-doctor>\n${lines.join("\n")}\n</context-doctor>`,
        },
      })
    );
  } catch {
    /* silent — never disturb the prompt */
  }
}
