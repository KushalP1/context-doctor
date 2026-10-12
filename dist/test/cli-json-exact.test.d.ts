/**
 * Machine-readable CLI paths: what a script or CI job reads must be complete
 * and parseable, and messages must only claim what happened.
 *
 *  - `session --json --fail-over-budget` exits 1 over budget, like analyze;
 *  - `analyze --json --exact` prints ONE JSON object, exact count inside;
 *  - "Remembered: … calibrated" only when the sample was actually stored, and
 *    CONTEXT_DOCTOR_NO_CALIBRATION=1 stores nothing.
 *
 * The count-tokens API is never called: a preloaded module answers fetch.
 */
export {};
