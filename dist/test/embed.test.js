/** Semantic pack: ranking fused with a local Ollama's embeddings, and a clear fallback without one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packContextSemantic } from "../pack.js";
/** A fake Ollama whose "embedding" is 1 on the axis of a meaning: [cache, billing, other]. */
function fakeOllama(models) {
    const calls = [];
    const server = createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/api/tags")
                return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
            const { input } = JSON.parse(b);
            calls.push(input.length);
            const vec = (t) => (/cache|cold|expire|idle|warm/i.test(t) ? [1, 0, 0] : /invoice|bill/i.test(t) ? [0, 1, 0] : [0, 0, 1]);
            res.end(JSON.stringify({ embeddings: input.map(vec) }));
        });
    });
    return { server, calls };
}
const doc = [
    "## Billing", "", "Invoices go out monthly.", "",
    "## Timing", "", "The prompt cache expires after an idle hour.", "",
    "## Misc", "", "Unrelated notes about the logo.",
].join("\n");
test("--semantic finds a paraphrase keyword ranking misses, and caches chunk vectors", async () => {
    const { server, calls } = fakeOllama(["llama3.1:latest", "nomic-embed-text:latest"]);
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
    process.env.OLLAMA_HOST = `http://127.0.0.1:${server.address().port}`;
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cd-embed-"));
    try {
        const q = "how long until the cache goes cold";
        const lexical = await packContextSemantic([{ name: "d.md", text: doc }], { query: "when is it no longer warm", budget: 30 });
        assert.equal(lexical.selected.length, 0, "no shared words: keyword ranking finds nothing");
        const r = await packContextSemantic([{ name: "d.md", text: doc }], { query: "when is it no longer warm", budget: 30, semantic: true });
        assert.match(r.semanticNote, /nomic-embed-text/);
        assert.ok(r.selected[0].text.includes("idle hour"));
        await packContextSemantic([{ name: "d.md", text: doc }], { query: q, budget: 30, semantic: true });
        assert.equal(calls.at(-1), 1, "second run embeds only the query: chunk vectors came from the cache");
    }
    finally {
        server.close();
        delete process.env.OLLAMA_HOST;
        delete process.env.XDG_CACHE_HOME;
    }
});
test("without an embedding model, pack stays lexical and says what to install", async () => {
    const { server } = fakeOllama(["llama3.1:latest"]);
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
    process.env.OLLAMA_HOST = `http://127.0.0.1:${server.address().port}`;
    try {
        const r = await packContextSemantic([{ name: "d.md", text: doc }], { query: "invoices", semantic: true });
        assert.match(r.semanticNote, /ollama pull nomic-embed-text/);
        assert.ok(r.selected[0].text.includes("Invoices"));
    }
    finally {
        server.close();
        delete process.env.OLLAMA_HOST;
    }
});
test("no Ollama at all is a note, not an error", async () => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:9";
    try {
        const r = await packContextSemantic([{ name: "d.md", text: doc }], { query: "invoices", semantic: true });
        assert.match(r.semanticNote, /no Ollama/);
    }
    finally {
        delete process.env.OLLAMA_HOST;
    }
});
