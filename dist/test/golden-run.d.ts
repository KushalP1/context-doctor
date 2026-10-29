/**
 * Running the history reports on the fixture history (history-fixture.ts),
 * the way the golden files were made: a clean environment (none of this
 * machine's Claude Code, cache or context-doctor variables), the clock frozen
 * at FIXTURE_NOW, the fixture's project folder as the working directory, and
 * the home folder taken out of the output.
 */
/** The golden file's name for a command: `fix --json` → `fix_json.txt`. */
export declare const goldenName: (args: string[]) => string;
export declare function cleanEnv(home: string, extra?: Record<string, string>): NodeJS.ProcessEnv;
/** One report's output (stdout, then its exit status), normalized. */
export declare function runReport(cli: string, home: string, args: string[], extra?: Record<string, string>): string;
