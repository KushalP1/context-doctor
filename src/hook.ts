/**
 * Claude Code UserPromptSubmit hook: runs on EVERY query in Claude Code (and
 * Codex, same format), and after every tool call in Cursor (postToolUse).
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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { recordLedger, statePath } from "./ledger.js";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { parseSessionFile } from "./session.js";
import { formatTokens, CHARS_PER_TOKEN } from "./tokens.js";
import { ensureProxyUp } from "./autopilot.js";
import { detectColdResume, renderColdResume, renderColdResumeNotice } from "./coldresume.js";
import { formatUsd, pricingFor } from "./pricing.js";
import { checkBudget, loadConfig } from "./config.js";

/** Default nudge threshold; a project budget or env var can lower/raise it. */
const DEFAULT_WARN_TOKENS = 80_000;

/**
 * Threshold precedence: CONTEXT_DOCTOR_WARN_TOKENS env var, then the project
 * budget's maxTokens (.contextdoctorrc), then the default.
 */
function warnThreshold(budgetMaxTokens?: number): number {
  const env = Number(process.env.CONTEXT_DOCTOR_WARN_TOKENS);
  if (env > 0) return env;
  if (budgetMaxTokens !== undefined && budgetMaxTokens > 0) return budgetMaxTokens;
  return DEFAULT_WARN_TOKENS;
}
/** Re-nudge only after the context grows another 40% — one reminder, not a nag. */
const REGROWTH_FACTOR = 1.4;
/**
 * Fast-path gate: no tokenizer we model packs more than one token into fewer
 * bytes than its densest ratio (Claude on code, 2.4), and the transcript
 * carries JSON overhead on top, so a file smaller than this cannot possibly
 * hold that many tokens of context. Lean sessions cost one stat() call — the
 * transcript is never even read. (This used 4 bytes per token until 0.19,
 * which let Claude sessions past the threshold take the fast path.)
 */
const DENSEST_CHARS_PER_TOKEN = Math.min(...Object.values(CHARS_PER_TOKEN).map((r) => Math.min(r.prose, r.code)));
function minBytesForWarn(threshold: number): number {
  return Math.floor(threshold * DENSEST_CHARS_PER_TOKEN);
}

/** Per-session state: last-warned token count + file size at last full parse. */
interface SessionState {
  t: number; // tokens at last warning (0 = parsed but never warned)
  b: number; // transcript bytes at last full parse
  cr?: number; // last reply timestamp of the idle period already advised on (cold resume)
}

/**
 * State lives in one small file per session, not one shared map.
 *
 * The hook runs once per prompt in every Claude Code window, and people keep
 * several open. With a shared JSON map, concurrent hooks each read the whole
 * map and wrote it back, so the last writer erased everyone else: measured,
 * 12 simultaneous sessions left 4 surviving entries. The cost of losing an
 * entry is a repeated warning the regrowth gate exists to prevent, plus a full
 * re-parse of a transcript that can be hundreds of megabytes.
 *
 * A process that only ever writes its own session's file cannot race another.
 */
function stateDir(): string {
  return statePath().replace(/\.json$/, "") + ".d";
}

function sessionStatePath(sessionId: string): string {
  // Session ids are usually uuids, but the fallback id is a filesystem path.
  // Hashing keeps the filename valid whatever the id looks like.
  return join(stateDir(), createHash("sha1").update(sessionId).digest("hex").slice(0, 16) + ".json");
}

function readSessionState(sessionId: string): SessionState {
  try {
    const raw = JSON.parse(readFileSync(sessionStatePath(sessionId), "utf8")) as SessionState;
    if (typeof raw?.t === "number" && typeof raw?.b === "number") return raw;
  } catch {
    /* absent or half-written: treat as a first run */
  }
  // Migration: entries written by the shared-map versions are still useful.
  try {
    const legacy = JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, SessionState | number>;
    const entry = legacy[sessionId];
    if (typeof entry === "number") return { t: entry, b: 0 };
    if (entry && typeof entry.t === "number") return { t: entry.t, b: entry.b ?? 0 };
  } catch {
    /* no legacy file */
  }
  return { t: 0, b: 0 };
}

