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

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const KEY = "openai_base_url";
const ANY_HEADER = /^\s*\[/;
const keyLine = (key: string) => new RegExp(String.raw`^\s*(?:${key}|"${key}"|'${key}')\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$`);

export function codexHomeIn(home: string): string {
  return join(home, ".codex");
}

/** How Codex signs in, from auth.json: "apikey", "chatgpt", another mode, or undefined (none yet). */
export function codexAuthMode(codexHome: string): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    if (typeof auth?.auth_mode === "string") return auth.auth_mode;
    // Older files carry only the key.
    if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY && !auth.tokens) return "apikey";
  } catch {
    /* no auth.json */
  }
  return undefined;
}

/** A top-level string value (before the first [table]), or undefined. */
export function topLevelString(toml: string, key: string): string | undefined {
  const re = keyLine(key);
  for (const line of toml.split("\n")) {
    if (ANY_HEADER.test(line)) return undefined;
    const m = re.exec(line);
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

/** Set (or with undefined, remove) a top-level string key, touching no other line. */
export function setTopLevelString(toml: string, key: string, value: string | undefined): string {
  const lines = toml.length ? toml.split("\n") : [];
  const re = keyLine(key);
  const header = lines.findIndex((l) => ANY_HEADER.test(l));
  const end = header === -1 ? lines.length : header;
  const at = lines.slice(0, end).findIndex((l) => re.test(l));
  const line = value === undefined ? undefined : `${key} = ${JSON.stringify(value)}`;
  if (at >= 0) {
    if (line === undefined) lines.splice(at, 1);
    else lines[at] = line;
  } else if (line !== undefined) {
    lines.splice(end, 0, line);
  }
  return lines.join("\n");
}

export interface CodexRoute {
  /** We wrote our address into config.toml. */
  routed: boolean;
  /** One line for the user, or undefined when Codex is not on this machine. */
  line?: string;
}

/** Point Codex at the proxy when, and only when, it signs in with an API key. */
export function routeCodex(home: string, url: string, isOurs: (u: string) => boolean): CodexRoute {
  const dir = codexHomeIn(home);
  if (!existsSync(dir)) return { routed: false };
  const path = join(dir, "config.toml");
  const toml = existsSync(path) ? readFileSync(path, "utf8") : "";
  const auth = codexAuthMode(dir);
  if (auth !== "apikey") {
    return { routed: false, line: `  Codex ${auth === "chatgpt" ? "signs in with ChatGPT" : "has no API key sign-in"}: left untouched (its traffic goes to OpenAI's ChatGPT servers, which autopilot does not proxy).` };
  }
  const provider = topLevelString(toml, "model_provider");
  if (provider && provider !== "openai") return { routed: false, line: `  Codex uses the "${provider}" provider: left untouched.` };
  const current = topLevelString(toml, KEY);
  if (current && !isOurs(current)) return { routed: false, line: `! Codex already sends its requests to ${current} (openai_base_url): left as it is.` };
  if (current !== url) {
    if (existsSync(path)) copyFileSync(path, `${path}.context-doctor.backup`);
    writeFileSync(path, setTopLevelString(toml, KEY, url));
  }
  return { routed: true, line: `✓ Codex (API key) routed through it (openai_base_url in ${path}; new Codex sessions)` };
}

/** Take our address out of config.toml. True when there was one to take out. */
export function unrouteCodex(home: string, isOurs: (u: string) => boolean): boolean {
  const path = join(codexHomeIn(home), "config.toml");
  if (!existsSync(path)) return false;
  const toml = readFileSync(path, "utf8");
  const current = topLevelString(toml, KEY);
  if (!current || !isOurs(current)) return false;
  writeFileSync(path, setTopLevelString(toml, KEY, undefined));
  return true;
}

/** What config.toml routes Codex to now, and how Codex signs in. */
export function codexRouting(home: string): { present: boolean; baseUrl?: string; auth?: string } {
  const dir = codexHomeIn(home);
  if (!existsSync(dir)) return { present: false };
  const path = join(dir, "config.toml");
  const toml = existsSync(path) ? readFileSync(path, "utf8") : "";
  return { present: true, baseUrl: topLevelString(toml, KEY), auth: codexAuthMode(dir) };
}
