/**
 * Heuristic calibration from the user's own exact counts.
 *
 * The chars-per-token heuristic is what lets everything run with no key and
 * no tokenizer, and its error is content-dependent: dense JSON tokenizes very
 * differently from prose. There is no honest way to fix that from transcripts
 * alone (the billed number includes content the transcript never sees). But
 * when someone runs `analyze --exact`, they fetch a true count for the exact
 * bytes the heuristic just estimated — the one clean comparison available.
 *
 * So that comparison is remembered, per model family, on this machine, and
 * applied to later estimates for the same family. Nothing is applied silently:
 * the profile carries the factor and the sample count, and the report prints
 * them. No exact count ever run means no calibration, and the numbers are
 * exactly what they were before.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./ledger.js";

interface FamilyRecord {
  exactSum: number;
  heuristicSum: number;
  samples: number;
}

export interface Calibration {
  /** Multiply heuristic estimates by this. 1 means uncalibrated. */
  factor: number;
  samples: number;
}

/** Anything outside this is a bad sample, not a calibration. */
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 2.0;

export function calibrationPath(): string {
  return join(dirname(statePath()), ".context-doctor-calibration.json");
}

/** "claude", "gpt", "gemini", … — coarse on purpose; tokenizers are per vendor. */
export function modelFamily(model?: string): string {
  const m = (model ?? "").toLowerCase();
  if (m.includes("claude")) return "claude";
  if (/gpt|^o\d/.test(m)) return "gpt";
  if (m.includes("gemini")) return "gemini";
  return m ? m.split(/[-_/]/)[0] : "unknown";
}

function readAll(): Record<string, FamilyRecord> {
  try {
    return JSON.parse(readFileSync(calibrationPath(), "utf8")) as Record<string, FamilyRecord>;
  } catch {
    return {};
  }
}

/** Remember one exact-vs-heuristic observation. Best-effort; never throws. */
export function recordCalibration(model: string | undefined, exactTokens: number, heuristicTokens: number): void {
  if (!(exactTokens > 0) || !(heuristicTokens > 0)) return;
  const ratio = exactTokens / heuristicTokens;
  if (ratio < MIN_FACTOR || ratio > MAX_FACTOR) return; // a broken sample must not poison the file
  try {
    const all = readAll();
    const key = modelFamily(model);
    const rec = all[key] ?? { exactSum: 0, heuristicSum: 0, samples: 0 };
    all[key] = { exactSum: rec.exactSum + exactTokens, heuristicSum: rec.heuristicSum + heuristicTokens, samples: rec.samples + 1 };
    mkdirSync(dirname(calibrationPath()), { recursive: true });
    writeFileSync(calibrationPath(), JSON.stringify(all, null, 2));
  } catch {
    /* calibration is a refinement; failing to save it must not fail the command */
  }
}

/** The factor to apply for a model, or 1 with zero samples when there is none. */
export function calibrationFor(model?: string): Calibration {
  if (process.env.CONTEXT_DOCTOR_NO_CALIBRATION) return { factor: 1, samples: 0 };
  const rec = readAll()[modelFamily(model)];
  if (!rec || rec.samples < 1 || rec.heuristicSum <= 0) return { factor: 1, samples: 0 };
  const factor = rec.exactSum / rec.heuristicSum;
  if (!Number.isFinite(factor) || factor < MIN_FACTOR || factor > MAX_FACTOR) return { factor: 1, samples: 0 };
  return { factor, samples: rec.samples };
}
