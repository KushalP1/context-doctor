/** A Copilot CLI session-state fixture: the shape copilotusage.ts reads, made-up numbers. Shared by the spend tests. */
/** Session a: a start with its context, two calls (one written twice), two compactions (one a record names), a call on Auto, an old call, a torn last line. Session b: a flat file, no context. */
export declare function writeCopilot(home: string, now: number): void;
/**
 * By hand. Opus 4.6 ($5 / $0.50 read / $6.25 write / $25): 2,000 uncached + 6,000 read + 2,000 written + 500 out.
 * GPT-5.4 ($2.50 / $0.25 / $15): 3,000 uncached + 1,000 read + 200 out. Sonnet 4.5 ($3 / $15): 3,000 in + 300 out, then 1,000 in + 100 out.
 */
export declare const COPILOT_USD: number;
