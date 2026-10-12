/**
 * `context-doctor dashboard` — a local savings dashboard.
 *
 * Serves one self-contained page on localhost from data already on this
 * machine: the activity ledger, recent session profiles, and the proxy's
 * /stats when it is running. No network calls, no accounts, no telemetry —
 * the server reads local files and answers only the loopback interface.
 */
import http from "node:http";
export interface DashboardData {
    generatedAt: string;
    /** tokensSaved: removed by context-doctor itself. shrinkage: sessions that got smaller after a warning (mostly compaction), shown apart. */
    totals: {
        tokensSaved: number;
        usdSaved: number;
        checks: number;
        warnings: number;
        optimizeRuns: number;
        shrinkage: number;
    };
    daily: Array<{
        date: string;
        saved: number;
    }>;
    sessions: Array<{
        title: string;
        tokens: number;
        waste: number;
        model?: string;
    }>;
    proxy: {
        startedAt?: string;
        requests: number;
        optimizedRequests: number;
        tokensSaved: number;
        estUsdSaved: number;
    } | null;
    budget: {
        path: string;
        overBudget: boolean;
        breaches: string[];
    } | null;
}
export declare function collectDashboardData(proxyPort?: number): Promise<DashboardData>;
/**
 * Whether a request's Host header names this machine's loopback.
 *
 * Listening on 127.0.0.1 is not enough on its own: a web page can rebind its
 * own hostname to 127.0.0.1 (DNS rebinding) and then read /api/data, session
 * titles included, as same-origin. Such a request still carries the attacker's
 * hostname in Host, so only loopback names are answered.
 */
export declare function isLoopbackHost(host: string | undefined, port: number): boolean;
export declare function startDashboard(opts?: {
    port?: number;
    proxyPort?: number;
}): http.Server;
