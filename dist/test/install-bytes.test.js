/**
 * Install then uninstall gives every config back byte for byte.
 *
 * Install used to parse each config and write it back with JSON.stringify:
 * a minified file came back indented, an inline array came back one item a
 * line, CRLF became LF, "é" became "é" and 30.0 became 30, so 9 of 11
 * configs differed after a round trip (QA, 0.39.0). Edits are now made to
 * the text, key by key and list item by list item (settingsedit.ts), and
 * uninstall takes out exactly what install put in. The skills folders
 * install had to create go too, once empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
import { appendJsonItem, editJsonText, removeJsonItem, setJsonPath, ABSENT } from "../settingsedit.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function run(home, args) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cliPath, ...args], { env: { ...sandboxEnv(home), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "9.9.9" }, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, out: stdout, err: stderr }));
    });
}
function desktopConfig(home) {
    if (platform() === "darwin")
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (platform() === "win32")
        return join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
    return join(home, ".config", "Claude", "claude_desktop_config.json");
}
/** The 11 config kinds install writes, relative to the home. */
function configFiles(home) {
    return {
        claudeSettings: join(home, ".claude", "settings.json"),
        claudeJson: join(home, ".claude.json"),
        desktop: desktopConfig(home),
        cursorMcp: join(home, ".cursor", "mcp.json"),
        cursorHooks: join(home, ".cursor", "hooks.json"),
        codexToml: join(home, ".codex", "config.toml"),
        codexHooks: join(home, ".codex", "hooks.json"),
        gemini: join(home, ".gemini", "settings.json"),
        antigravity: join(home, ".gemini", "config", "mcp_config.json"),
        copilotMcp: join(home, ".copilot", "mcp-config.json"),
        copilotOtherHooks: join(home, ".copilot", "hooks", "other.json"),
    };
}
/** Every file and folder under `dir`, except the backups install keeps on purpose. */
function tree(dir) {
    const out = [];
    const walk = (d) => {
        for (const name of readdirSync(d)) {
            const p = join(d, name);
            if (name.endsWith(".context-doctor.backup"))
                continue;
            out.push(relative(dir, p) + (statSync(p).isDirectory() ? "/" : ""));
            if (statSync(p).isDirectory())
                walk(p);
        }
    };
    walk(dir);
    return out.sort();
}
function writeAll(home, contents) {
    const files = configFiles(home);
    for (const [k, text] of Object.entries(contents)) {
        mkdirSync(dirname(files[k]), { recursive: true });
        writeFileSync(files[k], text);
    }
}
/** As people write them: CRLF, tabs, four spaces, inline objects and arrays, escapes, 30.0 and 1e3, comments in Gemini's. */
const HAND_WRITTEN = {
    claudeSettings: '{\r\n  "model": "opus",\r\n  "env": { "FOO": "bär", "ESC": "\\u00e9" },\r\n  "cleanupPeriodDays": 30.0,\r\n  "hooks": {\r\n    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "echo mine" } ] } ]\r\n  },\r\n  "permissions": { "allow": ["Bash(ls:*)", "Read"] }\r\n}\r\n',
    claudeJson: '{\n\t"numStartups": 3,\n\t"mcpServers": {\n\t\t"other": {"command": "x", "args": []}\n\t},\n\t"projects": {}\n}\n',
    desktop: '{\n    "mcpServers": {\n        "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }\n    },\n    "globalShortcut": "Ctrl+Space"\n}',
    cursorMcp: '{"mcpServers":{"perplexity":{"command":"npx","args":["-y","@perplexity-ai/mcp-server"]}}}',
    cursorHooks: '{"version":1,"hooks":{"stop":[{"command":"echo cursor-stop"}]}}\n',
    codexToml: '# my codex config\nmodel = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["--x"]  # keep me\n\n[profiles.fast]\nmodel = "gpt-5.5-mini"\n',
    codexHooks: '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo codex-stop"}]}]}}\n',
    gemini: '{\n  // my theme\n  "theme": "Dracula", /* inline, with a "quote" */\n  "url": "https://example.com/a//b",\n  "mcpServers": { "gh": { "command": "gh-mcp" } } // servers\n}\n',
    antigravity: '{"mcpServers":{"ag-other":{"command":"ag"}}}\n',
    copilotMcp: '{\n  "mcpServers": {\n    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "timeout": 1e3, "note": "café" }\n  }\n}\n',
    copilotOtherHooks: '{"version":1,"hooks":{"sessionStart":[{"type":"command","bash":"echo other"}]}}\n',
};
/** Minified, no final newline, and no hooks or mcpServers yet: install makes the containers, uninstall takes them out. */
const MINIFIED = {
    claudeSettings: '{"model":"opus","env":{"FOO":"bar"},"n":1.50}',
    claudeJson: '{"numStartups":3,"projects":{}}',
    desktop: '{"globalShortcut":"Ctrl+Space"}',
    cursorMcp: '{"mcpServers":{}}',
    cursorHooks: '{"version":1}',
    codexToml: 'model = "gpt-5.5"',
    codexHooks: '{"hooks":{}}',
    gemini: '{"theme":"Dracula"}',
    antigravity: '{"x":"\\u00e9"}',
    copilotMcp: '{"mcpServers":{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/"}}}',
    copilotOtherHooks: '{"version":1,"hooks":{}}',
};
for (const [name, contents] of [["hand-written", HAND_WRITTEN], ["minified", MINIFIED]]) {
    test(`install, install again, uninstall: all 11 ${name} configs come back byte for byte`, async () => {
        const home = mkdtempSync(join(tmpdir(), `ctxdoc-bytes-${name}-`));
        writeAll(home, contents);
        const before = tree(home);
        const first = await run(home, ["install", "--statusline"]);
        assert.equal(first.code, 0, first.out + first.err);
        const files = configFiles(home);
        // Install did write into each config it owns an entry in, and each still parses.
        for (const k of ["claudeSettings", "claudeJson", "desktop", "cursorMcp", "cursorHooks", "codexHooks", "gemini", "antigravity", "copilotMcp"]) {
            const text = readFileSync(files[k], "utf8");
            assert.match(text, /context-doctor|cli\.js/, `${k}: install wrote nothing\n${text}`);
            if (k !== "gemini")
                JSON.parse(text);
        }
        assert.ok(existsSync(join(home, ".claude", "skills", "context-doctor", "SKILL.md")));
        assert.ok(existsSync(join(home, ".codex", "skills", "context-doctor", "SKILL.md")));
        if (name === "minified") {
            // Additions to a minified file are minified too.
            assert.ok(!readFileSync(files.cursorMcp, "utf8").includes("\n"), readFileSync(files.cursorMcp, "utf8"));
        }
        if (name === "hand-written") {
            const s = readFileSync(files.claudeSettings, "utf8");
            assert.ok(!/[^\r]\n/.test(s), "CRLF stays CRLF");
            assert.ok(s.includes('"ESC": "\\u00e9"') && s.includes('"cleanupPeriodDays": 30.0,'), s);
            assert.ok(readFileSync(files.gemini, "utf8").includes("// my theme"), "Gemini's comments are kept");
        }
        const again = await run(home, ["install", "--statusline"]);
        assert.equal(again.code, 0, again.out + again.err);
        const un = await run(home, ["uninstall"]);
        assert.equal(un.code, 0, un.out + un.err);
        for (const [k, text] of Object.entries(contents))
            assert.equal(readFileSync(files[k], "utf8"), text, `${k} changed by the round trip`);
        // Nothing of ours is left: no skills folder install made, no marker, no hook file.
        assert.deepEqual(tree(home), before);
    });
}
test("uninstall never removes a skills folder that was there before, or one with something else in it", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-bytes-skills-"));
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    assert.equal((await run(home, ["install"])).code, 0);
    // The user adds a skill of their own to the folder install created for Codex.
    mkdirSync(join(home, ".codex", "skills", "mine"), { recursive: true });
    writeFileSync(join(home, ".codex", "skills", "mine", "SKILL.md"), "---\nname: mine\n---\n");
    assert.equal((await run(home, ["uninstall"])).code, 0);
    assert.ok(existsSync(join(home, ".claude", "skills")), "the user's own (empty) skills folder stays");
    assert.ok(existsSync(join(home, ".codex", "skills", "mine", "SKILL.md")), "a folder with the user's skill in it stays");
    assert.ok(!existsSync(join(home, ".claude", "skills", "context-doctor")));
    assert.ok(!existsSync(join(home, ".codex", ".context-doctor-created.json")), "the marker goes");
});
test("a Gemini CLI settings.json with comments is edited, not refused as invalid JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-bytes-gemini-"));
    mkdirSync(join(home, ".gemini"), { recursive: true });
    const original = '{\n  // Gemini CLI reads this with strip-json-comments\n  "theme": "Dracula" /* mine */\n}\n';
    writeFileSync(join(home, ".gemini", "settings.json"), original);
    const r = await run(home, ["install"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(!/not valid JSON/.test(r.out + r.err), r.err);
    const text = readFileSync(join(home, ".gemini", "settings.json"), "utf8");
    assert.ok(text.includes("// Gemini CLI reads this") && text.includes("/* mine */"), text);
    assert.match(text, /"context-doctor"/);
    assert.match(text, /"BeforeAgent"/);
    const doc = await run(home, ["doctor"]);
    assert.match(doc.out, /✓ Gemini CLI MCP/, "doctor reads the commented file too");
    assert.equal((await run(home, ["uninstall"])).code, 0);
    assert.equal(readFileSync(join(home, ".gemini", "settings.json"), "utf8"), original);
});
test("text edits: an added item or key taken out again gives back the exact text", () => {
    const samples = [
        '{"a":[1,2],"b":{}}',
        '{ "a": [ 1, 2 ], "b": { "c": 1 } }',
        '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}\n',
        '{\r\n\t"a": [],\r\n\t"b": {\r\n\t\t"c": 1.0\r\n\t}\r\n}\r\n',
        '{\n  "a": [1] // one\n  , "b": {} /* two */\n}',
    ];
    for (const s of samples) {
        const added = appendJsonItem(s, ["a"], { hooks: [{ type: "command", command: "x" }] });
        const n = JSON.parse(s.replace(/\/\/[^\n]*|\/\*.*?\*\//g, "")).a.length;
        assert.equal(removeJsonItem(added, ["a"], n), s, `item round trip of ${JSON.stringify(s)}`);
        const keyed = setJsonPath(s, ["b", "k"], { x: [1, 2] });
        assert.equal(setJsonPath(keyed, ["b", "k"], ABSENT), s, `key round trip of ${JSON.stringify(s)}`);
    }
    // Removing an item in the middle keeps a comment that belongs to the next one.
    assert.equal(removeJsonItem('[\n  1,\n  // two\n  2\n]'.replace(/^/, '{"a":') + "}", ["a"], 0), '{"a":[\n  // two\n  2\n]}');
    // editJsonText: only what differs is touched.
    const text = '{"keep":  1.0, "list": [ "x", "ours" ], "gone": true}';
    assert.equal(editJsonText(text, { keep: 1, list: ["x"] }), '{"keep":  1.0, "list": [ "x" ]}');
});
