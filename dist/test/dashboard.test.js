/** Dashboard: local-only server, real data shape, self-contained page. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startDashboard, collectDashboardData } from "../dashboard.js";
const server = startDashboard({ port: 0 });
await new Promise((r) => server.once("listening", () => r()));
const port = server.address().port;
after(() => server.close());
test("binds loopback only", () => {
    assert.equal(server.address().address, "127.0.0.1");
});
test("/api/data returns the documented shape", async () => {
    const data = (await (await fetch(`http://127.0.0.1:${port}/api/data`)).json());
    for (const key of ["generatedAt", "totals", "daily", "sessions", "proxy", "budget"]) {
        assert.ok(key in data, `missing ${key}`);
    }
    for (const key of ["tokensSaved", "usdSaved", "checks", "warnings", "optimizeRuns"]) {
        assert.equal(typeof data.totals[key], "number", `totals.${key} must be numeric`);
    }
    assert.ok(Array.isArray(data.daily) && Array.isArray(data.sessions));
});
test("page is self-contained: no external requests", async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.startsWith("<!doctype html>"));
    // Only same-origin data fetch; nothing pulled from the network.
    assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/127\.0\.0\.1/g, "")), "page must not reference remote origins");
    assert.ok(html.includes("/api/data"));
    // Accessibility affordances required by the house chart rules.
    assert.ok(html.includes("Table view"), "table view present");
    assert.ok(html.includes('role="img"') || html.includes("aria-label"), "charts labelled");
    assert.ok(html.includes("prefers-color-scheme: dark"), "dark mode selected, not flipped");
});
test("collectDashboardData works without a proxy running", async () => {
    const data = await collectDashboardData(59999); // nothing listens here
    assert.equal(data.proxy, null);
    assert.ok(data.totals.tokensSaved >= 0);
});
