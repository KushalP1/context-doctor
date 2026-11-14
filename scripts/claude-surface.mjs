#!/usr/bin/env node
// What a Claude Code release lets a user (or context-doctor) change, as a list
// to review instead of a 10,000-line CHANGELOG: the environment variables it
// reads, the settings.json keys, the plugin.json keys, the hook events and the
// mod events, read from its binary and diffed against the reviewed list in
// docs/hosts-reviewed.json (ROADMAP E7). Read-only unless --write.
//
//   node scripts/claude-surface.mjs [--claude <binary>] [--reviewed <json>] [--changelog <url|file>]
//                                   [--summary <file>] [--write] [--json]
//
//   --claude      the binary (or its npm package's cli); default: the newest
//                 Claude Code here (the Desktop app's on macOS, else claude on PATH)
//   --reviewed    the reviewed list (default docs/hosts-reviewed.json)
//   --changelog   Claude Code's CHANGELOG: also lists the names its entries
//                 since the reviewed version mention (a knob can ship
//                 undocumented and be announced later, as
//                 CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES was: in the
//                 binary from 2.1.318, in the CHANGELOG at 2.1.323)
//   --summary     append the report as Markdown (GitHub's job summary)
//   --write       replace the reviewed list with this binary's surface (after review)
//
// Exit 0 with a report (new and removed names), also when something changed:
// it is a list to read, not a failure. 2 when the binary cannot be read or
// none of the surfaces can be found in it (the extractors need updating).
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The surfaces, in report order, with how each reads. */
export const KINDS = {
  env: "environment variables",
  settings: "settings.json keys",
  plugin: "plugin.json keys",
  hooks: "hook events",
  mods: "mod events",
};

/** The version a binary states (its build constants). */
export function versionOf(text) {
  return text.match(/PACKAGE_URL:"@anthropic-ai\/claude-code"[^}]{0,400}?VERSION:"([^"]+)"/)?.[1];
}

/**
 * Environment variables: every CLAUDE_*, ANTHROPIC_*, DISABLE_* and ENABLE_*
 * name (Claude Code's own; the binary bundles other libraries whose
 * constants share no such prefix), and any other UPPER_SNAKE name read as
 * `env.NAME` or `env["NAME"]`, except the bundled TypeScript's and Node's.
 * A few CLAUDE_* constants that are not variables come along; the list is
 * for a person to read.
 */