/** Keep the directory from growing without bound as sessions come and go. */
const MAX_STATE_FILES = 200;

function writeSessionState(sessionId: string, state: SessionState): void {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(sessionStatePath(sessionId), JSON.stringify(state));
  try {
    const files = readdirSync(dir);
    if (files.length <= MAX_STATE_FILES) return;
    const byAge = files
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(MAX_STATE_FILES);
    for (const { f } of byAge) rmSync(join(dir, f), { force: true });
  } catch {
    /* pruning is housekeeping, never worth failing a prompt over */
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function settingsHasOurHook(): boolean {
  try {
    const hooks = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"))?.hooks?.UserPromptSubmit;
    return JSON.stringify(hooks ?? "").includes("context-doctor");
  } catch {
    return false;
  }
}

export async function runHook(): Promise<void> {
  // A hook must never break the user's prompt: any failure exits silently.
  try {
    // Autopilot self-heal: this prompt's request is about to go to the proxy,
    // so if the proxy died, start it now. One existsSync when autopilot is
    // off; a ~1ms localhost health check when it is on and healthy.
    const heal = ensureProxyUp().catch(() => undefined);
    // Installed both ways (plugin and `context-doctor install`)? The plugin
    // copy stays silent so the model is told once, not twice.
    if (process.env.CLAUDE_PLUGIN_ROOT && settingsHasOurHook()) { await heal; return; }
    const input = JSON.parse(await readStdin()) as {
      session_id?: string; transcript_path?: string; cwd?: string;
      hook_event_name?: string; conversation_id?: string; model?: string; workspace_roots?: string[]; cursor_version?: string;
    };
    await heal;
    // Cursor runs this hook twice over: Claude Code's UserPromptSubmit as its
    // beforeSubmitPrompt (which cannot add context, so there is nothing to do),
    // and natively after each tool call, where `additional_context` reaches
    // the model. Codex and Claude Code send UserPromptSubmit.
    // Cursor marks every hook input with cursor_version; any of its events but
    // postToolUse would only spend the once-per-growth warning on output Cursor
    // drops.
    const cursor = input.hook_event_name === "postToolUse";
    if (input.hook_event_name === "beforeSubmitPrompt" || (input.cursor_version && !cursor)) return;
    const transcriptPath = input.transcript_path;
    if (!transcriptPath || !existsSync(transcriptPath)) return;

    // Fast path 1: a small transcript cannot exceed the threshold — exit on a
    // single stat() without reading the file. This is the every-prompt cost
    // for lean sessions: ~1ms.
    const { config } = loadConfig(input.cwd ?? input.workspace_roots?.[0] ?? process.cwd());
    const threshold = warnThreshold(config.budget?.maxTokens);
    const sizeBytes = statSync(transcriptPath).size;
    if (sizeBytes < minBytesForWarn(threshold)) return;

    // Fast path 2: growth gate BEFORE parsing. If the file hasn't grown ~40%
    // since the last full parse, nothing new can trigger — exit without the
    // expensive read. Heavy-but-quiet sessions cost one stat + tiny state read.
    const sessionId = input.session_id ?? input.conversation_id ?? transcriptPath;
    const prev = readSessionState(sessionId);

    // Cold resume: back on a large session after the cache expired. Checked
    // before the growth gate, because a return after idle involves no growth.
    // Once per idle period; the tail read is ~1 ms and only on large files.
    const notes: string[] = [];
    let notice: string | undefined;
    const cold = detectColdResume(transcriptPath);
    let cr = prev.cr;
    if (cold && cold.lastReplyAt !== prev.cr) {
      notes.push(renderColdResume(cold));
      notice = renderColdResumeNotice(cold);
      cr = cold.lastReplyAt;
      recordLedger({ ev: "cold_resume", sid: sessionId.slice(0, 12), tok: cold.tokens, model: cold.model });
    }
    const emit = (lines: string[]): void => {
      if (lines.length === 0 && !notice) return;
      const block = `<context-doctor>\n${lines.join("\n")}\n</context-doctor>`;
      if (cursor) {
        // Cursor's postToolUse has no user-facing field, so only the model's note goes out.
        if (lines.length > 0) console.log(JSON.stringify({ additional_context: block }));
        return;
      }
      const out: Record<string, unknown> = {};
      // systemMessage is shown to the user in the app; additionalContext goes to the model.
      if (notice) out.systemMessage = notice;
      if (lines.length > 0) out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: block };
      console.log(JSON.stringify(out));
    };
    if (prev.b > 0 && sizeBytes < prev.b * REGROWTH_FACTOR) {
      if (cr !== prev.cr) writeSessionState(sessionId, { ...prev, cr });
      emit(notes);
      return;
    }

    // Slow path (growth events only): full parse + profile.
    const parsed = parseSessionFile(transcriptPath);
    if (parsed.messageCount === 0) return;
    const model = parsed.model ?? input.model;
    const profile = profileConversation(parseConversation(parsed.conversationJson), model);

    // Prefer the API's own figure when the transcript carries it: it includes
    // the system prompt and tool schemas the transcript omits, so it is the
    // real context size rather than a message-only estimate.
    const liveTokens = parsed.reportedInputTokens ?? profile.totalTokens;

    // Record this parse so the next prompts take fast path 2.
    const shouldWarn = liveTokens >= threshold && liveTokens >= prev.t * REGROWTH_FACTOR;
    writeSessionState(sessionId, { t: shouldWarn ? liveTokens : prev.t, b: sizeBytes, cr });
    recordLedger({ ev: "check", sid: sessionId.slice(0, 12), tok: liveTokens, warn: shouldWarn });
    if (!shouldWarn) { emit(notes); return; }

    const windowPct = !cursor && profile.contextWindow ? (liveTokens / profile.contextWindow) * 100 : undefined;
    // Agent sessions run on the prompt cache: a message normally re-reads the
    // context at the cached rate (0.1x) and pays the full rate only when the
    // cache has expired. Quoting the uncached figure alone overstated the
    // per-message cost tenfold (fixed in 0.22).
    const pricing = pricingFor(model);
    const cachedUsd = pricing ? (liveTokens * pricing.cacheReadPerM) / 1e6 : undefined;
    const coldUsd = pricing ? (liveTokens * pricing.inputPerM * 1.25) / 1e6 : undefined;
    // Cursor's agent transcript records tool calls but not their output, and
    // keeps turns Cursor has since summarized, so it measures how much the chat
    // has accumulated, not the live context: no window share or price for it.
    const lines: string[] = cursor ? [
      `This chat has accumulated ~${formatTokens(liveTokens)} tokens of messages and tool calls (tool output not counted; Cursor summarizes older turns itself, so the live context may differ).`,
      "Practice context hygiene from here on: summarize large tool results instead of keeping them verbatim, reference earlier content rather than re-reading or re-quoting it, and keep responses lean.",
    ] : [
      `This session's context is at ~${formatTokens(liveTokens)} tokens` +
        (windowPct !== undefined ? ` (${windowPct.toFixed(0)}% of the window)` : "") +
        (cachedUsd !== undefined ? `: each message re-reads it for ~${formatUsd(cachedUsd)} from the prompt cache, ~${formatUsd(coldUsd!)} when the cache has expired` : "") +
        ".",
      "Practice context hygiene from here on: summarize large tool results instead of keeping them verbatim, reference earlier content rather than re-reading or re-quoting it, and keep responses lean.",
    ];
    // A configured budget is the user's own limit — say so first and by name.
    const verdict = checkBudget(config.budget, { ...profile, totalTokens: liveTokens, usagePct: windowPct });
    if (verdict.overBudget) {
      lines.splice(1, 0, `This project's context budget is exceeded: ${verdict.breaches.join("; ")}. Treat compaction as a priority, not an option.`);
    }
    const topFinding = profile.findings.find((f) => f.estSavings > 0);
    if (topFinding) {
      lines.push(`Largest recoverable waste: ${topFinding.message} (${topFinding.suggestion})`);
    }
    if (liveTokens > threshold * 2) {
      lines.push(cursor
        ? "If the task changes, suggest the user start a new chat from a short summary of this one."
        : "If it fits the flow, offer the user a compaction of the older history.");
    }

    emit([...notes, ...lines]);
  } catch {
    /* silent — never disturb the prompt */
  }
}
