/**
 * The auto-compact window the Desktop app chose, and the one Anthropic's
 * server sets: read (never written) so `compact-window` and `fix` do not
 * offer a second window over one the person just answered.
 *
 * Read from the 2.1.329 binary (`strings`; ROADMAP "Research 2026-11-20"):
 *  - The Code tab is testing an offer of a lower auto-compact window. It
 *    passes the person's answer to Claude Code in its own (flag) settings,
 *    `autoCompactOfferAnswer: { model, choice: 'accept'|'keep'|'undo',
 *    tokens, at }` ("`tokens` is the window they chose or kept, and `at` is
 *    when they answered"), and Claude Code records it in `~/.claude.json`
 *    as `autoCompactOfferCodeTab[account][model] = { choice, tokens, at }`
 *    (the account lowercased, the model as its settings key). Claude Code
 *    reads that record back only to keep an older answer from replacing a
 *    newer one: nothing in the binary sets a window from it. Whether
 *    accepting changes the window Claude Code uses depends on what the app
 *    passes in its own settings, which are not on disk. So this says what
 *    the app offered and what the person chose, and assumes nothing about
 *    the window that followed.
 *  - `autoCompactRaisedForLoad` (also the app's own settings only): true
 *    "lets a conversation compact at twice what is still in each request
 *    after a summary (system prompt, tools, instruction files), where that is
 *    above its auto-compact threshold".
 *  - `autoCompactWindowsCache` in `~/.claude.json`: the per-model windows
 *    Anthropic's server sends with the account (`auto_compact_windows`, on
 *    the Anthropic API only). Claude Code uses one for its model when no
 *    environment variable or settings file sets a window (its "server"
 *    source), so this one is a window in effect.
 */

import { readFileSync } from "node:fs";
import { claudeJsonPath, tilde } from "./claudedir.js";
import { settingsSources } from "./effective.js";
import { modelName } from "./subagentmodel.js";

export type OfferChoice = "accept" | "keep" | "undo";

/** One answer to the Desktop app's offer, the newest for its model. */
export interface AppWindowAnswer {
  /** The model as Claude Code keyed it (its settings key, e.g. "claude-opus-5-5"). */
  model: string;
  choice: OfferChoice;
  /** The window the person chose or kept. */
  tokens: number;
  /** When they answered (epoch ms). */
  at: number;
  /** Where it was read: ~/.claude.json, or a settings file. */
  where: string;
}

export interface AppWindows {
  answers: AppWindowAnswer[];
  /** Windows Anthropic's server sets for this account, per model (autoCompactWindowsCache). */
  served: Array<{ model: string; window: number }>;
  /** A settings file with autoCompactRaisedForLoad: true. */
  raisedForLoad?: string;
}

const CHOICES = new Set<string>(["accept", "keep", "undo"]);

function answerOf(v: any, model: string | undefined, where: string): AppWindowAnswer | undefined {
  if (!v || typeof v !== "object") return undefined;
  const m = typeof model === "string" && model ? model : typeof v.model === "string" ? v.model : undefined;
  if (!m || !CHOICES.has(v.choice)) return undefined;
  if (!(typeof v.tokens === "number" && Number.isInteger(v.tokens) && v.tokens > 0)) return undefined;
  // A time a Date can hold (its range is ±8.64e15 ms): the lines print it as a day, which throws past it.
  if (!(typeof v.at === "number" && Number.isFinite(v.at) && v.at > 0 && v.at <= 8.64e15)) return undefined;
  return { model: m, choice: v.choice, tokens: v.tokens, at: v.at, where };
}

/** Read-only: ~/.claude.json and the settings files. Nothing found: empty lists. */
export function readAppWindows(opts: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): AppWindows {
  const env = opts.env ?? process.env;
  const out: AppWindows = { answers: [], served: [] };
  const byModel = new Map<string, AppWindowAnswer>();
  const keep = (a: AppWindowAnswer | undefined) => {
    if (!a) return;
    const k = modelKey(a.model);
    const had = byModel.get(k);
    if (!had || a.at > had.at) byModel.set(k, a);
  };
  const path = claudeJsonPath(opts.home, env);
  let j: any;
  try { j = JSON.parse(readFileSync(path, "utf8")); } catch { j = undefined; }
  if (j && typeof j === "object") {
    // Every account's answers on this machine: the Code tab's account need not be the terminal's login.
    const tab = j.autoCompactOfferCodeTab;
    if (tab && typeof tab === "object") {
      for (const models of Object.values(tab)) {
        if (!models || typeof models !== "object") continue;
        for (const [model, v] of Object.entries(models as Record<string, unknown>)) keep(answerOf(v, model, tilde(path)));
      }
    }
    const cache = j.autoCompactWindowsCache;
    if (cache && typeof cache === "object" && !Array.isArray(cache)) {
      for (const [model, w] of Object.entries(cache)) if (typeof w === "number" && Number.isInteger(w) && w > 0) out.served.push({ model, window: w });
    }
  }
  for (const s of settingsSources({ home: opts.home, cwd: opts.cwd, env })) {
    keep(answerOf(s.settings.autoCompactOfferAnswer, undefined, tilde(s.path)));
    if (s.settings.autoCompactRaisedForLoad === true && !out.raisedForLoad) out.raisedForLoad = tilde(s.path);
  }
  out.answers = [...byModel.values()].sort((a, b) => a.at - b.at);
  out.served.sort((a, b) => a.model.localeCompare(b.model));
  return out;
}