function envNames(text) {
  const out = new Set();
  // Only in JavaScript's own text (a quote, a property access, prose): the
  // bundled SQLite's compile options (ENABLE_FTS5...) sit between NUL bytes,
  // and a string table's entries behind length bytes.
  for (const m of text.matchAll(/(?<=["'`.,{(\[:=!|&?; \n])((?:CLAUDE|ANTHROPIC|DISABLE|ENABLE)_[A-Z0-9]+(?:_[A-Z0-9]+)*)(?=["'`.,:;)\]}=!|&?+\- \n<>])/g)) out.add(m[1]);
  for (const m of text.matchAll(/env(?:\.|\[["'`])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![\w$])/g)) {
    if (!/^(?:TSC|NODE|NPM|VSCODE_INSPECTOR|BUN|JSC)_/.test(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * The object literal opening at `text[start]` ("{"): where it closes and the
 * keys at its top level. Skips strings, template literals (and what their
 * ${} hold) and regular expressions. undefined if it does not close within
 * `limit` characters.
 */
function objectAt(text, start, limit = 2_000_000) {
  const keys = [];
  const stop = Math.min(text.length, start + limit);
  // Each open bracket, and for a template literal's ${, a "`" to return to.
  const stack = [];
  let prev = "";
  for (let i = start; i < stop; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const from = i;
      for (i++; i < stop && text[i] !== c; i++) if (text[i] === "\\") i++;
      if (stack.length === 1 && (prev === "{" || prev === ",") && text[i + 1] === ":") keys.push(text.slice(from + 1, i));
      prev = c;
      continue;
    }
    if (c === "`" || (c === "}" && stack.at(-1) === "${")) {
      if (c === "}") stack.pop();
      // Inside a template literal: up to its end, or into a ${...}.
      for (i++; i < stop; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === "`") break;
        if (text[i] === "$" && text[i + 1] === "{") { stack.push("${"); i++; break; }
      }
      prev = "`";
      continue;
    }
    if (c === "/" && prev !== "" && "(,=:[!&|?{};".includes(prev)) {
      // A regular expression: a slash where an operand starts.
      let cls = false;
      for (i++; i < stop && text[i] !== "\n"; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === "[") cls = true;
        else if (text[i] === "]") cls = false;
        else if (text[i] === "/" && !cls) break;
      }
      prev = "a";
      continue;
    }
    if (c === "{" || c === "(" || c === "[") stack.push(c);
    else if (c === "}" || c === ")" || c === "]") {
      stack.pop();
      if (!stack.length) return { end: i, keys };
    } else if (stack.length === 1 && stack[0] === "{" && (prev === "{" || prev === ",")) {
      const m = /^([$A-Za-z_][\w$]*)\s*:/.exec(text.slice(i, i + 200));
      if (m) {
        keys.push(m[1]);
        i += m[1].length - 1;
        prev = "a";
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
  }
  return undefined;
}

/**
 * settings.json's keys: the schema object whose first key is `$schema`,
 * described as "JSON Schema reference for Claude Code settings".
 */
function settingsKeys(text) {
  const at = text.search(/\{\$schema:\(\)=>[\w$]+\(\)\.optional\(\)\.describe\("JSON Schema reference for Claude Code settings"\)/);
  return new Set(at === -1 ? [] : objectAt(text, at)?.keys ?? []);
}

/**
 * plugin.json's keys: the manifest's shape, where each key is read lazily as
 * `key:()=>schema().shape.key` (the plugin, hooks, commands, agents, skills
 * schemas merged into one object).
 */
function pluginKeys(text) {
  const anchor = text.search(/displayName:\(\)=>[\w$]+\(\)\.shape\.displayName/);
  if (anchor === -1) return new Set();
  const start = text.lastIndexOf("{", anchor);
  const end = objectAt(text, start)?.end;
  if (end === undefined) return new Set();
  const body = text.slice(start, end + 1);
  return new Set([...body.matchAll(/[{,]([$A-Za-z_][\w$]*):\(\)=>[\w$]+\(\)(?:\.partial\(\))?\.shape\.\1(?![\w$])/g)].map((m) => m[1]));
}

/** The string elements of every array literal that holds all of `needles`. */
function stringArrays(text, needles, element) {
  const out = new Set();
  let at = -1;
  while ((at = text.indexOf(needles[0], at + 1)) !== -1) {
    const start = text.lastIndexOf("[", at);
    if (start === -1 || at - start > 5_000) continue;
    const end = text.indexOf("]", at);
    if (end === -1) continue;
    const body = text.slice(start + 1, end);
    if (!needles.every((n) => body.includes(n))) continue;
    // Only an array of strings (and spreads of other arrays) counts.
    const items = body.split(",").map((s) => s.trim());
    if (!items.every((s) => /^"[^"]*"$/.test(s) || /^\.\.\.[\w$]+$/.test(s))) continue;
    for (const s of items) if (s.startsWith('"') && element.test(s.slice(1, -1))) out.add(s.slice(1, -1));
  }
  return out;
}

/** Hook events: the longest list that names PreToolUse and SessionStart. */
function hookEvents(text) {
  return stringArrays(text, ['"PreToolUse"', '"SessionStart"', '"UserPromptSubmit"'], /^[A-Z][A-Za-z]+$/);
}

/**
 * Mod events: the list of event names (`session.measure`, `turn.step`...),
 * and the keys of the default-answer table that has one per event (it holds
 * the ui.* events the list leaves out).
 */
function modEvents(text) {
  const out = stringArrays(text, ['"session.measure"', '"turn.step"', '"tool.describe"'], /^[a-z]+\.[a-zA-Z]+$/);
  const at = text.search(/[{,]"tool\.call":\([\w$]*\)=>/);
  if (at !== -1) {
    for (const k of objectAt(text, text.lastIndexOf("{", at + 1))?.keys ?? []) if (/^[a-z]+\.[a-zA-Z]+$/.test(k)) out.add(k);
  }
  return out;
}

/** Everything one binary exposes, each list sorted. */
export function surfaceOf(text) {
  const sorted = (s) => [...s].sort();
  return {
    version: versionOf(text) ?? null,
    env: sorted(envNames(text)),
    settings: sorted(settingsKeys(text)),
    plugin: sorted(pluginKeys(text)),
    hooks: sorted(hookEvents(text)),
    mods: sorted(modEvents(text)),
  };
}

/** What `now` has that `reviewed` has not, and the reverse, per kind. */
export function diffSurfaces(reviewed, now) {
  const out = {};
  for (const kind of Object.keys(KINDS)) {
    const before = new Set(reviewed[kind] ?? []);
    const after = new Set(now[kind] ?? []);
    out[kind] = { added: [...after].filter((x) => !before.has(x)).sort(), removed: [...before].filter((x) => !after.has(x)).sort() };
  }
  return out;
}

const semver = (v) => (v ?? "").split(/[.-]/).map((n) => Number(n) || 0);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/**
 * The names the CHANGELOG's entries after `from` up to and including `to`
 * mention in backticks (env vars, settings and plugin keys, events), each
 * with the first version that mentions it, limited to names in `surface`.
 */
export function changelogMentions(changelog, from, to, surface) {
  const known = new Map();
  for (const kind of Object.keys(KINDS)) for (const name of surface[kind] ?? []) if (!known.has(name)) known.set(name, kind);
  const out = [];
  const seen = new Set();
  const sections = changelog.split(/^## /m).slice(1);
  for (const section of sections.reverse()) {
    const version = section.match(/^(\d+\.\d+\.\d+)/)?.[1];
    if (!version || !newer(version, from) || newer(version, to)) continue;
    for (const line of section.split("\n")) {
      // Only entries that add, remove or rename something: "Fixed X when `env`..." is not news about `env`.
      if (!/^\s*[-*]\s*(?:[\w ]+:\s*)?(?:Added|Removed|Deprecated|Renamed)\b/.test(line)) continue;
      for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const name = m[1].replace(/^([\w.$]+)\[.*$/, "$1").replace(/=.*$/, "");
        const kind = known.get(name);
        if (!kind || seen.has(name)) continue;
        seen.add(name);
        out.push({ version, kind, name, line: line.replace(/^[-*]\s*/, "").trim() });
      }
    }
  }
  return out;
}

/** The newest Claude Code installed here: the Desktop app's bundled one on macOS, else `claude` on PATH. */
function newestClaude() {
  const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  if (existsSync(root)) {
    const found = [];
    for (const v of readdirSync(root)) {
      let builds = [];
      try { builds = readdirSync(join(root, v)); } catch { continue; }
      for (const b of builds) {
        const bin = join(root, v, b, "claude.app", "Contents", "MacOS", "claude");
        if (existsSync(bin)) found.push({ v, bin, t: statSync(bin).mtimeMs });
      }
    }
    found.sort((a, b) => (newer(a.v, b.v) ? -1 : newer(b.v, a.v) ? 1 : b.t - a.t));
    if (found.length) return found[0].bin;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** The report, as Markdown (for a job summary) or plain text. */
export function formatReport({ reviewed, now, diff, mentions }, markdown) {
  const lines = [];
  const h = (s) => lines.push(markdown ? `### ${s}` : `== ${s}`);
  h(`Claude Code's surface: ${now.version ?? "unknown version"} against the reviewed ${reviewed.version ?? "list"}`);
  let any = false;
  for (const [kind, label] of Object.entries(KINDS)) {
    const { added, removed } = diff[kind];
    const total = (now[kind] ?? []).length;
    if (!added.length && !removed.length) {
      lines.push(`${markdown ? "- " : ""}${label}: no change (${total})`);
      continue;
    }
    any = true;
    lines.push(`${markdown ? "- " : ""}${label}: ${added.length} new, ${removed.length} removed (${total})`);
    for (const n of added) lines.push(`${markdown ? "  - " : "    + "}${markdown ? `new: \`${n}\`` : n}`);
    for (const n of removed) lines.push(`${markdown ? "  - " : "    - "}${markdown ? `removed: \`${n}\`` : n}`);
  }
  if (mentions?.length) {
    lines.push("");
    h(`Named in the CHANGELOG since ${reviewed.version}`);
    for (const m of mentions) {
      const where = diff[m.kind].added.includes(m.name) ? "new in this binary" : "already in the reviewed binary";
      lines.push(`${markdown ? "- " : "  "}${m.version} ${markdown ? `\`${m.name}\`` : m.name} (${KINDS[m.kind]}, ${where}): ${m.line.length > 200 ? `${m.line.slice(0, 197)}...` : m.line}`);
    }
  }
  if (!any && !mentions?.length) lines.push(markdown ? "\nNothing new to review." : "Nothing new to review.");
  else lines.push(markdown ? "\nAfter review: `node scripts/claude-surface.mjs --claude <binary> --write`, and commit docs/hosts-reviewed.json." : "After review: node scripts/claude-surface.mjs --claude <binary> --write, then commit docs/hosts-reviewed.json.");
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const opt = { reviewed: join(repo, "docs", "hosts-reviewed.json") };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--write" || a === "--json") { opt[a.slice(2)] = true; continue; }
    if (["--claude", "--reviewed", "--changelog", "--summary"].includes(a) && args[i + 1]) { opt[a.slice(2)] = args[++i]; continue; }
    console.error(`usage: claude-surface.mjs [--claude <binary>] [--reviewed <json>] [--changelog <url|file>] [--summary <file>] [--write] [--json]  (got ${a})`);
    process.exit(2);
  }
  const bin = opt.claude ?? newestClaude();
  if (!bin) {
    console.error("✗ no Claude Code found: pass --claude <binary>");
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(realpathSync(bin)).toString("latin1");
  } catch (e) {
    console.error(`✗ ${bin}: could not read it (${e.message})`);
    process.exit(2);
  }
  const now = surfaceOf(text);
  const empty = Object.keys(KINDS).filter((k) => !now[k].length);
  if (empty.length) {
    // A surface that reads as empty is an extractor that no longer fits the binary, not a removal.
    console.error(`✗ ${bin}: found no ${empty.map((k) => KINDS[k]).join(", ")} in it (scripts/claude-surface.mjs needs updating for ${now.version ?? "this version"})`);
    process.exit(2);
  }
  if (opt.write) {
    writeFileSync(opt.reviewed, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`✓ ${opt.reviewed}: Claude Code ${now.version}'s surface (${Object.keys(KINDS).map((k) => `${now[k].length} ${KINDS[k]}`).join(", ")})`);
    return;
  }
  let reviewed;
  try {
    reviewed = JSON.parse(readFileSync(opt.reviewed, "utf8"));
  } catch (e) {
    console.error(`✗ ${opt.reviewed}: could not read the reviewed list (${e.message}); make one with --write`);
    process.exit(2);
  }
  const diff = diffSurfaces(reviewed, now);
  let mentions;
  if (opt.changelog) {
    try {
      let log;
      if (/^https?:\/\//.test(opt.changelog)) {
        const res = await fetch(opt.changelog, { headers: { "user-agent": "context-doctor-surface-check" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log = await res.text();
      } else log = readFileSync(opt.changelog, "utf8");
      mentions = changelogMentions(log, reviewed.version ?? "0", now.version ?? "999", now);
    } catch (e) {
      console.log(`::warning title=claude-surface::${opt.changelog} could not be read (${e.message}); the binary's diff only`);
    }
  }
  if (opt.json) console.log(JSON.stringify({ reviewed: reviewed.version, version: now.version, diff, mentions: mentions ?? null }, null, 2));
  else console.log(formatReport({ reviewed, now, diff, mentions }, false));
  if (opt.summary) appendFileSync(opt.summary, `${formatReport({ reviewed, now, diff, mentions }, true)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
