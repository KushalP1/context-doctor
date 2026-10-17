/**
 * analyze, optimize and diff on a file that is not a conversation: broken
 * JSON, JSON without messages, an array without roles. analyze used to
 * profile it as a handful of tokens and say the context was in good shape;
 * diff compared 0 tokens with 0. Each must fail with the reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "ctxdoc-malformed-"));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: sandboxEnv(dir), cwd: dir, input: "" });
const bad = {
    "broken.json": '{"messages": [',
    "notconv.json": '{"foo": 1}',
    "noroles.json": "[1, 2, 3]",
    "wrongtype.json": '{"messages": "nope"}',
    "empty.json": "",
};
for (const [name, text] of Object.entries(bad))
    writeFileSync(join(dir, name), text);
const good = join(dir, "good.json");
writeFileSync(good, JSON.stringify({ messages: [{ role: "user", content: "hello there" }, { role: "assistant", content: "hi" }] }));
writeFileSync(join(dir, "prompt.txt"), "Just a raw prompt, which is a supported input.");
test("analyze and optimize reject what is not a conversation, with the reason, exit 1", () => {
    for (const name of Object.keys(bad)) {
        for (const cmd of ["analyze", "optimize"]) {
            const r = run(cmd, name);
            assert.equal(r.status, 1, `${cmd} ${name}: ${r.stdout}`);
            assert.match(r.stderr, new RegExp(`Could not ${cmd} ${name.replace(".", "\\.")}: `), `${cmd} ${name}`);
            assert.ok(!/in good shape|CONTEXT DOCTOR — profile/.test(r.stdout), `${cmd} ${name} printed a report`);
        }
        const j = run("analyze", name, "--json");
        assert.equal(j.status, 1);
        assert.equal(j.stdout, "", "no JSON profile of a non-conversation");
    }
});
test("a real conversation and raw text still work", () => {
    assert.equal(run("analyze", good).status, 0);
    assert.equal(run("optimize", good).status, 0);
    const t = run("analyze", "prompt.txt");
    assert.equal(t.status, 0, t.stderr);
});
test("diff refuses a non-conversation, and compares saved profiles for real", () => {
    const r = run("diff", "notconv.json", good);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not diff: .*notconv\.json.*no `messages` array/);
    const b = run("diff", good, "broken.json");
    assert.equal(b.status, 1);
    assert.match(b.stderr, /broken\.json.*does not parse/);
    // `analyze --json` output is a profile: diff reads it as one (it used to read it as 0 tokens).
    const profile = run("analyze", good, "--json").stdout;
    writeFileSync(join(dir, "a.json"), profile);
    const d = run("diff", "a.json", "a.json");
    assert.equal(d.status, 0, d.stderr);
    const tokens = JSON.parse(profile).totalTokens;
    assert.ok(tokens > 0);
    assert.match(d.stdout, new RegExp(`Total: ${tokens} → ${tokens} tokens`));
});
