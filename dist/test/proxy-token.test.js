/**
 * The path token is what lets the proxy sit on a public URL for apps whose
 * servers call the base URL (Cursor with your own key). A wrong token must
 * never reach upstream, and the good one must be stripped before routing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy, stripToken } from "../proxy.js";
let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 }, path: req.url }));
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const TOKEN = "s3cret-token";
const proxy = startProxy({ port: 0, openaiUpstream: upstreamUrl, token: TOKEN });
await new Promise((r) => proxy.once("listening", r));
const base = `http://127.0.0.1:${proxy.address().port}`;
after(() => { proxy.close(); upstream.close(); });
const body = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
const post = (path) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body });
test("stripToken: exact token strips, anything else is rejected", () => {
    assert.equal(stripToken("/t/abc/v1/chat/completions", "abc"), "/v1/chat/completions");
    assert.equal(stripToken("/t/abc", "abc"), "/");
    assert.equal(stripToken("/t/abd/v1/chat/completions", "abc"), undefined);
    assert.equal(stripToken("/t/ab/v1/chat/completions", "abc"), undefined);
    assert.equal(stripToken("/v1/chat/completions", "abc"), undefined);
    assert.equal(stripToken("/t/abcd/v1", "abc"), undefined);
});
test("proxy token: good prefix is served and stripped, bad or missing prefix gets 401 without an upstream call", async () => {
    const ok = await post(`/t/${TOKEN}/v1/chat/completions`);
    assert.equal(ok.status, 200);
    const json = (await ok.json());
    assert.equal(json.path, "/v1/chat/completions");
    assert.equal(upstreamHits, 1);
    const bad = await post(`/t/wrong/v1/chat/completions`);
    assert.equal(bad.status, 401);
    const missing = await post(`/v1/chat/completions`);
    assert.equal(missing.status, 401);
    assert.equal(upstreamHits, 1);
    // /health stays open so tunnels and load balancers can probe; /stats does not.
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/stats`)).status, 401);
    assert.equal((await fetch(`${base}/t/${TOKEN}/stats`)).status, 200);
});
