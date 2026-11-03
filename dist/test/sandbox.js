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
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming") };
    // Copilot, Codex and Claude Code follow these when set, wherever HOME is:
    // a developer running one test file from a shell that sets them must not
    // have the test write into the real ones.
    delete env.COPILOT_HOME;
    delete env.CODEX_HOME;
    delete env.CLAUDE_CONFIG_DIR;
    return env;
}
/** Run `fn` with the current process's home redirected, restoring afterwards. */
export async function withSandboxHome(home, fn) {
    const keys = ["HOME", "USERPROFILE", "APPDATA", "COPILOT_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, sandboxEnv(home));
    for (const k of ["COPILOT_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])
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
