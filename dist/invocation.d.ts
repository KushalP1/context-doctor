/**
 * How the user started this process, so the next steps we print can be
 * typed as they are. Someone who ran `npx context-doctor savings` has no
 * `context-doctor` on PATH: a hint saying `context-doctor autopilot on` is
 * "command not found" for them.
 */
/** Started through npx (or `npm exec`): npm says so, or the script sits in npx's cache. */
export declare function launchedViaNpx(env?: NodeJS.ProcessEnv, script?: string): boolean;
/** Should follow-up commands be spelled `npx context-doctor …`? */
export declare function needsNpx(env?: NodeJS.ProcessEnv, script?: string): boolean;
/** A follow-up command as the user should type it: `npx context-doctor <rest>` after an npx run. */
export declare function selfCommand(rest: string, env?: NodeJS.ProcessEnv, script?: string): string;
/**
 * Rewrite the `context-doctor <command>` hints in printed text for the way
 * this process was started. Autopilot runs as a background service, which
 * cannot point into npx's cache, so from npx its hint is a global install.
 */
export declare function withInvocation(text: string, env?: NodeJS.ProcessEnv, script?: string): string;
