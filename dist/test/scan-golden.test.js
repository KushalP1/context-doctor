/**
 * The shared scan (scan.ts) changes how often a transcript is read, never a
 * figure: every history report, text and JSON, on the fixture history
 * (history-fixture.ts), byte for byte against the outputs the code before it
 * printed (src/test/golden, made by scripts/gen-scan-golden.mjs): with
 * nothing cached, with the cache written by the run before, and after the
 * history grew, from a cache that resumes where it stopped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHistory, growHistory, GOLDEN_COMMANDS } from "./history-fixture.js";
import { goldenName, runReport } from "./golden-run.js";
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "cli.js");
const golden = (stage, args) => readFileSync(join(here, "..", "..", "src", "test", "golden", stage, goldenName(args)), "utf8");
function check(stage, home, env, label, commands = GOLDEN_COMMANDS) {
    for (const args of commands) {
        assert.equal(runReport(cli, home, args, env), golden(stage, args), `${label}: context-doctor ${args.join(" ")}`);
    }
}
test("every history report prints what it printed before the shared scan: cold cache, warm cache, no cache, and after the history grew", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-scan-golden-"));
    const cache = mkdtempSync(join(tmpdir(), "cd-scan-cache-"));
    try {
        buildHistory(home);
        const env = { CONTEXT_DOCTOR_CACHE_DIR: cache };
        check("base", home, env, "cold cache");
        const entries = readdirSync(join(cache, "transcripts"), { recursive: true }).filter((f) => String(f).endsWith(".json"));
        assert.ok(entries.length >= 20, `the first run kept its records (${entries.length} entries)`);
        check("base", home, env, "warm cache");
        check("base", home, { CONTEXT_DOCTOR_NO_CACHE: "1", CONTEXT_DOCTOR_CACHE_DIR: join(home, "unused") }, "no cache", [["savings", "--json"], ["fix", "--json"]]);
        growHistory(home);
        check("grown", home, env, "grown, resumed");
    }
    finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
});
