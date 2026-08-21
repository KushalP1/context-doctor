/**
 * `context-doctor watch [file]` — live monitor for a growing session/agent
 * trace. Polls the file (default: your most recent Claude Code session) and
 * on growth re-profiles, printing one status line per change plus any NEW
 * findings as they appear. Ctrl-C to stop.
 *
 * Polling (not fs.watch) is deliberate: editors/agents rewrite files in ways
 * that break watchers cross-platform, and a 2s stat is effectively free.
 */
export interface WatchOptions {
    file?: string;
    intervalMs?: number;
    model?: string;
}
export declare function runWatch(opts: WatchOptions): void;
