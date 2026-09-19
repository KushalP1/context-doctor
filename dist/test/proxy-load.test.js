/**
 * Accounting must be exact under concurrency: 60 streaming requests at once,
 * every one counted, every usage figure summed to the token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../proxy.js";
test("60 concurrent streaming requests are accounted exactly", async () => {
    let upstreamCalls = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            upstreamCalls++;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("event: message_start\ndata: {}\n\n");
            res.write('event: message_delta\ndata: {"usage":{"input_tokens":1000,"output_tokens":50}}\n\n');
            res.end("event: message_stop\ndata: {}\n\n");
        });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const proxy = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => proxy.once("listening", r));
    const port = proxy.address().port;
    try {
        const dup = "the same long paragraph repeated ".repeat(40);
        const body = JSON.stringify({
            model: "claude-sonnet-5",
            messages: [
                { role: "user", content: dup }, { role: "assistant", content: "ok" }, { role: "user", content: dup },
                ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
            ],
        });
        const N = 60;
        const results = await Promise.all(Array.from({ length: N }, async () => {
            const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
                method: "POST", headers: { "content-type": "application/json", "x-api-key": "k" }, body,
            });
            return { status: r.status, len: (await r.text()).length };
        }));
        assert.ok(results.every((r) => r.status === 200 && r.len > 0), "every request streamed a 200");
        assert.equal(upstreamCalls, N);
        const stats = (await fetch(`http://127.0.0.1:${port}/stats`).then((r) => r.json()));
        assert.equal(stats.requests, N);
        assert.equal(stats.optimizedRequests, N, "the duplicate paste is optimized in every request");
        assert.equal(stats.upstreamInputTokens, N * 1000, "usage summed exactly");
        assert.equal(stats.upstreamOutputTokens, N * 50);
        assert.ok(Number.isFinite(stats.estUsdSaved) && stats.estUsdSaved > 0);
    }
    finally {
        proxy.close();
        upstream.close();
    }
});
