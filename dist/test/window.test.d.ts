/**
 * `--days` counts events, not files: a session touched today brings only
 * today's requests, reads, subagents and compactions into `--days 1`, each
 * by its own timestamp. And repeated reads are per project and file.
 */
export {};
