/**
 * Guards for the MCP server's --http mode, kept apart from mcp.ts (which
 * starts a server on import) so they can be tested directly.
 *
 * A server on 127.0.0.1 is still reachable from a browser: a page can POST to
 * it (a cross-origin "simple" request needs no preflight), and with DNS
 * rebinding a page on attacker.example can even make the browser treat the
 * server as same-origin. A QA pass did exactly that: a foreign origin saved
 * 101 handoffs through --store-handoffs, evicted the user's own and planted
 * handoff://latest. So every /mcp request is checked:
 *
 *  - Host must name this server: localhost, 127.0.0.1, [::1], the --host it
 *    was given, or a name in --allowed-hosts (a tunnel's host name, say).
 *    `--allowed-hosts '*'` turns the check off, explicitly.
 *  - Origin, when a browser sends one, must be a loopback origin, one whose
 *    host is allowed above, or one in --allowed-origins. ChatGPT's own
 *    origins are allowed by default; requests without an Origin (servers,
 *    CLIs, ChatGPT's connector backend) are not affected.
 *  - The body is read here, capped (10 MB, else 413), and parsed (else 400),
 *    then handed to the transport, so no request can make the server buffer
 *    an unbounded body.
 */

import type { IncomingMessage } from "node:http";

export const HTTP_LIMITS = { bodyBytes: 10 * 1024 * 1024 };

/** Origins a browser may call from without being listed: ChatGPT's. */
export const DEFAULT_ALLOWED_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"];

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

export interface HttpGuard {
  /** Host names (lowercase, no port, no brackets) accepted in Host; "*" accepts any. */
  hosts: Set<string> | "*";
  origins: Set<string>;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

/** A Host header's or URL's host name: lowercase, no port, no brackets, no trailing dot. */
export function hostName(hostHeader: string): string {
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) h = h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  else if (h.split(":").length === 2) h = h.split(":")[0];
  return h.replace(/\.$/, "");
}

/**
 * The guard for a server bound to `bindHost`, from --allowed-hosts and
 * --allowed-origins (comma lists) and the CONTEXT_DOCTOR_ALLOWED_HOSTS and
 * CONTEXT_DOCTOR_ALLOWED_ORIGINS environment variables.
 */
export function makeGuard(bindHost: string, allowedHosts?: string, allowedOrigins?: string, env: NodeJS.ProcessEnv = process.env): HttpGuard {
  const extra = [...list(allowedHosts), ...list(env.CONTEXT_DOCTOR_ALLOWED_HOSTS)];
  const origins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...list(allowedOrigins), ...list(env.CONTEXT_DOCTOR_ALLOWED_ORIGINS)].map((o) => o.toLowerCase().replace(/\/+$/, "")));
  if (extra.includes("*")) return { hosts: "*", origins };
  const bind = hostName(bindHost);
  const hosts = new Set([...LOOPBACK_HOSTS, ...extra.map(hostName)]);
  // A specific bind address or name is one the server answers to; a wildcard is not a name.
  if (bind && bind !== "0.0.0.0" && bind !== "::") hosts.add(bind);
  return { hosts, origins };
}

/** Why this request may not reach /mcp, or undefined when it may. */
export function refusal(guard: HttpGuard, headers: IncomingMessage["headers"]): string | undefined {
  if (guard.hosts !== "*") {
    const host = hostName(String(headers.host ?? ""));
    if (!host) return "the request has no Host header";
    if (!guard.hosts.has(host)) {
      return `Host "${host}" is not one this server answers to. Behind a tunnel or under a host name, start it with --allowed-hosts ${host}`;
    }
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    const o = String(origin).toLowerCase().replace(/\/+$/, "");
    if (guard.origins.has(o)) return undefined;
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      return `Origin "${o}" is not allowed`;
    }
    const h = hostName(url.host);
    const ok = LOOPBACK_HOSTS.includes(h) || (guard.hosts !== "*" && guard.hosts.has(h));
    if (!ok) return `Origin "${o}" is not allowed. To let a web page call this server, start it with --allowed-origins ${o}`;
  }
  return undefined;
}

/** The request body as JSON, at most `limit` bytes; otherwise the status and reason to answer with. */
export function readJsonBody(req: IncomingMessage, limit = HTTP_LIMITS.bodyBytes): Promise<{ value: unknown } | { status: number; code: number; message: string }> {
  return new Promise((resolve) => {
    const tooLarge = { status: 413, code: -32600, message: `request body over ${Math.round(limit / 1024 / 1024)} MB` };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return resolve(tooLarge);
    }
    const parts: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (d: Buffer) => {
      if (done) return;
      size += d.length;
      if (size > limit) {
        done = true;
        parts.length = 0;
        req.resume();
        return resolve(tooLarge);
      }
      parts.push(d);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve({ value: JSON.parse(Buffer.concat(parts).toString("utf8")) });
      } catch {
        resolve({ status: 400, code: -32700, message: "Parse error: the body is not JSON" });
      }
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      resolve({ status: 400, code: -32700, message: "the request body could not be read" });
    });
  });
}
