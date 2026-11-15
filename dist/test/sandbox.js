/**
 * Sandboxed home directories for tests.
 *
 * os.homedir() reads USERPROFILE on Windows and HOME everywhere else, and the
 * Claude Desktop config path is derived from APPDATA. A test that overrides
 * HOME alone passes on macOS and Linux while quietly writing into the
 * developer's real profile on Windows — which is exactly how this suite went
 * red on all three Windows jobs, twice. Every test goes through here, and
 * `sandbox.guard.test.ts` fails the suite if one does not.
 */
import { join } from "node:path";
/** Environment for a child process whose home is `home` on every platform. */
export function sandboxEnv(home) {
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
    // Copilot, Codex and Claude Code follow these when set, wherever HOME is:
    // a developer running one test file from a shell that sets them must not
    // have the test write into the real ones. So does our own state without a
    // ~/.claude (XDG_STATE_HOME, LOCALAPPDATA: ledger.ts fallbackStateDir).
    delete env.XDG_STATE_HOME;
    delete env.COPILOT_HOME;
    delete env.CODEX_HOME;
    delete env.CLAUDE_CONFIG_DIR;
    // OpenCode's and Cline's data follow these (spend reads them): never the developer's own.
    delete env.OPENCODE_DATA_DIR;
    delete env.CLINE_DATA_DIR;
    delete env.XDG_DATA_HOME;
    delete env.XDG_CONFIG_HOME;
    // Run from inside a Claude Code session, the suite must behave as on CI.
    delete env.CLAUDECODE;
    return env;
}
/** Run `fn` with the current process's home redirected, restoring afterwards. */
export async function withSandboxHome(home, fn) {
    const keys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_STATE_HOME", "COPILOT_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_DATA_DIR", "CLINE_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, sandboxEnv(home));
    for (const k of ["XDG_STATE_HOME", "COPILOT_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_DATA_DIR", "CLINE_DATA_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME"])
        delete process.env[k];
    try {
        return await fn();
    }
    finally {
        for (const k of keys) {
            if (saved[k] === undefined)
                delete process.env[k];
            else
                process.env[k] = saved[k];
        }
    }
}
