/**
 * The Claude Code plugin (.claude-plugin/) is what users get from
 * `/plugin install context-doctor@context-doctor`. Older Claude Code rejects a
 * manifest with any key it does not know (2.1.62 refused `displayName`), and
 * the plugin must run from its committed files alone, so: known keys only,
 * every referenced file exists, the MCP server bundle runs with no
 * node_modules at all, and Claude Code's dependency install finds nothing to do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
const market = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
test("plugin manifest uses only keys every supported Claude Code accepts", () => {
    const known = new Set(["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "hooks", "mcpServers"]);
    for (const k of Object.keys(manifest))
        assert.ok(known.has(k), `unknown manifest key ${k}`);
    assert.equal(market.plugins[0].name, manifest.name, "entry name and manifest name must match");
    assert.equal(market.plugins[0].source, "./");
});
// The marketplace entry's source is "./", the repository root, which is also
// the npm package: package.json beside package-lock.json. Claude Code runs
// `npm ci --ignore-scripts` in every marketplace copy that has both
// (code.claude.com/docs/en/plugins/loading, "Node.js package dependencies"),
// and its package.json takes devDependencies too: 80 MB (typescript, esbuild,
// the MCP SDKs) and 23 s from the registry at the first session, for a plugin
// that runs from dist/ alone. From 2.1.286 it skips the install for a
// package.json that sets `overrides` (the same page, "No overrides or
// patches"); `{}` changes nothing for npm. 2.1.105 to 2.1.285 still install
// (`npm ci --ignore-scripts` in place), as before. The plugin's runtime needs no
// package, so dependencies must stay empty: a plugin that listed one would
// lose it here.
test("Claude Code's dependency install skips the plugin: package.json sets overrides and lists no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(pkg.overrides, {}, "package.json `overrides: {}` keeps Claude Code from installing the devDependencies into the plugin");
    for (const k of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"])
        assert.equal(pkg[k], undefined, `package.json ${k}: the plugin and the npm package run from dist/ alone`);
    for (const k of ["preinstall", "install", "postinstall", "prepare"])
        assert.equal(pkg.scripts?.[k], undefined, `package.json scripts.${k}: nothing runs at install time`);
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.packages[""].dependencies, undefined, "package-lock.json lists no runtime dependencies");
});
test("every file the plugin references exists, and every skill has frontmatter", () => {
    const sub = (s) => s.replace("${CLAUDE_PLUGIN_ROOT}", root);
    assert.ok(existsSync(sub(manifest.mcpServers["context-doctor"].args[0])));
    const hookCmd = manifest.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(existsSync(join(root, "dist", "cli.js")) && hookCmd.includes("dist/cli.js\" hook"));
    const skillsDir = join(root, manifest.skills);
    const skills = readdirSync(skillsDir);
    assert.ok(skills.length >= 3);
    for (const s of skills) {
        const md = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
        assert.match(md, new RegExp(`^---\\r?\\nname: ${s}\\r?\\ndescription: .{40,}`), `${s}/SKILL.md frontmatter`);
    }
});
test("the bundled MCP server answers from a directory with no node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-bundle-"));
    copyFileSync(join(root, "dist", "mcp.bundle.js"), join(dir, "mcp.bundle.js"));
    const child = spawn(process.execPath, [join(dir, "mcp.bundle.js")], { stdio: ["pipe", "pipe", "ignore"], cwd: dir });
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    const reply = new Promise((resolve, reject) => {
        let out = "";
        const t = setTimeout(() => reject(new Error(`no tools/list or prompts/list reply: ${out.slice(0, 200)}`)), 10_000);
        child.stdout.on("data", (d) => { out += d; if (out.includes(`"id":2`) && out.includes(`"id":3`)) {
            clearTimeout(t);
            resolve(out);
        } });
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "prompts/list" });
    try {
        const out = await reply;
        assert.match(out, /profile_context/);
        assert.match(out, /optimize_context/);
        // The Claude Desktop bundle's manifest lists the tools by hand: it listed
        // four of six after save_handoff and recall were added.
        const tools = JSON.parse(out.split("\n").find((l) => l.includes('"id":2'))).result.tools.map((t) => t.name);
        const mcpb = readFileSync(join(root, "scripts", "build-mcpb.mjs"), "utf8");
        const listed = [...(/tools: \[([\s\S]*?)\n {2}\],/.exec(mcpb)?.[1] ?? "").matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);
        assert.deepEqual(listed.sort(), tools.sort(), "scripts/build-mcpb.mjs lists the server's tools");
        assert.match(mcpb, new RegExp(`Adds ${["", "one", "two", "three", "four", "five", "six", "seven", "eight"][tools.length]} tools`));
        // The prompts too: it listed context_checkup alone after handoff and ask_file were added.
        const prompts = JSON.parse(out.split("\n").find((l) => l.includes('"id":3'))).result.prompts;
        const promptBlock = /prompts: \[([\s\S]*?)\n {2}\],/.exec(mcpb)?.[1] ?? "";
        const listedPrompts = [...promptBlock.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);
        assert.deepEqual(listedPrompts.sort(), prompts.map((p) => p.name).sort(), "scripts/build-mcpb.mjs lists the server's prompts");
        for (const p of prompts) {
            const entry = new RegExp(`name: "${p.name}",[\\s\\S]*?(?=\\n {4}\\}|$)`).exec(promptBlock)?.[0] ?? "";
            for (const a of p.arguments ?? [])
                assert.match(entry, new RegExp(`"${a.name}"`), `${p.name} lists its argument ${a.name}`);
        }
    }
    finally {
        child.kill();
    }
});
test("the GitHub Action runs its own version unless `version:` names another", { skip: process.platform === "win32" && "the step is bash" }, () => {
    const action = readFileSync(join(root, "action.yml"), "utf8");
    assert.match(action, /version:\n\s+description: [^\n]+\n\s+required: false\n\s+default: ""/, "the default is empty: the Action's own version");
    const fragment = /# version:start[^\n]*\n([\s\S]*?)# version:end/.exec(action)?.[1];
    assert.ok(fragment, "action.yml marks the version step");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const run = (version, actionPath = root) => spawnSync("bash", ["-c", `${fragment}\necho "$CD_VERSION"`], { env: { ...process.env, CD_VERSION: version, GITHUB_ACTION_PATH: actionPath }, encoding: "utf8" }).stdout.trim();
    assert.equal(run(""), pkg.version, "a pinned tag runs the release it names");
    assert.equal(run("latest"), "latest");
    assert.equal(run("0.40.0"), "0.40.0");
    assert.equal(run("", mkdtempSync(join(tmpdir(), "cd-action-"))), "latest", "no package.json beside the Action: npm's newest");
});
test("the GitHub Action installs context-doctor outside the checkout, so a pull request's .npmrc picks no registry or shell", { skip: process.platform === "win32" && "the step is bash" }, () => {
    const action = readFileSync(join(root, "action.yml"), "utf8");
    assert.doesNotMatch(action.replace(/^\s*#.*$/gm, ""), /\bnpx\b/, "npx in the checkout reads its .npmrc");
    const fragment = /# install:start[^\n]*\n([\s\S]*?)# install:end/.exec(action)?.[1];
    assert.ok(fragment, "action.yml marks the install step");
    // A stand-in npm that says where it ran; the checkout carries an .npmrc of its own.
    const tmp = mkdtempSync(join(tmpdir(), "cd-action-npm-"));
    const bin = join(tmp, "bin"), checkout = join(tmp, "checkout"), runnerTemp = join(tmp, "runner-temp");
    for (const d of [bin, checkout, runnerTemp])
        mkdirSync(d);
    writeFileSync(join(checkout, ".npmrc"), "registry=http://127.0.0.1:9/\n");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm in $(pwd -P)"\n`, { mode: 0o755 });
    const r = spawnSync("bash", ["-c", `${fragment}\necho "cmd \${cd_cmd[*]}"`], { cwd: checkout, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CD_VERSION: "0.44.0", RUNNER_TEMP: runnerTemp, GITHUB_ACTION_PATH: root }, encoding: "utf8" });
    assert.match(r.stderr, new RegExp(`npm in ${realpathSync(runnerTemp).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), r.stderr);
    assert.match(r.stdout, /^cmd node .*context-doctor-cli\/node_modules\/context-doctor\/dist\/cli\.js$/m, r.stdout);
});
/**
 * Plain (unquoted) YAML values with ": " inside, which a parser refuses
 * ("mapping values are not allowed in this context"). action.yml's
 * `comment` input said "Needs `pull-requests: write`." unquoted, so the
 * runner could not load the Action at all (libyaml, which GitHub's YAML
 * library follows, stops there). No YAML parser is a dependency here, so
 * this reads the lines: block scalars (| and >) are skipped.
 */
