/**
 * An organization's contracted rates: Claude Code's `modelPricing` setting,
 * which it reads from managed (policy) settings only and applies to every
 * spend figure it reports (/cost, the status line, `total_cost_usd`).
 * Where it is set, context-doctor prices Claude requests at the same rates,
 * so its dollars match Claude Code's and the organization's bill.
 *
 * Read from the 2.1.321 binary and the settings reference
 * (code.claude.com/docs/en/settings-reference#modelpricing, read 2026-11-10):
 *  - `multiplier`: a number greater than 0 and at most 10, applied to every
 *    cost Claude Code computes, a row's included. Anything else is ignored.
 *  - `overrides`: model id to `{ input, output, cacheRead, cacheWrite }`, USD
 *    per million tokens, all four required, each 0 to 10000; a row missing
 *    one is ignored. `cacheWrite` prices 5-minute and 1-hour writes alike. A
 *    row is charged as written: no fast-mode or US-only surcharge, no
 *    long-prompt tier. Web searches keep their list fee.
 *  - A key that spells a Claude model (`claude-sonnet-4-6`, its Bedrock or
 *    Vertex id) covers every dated and provider spelling of that model; any
 *    other key (a gateway alias) only its exact id, which wins over a
 *    model's row.
 *  - Managed sources only: user, project and local settings never set it.
 *    Here, the managed settings files (effective.ts managedSettingsPaths:
 *    managed-settings.json, then managed-settings.d/*.json in alphabetical
 *    order, nested blocks merged key by key). MDM profiles and
 *    server-managed settings are not read.
 */

import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { claudeDir } from "./claudedir.js";
import { managedSettingsPaths } from "./effective.js";
import type { ModelPricing } from "./pricing.js";

export interface OrgRates {
  /** Scales every Claude cost, a row's included (1 when unset). */
  multiplier: number;
  /** Rows by their exact key, lowercased. */
  exact: Map<string, ModelPricing>;
  /** Rows keyed by a Claude model, by that model's canonical id. */
  models: Map<string, ModelPricing>;
  /** The files that set it. */
  sources: string[];
  /** Fingerprint of the rates in force: cached dollars priced under other rates are stale. */
  key: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Nested blocks merged key by key, the later value winning (Claude Code's rule for managed-settings.d). */
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "__proto__" || k === "constructor") continue;
    out[k] = isObject(v) && isObject(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/**
 * One Claude model, however a provider spells it: "claude-sonnet-4-6" for
 * claude-sonnet-4-6-20260101, claude-sonnet-4-6[1m],
 * us.anthropic.claude-sonnet-4-6-v1:0 and claude-sonnet-4-6@20260101.
 * Undefined for an id that is not a Claude model's.
 */
export function canonicalClaude(id: string): string | undefined {
  let m = id.trim().toLowerCase().replace(/\[1m\]$/, "");
  m = m.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "").replace(/(?:@|-)\d{8}$/, "");
  return /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m) ? m : undefined;
}

/** A row as Claude Code accepts it, or undefined (all four rates, each 0 to 10000). */
function rowOf(v: unknown): ModelPricing | undefined {
  if (!isObject(v)) return undefined;
  const r = [v.input, v.output, v.cacheRead, v.cacheWrite];
  if (!r.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 10_000)) return undefined;
  const [inputPerM, outputPerM, cacheReadPerM, cacheWritePerM] = r as number[];
  return { inputPerM, outputPerM, cacheReadPerM, cacheWritePerM };
}

/** `modelPricing` from merged managed settings, as Claude Code keeps it; undefined when it changes nothing. */
export function parseOrgRates(value: unknown, sources: string[] = []): OrgRates | undefined {
  if (!isObject(value)) return undefined;
  const mult = value.multiplier;
  const multiplier = typeof mult === "number" && Number.isFinite(mult) && mult > 0 && mult <= 10 ? mult : 1;
  const exact = new Map<string, ModelPricing>();
  const models = new Map<string, ModelPricing>();
  if (isObject(value.overrides)) {
    for (const [k, v] of Object.entries(value.overrides)) {
      const row = rowOf(v);
      const key = k.trim().toLowerCase().replace(/\[1m\]$/, "");
      // The first row of a key, or of a model, is the one used (Claude Code warns of the later one).
      if (!row || !key || exact.has(key)) continue;
      exact.set(key, row);
      const model = canonicalClaude(key);
      if (model && !models.has(model)) models.set(model, row);
    }
  }
  if (exact.size === 0 && multiplier === 1) return undefined;
  const key = JSON.stringify([multiplier, [...exact].map(([k, r]) => [k, r.inputPerM, r.outputPerM, r.cacheReadPerM, r.cacheWritePerM])]);
  return { multiplier, exact, models, sources, key };
}

/** The merged `modelPricing` of the managed settings files, and which files set it. */
export function readOrgRates(env: NodeJS.ProcessEnv = process.env): OrgRates | undefined {
  return readOrgRatesFrom(managedSettingsPaths(env));
}

