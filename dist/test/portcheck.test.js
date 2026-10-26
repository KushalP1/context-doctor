/** doctor names another program on autopilot's port (Headroom's default is 8787 too). */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portOccupant } from "../autopilot.js";
import { startProxy } from "../proxy.js";
import { freePort } from "./freeport.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
/** A stand-in for another local proxy: JSON health with its own service name. */
async function otherProxy() {
    const server = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("server", "uvicorn");
        res.end(JSON.stringify(req.url === "/health" ? { status: "healthy", service: "headroom-proxy" } : { detail: "Not Found" }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { port: server.address().port, close: () => server.close() };
}
test("portOccupant: nobody, our proxy, or another program by the name it gives", async () => {
    const free = await freePort();
    assert.deepEqual(await portOccupant(free), { listening: false, ours: false });
    const other = await otherProxy();
    try {
        const o = await portOccupant(other.port);
        assert.equal(o.listening, true);
        assert.equal(o.ours, false);
        assert.match(o.name ?? "", /^headroom-proxy/);
    }
    finally {
        other.close();
    }
    const ours = startProxy({ port: 0, autopilot: true, autopilotStatePath: join(mkdtempSync(join(tmpdir(), "cd-port-")), "s.json") });
    await new Promise((r) => ours.once("listening", r));
    try {
        assert.deepEqual(await portOccupant(ours.address().port), { listening: true, ours: true });
    }
    finally {
        ours.close();
    }
});
test("doctor: another program on the autopilot port, with Claude Code routed there, is a failed check that names it", async () => {
    const other = await otherProxy();
    const home = mkdtempSync(join(tmpdir(), "cd-port-doc-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".context-doctor-autopilot.json"), JSON.stringify({ port: other.port }));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${other.port}` } }));
    try {
        const out = await new Promise((resolve) => execFile(process.execPath, [cliPath, "doctor"], { env: sandboxEnv(home), timeout: 30_000 }, (_e, stdout) => resolve(stdout)));
        assert.match(out, /✗ Autopilot port\s+headroom-proxy.* listens on http:\/\/127\.0\.0\.1:\d+ instead of the proxy, and Claude Code's requests go to it/);
    }
    finally {
        other.close();
    }
});
