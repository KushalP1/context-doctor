/**
 * Codex on an API key, through autopilot.
 *
 * Verified 2026-10-18 against codex-cli 0.153.4 (the ChatGPT app's) and
 * 0.154.0-alpha (the IDE extension's), and openai/codex main:
 *  - The built-in `openai` provider's address is `openai_base_url`, a
 *    top-level key of the user's ~/.codex/config.toml (Codex ignores it in a
 *    project's .codex/config.toml). The OPENAI_BASE_URL environment variable
 *    no longer routes it: with only the variable set, Codex went straight to
 *    wss://api.openai.com. With the key set, `codex exec` on an API key sent
 *    its requests through the proxy and they showed in /stats.
 *  - The key applies whatever the sign-in. With ChatGPT sign-in Codex
 *    otherwise talks to chatgpt.com/backend-api/codex, so autopilot sets it
 *    only when ~/.codex/auth.json says "apikey", and the every-prompt hook's
 *    self-heal takes it out again if the sign-in changes. A ChatGPT-signed-in
 *    Codex that reads the same file anyway (the ChatGPT app's Codex tab) is
 *    relayed by the proxy to chatgpt.com unedited (see proxy.ts).
 *  - Codex tries Responses over WebSocket first; the proxy answers 426, and
 *    Codex switches to HTTP for the session at once.
 *
 * config.toml is the user's file: only our one top-level line is ever
 * added, replaced or removed, and a value someone else set is left alone.
 */
export declare function codexHomeIn(home: string): string;
/** How Codex signs in, from auth.json: "apikey", "chatgpt", another mode, or undefined (none yet). */
export declare function codexAuthMode(codexHome: string): string | undefined;
/** A top-level string value (before the first [table]), or undefined. */
export declare function topLevelString(toml: string, key: string): string | undefined;
/** Set (or with undefined, remove) a top-level string key, touching no other line. */
export declare function setTopLevelString(toml: string, key: string, value: string | undefined): string;
export interface CodexRoute {
    /** We wrote our address into config.toml. */
    routed: boolean;
    /** One line for the user, or undefined when Codex is not on this machine. */
    line?: string;
}
/** Point Codex at the proxy when, and only when, it signs in with an API key. */
export declare function routeCodex(home: string, url: string, isOurs: (u: string) => boolean): CodexRoute;
/** Take our address out of config.toml. True when there was one to take out. */
export declare function unrouteCodex(home: string, isOurs: (u: string) => boolean): boolean;
/** What config.toml routes Codex to now, and how Codex signs in. */
export declare function codexRouting(home: string): {
    present: boolean;
    baseUrl?: string;
    auth?: string;
};
