#!/usr/bin/env node
// The plugin as Anthropic's directory gets it (ROADMAP E5): a folder that holds
// only what the plugin runs, built from this checkout's dist/. The directory
// reads a plugin folder from a GitHub repository (docs/directory-submission.md);
// submitted as this repository's root, the plugin brings 949 files, a lockfile
// install (package.json beside package-lock.json), files over 256 KiB and a
// minified MCP server, and the portal holds each of those for a reviewer.
//
//   node scripts/build-directory-plugin.mjs [--out <dir>] [--no-mod] [--validate] [--claude <binary>]
//
// What changes from the plugin this repository's marketplace serves:
//  - plugin.json gains engines["claude-code"] and the directory's listing fields
//    (icon, documentationUrl, supportUrl, privacyPolicyUrl). Claude Code before
//    2.1.76 refuses a manifest with a key it does not know and loads nothing of
//    the plugin (measured on 2.1.62 and 2.1.75; 2.1.76 loads it), so the
//    repository's own plugin.json stays without them;
//  - no marketplace.json, no package-lock.json (a package.json alone, for
//    "type": "module", installs nothing), no tests, no type declarations;
//  - the MCP server bundled again from src/ without minifying, so the security
//    scan can read it; dist/mcp.js (npm's copy of it) becomes a one-line import
//    of that bundle, and dist/mcpclient.js (`overhead --mcp`, which says so
//    and falls back without it) is left out;
//  - README.md is plugin/README.md: what the plugin runs, reads, writes and sends.
//  - --no-mod: the fallback for a directory that refuses a hooks module: no
//    `modules` in hooks/hooks.json and no dist/mod/. The hooks, skills and MCP
//    server are the same.
//
// --validate runs `claude plugin validate --profile directory --strict` on the
// result with a Claude Code (--claude, else the newest here, as the canary
// finds it) in a throwaway HOME and CLAUDE_CONFIG_DIR. Exit 0 built (and
// valid), 1 not valid, 2 could not build.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB = "https://github.com/KushalP1/context-doctor";

/** The oldest Claude Code that loads a plugin.json carrying keys it does not know (2.1.75 refuses it whole). */
export const ENGINE_RANGE = ">=2.1.76";
/** The directory's own limits (claude.com/docs/plugins/pre-submission-checklist). */
export const LIMITS = { files: 512, heldBytes: 256 * 1024, stopBytes: 5 * 1024 * 1024 };

/** The listing fields and the engine range, in the order the manifest reads best. */
export function directoryManifest(manifest) {
  const out = {};
  for (const [k, v] of Object.entries(manifest)) {
    out[k] = v;
    if (k === "license") {
      out.engines = { "claude-code": ENGINE_RANGE };
      out.icon = "./assets/icon.png";
      out.documentationUrl = `${GITHUB}#readme`;
      out.supportUrl = `${GITHUB}/issues`;
      out.privacyPolicyUrl = `${GITHUB}/blob/main/docs/privacy.md`;
    }
  }
  return out;
}

/** hooks/hooks.json without the mod: the model-switch hook alone. */
export function hooksWithoutMod(hooks) {
  const { modules: _modules, ...rest } = hooks;
  return { ...rest, description: "PreModelSwitch lives in its own file: Claude Code before 2.1.251 rejects a hooks file that names an event it does not know, and this way it drops only this one, not the plugin's other hooks in plugin.json." };
}

/** dist/ files the plugin runs: no tests, no declarations, no npm-only copies. */
export function wantDist(rel, { mod }) {
  const p = rel.split(sep).join("/");
  if (!p.endsWith(".js")) return false;
  if (p.startsWith("test/")) return false;
  if (p === "mcp.js" || p === "mcpclient.js" || p === "mcp.bundle.js") return false;
  if (p.startsWith("mod/")) return mod && p !== "mod/api.js";
  return true;
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

/** The out folder may be replaced only when it is empty or an earlier build of this plugin. */
function clearOut(out) {
  if (!existsSync(out)) return;
  if (readdirSync(out).length === 0) return;
  let name;
  try { name = JSON.parse(readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8")).name; } catch { /* not ours */ }
  if (name !== "context-doctor") throw new Error(`${out} is not empty and is not a build of this plugin: refusing to replace it`);
  // A git checkout of the branch the directory follows can be the out folder: its .git stays.
  for (const e of readdirSync(out)) if (e !== ".git") rmSync(join(out, e), { recursive: true, force: true });
}

async function bundleMcp(file) {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(REPO, "src", "mcp.ts")],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: false,
    legalComments: "inline",
    logLevel: "warning",
    banner: { js: "import { createRequire as __cdRequire } from 'module'; const require = __cdRequire(import.meta.url);" },
  });
}

