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
/** Environment for a child process whose home is `home` on every platform. */
export declare function sandboxEnv(home: string): NodeJS.ProcessEnv;
/** Run `fn` with the current process's home redirected, restoring afterwards. */
export declare function withSandboxHome<T>(home: string, fn: () => T | Promise<T>): Promise<T>;
