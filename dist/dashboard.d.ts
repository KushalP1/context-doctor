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
    totals: {
        tokensSaved: number;
        usdSaved: number;
        checks: number;
        warnings: number;
        optimizeRuns: number;
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
export declare function startDashboard(opts?: {
    port?: number;
    proxyPort?: number;
}): http.Server;
