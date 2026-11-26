/**
 * The models a source names, to check each has a price of its own. Claude's
 * below; OpenAI's and Google's price pages, Codex's model catalog and Gemini
 * CLI's model list after them (openaiPageIds...), and the table's own dated
 * rows (datedRows, dueRows). All read by scripts/check-models.mjs.
 *
 * The Claude models a text names, to check each has a price of its own
 * (pricing.ts hasKnownPrice) before a user runs it: Claude Code ships a
 * model days before a context-doctor release (2.1.322 made Fable 5.2 the
 * default the day its price changed), and an id the table does not know is
 * priced by its family's row, an estimate that was five times too high on
 * Fable 5.2's cache reads. Read from Claude Code's binary (its model
 * catalog), its CHANGELOG and the price page by scripts/check-models.mjs.
 *
 * Three spellings: Bedrock ids (`anthropic.claude-opus-5-5`,
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0`), the catalog's cleanest
 * list; first-party ids of the current naming (`claude-fable-5-2`); and
 * display names (`Claude Fable 5.2`), which is how the price page names
 * them. First-party and display names of the known families count from
 * major version 4 (the naming the table keys on): older aliases Claude Code
 * still accepts (`claude-haiku-3-5`, `claude-sonnet-3-7`) are not ids
 * anything bills. A family the table does not know counts from version 1.
 */

import { hasKnownPrice } from "./pricing.js";

/** The families the table keys on: their ids and names count from major version 4. */
const FAMILY = "opus|sonnet|haiku|fable|mythos";
/**
 * Words that follow "claude-" or "Claude " with a number and are not a model
 * family: products, plans, apps, test ids (`claude-eval-9` is in the 2.1.321
 * binary). Any other word with a version is a model, a family new to the
 * table included: Fable and Mythos were new families once, and an id of a
 * family the table does not know has no price at all, not even a family's.
 */
const NOT_A_FAMILY = new Set(["code", "eval", "agent", "agents", "desktop", "app", "apps", "api", "cli", "sdk", "tag", "chrome", "max", "pro", "team", "enterprise", "gov", "console", "platform", "models", "cowork", "design", "for", "in", "on", "and", "is", "the"]);
const family = (word: string, major: string): boolean => {
  const f = word.toLowerCase();
  if (new RegExp(`^(?:${FAMILY})$`).test(f)) return Number(major) >= 4;
  return !NOT_A_FAMILY.has(f) && Number(major) >= 1;
};

/** Ids that have no price on purpose, with the reason. */
export const UNPRICED_ON_PURPOSE: Record<string, string> = {
  "claude-mythos-preview": "no list price on the page; priced by the Fable/Mythos family row as an estimate",
  // Gemini CLI names these (packages/core/src/config/models.ts, read
  // 2026-11-14); Google's price page does not, so there is no price to copy.
  "gemini-3-pro-preview": "Gemini CLI's preview model, not on Google's price page (2026-11-14); the 3.x Pro fallback prices it at 3.1 Pro's rates, an estimate",
  "gemini-3.5-flash": "Gemini CLI's base Flash, not on Google's price page (2026-11-14; Gemini CLI rewrites it to gemini-3.8-flash once that is GA); the 3.x Flash fallback prices it at 3.8 Flash's rates, an estimate",
};

/** The model a Bedrock id names, as a first-party id: region prefix, `-v1:0` and the date dropped. */
function fromBedrock(id: string): string {
  return id.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "").replace(/-\d{8}$/, "");
}

