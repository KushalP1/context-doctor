/**
 * The A/B suite's tasks (`context-doctor ab`): small, self-contained coding
 * tasks, each a tiny repository, a request, and a deterministic check
 * (`node test.mjs`, exit 0 = pass). Every file is generated here: no
 * network, no dependencies, nothing from anyone's real sessions.
 *
 * Three of them carry a big file on purpose, because that is where the
 * levers act: a long format spec only one section of which matters
 * (pack_context), a production log the agent reads and then no longer needs
 * (autopilot's clearing), a design doc (both). The others are ordinary
 * small fixes, where a lever should change nothing.
 *
 * `solution` is the reference fix. The agent never sees it: the test suite
 * checks that every fixture fails its check and passes with the solution,
 * and the local mock API writes it to play a model that solves the task.
 */
export interface AbTask {
    id: string;
    title: string;
    /** The repository: relative path -> content. `test.mjs` is the check and is read-only to the agent. */
    files: Record<string, string>;
    /** What the agent is asked to do. */
    prompt: string;
    /** The reference fix: files to write over the fixture. */
    solution: Record<string, string>;
    /** A big file the task needs only part of (read whole, or packed). */
    bigFile?: string;
}
export declare const AB_TASKS: AbTask[];
