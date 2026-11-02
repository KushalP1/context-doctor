/** Subagent transcripts for the subagents'-model tests: replies as Claude Code streams them, in a throwaway home. */
export declare const DAY = 86400000;
/**
 * One subagent reply as Claude Code writes it while it streams: a first row
 * with a partial output count, then the last row with the final one. Usage:
 * 1k uncached, 200k read, 10k written (4k at 5 minutes, 6k at 1 hour), 1k out.
 */
export declare function reply(at: number, model: string, cwd: string, id?: string): string[];
export declare const OPUS: number;
export declare const SONNET: number;
export declare const FABLE: number;
export interface Agent {
    id: string;
    type?: string;
    rows: string[];
}
/** A throwaway home: a session with these subagents, a user agent file and a project one. */
export declare function history(agents: (cwd: string) => Agent[]): {
    home: string;
    cwd: string;
    parent: string;
    sub: string;
};
export declare const now: number;
export declare const at: number;
export declare function mixed(cwd: string): Agent[];
