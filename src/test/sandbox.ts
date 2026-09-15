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
export function sandboxEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming") };
}

/** Run `fn` with the current process's home redirected, restoring afterwards. */
export async function withSandboxHome<T>(home: string, fn: () => T | Promise<T>): Promise<T> {
  const keys = ["HOME", "USERPROFILE", "APPDATA"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, sandboxEnv(home));
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
