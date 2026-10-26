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
export declare const HTTP_LIMITS: {
    bodyBytes: number;
};
/** Origins a browser may call from without being listed: ChatGPT's. */
export declare const DEFAULT_ALLOWED_ORIGINS: string[];
export interface HttpGuard {
    /** Host names (lowercase, no port, no brackets) accepted in Host; "*" accepts any. */
    hosts: Set<string> | "*";
    origins: Set<string>;
}
/** A Host header's or URL's host name: lowercase, no port, no brackets, no trailing dot. */
export declare function hostName(hostHeader: string): string;
/**
 * The guard for a server bound to `bindHost`, from --allowed-hosts and
 * --allowed-origins (comma lists) and the CONTEXT_DOCTOR_ALLOWED_HOSTS and
 * CONTEXT_DOCTOR_ALLOWED_ORIGINS environment variables.
 */
export declare function makeGuard(bindHost: string, allowedHosts?: string, allowedOrigins?: string, env?: NodeJS.ProcessEnv): HttpGuard;
/** Why this request may not reach /mcp, or undefined when it may. */
export declare function refusal(guard: HttpGuard, headers: IncomingMessage["headers"]): string | undefined;
/** The request body as JSON, at most `limit` bytes; otherwise the status and reason to answer with. */
export declare function readJsonBody(req: IncomingMessage, limit?: number): Promise<{
    value: unknown;
} | {
    status: number;
    code: number;
    message: string;
}>;