/** The merged `modelPricing` of `paths`, in order (the base file, then the drop-ins). */
export function readOrgRatesFrom(paths: string[]): OrgRates | undefined {
  let merged: Record<string, unknown> = {};
  const sources: string[] = [];
  for (const path of paths) {
    if (basename(path).startsWith(".")) continue; // Claude Code skips hidden drop-ins
    let data: unknown;
    try { data = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")); } catch { continue; /* absent or unreadable */ }
    if (!isObject(data) || data.modelPricing === undefined) continue;
    sources.push(path);
    merged = merge(merged, { modelPricing: data.modelPricing });
  }
  return parseOrgRates(merged.modelPricing, sources);
}

let cache: { env: string; rates: OrgRates | undefined } | undefined;

/**
 * The organization's rates in force, read once per process (and again when
 * the variables that move the managed files change). The hook's cost: a
 * stat of the managed folder and its drop-in folder, once.
 */
export function orgRates(env: NodeJS.ProcessEnv = process.env): OrgRates | undefined {
  const k = `${env.CONTEXT_DOCTOR_NO_MANAGED_SETTINGS ?? ""}\u0000${env.CLAUDE_CODE_MANAGED_SETTINGS_PATH ?? ""}`;
  if (cache?.env !== k) cache = { env: k, rates: readOrgRates(env) };
  return cache.rates;
}

/** Forget what orgRates read (tests that rewrite a managed file in place). */
export function resetOrgRates(): void {
  cache = undefined;
}

/** The row that prices `model`: its exact key first, then its Claude model's. */
export function orgRowFor(rates: OrgRates, model: string): ModelPricing | undefined {
  const exact = rates.exact.get(model.trim().toLowerCase().replace(/\[1m\]$/, ""));
  if (exact) return exact;
  const canon = canonicalClaude(model);
  return canon ? rates.models.get(canon) : undefined;
}

/** Whether the organization's rates reach `model`: a row of its own, or a Claude model under the multiplier. */
export function orgApplies(rates: OrgRates | undefined, model: string | undefined): boolean {
  if (!rates || !model) return false;
  return orgRowFor(rates, model) !== undefined || (rates.multiplier !== 1 && /claude/i.test(model));
}

/**
 * How a report's dollars were priced, for its heading: "at list prices", or
 * "at your organization's rates" where managed settings set `modelPricing`
 * (Claude models at those rates, any other provider's at list).
 */
export function priceBasis(plural = true, env: NodeJS.ProcessEnv = process.env): string {
  return orgRates(env) ? "at your organization's rates" : plural ? "at list prices" : "at list price";
}

/**
 * The line a report adds where the organization's rates are in force:
 * which files set them and what they are. Undefined at list prices.
 */
export function orgRatesLine(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const r = orgRates(env);
  if (!r) return undefined;
  const keys = [...r.exact.keys()];
  const parts = [
    ...(r.multiplier !== 1 ? [`multiplier ${r.multiplier}`] : []),
    ...(keys.length ? [`${keys.length === 1 ? "a row" : `${keys.length} rows`} for ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? " and others" : ""}`] : []),
  ];
  return `Claude requests priced at your organization's rates (Claude Code's managed modelPricing: ${parts.join("; ")}; in ${r.sources.map((s) => basename(s)).join(", ")}), as Claude Code's own cost figures are; other providers at list prices.`;
}

/**
 * The managed sources Claude Code reads before the managed settings files,
 * found on this machine. Read from the 2.1.321 binary: the policy origin is
 * server-managed settings when present, else an MDM profile (a macOS
 * managed-preferences plist, the Windows HKLM policy key), else the files,
 * and by default only the first source found counts ("first-wins"): with
 * either of the others present, Claude Code prices at their modelPricing,
 * or at list, never at the files'. context-doctor reads neither (the
 * server-managed copy, `remote-settings.json` in Claude Code's folder, is an
 * undocumented, signed cache); this only says that one is there. The
 * Windows key is not looked up (it needs reg.exe).
 */
export function managedSourcesAhead(env: NodeJS.ProcessEnv = process.env, home?: string, prefs = "/Library/Managed Preferences"): string[] {
  if (env.CONTEXT_DOCTOR_NO_MANAGED_SETTINGS) return [];
  const out: string[] = [];
  try {
    const remote = join(claudeDir(home, env), "remote-settings.json");
    if (existsSync(remote)) out.push(`server-managed settings (Claude Code's copy: ${remote})`);
  } catch { /* no config folder */ }
  if (process.platform === "darwin") {
    let user = "";
    try { user = userInfo().username; } catch { /* none */ }
    for (const p of [...(user ? [join(prefs, user, "com.anthropic.claudecode.plist")] : []), join(prefs, "com.anthropic.claudecode.plist")]) {
      if (existsSync(p)) { out.push(`an MDM profile (${p})`); break; }
    }
  }
  return out;
}

/**
 * The line a report adds when Claude Code may take its rates from a source
 * context-doctor does not read: undefined when none is on this machine.
 */
export function managedSourcesLine(env: NodeJS.ProcessEnv = process.env, home?: string, prefs?: string): string | undefined {
  const ahead = managedSourcesAhead(env, home, prefs);
  if (!ahead.length) return undefined;
  return `Claude Code takes its managed settings from ${ahead.join(" and ")} before the managed settings files, and only from the first it finds: its own cost figures may use contracted rates (modelPricing) set there, which context-doctor does not read; these reports price ${orgRates(env) ? "at the files' rates" : "at list rates"}.`;
}
