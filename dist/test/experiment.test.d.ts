/**
 * The harness drives the `claude` CLI, which tests cannot call. A stub binary
 * stands in: it makes a change, emits the JSON shape `claude -p
 * --output-format json` returns, and behaves differently when forked from an
 * existing session, so both arms and the verdict are exercised end to end.
 */
export {};