/** Anything to say: an answer, a served window, or the raised-for-load switch. */
export const hasAppWindows = (a: AppWindows | undefined): a is AppWindows => !!a && (a.answers.length > 0 || a.served.length > 0 || !!a.raisedForLoad);

/** A model id as a settings key: lowercase, no "[1m]", no date suffix, no Bedrock or Vertex wrapping. */
export function modelKey(model: string): string {
  return model.trim().toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/-\d{8}$/, "");
}

/** Whether a transcript's model is the one an answer names ("opus" and the like match their family). */
export function sameModel(answer: string, model: string): boolean {
  const a = modelKey(answer);
  const m = modelKey(model);
  if (/^(opus|sonnet|haiku|fable|mythos)$/.test(a)) return m.includes(a);
  return a === m;
}

/** A window in tokens: "300k", "1M", "1.5M" (a 1M window read "1000k"). */
const k = (n: number) => (n >= 999_500 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}k`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nameOf = (m: string) => modelName(m) === m ? m : modelName(m);

/**
 * `doctor`'s one line: each answer on file, in plain words ("on 2026-11-18
 * the Desktop app offered a 400k auto-compact window for Opus 5.5 and you
 * accepted it"). Undefined when there is none.
 */
export function appAnswerText(a: AppWindows): string | undefined {
  if (!a.answers.length) return undefined;
  const one = (x: AppWindowAnswer) =>
    x.choice === "accept" ? `on ${day(x.at)} the Desktop app offered a ${k(x.tokens)} auto-compact window for ${nameOf(x.model)} and you accepted it`
      : x.choice === "keep" ? `on ${day(x.at)} the Desktop app offered a lower auto-compact window for ${nameOf(x.model)} and you kept yours (${k(x.tokens)})`
        : `on ${day(x.at)} you undid the lower auto-compact window the Desktop app had set for ${nameOf(x.model)} (on record: ${k(x.tokens)})`;
  return a.answers.map(one).join("; ");
}

/**
 * The lines `compact-window` and `fix` say about it (none when nothing is on
 * file). `left`: the sessions the replay left as they ran, when known.
 */
export function appWindowLines(a: AppWindows, left?: number): string[] {
  const lines: string[] = [];
  for (const x of a.answers) {
    const who = `The Desktop app, ${nameOf(x.model)}`;
    if (x.choice === "accept") lines.push(`${who}: on ${day(x.at)} it offered a ${k(x.tokens)} auto-compact window and you accepted it.`);
    else if (x.choice === "keep") lines.push(`${who}: on ${day(x.at)} it offered a lower auto-compact window and you kept yours (${k(x.tokens)}).`);
    else lines.push(`${who}: on ${day(x.at)} you undid the lower auto-compact window it had set (on record: ${k(x.tokens)}).`);
  }
  if (a.answers.length) {
    const models = a.answers.map((x) => nameOf(x.model)).join(", ");
    lines.push(`Whether that answer changes the window Claude Code uses is not recorded on this computer`);
    lines.push(`(the app passes it in its own settings), so nothing here assumes it does: sessions`);
    const n = left === undefined ? "" : left === 0 ? " (none here)" : left === 1 ? " (1 here)" : ` (${left} here)`;
    lines.push(`mostly on ${models}${n} are left as they ran, and only the rest are replayed.`);
  }
  if (a.served.length) {
    lines.push(`Anthropic's server sets an auto-compact window on your account: ${a.served.map((s) => `${k(s.window)} for ${nameOf(s.model)}`).join(", ")}`);
    lines.push(`(Claude Code uses it where no autoCompactWindow is set).`);
  }
  if (a.raisedForLoad) lines.push(`autoCompactRaisedForLoad in ${a.raisedForLoad} does nothing: Claude Code reads it from the app's settings only.`);
  return lines;
}
