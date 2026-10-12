/** OLLAMA_HOST is read the way Ollama reads it, so semantic ranking finds the server it names. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ollamaUrl } from "../embed.js";
import { packContextSemantic } from "../pack.js";
test("a bare host or bind address means http on 11434; an explicit scheme keeps its own default port", () => {
    assert.equal(ollamaUrl(undefined), "http://127.0.0.1:11434");
    assert.equal(ollamaUrl(""), "http://127.0.0.1:11434");
    assert.equal(ollamaUrl("0.0.0.0"), "http://127.0.0.1:11434", "0.0.0.0 is where Ollama listens, not port 80");
    assert.equal(ollamaUrl("0.0.0.0:11500"), "http://127.0.0.1:11500");
    assert.equal(ollamaUrl("localhost"), "http://localhost:11434");
    assert.equal(ollamaUrl("gpu-box:8080"), "http://gpu-box:8080");
    assert.equal(ollamaUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
    assert.equal(ollamaUrl("http://ollama.internal"), "http://ollama.internal:80");
    assert.equal(ollamaUrl("https://ollama.example.com/base/"), "https://ollama.example.com:443/base");
    assert.equal(ollamaUrl("[::]"), "http://[::1]:11434");
    assert.equal(ollamaUrl("::1"), "http://[::1]:11434");
});
test("OLLAMA_HOST=0.0.0.0:<port> reaches a server on loopback", async () => {
    const server = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url === "/api/tags" ? { models: [] } : {}));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
    process.env.OLLAMA_HOST = `0.0.0.0:${server.address().port}`;
    try {
        const r = await packContextSemantic([{ name: "d.md", text: "# A\n\nalpha\n" }], { query: "alpha", semantic: true });
        assert.match(r.semanticNote, /no embedding model/, "it found the server; it has no model");
    }
    finally {
        server.close();
        delete process.env.OLLAMA_HOST;
    }
});
