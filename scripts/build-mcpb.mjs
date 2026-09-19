#!/usr/bin/env node
/**
 * Build the Claude Desktop one-click bundle (context-doctor-<version>.mcpb).
 *
 * An .mcpb is a zip with a manifest.json, the server files and their
 * node_modules. Claude Desktop installs it by double-click (Settings >
 * Extensions), runs it on its own bundled Node, and shows the tools and the
 * context_checkup prompt without the user touching claude_desktop_config.json.
 *
 * Steps: stage dist/ (minus tests) + a production-only package.json into
 * build/mcpb, `npm install --omit=dev` there, write the manifest from
 * package.json, then `mcpb pack` and `mcpb validate`. Run `npm run build` first.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, "build", "mcpb");
const out = join(root, `context-doctor-${pkg.version}.mcpb`);

if (!existsSync(join(root, "dist", "mcp.js"))) {
  console.error("dist/mcp.js missing: run `npm run build` first");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true, filter: (src) => !src.includes(`${join("dist", "test")}`) });
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));

// Production dependencies only; devDependencies (typescript, @types) would triple the bundle.
writeFileSync(join(stage, "package.json"), JSON.stringify({
  name: pkg.name, version: pkg.version, type: pkg.type, private: true, dependencies: pkg.dependencies,
}, null, 2));
execFileSync("npm", ["install", "--omit=dev", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: stage, stdio: "inherit" });

const manifest = {
  manifest_version: "0.3",
  name: "context-doctor",
  display_name: "Context Doctor",
  version: pkg.version,
  description: "See what is eating your context and reclaim it: token breakdown, wasted-context findings, one-click checkup.",
  long_description:
    "Adds three tools and a checkup prompt to Claude Desktop. profile_context measures the conversation " +
    "(pass a sketch in chat: turn count plus the large or repeated blocks), finds duplicates, oversized pastes, " +
    "base64 blobs and long history, and tells Claude what to summarize or drop. optimize_context rewrites an " +
    "exported conversation with deterministic, inspectable strategies. context_best_practices is a checklist. " +
    "Standing hygiene rules ride in every chat where the extension is enabled. Nothing leaves your machine.",
  author: { name: pkg.author?.name ?? pkg.author ?? "gAI Ventures", url: "https://github.com/KushalP1" },
  repository: { type: "git", url: "https://github.com/KushalP1/context-doctor" },
  homepage: "https://github.com/KushalP1/context-doctor",
  documentation: "https://github.com/KushalP1/context-doctor#readme",
  support: "https://github.com/KushalP1/context-doctor/issues",
  license: pkg.license ?? "MIT",
  keywords: ["context", "tokens", "cost", "prompt-caching", "context-window", "llm"],
  server: {
    type: "node",
    entry_point: "dist/mcp.js",
    mcp_config: { command: "node", args: ["${__dirname}/dist/mcp.js"], env: {} },
  },
  tools: [
    { name: "profile_context", description: "Token breakdown and wasted-context findings for a conversation or a sketch of it" },
    { name: "optimize_context", description: "Rewrite an exported conversation to reclaim tokens with deterministic strategies" },
    { name: "context_best_practices", description: "Curated context-management checklist, optionally per provider" },
  ],
  prompts: [
    {
      name: "context_checkup",
      description: "Profile this conversation's context and apply the top fix. One click, no typing.",
      text: "Run profile_context on our conversation so far with a sketch, report the total and top findings, then apply the top fix.",
    },
  ],
  compatibility: { claude_desktop: ">=0.10.0", platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=20" } },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));

rmSync(out, { force: true });
execFileSync("npx", ["--yes", MCPB_CLI, "validate", join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync("npx", ["--yes", MCPB_CLI, "pack", stage, out], { stdio: "inherit" });
console.log(`\nBundle: ${out}`);
