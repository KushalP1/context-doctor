/** pack never reads secrets by accident, survives unreadable entries, and says when the budget (not the query) is the problem. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packContext, readSources, renderPack, secretFileReason } from "../pack.js";
import { sandboxEnv, withSandboxHome } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const names = (r: { sources: Array<{ name: string }> }) => r.sources.map((s) => s.name.replace(/\\/g, "/")).sort();
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function secretFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "cd-pack-secrets-"));
  writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-live-123\n");
  writeFileSync(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_secret\n");
  writeFileSync(join(dir, ".prettierrc"), "{}\n");
  writeFileSync(join(dir, "server.pem"), "-----BEGIN PRIVATE KEY-----\nabc\n");
  writeFileSync(join(dir, "guide.md"), "# Guide\n\nHello.\n");
  mkdirSync(join(dir, ".aws"));
  writeFileSync(join(dir, ".aws", "credentials"), "aws_secret_access_key=xyz\n");
  return dir;
}

test("secret file names are recognized; ordinary ones are not", () => {
  for (const f of [".env", ".env.local", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "id_ed25519_sk", "a/server.pem", "x.key", "c.p12", "k.keystore", "home/.aws/credentials", ".git-credentials"]) {
    assert.ok(secretFileReason(f), f);
  }
  for (const f of ["guide.md", "id_rsa.pub", "env.ts", "credentials.md", "keys.ts", "environment.md"]) {
    assert.equal(secretFileReason(f), undefined, f);
  }
});

test("a folder outside git: hidden files and secrets stay out, and the user hears what was skipped", () => {
  const dir = secretFolder();
  const r = readSources([dir], dir);
  assert.deepEqual(names(r), ["guide.md"]);
  assert.ok(!r.sources.some((s) => /sk-live|npm_secret|PRIVATE KEY|aws_secret/.test(s.text)));
  assert.ok(r.skipped.some((s) => /server\.pem: a key or certificate store/.test(s)), r.skipped.join("\n"));
  assert.ok(r.skipped.some((s) => /hidden file\(s\) or folder\(s\) not read/.test(s)), r.skipped.join("\n"));
});

test("secrets are skipped even when named outright or tracked by git; --include-secrets packs them", () => {
  const dir = secretFolder();
  const named = readSources([join(dir, ".env"), join(dir, ".npmrc"), join(dir, ".prettierrc")], dir);
  assert.deepEqual(names(named), [".prettierrc"], "a hidden non-secret file named outright is read");
  assert.ok(named.skipped.some((s) => /\.env: an \.env file, likely holding secrets/.test(s)));

  if (spawnSync("git", ["init", "-q"], { cwd: dir }).status === 0) {
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const tracked = readSources([dir], dir);
    assert.deepEqual(names(tracked), [".prettierrc", "guide.md"], tracked.skipped.join("\n"));
  }

  const out = spawnSync(process.execPath, [cliPath, "pack", join(dir, ".env"), "-q", "key"], { cwd: dir, encoding: "utf8" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /--include-secrets packs it/);
  const opted = spawnSync(process.execPath, [cliPath, "pack", join(dir, ".env"), "-q", "OPENAI_API_KEY", "--include-secrets"], { cwd: dir, encoding: "utf8" });
  assert.equal(opted.status, 0, opted.stderr);
  assert.match(opted.stdout, /sk-live-123/);
});

test("credential folders under home are refused unless secrets are allowed", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-pack-home-"));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "config"), "Host prod\n  User deploy\n");
  await withSandboxHome(home, () => {
    const r = readSources([join(home, ".ssh"), join(home, ".ssh", "config")], home);
    assert.equal(r.sources.length, 0);
    assert.equal(r.skipped.filter((s) => /refused, .* holds credentials/.test(s)).length, 2, r.skipped.join("\n"));
    const allowed = readSources([join(home, ".ssh", "config")], { cwd: home, includeSecrets: true });
    assert.equal(allowed.sources.length, 1);
  });
});

test("a credential folder spelled in another case is refused where the disk ignores case (macOS, Windows)", async () => {
  assert.ok(secretFileReason("h/.AWS/credentials"), "the name check ignores case too");
  const home = mkdtempSync(join(tmpdir(), "cd-pack-case-"));
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  mkdirSync(join(home, ".aws"));
  mkdirSync(join(home, ".kube"));
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: gho_case\n");
  writeFileSync(join(home, ".aws", "credentials"), "aws_secret_access_key = case\n");
  writeFileSync(join(home, ".kube", "config"), "token: kube-case\n");
  const spelled = [join(home, ".CONFIG", "GH", "hosts.yml"), join(home, ".Aws", "credentials"), join(home, ".KUBE", "config"), join(home, ".KUBE")];
  if (!existsSync(spelled[0])) return; // a case-sensitive disk: those paths are not the files
  await withSandboxHome(home, () => {
    const r = readSources(spelled, home);
    assert.equal(r.sources.length, 0, r.sources.map((s) => s.text).join("\n"));
    assert.equal(r.skipped.filter((s) => /refused, .* holds credentials/.test(s)).length, 4, r.skipped.join("\n"));
  });
});

test("the agents' MCP and settings files in the home folder are refused (their servers' env holds API keys); a project's .mcp.json is read", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-pack-configs-"));
  const claudeHome = join(home, "claude-config"), codexHome = join(home, "codex-home");
  const files = [
    ".claude.json", join(".claude", "settings.json"), join(".claude", "settings.local.json"),
    join("claude-config", ".claude.json"), join("claude-config", "settings.json"),
    join(".cursor", "mcp.json"), join("codex-home", "config.toml"), join(".codex", "config.toml"),
    join(".gemini", "settings.json"), join(".gemini", "config", "mcp_config.json"), join(".gemini", "antigravity", "mcp_config.json"),
    join("Library", "Application Support", "Claude", "claude_desktop_config.json"),
    join("AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    join(".config", "Claude", "claude_desktop_config.json"),
    join(".copilot", "mcp-config.json"),
  ];
  for (const f of files) {
    mkdirSync(dirname(join(home, f)), { recursive: true });
    writeFileSync(join(home, f), '{"mcpServers":{"x":{"env":{"API_KEY":"sk-live-config"}}}}\n');
  }
  const repo = join(home, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{"docs":{"command":"docs-mcp"}}}\n');
  await withSandboxHome(home, () => {
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.CODEX_HOME = codexHome;
    try {
      const r = readSources([...files.map((f) => join(home, f)), join(home, ".cursor"), join(repo, ".mcp.json")], home);
      assert.deepEqual(names(r), ["repo/.mcp.json"], r.sources.map((s) => s.text).join("\n"));
      assert.equal(r.skipped.filter((s) => /refused, .* can hold API keys \(an MCP server's env\)/.test(s)).length, files.length + 1, r.skipped.join("\n"));
      assert.equal(readSources([join(home, ".cursor", "mcp.json")], { cwd: home, includeSecrets: true }).sources.length, 1);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
    }
  });
});

test("the agents' own sign-ins are refused, named outright, behind a link, or where CODEX_HOME puts them", async () => {
  for (const f of ["h/.claude/.credentials.json", "h/.codex/auth.json", "h/.gemini/oauth_creds.json", "h/.cargo/credentials.toml", "h/.gem/credentials", ".vault-token"]) {
    assert.ok(secretFileReason(f), f);
  }
  for (const f of ["src/auth.json", "docs/credentials", "oauth.md"]) assert.equal(secretFileReason(f), undefined, f);

  const home = mkdtempSync(join(tmpdir(), "cd-pack-agents-"));
  const codex = join(home, "codex-home");
  mkdirSync(codex);
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(codex, "auth.json"), '{"OPENAI_API_KEY":"sk-proj-x"}\n');
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: gho_x\n");
  const repo = join(home, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, ".env"), "KEY=sk-live-x\n");
  let linked = false;
  try {
    symlinkSync(join(repo, ".env"), join(repo, "notes.md"));
    linked = true;
  } catch { /* no symlinks without privileges on Windows */ }
  await withSandboxHome(home, () => {
    process.env.CODEX_HOME = codex;
    try {
      const r = readSources([join(codex, "auth.json"), join(home, ".config", "gh", "hosts.yml"), ...(linked ? [join(repo, "notes.md")] : [])], home);
      assert.equal(r.sources.length, 0, r.sources.map((s) => s.text).join("\n"));
      assert.ok(r.skipped.some((s) => /auth\.json: refused/.test(s)), r.skipped.join("\n"));
      assert.ok(r.skipped.some((s) => /hosts\.yml: refused/.test(s)), r.skipped.join("\n"));
      if (linked) assert.ok(r.skipped.some((s) => /notes\.md: an \.env file/.test(s)), r.skipped.join("\n"));
    } finally {
      delete process.env.CODEX_HOME;
    }
  });
});