function plainScalarProblems(yaml) {
    const out = [];
    let block = -1; // the column of the key whose block scalar is being read
    yaml.split(/\r?\n/).forEach((line, i) => {
        const indent = line.search(/\S/);
        if (block >= 0) {
            if (indent === -1 || indent > block)
                return;
            block = -1;
        }
        const m = /^(\s*(?:- )?)[\w.-]+:\s+(.*)$/.exec(line);
        if (!m)
            return;
        const value = m[2];
        if (/^[|>][-+]?\s*$/.test(value))
            block = m[1].length;
        // A comment after the value (" # …") is fine; ": " before it is not.
        else if (!/^["'[{&*!#]/.test(value) && /: /.test(value.replace(/\s+#.*$/, "")))
            out.push(`line ${i + 1}: ${line.trim()}`);
    });
    return out;
}
test("action.yml and the workflows hold no unquoted value with ': ' inside, which a YAML parser refuses", () => {
    assert.deepEqual(plainScalarProblems('a:\n  description: Needs `pull-requests: write`.\n'), ["line 2: description: Needs `pull-requests: write`."], "the check sees the case it is for");
    assert.deepEqual(plainScalarProblems('run: |\n  echo "a: b # c"\nnext: "x: y"\nid-token: write # a: comment\n'), [], "block scalars, quoted values and comments are fine");
    const files = ["action.yml", ...readdirSync(join(root, ".github", "workflows")).map((f) => join(".github", "workflows", f))];
    for (const f of files)
        assert.deepEqual(plainScalarProblems(readFileSync(join(root, f), "utf8")), [], f);
});
test("build-mcpb: npm and npx run on Windows too, and the signing key's PEM is removed even when signing fails", () => {
    const text = readFileSync(join(root, "scripts", "build-mcpb.mjs"), "utf8");
    // execFileSync("npm") is ENOENT on Windows (npm.cmd), and a .cmd needs a shell since CVE-2024-27980.
    assert.doesNotMatch(text, /execFileSync\("np[mx]"/, "npm and npx go through run(), which uses npm.cmd and a shell on Windows");
    assert.match(text, /execFileSync\(`\$\{cmd\}\.cmd`, args\.map\(quote\), \{ \.\.\.opts, shell: true \}\)/);
    // The PEM files are written inside the try whose finally removes them.
    const tryAt = text.indexOf("try {\n  cert = pemPath(");
    const finallyAt = text.indexOf("} finally {", tryAt);
    assert.ok(tryAt > 0 && finallyAt > tryAt, "the key is written inside a try");
    assert.match(text.slice(finallyAt, finallyAt + 200), /rmSync\(join\(root, "build", f\)/, "and removed in its finally");
    assert.ok(text.indexOf('pemPath(process.env.MCPB_KEY') > tryAt, "not before the try");
});
test("the build scripts find their own folder in a checkout whose path has a space (a URL's pathname is %20-encoded)", () => {
    for (const f of readdirSync(join(root, "scripts")).filter((n) => /\.m?js$/.test(n))) {
        const text = readFileSync(join(root, "scripts", f), "utf8");
        assert.doesNotMatch(text, /import\.meta\.url\)\.pathname/, `scripts/${f}: use fileURLToPath(new URL(..., import.meta.url))`);
    }
});
test("MCP Registry: server.json matches package.json and the registry's limits", () => {
    const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(server.name, pkg.mcpName, "registry name must equal package.json mcpName");
    assert.match(server.name, /^io\.github\.KushalP1\//);
    assert.ok(server.description.length <= 100, `description is ${server.description.length} chars; the registry allows 100`);
    assert.equal(server.version, pkg.version, "bump server.json with package.json");
    assert.equal(server.packages[0].version, pkg.version);
    assert.equal(server.packages[0].identifier, pkg.name);
    assert.deepEqual(server.packages[0].packageArguments, [{ type: "positional", value: "mcp" }]);
});
