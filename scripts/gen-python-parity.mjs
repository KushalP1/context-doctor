// Expected outputs for the Python port, produced by the TypeScript build.
// python/tests/test_parity.py checks the port reproduces every one exactly.
//   node scripts/gen-python-parity.mjs     (after npm run build)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { estimateTokens, formatTokens } from "../dist/tokens.js";
import { chunkSource, packContext, renderPack, terms } from "../dist/pack.js";

// Inputs are frozen in parity-inputs.json (written once from repo files), so
// editing the README never makes the fixtures stale; only the TypeScript logic does.
const inputsPath = new URL("../python/tests/parity-inputs.json", import.meta.url);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
if (!existsSync(inputsPath)) {
  const sources = [
    { name: "README.md", text: read("README.md").slice(0, 60_000) },
    { name: "src/ledger.ts", text: read("src/ledger.ts") },
    { name: "src/pack.ts", text: read("src/pack.ts") },
    { name: "notes.txt", text: "First paragraph about billing.\nStill billing.\n\nSecond paragraph: the signing key rotates monthly.\n\n\nThird, unrelated: the logo is blue." },
    { name: "server.log", text: "boot ok\n" + "GET /api/users 200 12ms user=alice ".repeat(400) + "\nERROR timeout upstream payments after 30s\nshutdown" },
    { name: "unicode.md", text: "# Café ☕ guide\n\nÜber-schnelle Bestellungen: naïve façade, résumé.\n\n## 日本語\n\n東京の天気は晴れです。キャッシュは一時間で期限切れ。\n\n## Emoji 🎉\n\nParty 🎉🎉 time with 👩‍💻 developers." },
    { name: "script.py", text: '#!/usr/bin/env python3\n"""Module doc."""\n\nimport os\n\n\ndef rotate_key(path):\n    """Rotate the signing key."""\n    return os.path.exists(path)\n\n\nclass Billing:\n    def invoice(self):\n        return 1\n' },
  ];
  const texts = [
    "", "hello world", "x = 1;\n".repeat(50), "{\"a\": [1, 2, 3], \"b\": {\"c\": \"d\"}}", "Café naïve résumé 東京 🎉👩‍💻",
    read("src/ledger.ts").slice(0, 3000), "The quick brown fox jumps over the lazy dog. ".repeat(30),
  ];
  writeFileSync(inputsPath, JSON.stringify({ sources, texts }));
}
const { sources, texts } = JSON.parse(readFileSync(inputsPath, "utf8"));
const models = [undefined, "claude", "claude-sonnet-5", "gpt-5", "gemini-3-pro", "llama-3"];
const out = {
  estimate: texts.flatMap((t) => models.map((m) => ({ text: t, model: m ?? null, tokens: estimateTokens(t, m) }))),
  format: [0, 7, 999, 1000, 1049, 1050, 1250, 1350, 9949, 9950, 9999, 10_000, 10_499, 10_500, 12_345, 999_999, 1_000_000, 1_250_000, 2_550_000_000].map((n) => ({ n, s: formatTokens(n) })),
  terms: ["How do the parseConfig_files work?", "Rotating keys: keyctl rotate --signing", "Café naïve résumé 東京の天気", "policies classes boss buses IDs x2 ab", "HTTPServer getHTTPResponse snake_case_name"].map((t) => ({ text: t, terms: terms(t) })),
  chunks: sources.flatMap((s) => [undefined, 120].map((max) => ({ source: s, max: max ?? null, chunks: chunkSource(s, { maxChunkTokens: max }) }))),
  packs: [
    { q: "how is the ledger kept from growing", budget: 1500 },
    { q: "signing key rotation", budget: 400 },
    { q: "timeout upstream", budget: 300 },
    { q: "cache 期限切れ", budget: 200 },
    { q: null, budget: 4000 },
    { q: "zzzz nothing matches", budget: 500 },
    { q: "billing", budget: 50, ids: ["notes.txt#1", "nope#3"] },
  ].map((c) => {
    const r = packContext(sources, { query: c.q ?? undefined, budget: c.budget, ids: c.ids });
    return { ...c, packed: r.packedTokens, total: r.totalTokens, mode: r.mode, selected: r.selected.map((x) => x.id), scores: r.chunks.map((x) => x.score), rendered: renderPack(r) };
  }),
};
writeFileSync(new URL("../python/tests/parity.json", import.meta.url), JSON.stringify(out));
console.log(`parity fixtures: ${out.estimate.length} estimates, ${out.format.length} formats, ${out.terms.length} terms, ${out.chunks.length} chunkings, ${out.packs.length} packs`);