test("unreadable entries are skipped with a reason instead of crashing the walk", { skip: (process.platform === "win32" || isRoot) && "chmod does not lock files here" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-pack-perm-"));
  writeFileSync(join(dir, "ok.md"), "# OK\n\nreadable\n");
  writeFileSync(join(dir, "locked.txt"), "secret\n");
  mkdirSync(join(dir, "locked-dir"));
  writeFileSync(join(dir, "locked-dir", "x.md"), "x\n");
  chmodSync(join(dir, "locked.txt"), 0o000);
  chmodSync(join(dir, "locked-dir"), 0o000);
  try {
    const r = readSources([dir], dir);
    assert.deepEqual(names(r), ["ok.md"]);
    assert.ok(r.skipped.some((s) => /locked\.txt: permission denied/.test(s)), r.skipped.join("\n"));
    assert.ok(r.skipped.some((s) => /locked-dir: permission denied/.test(s)), r.skipped.join("\n"));
  } finally {
    chmodSync(join(dir, "locked.txt"), 0o644);
    chmodSync(join(dir, "locked-dir"), 0o755);
  }
});

test("a device folder (/dev) is walked without throwing", { skip: process.platform === "win32" && "no /dev" }, () => {
  assert.doesNotThrow(() => readSources(["/dev"], "/"));
});

