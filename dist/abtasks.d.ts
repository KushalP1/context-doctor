/**
 * The A/B suite's tasks (`context-doctor ab`): small, self-contained coding
 * tasks, each a tiny repository, a request, a visible smoke test and a
 * hidden check. Every file is generated here: no network, no dependencies,
 * nothing from anyone's real sessions.
 *
 * The agent can run the smoke test (`node test.mjs`), which shows that the
 * code loads and runs and gives no expected values. The verdict is `verify`,
 * which the harness runs from outside the repository after the agent stops:
 * the agent can neither read nor run it, so the answers come from the
 * request and the repository's own files, not from a failing assertion.
 *
 * Three tasks keep the facts their solution needs only in a big file: a long
 * format spec (one section of which matters, with an older version's rules
 * as a decoy), a production log with the retry policy in the middle, a
 * design doc. That is where the levers act (pack_context, autopilot's
 * clearing, compaction). The other five are small fixes whose facts are in
 * the request: there a lever should change nothing.
 *
 * `solution` is the reference fix. The agent never sees it: the test suite
 * checks that every fixture fails `verify` and passes it with the solution,
 * and the local mock API writes it to play a model that solves the task.
 */
export interface AbTask {
    id: string;
    title: string;
    /** The repository: relative path -> content. `test.mjs` is the smoke test and is read-only to the agent. */
    files: Record<string, string>;
    /** What the agent is asked to do. */
    prompt: string;
    /**
     * The hidden check, an ES module body run with the repository as its
     * working directory after a prelude (abVerifyScript) that provides `A`
     * (assert functions captured before any repository code loads) and
     * `load(path)` (import a repository file). Passing = it ran to the end.
     */
    verify: string;
    /** The reference fix: files to write over the fixture. */
    solution: Record<string, string>;
    /** A big file holding facts the solution needs. */
    bigFile?: string;
}
/**
 * The hidden check as a script: the prelude, the task's body, and a last
 * line printing `ab-verify-ok <nonce>`, which the harness requires along
 * with exit 0 (an exit code alone could be set by the code under test).
 */
export declare function abVerifyScript(task: AbTask): string;
export declare const AB_TASKS: AbTask[];