/** Every Claude model id `text` names, each once, sorted. */
export function claudeModelIds(text: string): string[] {
  const out = new Set<string>();
  // A model's Bedrock id has a version number (com.anthropic.claude-code, an app id, has none).
  for (const m of text.matchAll(/(?<![\w.-])(?:(?:us|eu|apac|global|au|jp|ca|us-gov)\.)?anthropic\.(claude-[a-z0-9-]*?\d[a-z0-9-]*?)(?:-v\d+(?::\d+)?)?(?![\w.-]*\w)/g)) out.add(fromBedrock(m[1]));
  for (const m of text.matchAll(/(?<![\w.-])claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?![\w-])/g)) {
    if (!family(m[1], m[2])) continue;
    out.add(`claude-${m[1]}-${m[2]}${m[3] && m[3] !== "0" ? `-${m[3]}` : ""}`);
  }
  for (const m of text.matchAll(/\bClaude ([A-Z][a-z]+) (\d{1,2})(?:\.(\d{1,2}))?(?![\w.]*\d)/g)) {
    if (!family(m[1], m[2])) continue;
    out.add(`claude-${m[1].toLowerCase()}-${m[2]}${m[3] && m[3] !== "0" ? `-${m[3]}` : ""}`);
  }
  return [...out].sort();
}

/** The Claude models `text` names that have no price of their own and no reason to lack one. */
export function unpricedClaudeIds(text: string): string[] {
  return unpriced(claudeModelIds(text));
}

/** The ids in `ids` that have no price of their own and no reason to lack one. */
export function unpriced(ids: string[]): string[] {
  return ids.filter((id) => !hasKnownPrice(id) && !(id in UNPRICED_ON_PURPOSE));
}

/**
 * Models priced per image, per minute or per character, or not by the token
 * at all (embeddings, moderation), and Google's endpoints that are not
 * models a coding agent runs (video, music, world generation, robots, the Decisions API, Gemma
 * on the free tier only): the table has no row for them on purpose
 * (pricing.ts header). Matched anywhere in the id.
 */
const NOT_A_TEXT_MODEL = /image|realtime|audio|tts|transcribe|whisper|translate|(?:^|-)live(?:-|$)|embedding|moderation|omni|robotics|decision|lyria|veo|imagen|gemma|nano-banana|sora|genie/i;

/**
 * The models OpenAI's price page (developers.openai.com/api/docs/pricing,
 * its .md) lists in its text tables: each table row's model cell (the first,
 * or the second where the first is a category), the context-length notes
 * dropped. Tables with a Modality or Use case column (images, audio,
 * transcription) and the tools table are not models priced by the token.
 */
export function openaiPageIds(markdown: string): string[] {
  const out = new Set<string>();
  let header: string[] | undefined;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) {
      header = undefined;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    if (header.includes("modality") || header.includes("use case") || header[0] === "tool") continue;
    const at = header.indexOf("model");
    if (at === -1) continue;
    const name = cells[at]?.replace(/\s*\(.*\)\s*$/, "").replace(/<[^>]*>/g, "").trim();
    if (name && /^[a-z][a-z0-9.-]*$/.test(name) && !NOT_A_TEXT_MODEL.test(name)) out.add(name);
  }
  return [...out].sort();
}

/** One model's per-1M rates as OpenAI's price page states them: short context, and the long tier where it has one. */
export interface PagePrice {
  model: string;
  short: { input: number; output: number; cached?: number };
  long?: { input: number; output: number; cached?: number };
}

/**
 * The prices in OpenAI's price page's Standard tables (not Batch, Flex, Fast
 * or Ultrafast): the main table's "Short context …" and "Long context …"
 * columns, and the specialized tables' "(short context)" / "(long context)"
 * row pairs. A "-" cell is no price (no cached rate, or no long tier). So
 * the weekly check can compare what we charge with what the page says, not
 * only that a model has some price.
 */
