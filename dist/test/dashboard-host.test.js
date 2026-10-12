/**
 * The dashboard answers only requests addressed to loopback by name. A page
 * that rebinds its own hostname to 127.0.0.1 (DNS rebinding) reaches the port
 * but still sends its own Host, and must not get /api/data (session titles).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isLoopbackHost, startDashboard } from "../dashboard.js";
const server = startDashboard({ port: 0 });
await new Promise((r) => server.once("listening", () => r()));
const port = server.address().port;
after(() => server.close());
/** fetch() cannot set Host, so a raw request does. */
function get(path, host) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
    });
}
test("a foreign Host gets 403 and no data", async () => {
    for (const host of [`evil.example:${port}`, "evil.example", `127.0.0.1.evil.example:${port}`, `localhost:${port + 1}`]) {
        const r = await get("/api/data", host);
        assert.equal(r.status, 403, `Host ${host}`);
        assert.doesNotMatch(r.body, /sessions/);
    }
    assert.equal((await get("/", `evil.example:${port}`)).status, 403, "the page too");
});
test("loopback names are served", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
        const r = await get("/api/data", host);
        assert.equal(r.status, 200, `Host ${host}`);
        assert.ok("totals" in JSON.parse(r.body));
    }
    assert.ok(isLoopbackHost(`[::1]:${port}`, port));
    assert.ok(!isLoopbackHost(undefined, port), "no Host header, no data");
});
