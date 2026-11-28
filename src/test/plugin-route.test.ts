/**
 * E1: on a Claude Code that runs mods (2.1.286+), `install` switches the
 * plugin on in ~/.claude/settings.json (extraKnownMarketplaces,
 * enabledPlugins) instead of wiring its own MCP server, skill and hooks;
 * an older Claude Code anywhere on the machine keeps install's own wiring.
 * Every round trip gives every file back byte for byte; at no step is the
 * same piece wired twice; doctor says which route is active and whether the
 * mod records.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
import { MOD_SINCE, modReadiness, isGlobalInstall, isOurDeclaration, pluginVersionDrift } from "../claudeplugin.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

const NEW = "2.1.321";
const OLD = "2.1.62";

function run(home: string, args: string[], versions: string | null = NEW, extra: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  const env: NodeJS.ProcessEnv = { ...sandboxEnv(home), CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1", ...extra };
  if (versions === null) delete env.CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS;
  else env.CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS = versions;
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env, timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout, err: stderr })
    );
  });
}

interface Home { home: string; settings: string; claudeJson: string; marker: string; skill: string }

/** A home with Claude Code (its ~/.claude.json) and, when given, the user's own settings.json text. */
function home(settingsText?: string): Home {
  const h = mkdtempSync(join(tmpdir(), "ctxdoc-e1-"));
  mkdirSync(join(h, ".claude"), { recursive: true });
  const claudeJson = join(h, ".claude.json");
  writeFileSync(claudeJson, '{\n  "numStartups": 7,\n  "projects": {}\n}\n');
  const settings = join(h, ".claude", "settings.json");
  if (settingsText !== undefined) writeFileSync(settings, settingsText);
  return { home: h, settings, claudeJson, marker: join(h, ".claude", ".context-doctor-plugin.json"), skill: join(h, ".claude", "skills", "context-doctor", "SKILL.md") };
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Nothing of install's own Claude Code wiring: no hooks, no MCP entry, no skill. */
function noOwnWiring(h: Home): void {
  const s = existsSync(h.settings) ? json(h.settings) : {};
  assert.ok(!/cli\.js|context-doctor/.test(JSON.stringify(s.hooks ?? {})), `no hooks of install's beside the plugin: ${JSON.stringify(s.hooks)}`);
  assert.equal(json(h.claudeJson).mcpServers?.["context-doctor"], undefined, "no MCP server in ~/.claude.json beside the plugin");
  assert.ok(!existsSync(h.skill), "no skill copy beside the plugin");
}

/** The plugin is switched on as install switches it on. */
function pluginOn(h: Home): void {
  const s = json(h.settings);
  assert.equal(s.enabledPlugins?.["context-doctor@context-doctor"], true);
  assert.ok(isOurDeclaration(s.extraKnownMarketplaces?.["context-doctor"]), JSON.stringify(s.extraKnownMarketplaces));
  assert.deepEqual(s.extraKnownMarketplaces["context-doctor"], { source: { source: "github", repo: "KushalP1/context-doctor" }, autoUpdate: true });
}

test("mod readiness: every Claude Code found must be 2.1.286 or later, and at least one found", () => {
  const at = (...v: string[]) => modReadiness(v.map((version) => ({ path: "x", version, source: "cli" as const })));
  assert.equal(MOD_SINCE, "2.1.286");
  assert.equal(at("2.1.286").ok, true);
  assert.equal(at("2.1.321", "2.1.311").ok, true);
  assert.equal(at("2.1.285").ok, false);
  assert.equal(at("2.1.321", "2.1.62").ok, false);
  assert.deepEqual(at("2.1.321", "2.1.62").old.map((i) => i.version), ["2.1.62"]);
  assert.equal(at().ok, false);
});

test("fresh home on 2.1.286+: install enables the plugin, wires nothing of its own, and uninstall leaves no file behind", async () => {
  const h = home();
  const claudeJsonBefore = read(h.claudeJson);
  const r = await run(h.home, ["install"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /✓ Claude Code: the context-doctor plugin enabled/);
  assert.match(r.out, /Claude Code 2\.1\.321 .* runs its mod/);
  assert.match(r.out, /downloads it in the background at its next start/);
  pluginOn(h);
  noOwnWiring(h);
  assert.equal(read(h.claudeJson), claudeJsonBefore, "~/.claude.json untouched");
  assert.deepEqual(json(h.marker), { marketplace: true, enabled: true });

  const settingsAfter = read(h.settings);
  const again = await run(h.home, ["install"]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /plugin already enabled, unchanged/);
  assert.equal(read(h.settings), settingsAfter, "a second install changes nothing");

  const un = await run(h.home, ["uninstall"]);
  assert.equal(un.code, 0, un.err);
  assert.match(un.out, /context-doctor plugin turned off/);
  assert.ok(!existsSync(h.settings), "the settings.json install created is gone again");
  assert.ok(!existsSync(h.marker));
  assert.equal(read(h.claudeJson), claudeJsonBefore);
});

test("hand-written settings with other plugins and marketplaces: install, install again, uninstall give it back byte for byte", async () => {
  const text =
    '{\r\n\t"model": "opus",\r\n\t"enabledPlugins": {"other@team": true, "x@y": false},\r\n' +
    '\t"extraKnownMarketplaces": {\r\n\t\t"team": {"source": {"source": "git", "url": "https://git.example.com/p.git"}}\r\n\t},\r\n' +
    '\t"permissions": {"allow": ["Bash(npm test)"]}\r\n}\r\n';
  const h = home(text);
  assert.equal((await run(h.home, ["install"])).code, 0);
  pluginOn(h);
  const s = json(h.settings);
  assert.equal(s.enabledPlugins["other@team"], true, "the user's own plugins stay");
  assert.ok(s.extraKnownMarketplaces.team, "the user's own marketplace stays");
  const installed = read(h.settings)!;
  assert.ok(installed.includes('\t"model": "opus",\r\n'), "edited key by key: tabs and CRLF kept");
  assert.equal((await run(h.home, ["install"])).code, 0);
  assert.equal(read(h.settings), installed);
  assert.equal((await run(h.home, ["uninstall"])).code, 0);
  assert.equal(read(h.settings), text, "byte for byte");
});

test("an existing install moves to the plugin: own hooks, skill and MCP server out, nothing twice, and uninstall restores the original bytes", async () => {
  const text = '{\n    "theme": "dark",\n    "hooks": {\n        "Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]\n    }\n}\n';
  const h = home(text);
  const claudeJsonBefore = read(h.claudeJson);
  // Before 0.47 (or next to an older Claude Code): install's own wiring.
  const old = await run(h.home, ["install"], "2.1.285");
  assert.equal(old.code, 0, old.err);
  assert.match(old.out, /install's own MCP server, skill and hooks, not the plugin: Claude Code 2\.1\.285 .*predates mods \(2\.1\.286\)/);
  assert.ok(json(h.settings).hooks.UserPromptSubmit);
  assert.ok(json(h.claudeJson).mcpServers["context-doctor"]);
  assert.ok(existsSync(h.skill));
  assert.equal(json(h.settings).enabledPlugins, undefined, "no plugin next to an older Claude Code");

  // Claude Code updated: install again moves to the plugin.
  const moved = await run(h.home, ["install"]);
  assert.equal(moved.code, 0, moved.err);
  assert.match(moved.out, /the context-doctor plugin enabled/);
  assert.match(moved.out, /Taking out install's own copies/);
  pluginOn(h);
  noOwnWiring(h);
  assert.deepEqual(json(h.settings).hooks, { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, "the user's own hook stays");

  const d = await run(h.home, ["doctor"]);
  assert.ok(!/Plugin \+ install/.test(d.out), d.out);
  assert.match(d.out, /Claude Code route\s+the context-doctor plugin \(enabled by install\), not fetched yet/);

  assert.equal((await run(h.home, ["uninstall"])).code, 0);
  assert.equal(read(h.settings), text, "settings.json as before the first install");
  assert.equal(read(h.claudeJson), claudeJsonBefore, "~/.claude.json as before the first install");
  assert.ok(!existsSync(join(h.home, ".claude", "skills")));
});

test("a plugin the user enabled already: install writes nothing to settings.json, uninstall leaves it on", async () => {
  const text = '{\n  "enabledPlugins": {\n    "context-doctor@context-doctor": true\n  },\n  "extraKnownMarketplaces": {\n    "context-doctor": {"source": {"source": "directory", "path": "/src/context-doctor"}}\n  }\n}\n';
  const h = home(text);
  const r = await run(h.home, ["install"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /skipped the MCP server, skill and hooks\. The context-doctor plugin is enabled/);
  assert.equal(read(h.settings), text);
  assert.ok(!existsSync(h.marker), "nothing of install's to record");
  noOwnWiring(h);
  const un = await run(h.home, ["uninstall"]);
  assert.equal(un.code, 0, un.err);
  assert.match(un.out, /plugin stays enabled: you turned it on/);
  assert.equal(read(h.settings), text, "the user's plugin and marketplace untouched");
});

test("a marketplace Claude Code already knows by that name is not declared over; only the plugin is enabled", async () => {
  const h = home("{}\n");
  // Added with /plugin from a local checkout: declaring GitHub over it would move it.
  mkdirSync(join(h.home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(h.home, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify({ "context-doctor": { source: { source: "directory", path: "/src/cd" }, installLocation: "/src/cd" } }));
  assert.equal((await run(h.home, ["install"])).code, 0);
  const s = json(h.settings);
  assert.equal(s.enabledPlugins["context-doctor@context-doctor"], true);
  assert.equal(s.extraKnownMarketplaces, undefined);
  assert.deepEqual(json(h.marker), { marketplace: false, enabled: true });
  const d = await run(h.home, ["doctor"]);
  assert.match(d.out, /its marketplace fetched but the plugin not downloaded yet/);
  assert.equal((await run(h.home, ["uninstall"])).code, 0);
  assert.equal(read(h.settings), "{}\n");
});

test("an older Claude Code beside a newer one keeps install's own wiring for both; one appearing later moves a plugin install back", async () => {
  const text = '{"model":"opus"}';
  const h = home(text);
  const mixed = await run(h.home, ["install"], `${NEW},${OLD}`);
  assert.equal(mixed.code, 0, mixed.err);
  assert.match(mixed.out, /not the plugin: Claude Code 2\.1\.62 .*predates mods \(2\.1\.286\), and every Claude Code here reads the same settings/);
  assert.equal(json(h.settings).enabledPlugins, undefined);
  assert.ok(json(h.settings).hooks.UserPromptSubmit, "the 2.1.62 keeps the every-prompt hook");
  assert.equal(json(h.settings).hooks.PreModelSwitch, undefined, "and no event it would skip the file over");
  const d = await run(h.home, ["doctor"], `${NEW},${OLD}`);
  assert.match(d.out, /Claude Code route\s+install's own MCP server, skill and hooks, not the plugin/);
  assert.match(d.out, /Mod\s+not running: Claude Code 2\.1\.62/);
  assert.equal((await run(h.home, ["uninstall"], `${NEW},${OLD}`)).code, 0);
  assert.equal(read(h.settings), text);

  // Plugin first, then an old Claude Code shows up: back to install's own wiring, plugin keys out.
  assert.equal((await run(h.home, ["install"])).code, 0);
  pluginOn(h);
  const back = await run(h.home, ["install"], `${NEW},${OLD}`);
  assert.equal(back.code, 0, back.err);
  assert.match(back.out, /plugin install had enabled is turned off again/);
  const s = json(h.settings);
  assert.equal(s.enabledPlugins, undefined);
  assert.equal(s.extraKnownMarketplaces, undefined);
  assert.ok(s.hooks.UserPromptSubmit);
  assert.ok(!existsSync(h.marker));
  assert.equal((await run(h.home, ["uninstall"], `${NEW},${OLD}`)).code, 0);
  assert.equal(read(h.settings), text);
});

test("a plugin the user turned off keeps install's own wiring, and doctor does not nag", async () => {
  const text = '{"enabledPlugins":{"context-doctor@context-doctor":false}}';
  const h = home(text);
  const r = await run(h.home, ["install"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /not the plugin: the context-doctor plugin is turned off in your settings/);
  assert.equal(json(h.settings).enabledPlugins["context-doctor@context-doctor"], false);
  assert.ok(json(h.settings).hooks.UserPromptSubmit);
  const d = await run(h.home, ["doctor"]);
  assert.match(d.out, /– Mod\s+not running: the context-doctor plugin is turned off/);
  assert.equal((await run(h.home, ["uninstall"])).code, 0);
  assert.equal(read(h.settings), text);
});

test("the Desktop app's bundled Claude Code counts: its version folder alone moves install to the plugin", async () => {
  const h = home();
  mkdirSync(join(h.home, "Library", "Application Support", "Claude", "claude-code", NEW), { recursive: true });
  mkdirSync(join(h.home, "AppData", "Roaming", "Claude", "claude-code", NEW), { recursive: true });
  // No CLI on PATH: only the app's folder says which Claude Code this is.
  const r = await run(h.home, ["install"], null, { PATH: mkdtempSync(join(tmpdir(), "ctxdoc-e1-path-")) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Claude Code 2\.1\.321 \(desktop app\)/);
  pluginOn(h);
});

test("doctor: the plugin's stage, and whether the mod is recording, from its ledgers", async () => {
  const h = home();
  assert.equal((await run(h.home, ["install"])).code, 0);
  let d = await run(h.home, ["doctor"]);
  assert.match(d.out, /! Claude Code route\s+the context-doctor plugin \(enabled by install\), not fetched yet: Claude Code does that in the background at its next start/);
  assert.match(d.out, /! Mod\s+has not measured yet/);

  // Claude Code downloaded it.
  mkdirSync(join(h.home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(h.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "context-doctor@context-doctor": [{ scope: "user", version: "0.46.0" }] } }));
  // The mod measured a turn a few minutes ago.
  const cost = join(h.home, ".claude", ".context-doctor-session-cost.jsonl");
  writeFileSync(cost, JSON.stringify({ ts: Date.now(), sid: "s1", cc: 0.0001, cd: 0.0001 }) + "\n");
  d = await run(h.home, ["doctor"]);
  assert.match(d.out, /✓ Claude Code route\s+the context-doctor plugin \(enabled by install\), downloaded \(0\.46\.0\)/);
  assert.match(d.out, /✓ Mod\s+recording: last measured \d+ min ago .*no limit reading yet/);

  // Two days without a turn.
  const old = (Date.now() - 2 * 86_400_000) / 1000;
  utimesSync(cost, old, old);
  d = await run(h.home, ["doctor"]);
  assert.match(d.out, /! Mod\s+last measured (2 days|4\d h) ago/);

  // Uninstall takes the mod's ledger too.
  const un = await run(h.home, ["uninstall"]);
  assert.equal(un.code, 0, un.err);
  assert.ok(!existsSync(cost));
  assert.match(un.out, /keeps its downloaded copy, disabled/);
});

test("audit: doctor names the mod's ledger where it is, not always ~/.claude", async () => {
  const h = home();
  assert.equal((await run(h.home, ["install"])).code, 0);
  mkdirSync(join(h.home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(h.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "context-doctor@context-doctor": [{ scope: "user", version: "0.46.0" }] } }));
  // The state folder moved (CONTEXT_DOCTOR_HOOK_STATE): the mod writes its ledger beside it, and doctor reads it there.
  const state = mkdtempSync(join(tmpdir(), "ctxdoc-e1-state-"));
  writeFileSync(join(state, ".context-doctor-session-cost.jsonl"), JSON.stringify({ ts: Date.now(), sid: "s1", cc: 0.0001, cd: 0.0001 }) + "\n");
  const d = await run(h.home, ["doctor"], NEW, { CONTEXT_DOCTOR_HOOK_STATE: join(state, ".context-doctor-hook-state.json") });
  const line = d.out.split("\n").find((l) => /Mod\s+recording/.test(l)) ?? d.out;
  assert.ok(line.includes(join(state, ".context-doctor-session-cost.jsonl")), line);
  assert.ok(!line.includes("~/.claude/"), line);
});

// -- I4: the plugin a release behind this CLI, or the global command behind the plugin ----------

const CLI_VERSION = (JSON.parse(readFileSync(join(dirname(cliPath), "..", "package.json"), "utf8")) as { version: string }).version;
const CLI_RE = CLI_VERSION.replace(/\./g, "\\.");

/** A home with the plugin enabled by install and, when given, downloaded at `version`. */
async function pluginHome(version?: string): Promise<Home> {
  const h = home();
  assert.equal((await run(h.home, ["install"])).code, 0);
  if (version) {
    mkdirSync(join(h.home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(h.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "context-doctor@context-doctor": [{ scope: "user", version }] } }));
  }
  return h;
}

const versionLine = (out: string) => out.split("\n").find((l) => /Plugin version/.test(l));

test("I4 pluginVersionDrift: older plugin, newer plugin behind a global command, equal, unknown", () => {
  assert.equal(pluginVersionDrift("0.50.0", "0.51.0", false), "the plugin is 0.50.0, this release is 0.51.0: the newer checks start once Claude Code updates it (at its next start, or /plugin update context-doctor)");
  assert.equal(pluginVersionDrift("0.50.0", "0.51.0", true), pluginVersionDrift("0.50.0", "0.51.0", false), "the plugin's line does not depend on how the CLI was installed");
  assert.equal(pluginVersionDrift("0.53.0", "0.49.0", true), "the context-doctor command is 0.49.0, older than the plugin (0.53.0): the commands you type miss the checks and fixes since; update it: npm i -g context-doctor");
  // npx or a clone running behind the plugin: not the user's to update by hand.
  assert.equal(pluginVersionDrift("0.53.0", "0.49.0", false), undefined);
  assert.equal(pluginVersionDrift("0.53.0", "0.53.0", true), undefined);
  assert.equal(pluginVersionDrift("0.10.0", "0.9.0", false), undefined, "compared as numbers: 0.10.0 is newer than 0.9.0");
  assert.match(pluginVersionDrift("0.9.0", "0.10.0", false)!, /^the plugin is 0\.9\.0, this release is 0\.10\.0/);
  assert.equal(pluginVersionDrift(undefined, "0.53.0", true), undefined);
  assert.equal(pluginVersionDrift("unknown", "0.53.0", true), undefined);
});

test("I4 isGlobalInstall: npm's global folders yes; npx, npm's cache, a project and a clone no", () => {
  assert.equal(isGlobalInstall("/opt/homebrew/lib/node_modules/context-doctor/dist/doctor.js"), true);
  assert.equal(isGlobalInstall("/usr/local/lib/node_modules/context-doctor/dist/doctor.js"), true);
  assert.equal(isGlobalInstall("/home/u/.nvm/versions/node/v22.11.0/lib/node_modules/context-doctor/dist/doctor.js"), true);
  assert.equal(isGlobalInstall("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\context-doctor\\dist\\doctor.js"), true);
  assert.equal(isGlobalInstall("/Users/u/.npm/_npx/1a2b3c/node_modules/context-doctor/dist/doctor.js"), false);
  assert.equal(isGlobalInstall("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\context-doctor\\dist\\doctor.js"), false);
  assert.equal(isGlobalInstall("/Users/u/work/app/node_modules/context-doctor/dist/doctor.js"), false);
  assert.equal(isGlobalInstall("/Users/u/src/context-doctor/dist/doctor.js"), false);
});

test("I4 doctor: a plugin older than this CLI gets a ! line naming both versions and how it updates", async () => {
  const h = await pluginHome("0.50.0");
  const d = await run(h.home, ["doctor"]);
  assert.match(d.out, /✓ Claude Code route\s+the context-doctor plugin \(enabled by install\), downloaded \(0\.50\.0\)/);
  const line = versionLine(d.out);
  assert.ok(line, d.out);
  assert.match(line, new RegExp(`! Plugin version\\s+the plugin is 0\\.50\\.0, this release is ${CLI_RE}: the newer checks start once Claude Code updates it \\(at its next start, or /plugin update context-doctor\\)$`));
});

test("I4 doctor: equal versions say nothing new; no plugin downloaded says nothing about versions", async () => {
  const eq = await run((await pluginHome(CLI_VERSION)).home, ["doctor"]);
  assert.match(eq.out, new RegExp(`✓ Claude Code route\\s+the context-doctor plugin \\(enabled by install\\), downloaded \\(${CLI_RE}\\)`));
  assert.equal(versionLine(eq.out), undefined, eq.out);
  const none = await run((await pluginHome()).home, ["doctor"]);
  assert.match(none.out, /! Claude Code route\s+the context-doctor plugin \(enabled by install\), not fetched yet/);
  assert.equal(versionLine(none.out), undefined, none.out);
});

test("I4 doctor: a plugin newer than this CLI: silent from a clone or npx, a ! line from a global install behind it", async () => {
  // This build runs from the repository's dist/: not a global install, so a newer plugin is not its business.
  const ahead = await run((await pluginHome("99.0.0")).home, ["doctor"]);
  assert.equal(versionLine(ahead.out), undefined, ahead.out);

  // The same build laid out as `npm i -g` lays it out (<prefix>/lib/node_modules/context-doctor), at a version older than the plugin.
  const dist = dirname(cliPath);
  const prefix = mkdtempSync(join(tmpdir(), "ctxdoc-i4-global-"));
  const pkgDir = join(prefix, "lib", "node_modules", "context-doctor");
  mkdirSync(pkgDir, { recursive: true });
  cpSync(dist, join(pkgDir, "dist"), { recursive: true, filter: (src) => !/^[\\/]test([\\/]|$)/.test(src.slice(dist.length)) });
  const pkg = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8"));
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ ...pkg, version: "0.49.0" }));
  const h = await pluginHome(CLI_VERSION);
  const env: NodeJS.ProcessEnv = { ...sandboxEnv(h.home), CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1", CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: NEW };
  const out = await new Promise<string>((resolve) => execFile(process.execPath, [join(pkgDir, "dist", "cli.js"), "doctor"], { env, timeout: 60_000 }, (_e, stdout) => resolve(stdout)));
  const line = versionLine(out);
  assert.ok(line, out);
  assert.match(line, new RegExp(`! Plugin version\\s+the context-doctor command is 0\\.49\\.0, older than the plugin \\(${CLI_RE}\\): the commands you type miss the checks and fixes since; update it: npm i -g context-doctor$`));
});