export function openaiPagePrices(markdown: string): PagePrice[] {
  const out = new Map<string, PagePrice>();
  const usd = (c: string | undefined): number | undefined => {
    const m = c?.match(/^\$([0-9]+(?:\.[0-9]+)?)$/);
    return m ? Number(m[1]) : undefined;
  };
  let speed = "";
  let header: string[] | undefined;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^(Standard|Batch|Flex|Fast|Ultrafast|Priority)$/.test(line)) speed = line;
    if (!line.startsWith("|")) {
      header = undefined;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (speed !== "Standard" || cells.every((c) => /^-+$/.test(c))) continue;
    // A Training column is fine-tuning's table: the price of a fine-tuned model, not the model's own.
    if (header.includes("modality") || header.includes("use case") || header.includes("training") || header[0] === "tool") continue;
    const at = header.indexOf("model");
    if (at === -1) continue;
    const cell = (cells[at] ?? "").replace(/<[^>]*>/g, "").trim();
    const name = cell.replace(/\s*\(.*\)\s*$/, "").trim();
    if (!/^[a-z][a-z0-9.-]*$/.test(name) || NOT_A_TEXT_MODEL.test(name)) continue;
    const col = (h: string) => usd(cells[header!.indexOf(h)]);
    const tier = (prefix: string) => {
      const input = col(`${prefix}input`), output = col(`${prefix}output`);
      if (input === undefined || output === undefined) return undefined;
      const cached = col(`${prefix}cached input`);
      return { input, output, ...(cached !== undefined ? { cached } : {}) };
    };
    const entry: PagePrice = out.get(name) ?? { model: name, short: undefined as unknown as PagePrice["short"] };
    if (header.includes("short context input")) {
      const short = tier("short context "), long = tier("long context ");
      if (!short) continue;
      entry.short = short;
      if (long) entry.long = long;
    } else {
      const t = tier("");
      if (!t) continue;
      if (/\(long context\)/i.test(cell)) entry.long = t;
      else entry.short = t;
    }
    out.set(name, entry);
  }
  return [...out.values()].filter((e) => e.short).sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * The prices in Anthropic's price page's model table (platform.claude.com
 * pricing.md, "Model | Base input tokens | … | Cache hits and refreshes |
 * Output tokens"): each "Claude Opus 5.5" row as `claude-opus-5-5`, notes in
 * parentheses and footnote marks dropped. A model priced in two rows by
 * prompt size (Haiku 5.5's "for prompts over 100,000 tokens") gets the
 * second as its long tier. Cache writes are not read: they are 1.25x and 2x
 * input by rule, which pricing.ts applies.
 */
export function anthropicPagePrices(markdown: string): PagePrice[] {
  const out = new Map<string, PagePrice>();
  const usd = (c: string | undefined): number | undefined => {
    const m = c?.replace(/<sup>.*?<\/sup>/g, "").match(/^\$([0-9]+(?:\.[0-9]+)?) \/ MTok$/);
    return m ? Number(m[1]) : undefined;
  };
  let header: string[] | undefined;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      header = undefined;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    const [m, i, o, h] = ["model", "base input tokens", "output tokens", "cache hits and refreshes"].map((k) => header!.indexOf(k));
    if (m === -1 || i === -1 || o === -1 || h === -1) continue;
    const cell = cells[m] ?? "";
    const name = cell.replace(/\s*\(.*\)\s*$/, "").trim();
    if (!/^Claude [A-Za-z]+ [0-9.]+$/.test(name)) continue;
    const id = "claude-" + name.slice(7).toLowerCase().replace(/[ .]/g, "-");
    const input = usd(cells[i]), output = usd(cells[o]), cached = usd(cells[h]);
    if (input === undefined || output === undefined) continue;
    const tier = { input, output, ...(cached !== undefined ? { cached } : {}) };
    const prev = out.get(id);
    if (prev && /prompts over/i.test(cell)) prev.long = tier;
    else if (!prev) out.set(id, { model: id, short: tier });
  }
  return [...out.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * The prices in Google's price page (ai.google.dev/gemini-api/docs/pricing,
 * its .md.txt): in each model's section, the Standard tab's paid-tier cells
 * for input, output and context caching. A cell's first price is today's
 * (a later "$4.00 starting December 1" line is the dated row's `then`, which
 * the dated check covers); "prompts <= 200k" / "prompts > 200k" lines split
 * a short and a long tier; per-hour storage lines and audio rates after a
 * text rate are not read. A section whose cells do not read this way is
 * left out rather than guessed.
 */
export function googlePagePrices(markdown: string): PagePrice[] {
  const out: PagePrice[] = [];
  const sections = markdown.split(/^## /m).slice(1);
  for (const sec of sections) {
    const id = sec.match(/\{% id="([a-z0-9.-]+)" %\}/)?.[1];
    if (!id || !/^gemini-/.test(id) || NOT_A_TEXT_MODEL.test(id)) continue;
    // The Standard tab when the section has tabs, else its first table.
    const std = sec.indexOf('{% tab title="Standard" %}');
    const body = std === -1 ? sec : sec.slice(std, sec.indexOf("{% /tab %}", std) >>> 0 || undefined);
    const rows = body.split(/^\s*---\s*$/m);
    const cellOf = (label: RegExp): string | undefined => {
      const row = rows.find((r) => label.test(r.split("\n").find((l) => /^\s*\*\s/.test(l)) ?? ""));
      if (!row) return undefined;
      const bullets = row.split(/^\s*\*\s/m).slice(1);
      return bullets[2];
    };
    const tiers = (cell: string | undefined) => {
      if (!cell) return undefined;
      let short: number | undefined, long: number | undefined;
      for (const line of cell.split("\n")) {
        const m = line.trim().match(/^\$([0-9]+(?:\.[0-9]+)?)\b(.*)$/);
        if (!m || /starting|per hour|storage/i.test(m[2])) continue;
        const v = Number(m[1]);
        if (/prompts\s*>\s*\d/i.test(m[2])) long ??= v;
        else short ??= v;
      }
      return short === undefined ? undefined : { short, long };
    };
    const i = tiers(cellOf(/Input price/)), o = tiers(cellOf(/Output price/)), c = tiers(cellOf(/Context caching price/));
    if (!i || !o) continue;
    const entry: PagePrice = { model: id, short: { input: i.short, output: o.short, ...(c ? { cached: c.short } : {}) } };
    if (i.long !== undefined && o.long !== undefined) entry.long = { input: i.long, output: o.long, ...(c?.long !== undefined ? { cached: c.long } : {}) };
    out.push(entry);
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * The models Google's price page (ai.google.dev/gemini-api/docs/pricing, its
 * .md.txt) prices: each section's model id line (`*[\`gemini-4-argon\`](...)*`),
 * the text models only.
 */
export function googlePageIds(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/^\s*\*\[`([a-z][a-z0-9.-]*)`\]/gm)) if (!NOT_A_TEXT_MODEL.test(m[1])) out.add(m[1]);
  return [...out].sort();
}

/**
 * The models Claude Code's signed model catalog offers
 * (downloads.claude.ai/model-catalog/v1/catalog.json, read from 2.1.331 on;
 * `modelCatalogUrl` can point elsewhere): every
 * `surfaces.<surface>.model_selector_config[].models[].id`, across the
 * terminal (`cc`), the Desktop app's Code tab (`ccd`) and the rest. It
 * changes between Claude Code releases (version 5883 was issued 2026-11-24
 * and expires a week later), so a model can reach the picker before any
 * binary or CHANGELOG names it. `about` says which catalog was read.
 * Throws on a catalog in another shape.
 */
export function catalogModelIds(json: string): { ids: string[]; about: string } {
  const catalog = JSON.parse(json);
  const surfaces = catalog?.surfaces;
  if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces)) throw new Error("no surfaces object");
  const out = new Set<string>();
  for (const surface of Object.values(surfaces) as any[]) {
    const configs = surface?.model_selector_config;
    if (!Array.isArray(configs)) continue;
    for (const config of configs) {
      if (!Array.isArray(config?.models)) continue;
      for (const m of config.models) if (typeof m?.id === "string" && m.id) out.add(m.id);
    }
  }
  const version = catalog.version !== undefined ? `version ${catalog.version}` : "no version";
  const dates = [catalog.issued_at && `issued ${String(catalog.issued_at).slice(0, 10)}`, catalog.expires_at && `expires ${String(catalog.expires_at).slice(0, 10)}`].filter(Boolean).join(", ");
  return { ids: [...out].sort(), about: `catalog ${version}${dates ? `, ${dates}` : ""}; surfaces ${Object.keys(surfaces).join(", ")}` };
}