/** Builds the folder; returns what the directory's limits say about it. */
export async function buildDirectoryPlugin({ out, mod = true }) {
  for (const f of ["dist/cli.js", "dist/mod/register.js", "plugin/README.md"]) if (!existsSync(join(REPO, f))) throw new Error(`${f} is missing: run npm run build first`);
  clearOut(out);
  mkdirSync(out, { recursive: true });
  const read = (f) => JSON.parse(readFileSync(join(REPO, f), "utf8"));
  const write = (f, s) => { mkdirSync(dirname(join(out, f)), { recursive: true }); writeFileSync(join(out, f), s); };
  const manifest = read(".claude-plugin/plugin.json");
  write(".claude-plugin/plugin.json", JSON.stringify(directoryManifest(manifest), null, 2) + "\n");
  const hooks = read("hooks/hooks.json");
  write("hooks/hooks.json", JSON.stringify(mod ? hooks : hooksWithoutMod(hooks), null, 2) + "\n");
  cpSync(join(REPO, "plugin", "skills"), join(out, "plugin", "skills"), { recursive: true });
  write("README.md", readFileSync(join(REPO, "plugin", "README.md"), "utf8"));
  write("LICENSE", readFileSync(join(REPO, "LICENSE"), "utf8"));
  mkdirSync(join(out, "assets"), { recursive: true });
  cpSync(join(REPO, "assets", "icon.png"), join(out, "assets", "icon.png"));
  const pkg = read("package.json");
  write("package.json", JSON.stringify({ name: pkg.name, version: pkg.version, description: "The context-doctor plugin for Claude Code. No dependencies: package.json is here for \"type\": \"module\" alone.", private: true, type: "module", license: pkg.license }, null, 2) + "\n");
  const dist = join(REPO, "dist");
  for (const rel of walk(dist)) if (wantDist(rel, { mod })) {
    mkdirSync(dirname(join(out, "dist", rel)), { recursive: true });
    cpSync(join(dist, rel), join(out, "dist", rel));
  }
  await bundleMcp(join(out, "dist", "mcp.bundle.js"));
  // `context-doctor mcp`, doctor's handshake and install start dist/mcp.js: the same server, not a second copy of it.
  write("dist/mcp.js", "#!/usr/bin/env node\n// The MCP server: the plugin's readable bundle of it (scripts/build-directory-plugin.mjs).\nimport \"./mcp.bundle.js\";\n");
  return inspect(out);
}

/** The directory's file rules, as far as a folder on disk shows them. */
export function inspect(out) {
  const files = walk(out);
  const sizes = files.map((f) => ({ f: f.split(sep).join("/"), bytes: lstatSync(join(out, f)).size, link: lstatSync(join(out, f)).isSymbolicLink() }));
  const image = (f) => /\.(png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i.test(f);
  return {
    files: files.length,
    overFileCount: files.length > LIMITS.files,
    held: sizes.filter((s) => !image(s.f) && s.bytes > LIMITS.heldBytes).map((s) => s.f),
    stops: sizes.filter((s) => s.bytes >= LIMITS.stopBytes).map((s) => s.f),
    links: sizes.filter((s) => s.link).map((s) => s.f),
    systemFiles: sizes.filter((s) => /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)(\/|$)/.test(s.f)).map((s) => s.f),
    lockfiles: sizes.filter((s) => /^(package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?)$/.test(s.f)).map((s) => s.f),
  };
}