test("when the match does not fit the budget, pack says so instead of 'rephrase'", () => {
  const text = "# Big\n\n" + "rotate the signing key with keyctl. ".repeat(60);
  const r = packContext([{ name: "big.md", text }], { query: "rotate signing key", budget: 20, maxChunkTokens: 2000 });
  assert.equal(r.selected.length, 0);
  assert.equal(r.unfit[0].id, "big.md#1");
  const out = renderPack(r);
  assert.match(out, /Nothing fit the budget of 20 tokens: the best match big\.md#1 \(Big\) is ~\d+ tokens/);
  assert.match(out, /--max-tokens/);
  assert.doesNotMatch(out, /rephrase/);

  const byId = renderPack(packContext([{ name: "big.md", text }], { ids: ["big.md#1"], budget: 20, maxChunkTokens: 2000 }));
  assert.match(byId, /the requested chunk big\.md#1/);

  const small = "# Small\n\nkeyctl rotate.\n\n# Big\n\n" + "keyctl filler words here. ".repeat(80);
  const mixed = renderPack(packContext([{ name: "m.md", text: small }], { ids: ["m.md#1", "m.md#2"], budget: 40, maxChunkTokens: 2000 }));
  assert.match(mixed, /Did not fit the budget of 40: m\.md#2/);
});

test("pack - reads stdin beside the other paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-pack-stdin-"));
  writeFileSync(join(dir, "a.md"), "# A\n\nalpha file\n");
  const out = spawnSync(process.execPath, [cliPath, "pack", "-", "a.md", "--ids", "stdin#1,a.md#1"], {
    cwd: dir,
    input: "﻿beta from stdin\n",
    encoding: "utf8",
    env: sandboxEnv(dir),
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /beta from stdin/);
  assert.match(out.stdout, /alpha file/);
  assert.doesNotMatch(out.stdout, /﻿/);
});
