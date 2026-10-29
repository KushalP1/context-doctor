/**
 * Running the history reports on the fixture history (history-fixture.ts),
 * the way the golden files were made: a clean environment (none of this
 * machine's Claude Code, cache or context-doctor variables), the clock frozen
 * at FIXTURE_NOW, the fixture's project folder as the working directory, and
 * the home folder taken out of the output.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { frozenClock, normalizeOutput } from "./history-fixture.js";
/** The golden file's name for a command: `fix --json` → `fix_json.txt`. */
export const goldenName = (args) => `${args.map((a) => a.replace(/^-+/, "")).join("_")}.txt`;
export function cleanEnv(home, extra = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(CLAUDE|CONTEXT_DOCTOR|ANTHROPIC|OPENAI|GEMINI|GOOGLE|COPILOT|XDG_|CODEX)/i.test(k))
            continue;
        env[k] = v;
    }
    return {
        ...env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        CONTEXT_DOCTOR_NO_CALIBRATION: "1",
        CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1",
        // The Claude Code versions a report names: fixed, not whatever this machine has installed.
        CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309",
        // Clock times in a report are local: the same zone everywhere.
        TZ: "UTC",
        ...extra,
    };
}
/** One report's output (stdout, then its exit status), normalized. */
export function runReport(cli, home, args, extra = {}) {
    const r = spawnSync(process.execPath, [...frozenClock(), cli, ...args], { cwd: join(home, "work", "app"), env: cleanEnv(home, extra), encoding: "utf8", timeout: 120_000 });
    return normalizeOutput(`${r.stdout ?? ""}\n[exit ${r.status}]\n`, home);
}
