/**
 * `spend` reads OpenCode and Cline. OpenCode: its JSON files and its
 * SQLite store (both tables), a message in both counted once, a forked
 * session's copy of its parent not again, a message run through Claude Code
 * (claude-agent) left to Claude Code's own transcript. Cline: the editor
 * extension's tasks, the older CLI's tasks and the CLI's sessions, only
 * complete `api_req_started` requests, a request with no model taking the
 * task's. Shapes from ccusage's loaders (opencode.ts, cline.ts), numbers
 * made up; each total priced by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clineSpend, opencodeSpend, renderSpend, spendReport } from "../spend.js";
import { clearScanMemo } from "../scan.js";
import { withSandboxHome } from "./sandbox.js";
const require = createRequire(import.meta.url);
let DatabaseSync;
try {
    ({ DatabaseSync } = require("node:sqlite"));
}
catch {
    DatabaseSync = undefined;
}
const noSqlite = DatabaseSync ? false : "no node:sqlite on this runtime";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const T = NOW - 2 * DAY;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const put = (file, value) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
};
const sonnet = { modelID: "claude-sonnet-4-5", providerID: "anthropic" };
/** OpenCode's JSON files: an assistant message with a path, a user message, a claude-agent one, one with no path whose session names its folder. */
export function writeOpenCodeJson(home) {
    const root = join(home, ".local", "share", "opencode", "storage");
    put(join(root, "session", "proj1", "ses_a.json"), { id: "ses_a", directory: "/Users/dev/tech/api", title: "SECRET TITLE" });
    const msg = (id, m) => put(join(root, "message", "ses_a", `${id}.json`), { id, sessionID: "ses_a", ...m });
    msg("msg_1", { role: "assistant", ...sonnet, time: { created: T, completed: T + 900 }, tokens: { input: 1_000, output: 200, reasoning: 50, cache: { read: 4_000, write: 500 } }, path: { cwd: "/Users/dev/tech/api", root: "/Users/dev/tech/api" } });
    msg("msg_2", { role: "user", time: { created: T - 10 }, content: "SECRET PROMPT" });
    msg("msg_3", { role: "assistant", modelID: "opus", providerID: "claude-agent", time: { created: T + 50 }, tokens: { input: 99_999, output: 1 } });
    // A total above the parts: the rest is output.
    msg("msg_4", { role: "assistant", modelID: "gpt-5.4", providerID: "openai", time: { created: T + 100 }, tokens: { input: 2_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 }, total: 2_300 } });
}
/** By hand: Sonnet 4.5 ($3 / $0.30 read / $3.75 write / $15) 1,000 + 4,000 + 500 + 250 out; GPT-5.4 ($2.50 / $15) 2,000 + 300 out. */
const OPENCODE_JSON_USD = (1_000 * 3 + 4_000 * 0.3 + 500 * 3.75 + 250 * 15 + 2_000 * 2.5 + 300 * 15) / 1e6;
/** OpenCode's SQLite store: msg_1 again (the store a migration made), a message of its own; v2 rows with a fork that copies its parent through p2. */
function writeOpenCodeDb(home) {
    const file = join(home, ".local", "share", "opencode", "opencode.db");
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, fork_session_id TEXT, fork_boundary TEXT);`);
    const m = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
    m.run("msg_1", "ses_a", T, JSON.stringify({ id: "msg_1", role: "assistant", ...sonnet, time: { created: T }, tokens: { input: 1_000, output: 200, reasoning: 50, cache: { read: 4_000, write: 500 } } }));
    m.run("msg_db1", "ses_b", T + 200, JSON.stringify({ role: "assistant", modelID: "gpt-5.4", providerID: "openai", time: { created: T + 200 }, tokens: { input: 500, output: 50 } }));
    m.run("msg_old", "ses_b", NOW - 60 * DAY, JSON.stringify({ role: "assistant", modelID: "gpt-5.4", time: { created: NOW - 60 * DAY }, tokens: { input: 500_000, output: 50 } }));
    db.prepare("INSERT INTO session VALUES (?, ?, ?)").run("ses_b", "/Users/dev/tech/web", "SECRET TITLE");
    const v2 = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
    const turn = (input, output, extra = {}) => JSON.stringify({ model: { id: "claude-sonnet-4-5", providerID: "anthropic" }, tokens: { input, output }, ...extra });
    v2.run("p1", "ses_p", "assistant", 1, T + 300, turn(300, 30));
    v2.run("p2", "ses_p", "assistant", 2, T + 400, turn(400, 40));
    v2.run("p3", "ses_p", "compaction", 3, T + 500, turn(1_000, 100, { status: "completed" }));
    v2.run("p4", "ses_p", "compaction", 4, T + 550, turn(9_999, 999, { status: "running" }));
    v2.run("pu", "ses_p", "user", 5, T + 560, JSON.stringify({ text: "SECRET PROMPT" }));
    v2.run("f1", "ses_f", "assistant", 1, T + 600, turn(300, 30));
    v2.run("f2", "ses_f", "assistant", 2, T + 600, turn(400, 40));
    v2.run("f3", "ses_f", "assistant", 3, T + 700, turn(600, 60));
    const s2 = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)");
    s2.run("ses_p", "/Users/dev/tech/api", null, null);
    s2.run("ses_f", "/Users/dev/tech/api", "ses_p", JSON.stringify({ type: "through", messageID: "p2" }));
    db.close();
}
/** By hand: msg_db1 at GPT-5.4; p1, p2, p3 (the completed compaction) and the fork's own f3 at Sonnet 4.5. */
const OPENCODE_DB_USD = (500 * 2.5 + 50 * 15 + 300 * 3 + 30 * 15 + 400 * 3 + 40 * 15 + 1_000 * 3 + 100 * 15 + 600 * 3 + 60 * 15) / 1e6;
/** Cline: an extension task (one request names its model, one takes the task's, four that are not requests), a CLI session, an older CLI task. */
export function writeCline(home) {
    const ext = join(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
    put(join(ext, "state", "taskHistory.json"), [{ id: "t1", ts: T, task: "SECRET TASK", cwdOnTaskInitialization: "/Users/dev/tech/app" }]);
    const req = (ts, t, extra = {}) => ({ ts, type: "say", say: "api_req_started", text: JSON.stringify({ request: "SECRET PROMPT /Users/dev/tech/app/secret.ts", ...t }), ...extra });
    put(join(ext, "tasks", "t1", "ui_messages.json"), [
        { ts: T - 5, type: "say", say: "task", text: "SECRET TASK" },
        req(T, { tokensIn: 100, tokensOut: 20, cacheReads: 5_000, cacheWrites: 1_000, cost: 0.01 }, { modelInfo: { modelId: "claude-sonnet-4-5", providerId: "anthropic", mode: "act" } }),
        req(T + 100, { tokensIn: 200, tokensOut: 40, cacheReads: 0, cacheWrites: 0 }),
        req(T + 150, {}),
        req(T + 200, { tokensIn: 999, tokensOut: 9, cacheReads: 0, cacheWrites: 0 }, { partial: true, modelInfo: { modelId: "claude-sonnet-4-5" } }),
        { ts: T + 300, type: "say", say: "deleted_api_reqs", modelInfo: { modelId: "claude-sonnet-4-5" }, text: JSON.stringify({ tokensIn: 15, tokensOut: 5, cacheReads: 1, cacheWrites: 2 }) },
        { ts: T + 400, type: "say", say: "subagent_usage", modelInfo: { modelId: "claude-sonnet-4-5" }, text: JSON.stringify({ tokensIn: 25, tokensOut: 10, cacheReads: 5, cacheWrites: 2 }) },
    ]);
    put(join(ext, "tasks", "t1", "task_metadata.json"), { model_usage: [{ ts: T - 1_000, model_id: "gpt-5.4", model_provider_id: "openai", mode: "act" }], files_in_context: [{ path: "SECRET/PATH.ts" }] });
    put(join(home, ".cline", "data", "sessions", "s1", "s1.messages.json"), { version: 1, sessionId: "s1", messages: [
            { role: "user", timestamp: new Date(T).toISOString(), content: "SECRET PROMPT" },
            { role: "assistant", ts: T + 500, id: "a1", modelInfo: { id: "claude-sonnet-4-5", provider: "anthropic" }, metrics: { inputTokens: 1_200, outputTokens: 30, cacheReadTokens: 800, cacheWriteTokens: 100, cost: 0 } },
            { role: "assistant", ts: T + 600, id: "a2", modelInfo: { id: "unknown" }, metrics: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        ] });
    put(join(home, ".cline", "data", "tasks", "t9", "ui_messages.json"), [req(T + 700, { tokensIn: 8, tokensOut: 4 }, { modelInfo: { modelId: "vendor/legacy-model" } })]);
}
/** By hand: Sonnet 4.5 100 + 5,000 read + 1,000 written + 20 out; GPT-5.4 200 + 40 out; the CLI's Sonnet 300 + 800 read + 100 written + 30 out. Two more counted, not priced. */
const CLINE_USD = (100 * 3 + 5_000 * 0.3 + 1_000 * 3.75 + 20 * 15 + 200 * 2.5 + 40 * 15 + 300 * 3 + 800 * 0.3 + 100 * 3.75 + 30 * 15) / 1e6;
function sandbox(fn) {
    const home = mkdtempSync(join(tmpdir(), "cd-oc-cline-"));
    const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
    process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, "cache");
    clearScanMemo();
    return withSandboxHome(home, () => fn(home)).finally(() => {
        if (saved === undefined)
            delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
        else
            process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
        clearScanMemo();
        rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    });
}
test("opencode: JSON files, user and claude-agent messages left out, reasoning and the rest of a total as output", async () => {
    await sandbox((home) => {
        writeOpenCodeJson(home);
        const items = opencodeSpend(NOW - 30 * DAY, NOW, home);
        assert.deepEqual(items.map((i) => [i.model, i.input, i.read, i.write, i.output, i.project]), [
            ["claude-sonnet-4-5", 1_000, 4_000, 500, 250, "tech-api"],
            ["gpt-5.4", 2_000, 0, 0, 300, "tech-api"],
        ]);
        close(items.reduce((n, i) => n + i.usd, 0), OPENCODE_JSON_USD, "json");
    });
});
test("opencode: the SQLite store, a message also in the files once, a fork's copies and a running compaction not counted", { skip: noSqlite }, async () => {
    await sandbox((home) => {
        writeOpenCodeJson(home);
        writeOpenCodeDb(home);
        const items = opencodeSpend(NOW - 30 * DAY, NOW, home);
        assert.equal(items.length, 7, items.map((i) => i.key).join(","));
        assert.deepEqual(items.map((i) => i.key).sort(), ["f3", "msg_1", "msg_4", "msg_db1", "p1", "p2", "p3"]);
        close(items.reduce((n, i) => n + i.usd, 0), OPENCODE_JSON_USD + OPENCODE_DB_USD, "json + db");
        assert.equal(items.find((i) => i.key === "msg_db1").project, "tech-web");
    });
});
test("cline: complete requests only, a request with no model takes the task's, the CLI's input less its cache", async () => {
    await sandbox((home) => {
        writeCline(home);
        const items = clineSpend(NOW - 30 * DAY, NOW, home);
        assert.deepEqual(items.map((i) => [i.model ?? null, i.input, i.read, i.write, i.output, i.project, i.priced]), [
            ["claude-sonnet-4-5", 100, 5_000, 1_000, 20, "tech-app", true],
            ["gpt-5.4", 200, 0, 0, 40, "tech-app", true],
            ["claude-sonnet-4-5", 300, 800, 100, 30, "cline", true],
            [null, 10, 0, 0, 2, "cline", false],
            ["vendor/legacy-model", 8, 0, 0, 4, "cline", false],
        ]);
        close(items.reduce((n, i) => n + i.usd, 0), CLINE_USD, "cline");
    });
});
test("opencode and cline: in the report beside the other tools, nothing of a prompt", async () => {
    await sandbox((home) => {
        writeOpenCodeJson(home);
        writeCline(home);
        const r = spendReport(30, { home, now: NOW, claudePaths: [], progress: false });
        const oc = r.tools.find((t) => t.tool === "opencode"), cl = r.tools.find((t) => t.tool === "cline");
        assert.equal(oc.name, "OpenCode");
        close(oc.usd, OPENCODE_JSON_USD, "opencode");
        assert.equal(cl.name, "Cline");
        close(cl.usd, CLINE_USD, "cline");
        assert.equal(cl.unpriced, 2);
        const text = renderSpend(r);
        assert.match(text, /OpenCode\s+\$0\.02\s+2 requests/);
        assert.match(text, /Cline\s+\$0\.01\s+5 requests\s+2 not priced/);
        assert.doesNotMatch(text, /SECRET/);
    });
});
