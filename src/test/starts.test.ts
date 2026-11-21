/** overhead's starts: each session's and subagent's first request, per entrypoint and subagent type, priced across the period; and fix's mcp-defer and desktop-tools-defer levers. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deferrableApp, deferrableConfigured, entrypointName, measureStarts, mcpServerOf, renderStarts } from "../starts.js";
import { applyFix, fixOverrides, overlaps, parseFixIds, planFixes, readFixRecords, renderFixPlan, undoFixes, type FixInputs } from "../fix.js";
import { tokensForLength } from "../tokens.js";

process.env.CONTEXT_DOCTOR_CACHE_DIR = mkdtempSync(join(tmpdir(), "cd-starts-cache-"));

const near = (a: number, b: number, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);
const OPUS = "claude-opus-5-5"; // $4 in, $0.20 cache read; writes 1.25x (5 minutes), 2x (1 hour)
const t0 = Date.now() - 2 * 86_400_000;
const iso = (at: number) => new Date(at).toISOString();
let n = 0;

function reply(at: number, u: { input?: number; read?: number; write1h?: number; write5m?: number }, extra: Record<string, unknown> = {}): string {
  const id = `msg_st${n++}`;
  const w1 = u.write1h ?? 0, w5 = u.write5m ?? 0;
  return JSON.stringify({
    type: "assistant", uuid: `u-${id}`, timestamp: iso(at), ...extra,
    message: { id, model: OPUS, content: [{ type: "text", text: "ok" }], usage: { input_tokens: u.input ?? 0, cache_read_input_tokens: u.read ?? 0, cache_creation_input_tokens: w1 + w5, output_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 } } },
  });
}
const user = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", uuid: `q${n++}`, timestamp: iso(t0), message: { role: "user", content: text }, ...extra });
const tool = (name: string, chars: number, deferred = false) => ({ name, description: "d".repeat(chars), input_schema: { type: "object" }, ...(deferred ? { defer_loading: true } : {}) });
const shape = (tools: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ type: "api-request-shape", timestamp: iso(t0), shape: { system: [{ type: "text", text: "s".repeat(1000) }], tools }, ...extra });
const tokensOf = (t: unknown) => tokensForLength(JSON.stringify(t).length, false, "claude-opus-5");

const BASH = tool("Bash", 3000);
const BROWSER = tool("mcp__Claude_Browser__navigate", 8000);
const MINE = tool("mcp__mine__do", 4000);
const LATER = tool("mcp__later__x", 5000, true);
const FETCH = tool("WebFetch", 2000); // announced as deferred: not sent whole

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cd-starts-"));
  const proj = join(home, ".claude", "projects", "-work-app");
  mkdirSync(proj, { recursive: true });
  const cwd = join(home, "work", "app");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { mine: { command: "mine-server", alwaysLoad: true } }, projects: { [resolve(cwd)]: { mcpServers: { proj: { command: "proj-server" } } } } }, null, 2));
  const write = (name: string, rows: string[]) => {
    const p = join(proj, name);
    writeFileSync(p, rows.join("\n") + "\n");
    return p;
  };
  // The Desktop app: a 70k start (the API's count, less "hi"), written at 1 hour, then read.
  const desktop = write("desk.jsonl", [
    JSON.stringify({ type: "attachment", entrypoint: "claude-desktop", timestamp: iso(t0), attachment: { type: "deferred_tools_delta", addedNames: ["WebFetch"] } }),
    user("hi", { entrypoint: "claude-desktop" }),
    JSON.stringify({ type: "api-request", querySource: "sdk", timestamp: iso(t0) }),
    shape([BASH, BROWSER, MINE, LATER, FETCH]),
    reply(t0, { input: 1, write1h: 70_000 }),
    reply(t0 + 60_000, { input: 1, read: 70_500, write1h: 100 }),
  ]);
  // The terminal: a 13k start.
  const terminal = write("term.jsonl", [user("hi", { entrypoint: "cli" }), reply(t0, { input: 1, write1h: 13_000 })]);
  // claude -p: an SDK entrypoint of its own.
  const sdk = write("sdk.jsonl", [user("hi", { entrypoint: "sdk-cli" }), reply(t0, { input: 1, write1h: 20_000 })]);
  // The Desktop session's subagents: one typed by its meta file, one by its first request's query source.
  const subs = join(proj, "desk", "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose" }));
  writeFileSync(join(subs, "agent-a1.jsonl"), [
    user("do the task", { isSidechain: true, entrypoint: "claude-desktop" }),
    JSON.stringify({ type: "api-request", querySource: "agent:builtin:general-purpose", timestamp: iso(t0), isSidechain: true }),
    shape([BASH, BROWSER, MINE], { isSidechain: true }),
    reply(t0, { input: 4, write5m: 52_000 }, { isSidechain: true }),
    reply(t0 + 10_000, { input: 1, read: 52_000, write5m: 500 }, { isSidechain: true }),
  ].join("\n") + "\n");
  writeFileSync(join(subs, "agent-a2.jsonl"), [
    user("look around", { isSidechain: true }),
    JSON.stringify({ type: "api-request", querySource: "agent:builtin:Explore", timestamp: iso(t0), isSidechain: true }),
    reply(t0, { input: 4, write5m: 30_000 }, { isSidechain: true }),
  ].join("\n") + "\n");
  return { home, cwd, paths: [desktop, terminal, sdk] };
}

test("names: entrypoints as people call them, MCP servers from tool names", () => {
  assert.equal(entrypointName("claude-desktop"), "Desktop app");
  assert.equal(entrypointName("cli"), "terminal");
  assert.equal(entrypointName("sdk-cli"), "claude -p / SDK");
  assert.equal(mcpServerOf("mcp__Claude_Browser__navigate"), "Claude_Browser");
  assert.equal(mcpServerOf("mcp__1a59c906-04da__batch"), "1a59c906-04da");
  assert.equal(mcpServerOf("Bash"), undefined);
});

test("starts: per entrypoint and subagent type, the API's count less the first message, priced on every step that re-read it", () => {
  const { home, cwd, paths } = fixture();
  const r = measureStarts({ days: 30, paths, home, cwd });
  const group = (kind: string, key: string) => r.groups.find((g) => g.kind === kind && (kind === "session" ? g.entrypoint === key : g.agentType === key))!;
  const desk = group("session", "claude-desktop");
  assert.equal(desk.starts, 1);
  assert.equal(desk.median, 70_000);
  assert.equal(desk.requests, 2);
  // Written at 1 hour ($8/M), then read ($0.20/M): only the start's 70k, not what followed it.
  near(desk.usd, (70_000 * 8 + 70_000 * 0.2) / 1e6, "desktop");
  // Sent whole: Bash, the browser and mine; the deferred tool and the one announced as deferred are not.
  assert.equal(desk.wholeTools, 3);
  assert.equal(desk.wholeTokens, tokensOf(BASH) + tokensOf(BROWSER) + tokensOf(MINE));
  assert.equal(desk.mcpTokens, tokensOf(BROWSER) + tokensOf(MINE));
  near(desk.deferrableUsd!, desk.usd * (tokensOf(BROWSER) + tokensOf(MINE)) / 70_000, "deferrable");
  assert.deepEqual(desk.servers.map((s) => [s.name, s.configured]), [["Claude_Browser", undefined], ["mine", "user"]]);

  assert.equal(group("session", "cli").median, 13_000);
  assert.equal(group("session", "sdk-cli").median, 20_000);
  const gp = group("subagent", "general-purpose");
  assert.equal(gp.entrypoint, "claude-desktop");
  assert.equal(gp.median, 52_000);
  // The subagent's brief is not part of its start; its writes are at 5 minutes ($5/M).
  near(gp.usd, (52_000 * 5 + 52_000 * 0.2) / 1e6, "subagent");
  const explore = group("subagent", "Explore");
  assert.equal(explore.median, 30_000, "typed by its query source, its parent's entrypoint");
  assert.equal(explore.entrypoint, "claude-desktop");
  assert.equal(explore.shaped, 0);

  // Desktop against terminal: the start above a terminal-sized one, at the Desktop requests' own rates.
  assert.deepEqual([r.gap!.desktop, r.gap!.terminal, r.gap!.tokens], [70_000, 13_000, 57_000]);
  near(r.gap!.usd, desk.usd * 57_000 / 70_000, "gap");

  const text = renderStarts(r).join("\n");
  assert.match(text, /Desktop app sessions\s+1\s+median\s+~70k/);
  assert.match(text, /terminal sessions/);
  assert.match(text, /general-purpose \(subagent\)/);
  assert.match(text, /Desktop app vs terminal: a Desktop session starts ~57k tokens larger/);
  assert.match(text, /Claude_Browser .*provided by the app or a connector/);
  assert.match(text, /mine .*~\/\.claude\.json: `alwaysLoad: false` defers it/);
  assert.match(text, /No setting defers the server the app provides/);
  assert.match(text, /fix --apply mcp-defer/);

  const conf = deferrableConfigured(r);
  assert.deepEqual(conf.map((c) => [c.name, c.scope]), [["mine", "user"]]);
  assert.ok(conf[0].usd > 0);
});

test("starts: no terminal session, no gap, and the report says so; a fork's copied first request is not a start", () => {
  const { home, cwd, paths } = fixture();
  const fork = join(home, ".claude", "projects", "-work-app", "fork.jsonl");
  // A fork begins with its parent's rows, uuids and reply ids included.
  writeFileSync(fork, readFileSync(paths[0], "utf8"));
  const r = measureStarts({ days: 30, paths: [paths[0], fork], home, cwd });
  assert.equal(r.gap, undefined);
  assert.equal(r.groups.find((g) => g.kind === "session")!.starts, 1);
  assert.match(renderStarts(r).join("\n"), /No terminal sessions in the period to compare/);
});

test("mcp-defer: offered for your own servers only, never by --apply all; apply and undo key by key in a throwaway HOME", async () => {
  const { home, cwd } = fixture();
  const inputs: FixInputs = { days: 30, billedUsd: 100, mcpDefer: { days: 30, servers: [{ name: "mine", scope: "user", tokens: 1_500, usd: 2 }, { name: "proj", scope: "project", tokens: 800, usd: 1 }, { name: "shared", scope: ".mcp.json", tokens: 900, usd: 1 }] } };
  const fixes = planFixes(inputs);
  const f = fixes.find((x) => x.id === "mcp-defer")!;
  assert.equal(f.state, "available");
  near(f.savedUsd!, 3, "the repository's .mcp.json is not written");
  assert.ok(!f.qualityFree);
  assert.match(f.quality, /one more step/);
  assert.deepEqual(parseFixIds("all", fixes).ids.includes("mcp-defer"), false);
  assert.deepEqual(parseFixIds("mcp-defer", fixes).ids, ["mcp-defer"]);

  const file = join(home, ".claude.json");
  const r = await applyFix(f, { home, cwd }, { mcpDefer: inputs.mcpDefer });
  assert.ok(r.ok, r.lines.join("\n"));
  let cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(cfg.mcpServers.mine.alwaysLoad, false);
  assert.equal(cfg.projects[resolve(cwd)].mcpServers.proj.alwaysLoad, false);
  assert.ok(r.lines.some((l) => /shared: in \.mcp\.json/.test(l)));
  assert.equal(readFixRecords(home).find((x) => x.id === "mcp-defer")!.entries!.length, 2);

  // Claude Code rewrites the file meanwhile: undo puts back each key, not the file.
  cfg.numStartups = 4;
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  const lines = await undoFixes(["mcp-defer"], { home, cwd });
  cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(cfg.mcpServers.mine.alwaysLoad, true, lines.join("\n"));
  assert.equal("alwaysLoad" in cfg.projects[resolve(cwd)].mcpServers.proj, false);
  assert.equal(cfg.numStartups, 4);
  assert.equal(readFixRecords(home).length, 0);
});

test("mcp-defer: a second apply keeps the first value; undo leaves a key the user changed since", async () => {
  const { home, cwd } = fixture();
  const inputs: FixInputs = { days: 30, billedUsd: 100, mcpDefer: { days: 30, servers: [{ name: "mine", scope: "user", tokens: 1_500, usd: 2 }] } };
  const f = planFixes(inputs).find((x) => x.id === "mcp-defer")!;
  assert.ok((await applyFix(f, { home, cwd }, { mcpDefer: inputs.mcpDefer })).ok);
  const again = await applyFix(f, { home, cwd }, { mcpDefer: inputs.mcpDefer });
  assert.ok(again.lines.some((l) => /already deferred/.test(l)));
  assert.equal(readFixRecords(home)[0].entries![0].previous, true);
  const file = join(home, ".claude.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  cfg.mcpServers.mine.alwaysLoad = "yes";
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  const lines = await undoFixes(["mcp-defer"], { home, cwd });
  assert.ok(lines.some((l) => /changed since fix set it/.test(l)), lines.join("\n"));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.mine.alwaysLoad, "yes");
});

test("desktop-tools-defer: the app's own servers, priced on the starts that never called them; overhead names the lever", () => {
  const { home, cwd, paths } = fixture();
  // The general-purpose subagent calls the browser; the Desktop session never does.
  const sub = join(home, ".claude", "projects", "-work-app", "desk", "subagents", "agent-a1.jsonl");
  writeFileSync(sub, readFileSync(sub, "utf8") + JSON.stringify({ type: "assistant", uuid: "call-1", isSidechain: true, timestamp: iso(t0 + 20_000), message: { id: "msg_call1", model: OPUS, content: [{ type: "tool_use", id: "t1", name: "mcp__Claude_Browser__navigate", input: {} }] } }) + "\n");
  const r = measureStarts({ days: 30, paths, home, cwd });
  const desk = r.groups.find((g) => g.kind === "session" && g.entrypoint === "claude-desktop")!;
  const app = deferrableApp(r);
  assert.deepEqual(app.map((s) => [s.name, s.starts, s.calledStarts]), [["Claude_Browser", 2, 1]], "mine is in the user's config: mcp-defer's, not this one's");
  near(app[0].unusedUsd, desk.usd * tokensOf(BROWSER) / 70_000, "only the Desktop session's start, which never called it");
  assert.ok(app[0].usd > app[0].unusedUsd, "overhead's figure counts the subagent's start too");
  assert.match(renderStarts(r).join("\n"), /fix --apply desktop-tools-defer` has context-doctor's mod keep Claude_Browser behind tool search in new sessions/);
});

test("desktop-tools-defer: offered by name only, priced in plain words, ccd_turn and much-called servers kept; apply and undo in a throwaway HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-dtd-"));
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, '{\n  "env": {\n    "OTHER": "1"\n  }\n}\n');
  const before = readFileSync(settings, "utf8");
  const s = (name: string, starts: number, calledStarts: number, unusedUsd: number) => ({ name, tools: 5, tokens: 5_000, starts, calledStarts, usd: unusedUsd * 1.3, unusedUsd });
  const inputs: FixInputs = { days: 30, billedUsd: 500, desktopTools: { days: 30, servers: [s("Claude_Browser", 100, 36, 40), s("ccd_session", 100, 12, 15), s("visualize", 100, 2, 9), s("terminal", 100, 70, 2)] } };
  const fixes = planFixes(inputs);
  const f = fixes.find((x) => x.id === "desktop-tools-defer")!;
  assert.equal(f.state, "available");
  near(f.savedUsd!, 64, "terminal, called in most starts, is kept");
  assert.equal(f.value, "Claude_Browser,ccd_session,visualize");
  assert.match(f.basis, /Claude_Browser ~5k tokens, called in 36 of 100 starts/);
  assert.match(f.basis, /never called them \(\$83\.20 counting the ones that did/);
  assert.match(f.quality, /Kept in front: ccd_turn, terminal/);
  assert.match(f.quality, /new sessions only/);
  assert.match(f.change, /env\.CONTEXT_DOCTOR_DEFER_MCP = "Claude_Browser,ccd_session,visualize", read by context-doctor's mod/);
  assert.ok(!f.qualityFree);
  assert.equal(parseFixIds("all", fixes).ids.includes("desktop-tools-defer"), false, "never by --apply all");
  assert.deepEqual(parseFixIds("desktop-tools-defer", fixes).ids, ["desktop-tools-defer"]);
  // Below a dollar, or nothing measured: not offered.
  assert.equal(planFixes({ ...inputs, desktopTools: { days: 30, servers: [s("visualize", 10, 0, 0.5)] } }).some((x) => x.id === "desktop-tools-defer"), false);
  assert.equal(planFixes({ days: 30, billedUsd: 500 }).some((x) => x.id === "desktop-tools-defer"), false);

  const r = await applyFix(f, { home, env: {} });
  assert.ok(r.ok, r.lines.join("\n"));
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).env.CONTEXT_DOCTOR_DEFER_MCP, "Claude_Browser,ccd_session,visualize");
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).env.OTHER, "1");
  assert.deepEqual(readFixRecords(home).map((x) => x.id), ["desktop-tools-defer"]);
  // Applied, the plan says so and offers nothing.
  const applied = planFixes({ ...inputs, desktopToolsSet: { value: "Claude_Browser,ccd_session,visualize", where: "~/.claude/settings.json env" } }).find((x) => x.id === "desktop-tools-defer")!;
  assert.equal(applied.state, "applied");
  assert.match(applied.note!, /keeps Claude_Browser, ccd_session, visualize behind tool search/);

  const lines = await undoFixes(["desktop-tools-defer"], { home });
  assert.ok(lines.some((l) => /removed/.test(l)), lines.join("\n"));
  assert.equal(readFileSync(settings, "utf8"), before, "byte for byte as before");
  assert.equal(readFixRecords(home).length, 0);

  // A value the user wrote is theirs: refused, nothing changed.
  writeFileSync(settings, '{ "env": { "CONTEXT_DOCTOR_DEFER_MCP": "visualize" } }');
  const mine = readFileSync(settings, "utf8");
  const refused = await applyFix(f, { home, env: {} });
  assert.equal(refused.ok, false);
  assert.match(refused.lines.join("\n"), /a value you set: left as it is/);
  assert.equal(readFileSync(settings, "utf8"), mine);
});

test("audit: desktop-tools-defer saves part of the same start dollars as the cache lifetimes and the subagents' model, so the plan says not to add them up", () => {
  const s = (name: string) => ({ name, tools: 5, tokens: 5_000, starts: 100, calledStarts: 2, usd: 52, unusedUsd: 40 });
  const fixes = planFixes({ days: 30, billedUsd: 500, desktopTools: { days: 30, servers: [s("Claude_Browser")] } });
  const dt = fixes.find((x) => x.id === "desktop-tools-defer")!;
  const other = (id: "cache-ttl" | "cache-ttl-subagents" | "subagent-model") => ({ ...dt, id, savedUsd: 10 });
  for (const id of ["cache-ttl", "cache-ttl-subagents", "subagent-model"] as const) {
    assert.equal(overlaps([dt, other(id)]).length, 1, id);
  }
  assert.match(renderFixPlan(30, 500, [dt, other("subagent-model")], []), /Do not add them up/);
});

test("audit: desktop-tools-defer's 'counting the ones that did' is never below its own figure (both counted start by start)", () => {
  // overhead's per-server share spreads a group's dollars by tokens: here it gives the browser $2, while its
  // definitions cost $5 in the expensive starts that never called it and $1 in the ones that did.
  const f = planFixes({ days: 30, billedUsd: 500, desktopTools: { days: 30, servers: [{ name: "Claude_Browser", tools: 19, tokens: 7_900, starts: 10, calledStarts: 2, usd: 2, unusedUsd: 5, calledUsd: 1 }] } }).find((x) => x.id === "desktop-tools-defer")!;
  near(f.savedUsd!, 5);
  assert.match(f.basis, /never called them \(\$6\.00 counting the ones that did; those would/);
  // measureStarts gives both parts.
  const { home, cwd, paths } = fixture();
  const sub = join(home, ".claude", "projects", "-work-app", "desk", "subagents", "agent-a1.jsonl");
  writeFileSync(sub, readFileSync(sub, "utf8") + JSON.stringify({ type: "assistant", uuid: "call-2", isSidechain: true, timestamp: iso(t0 + 20_000), message: { id: "msg_call2", model: OPUS, content: [{ type: "tool_use", id: "t2", name: "mcp__Claude_Browser__navigate", input: {} }] } }) + "\n");
  const [b] = deferrableApp(measureStarts({ days: 30, paths, home, cwd }));
  assert.ok(b.calledUsd > 0 && b.unusedUsd > 0, JSON.stringify(b));
});

test("audit: with tool search off there is nothing to load a deferred tool: desktop-tools-defer says it would not take effect", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-dtd-ts-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), '{"env": {"ENABLE_TOOL_SEARCH": "false"}}');
  const over = fixOverrides("desktop-tools-defer", { home, cwd: home, env: { CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1" } });
  assert.equal(over.length, 1, over.join("; "));
  assert.match(over[0], /ENABLE_TOOL_SEARCH=false in .*settings\.json env \(tool search is off\)/);
  // On (the default, or a true value): nothing in the way.
  writeFileSync(join(home, ".claude", "settings.json"), '{"env": {"ENABLE_TOOL_SEARCH": "true"}}');
  assert.deepEqual(fixOverrides("desktop-tools-defer", { home, cwd: home, env: { CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1" } }), []);
});
