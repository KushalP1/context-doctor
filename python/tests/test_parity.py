"""The Python port reproduces the TypeScript package exactly (fixtures from scripts/gen-python-parity.mjs)."""

import json
import math
import pathlib
import unittest

from context_doctor import PackSource, chunk_source, estimate_tokens, format_tokens, pack_context, terms

FIX = json.loads((pathlib.Path(__file__).parent / "parity.json").read_text(encoding="utf-8"))


class Parity(unittest.TestCase):
    def test_estimate_tokens(self):
        for c in FIX["estimate"]:
            self.assertEqual(estimate_tokens(c["text"], c["model"]), c["tokens"], (c["text"][:40], c["model"]))

    def test_format_tokens(self):
        for c in FIX["format"]:
            self.assertEqual(format_tokens(c["n"]), c["s"], c["n"])

    def test_terms(self):
        for c in FIX["terms"]:
            self.assertEqual(terms(c["text"]), c["terms"], c["text"])

    def test_chunking(self):
        for c in FIX["chunks"]:
            src = PackSource(c["source"]["name"], c["source"]["text"])
            got = chunk_source(src, c["max"])
            want = c["chunks"]
            self.assertEqual(len(got), len(want), (src.name, c["max"]))
            for g, w in zip(got, want):
                self.assertEqual(
                    (g.id, g.start_line, g.end_line, g.heading, g.text, g.tokens),
                    (w["id"], w["startLine"], w["endLine"], w["heading"], w["text"], w["tokens"]),
                    (src.name, c["max"], w["id"]),
                )

    def test_pack_and_render(self):
        sources = [PackSource(c["source"]["name"], c["source"]["text"]) for c in FIX["chunks"] if c["max"] is None]
        for c in FIX["packs"]:
            r = pack_context(sources, query=c["q"], budget=c["budget"], ids=c.get("ids"))
            self.assertEqual((r.mode, r.packed_tokens, r.total_tokens), (c["mode"], c["packed"], c["total"]), c["q"])
            self.assertEqual([x.id for x in r.selected], c["selected"], c["q"])
            for g, w in zip((x.score for x in r.chunks), c["scores"]):
                self.assertTrue(math.isclose(g, w, rel_tol=1e-12, abs_tol=1e-12), (c["q"], g, w))
            self.assertEqual(r.render(), c["rendered"], c["q"])


if __name__ == "__main__":
    unittest.main()