/**
 * The models Codex offers (its models catalog, codex-rs/models-manager/
 * models.json): `listed` are the ones its picker shows, `hidden` the rest
 * (internal and trusted-access ids, which the price page may not name).
 */
export function codexModelIds(json: string): { listed: string[]; hidden: string[] } {
  const models: Array<{ slug?: unknown; visibility?: unknown }> = JSON.parse(json).models ?? [];
  const listed = new Set<string>();
  const hidden = new Set<string>();
  for (const m of models) if (typeof m.slug === "string") (m.visibility === "list" ? listed : hidden).add(m.slug);
  return { listed: [...listed].sort(), hidden: [...hidden].sort() };
}

/**
 * The Gemini models Gemini CLI names (packages/core/src/config/models.ts):
 * every quoted full model id (a version and a Pro/Flash/Flash-Lite name),
 * not family prefixes like 'gemini-3' or the embedding model.
 */
export function geminiCliIds(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/['"`](gemini-\d[\d.]*-(?:pro|flash)[a-z0-9.-]*)['"`]/g)) if (!NOT_A_TEXT_MODEL.test(m[1])) out.add(m[1]);
  return [...out].sort();
}

/** One way of naming a pricing.ts row, as a model id the row prices. */
function rowId(line: string): string | undefined {
  const named = /\[(?:openai|gemini)\("([^"]+)"\)/.exec(line);
  if (named) return named[1];
  const c = /\[claude\("([a-z]+)[^"]*",\s*(\d+)(?:,\s*(\d+))?\)/.exec(line);
  return c ? `claude-${c[1]}-${c[2]}${c[3] ? `-${c[3]}` : ""}` : undefined;
}

/** A dated pricing.ts row: the model it prices, the day its price changes, and whether the page gave what follows. */
export interface DatedRow {
  id: string;
  changes: string;
  successor: boolean;
}

/**
 * The rows of pricing.ts's table (its source, `src/pricing.ts`) whose price
 * ends on a known day (`changes`), each with whether the page said what
 * follows (`then`, or `routes`: billed as another model from that day).
 * Throws on a dated row it cannot name, so the check cannot pass by missing one.
 */
export function datedRows(pricingSource: string): DatedRow[] {
  const out: DatedRow[] = [];
  for (const line of pricingSource.split("\n")) {
    const day = /\bchanges:\s*"(\d{4}-\d{2}-\d{2})"/.exec(line);
    if (!day || /^\s*(?:\/\/|\*)/.test(line)) continue;
    const id = rowId(line);
    if (!id) throw new Error(`a dated row with no model name this check can read: ${line.trim()}`);
    out.push({ id, changes: day[1], successor: /\bthen:|\broutes:/.test(line) });
  }
  return out;
}

/**
 * The dated rows with no successor price whose last day at that price (the
 * day before `changes`) is at most `days` days after `today`, or already
 * past: from then, every install prices that model as an estimate, so the
 * page needs reading again (and the successor price adding, once published).
 */
export function dueRows(rows: DatedRow[], today: string, days = 14): Array<DatedRow & { daysLeft: number }> {
  const t = Date.parse(`${today}T00:00:00Z`);
  return rows
    .filter((r) => !r.successor)
    .map((r) => ({ ...r, daysLeft: Math.round((Date.parse(`${r.changes}T00:00:00Z`) - 864e5 - t) / 864e5) }))
    .filter((r) => r.daysLeft <= days);
}