/** `claude plugin validate --profile directory --strict --json` in a throwaway HOME and CLAUDE_CONFIG_DIR. */
export function validate(claude, dir) {
  const home = mkdtempSync(join(tmpdir(), "cd-directory-validate-"));
  try {
    const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"), DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    if (process.platform === "win32") Object.assign(env, { SystemRoot: process.env.SystemRoot ?? "", APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") });
    const version = (spawnSync(claude, ["--version"], { env, encoding: "utf8", timeout: 60_000 }).stdout ?? "").trim();
    const r = spawnSync(claude, ["plugin", "validate", "--profile", "directory", "--strict", "--json", dir], { env, encoding: "utf8", timeout: 180_000 });
    let report;
    try { report = JSON.parse(r.stdout); } catch { /* an older Claude Code: no --json or no --profile */ }
    const problems = [];
    if (report) {
      for (const part of [report.manifest, ...(report.contents ?? [])].filter(Boolean)) for (const kind of ["errors", "warnings"]) for (const p of part[kind] ?? []) problems.push(`${kind.slice(0, -1)}: ${relative(dir, part.file ?? dir) || "."} ${p.path ?? ""}: ${p.message ?? JSON.stringify(p)}`);
      for (const f of report.directory?.findings ?? []) problems.push(`directory ${f.severity ?? ""}: ${f.code ?? ""} ${f.message ?? f.title ?? JSON.stringify(f)}`);
    }
    return { ok: r.status === 0 && !!report && problems.length === 0, code: r.status, version, problems, notes: [...(report?.directory?.notes ?? []), ...(report?.contents ?? []).flatMap((c) => c.notes ?? [])], raw: report ? undefined : (r.stdout ?? "") + (r.stderr ?? "") };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const known = new Set(["--out", "--no-mod", "--validate", "--claude"]);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i])) { console.error(`build-directory-plugin: unknown argument ${argv[i]}`); return 2; }
    if (argv[i] === "--out" || argv[i] === "--claude") i++;
  }
  const mod = !argv.includes("--no-mod");
  const out = resolve(opt("--out") ?? join(REPO, "build", mod ? "directory-plugin" : "directory-plugin-no-mod"));
  let r;
  try {
    r = await buildDirectoryPlugin({ out, mod });
  } catch (e) {
    console.error(`build-directory-plugin: ${e.message}`);
    return 2;
  }
  console.log(`Built ${out} (${mod ? "with the mod" : "without the mod"}): ${r.files} files`);
  const bad = [];
  if (r.overFileCount) bad.push(`more than ${LIMITS.files} files: held for a reviewer`);
  for (const [k, what] of [["stops", "5 MiB or more: the portal's validation stops"], ["links", "a symbolic link"], ["systemFiles", "a macOS or Windows system file: blocks"], ["lockfiles", "a lockfile: a dependency install, held for a reviewer"]]) for (const f of r[k]) bad.push(`${f}: ${what}`);
  for (const f of bad) console.log(`✗ ${f}`);
  for (const f of r.held) console.log(`⚠ ${f}: over 256 KiB, held for a reviewer (expected for the MCP server's bundle)`);
  let code = bad.length ? 1 : 0;
  if (argv.includes("--validate")) {
    const { findClaude } = await import(pathToFileURL(join(REPO, "scripts", "canary.mjs")).href);
    const claude = opt("--claude") ?? findClaude();
    if (!claude || !existsSync(claude)) { console.error("build-directory-plugin: no Claude Code found; pass --claude <binary>"); return 2; }
    const v = validate(claude, out);
    console.log(`${v.ok ? "✓" : "✗"} claude plugin validate --profile directory --strict on Claude Code ${v.version || "(version unknown)"}: ${v.ok ? "no errors, no warnings, no directory findings" : `exit ${v.code}`}`);
    for (const p of v.problems) console.log(`  ${p}`);
    for (const n of v.notes) console.log(`  note: ${n}`);
    if (v.raw) console.log(v.raw.trim().split("\n").slice(-8).map((l) => `  ${l}`).join("\n"));
    if (!v.ok) code = 1;
  }
  return code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`build-directory-plugin: ${e.message}`); process.exit(2); });
}
