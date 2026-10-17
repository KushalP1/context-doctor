/**
 * How the user started this process, so the next steps we print can be
 * typed as they are. Someone who ran `npx context-doctor savings` has no
 * `context-doctor` on PATH: a hint saying `context-doctor autopilot on` is
 * "command not found" for them.
 */

import { existsSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";

/** Started through npx (or `npm exec`): npm says so, or the script sits in npx's cache. */
export function launchedViaNpx(env: NodeJS.ProcessEnv = process.env, script: string = process.argv[1] ?? ""): boolean {
  return env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(script);
}

/**
 * A `context-doctor` the user's own shell will find: on PATH, outside npx's
 * cache and outside a project's node_modules/.bin (which npm puts on PATH
 * only while it runs a command).
 */
function installedBinary(env: NodeJS.ProcessEnv): boolean {
  const exts = platform() === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir || /[\\/]_npx[\\/]|[\\/]node_modules[\\/]\.bin\b|[\\/]\.npm[\\/]|[\\/]npm-cache[\\/]/i.test(dir + "/")) continue;
    if (exts.some((e) => existsSync(join(dir, "context-doctor" + e)))) return true;
  }
  return false;
}

/** Should follow-up commands be spelled `npx context-doctor …`? */
export function needsNpx(env: NodeJS.ProcessEnv = process.env, script?: string): boolean {
  return launchedViaNpx(env, script) && !installedBinary(env);
}

/** A follow-up command as the user should type it: `npx context-doctor <rest>` after an npx run. */
export function selfCommand(rest: string, env: NodeJS.ProcessEnv = process.env, script?: string): string {
  return `${needsNpx(env, script) ? "npx context-doctor" : "context-doctor"} ${rest}`;
}

const SUBCOMMANDS = "install|uninstall|autopilot|init|compact-window|compactions|doctor|savings|instructions|session|overhead|report|subagents|tasks|reads|--help";

/**
 * Rewrite the `context-doctor <command>` hints in printed text for the way
 * this process was started. Autopilot runs as a background service, which
 * cannot point into npx's cache, so from npx its hint is a global install.
 */
export function withInvocation(text: string, env: NodeJS.ProcessEnv = process.env, script?: string): string {
  if (!needsNpx(env, script)) return text;
  return text
    .replace(/(?<![\w/@.-])context-doctor autopilot on\b/g, "npm i -g context-doctor && context-doctor autopilot on")
    .replace(new RegExp(`(?<![\\w/@.-]|npx |-g |&& )context-doctor (?=(?:${SUBCOMMANDS})\\b)`, "g"), "npx context-doctor ");
}
