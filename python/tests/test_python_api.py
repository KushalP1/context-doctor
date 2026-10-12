"""The Python-only surface: framework documents, message profiles, the CLI."""

import io
import json
import unittest
from contextlib import redirect_stdout

from context_doctor import pack_documents, profile_messages
from context_doctor.__main__ import main


class LangChainDoc:  # the shape of langchain_core.documents.Document
    def __init__(self, text, source):
        self.page_content = text
        self.metadata = {"source": source}


class LlamaNode:  # the shape of llama_index TextNode
    def __init__(self, text, path):
        self._t = text
        self.metadata = {"file_path": path}

    def get_content(self):
        return self._t


class NodeWithScore:
    def __init__(self, node):
        self.node = node
        self.score = 0.9


FILLER = "Unrelated paragraph about the office plants and the coffee machine. " * 30


class Api(unittest.TestCase):
    def test_pack_documents_reads_framework_shapes_and_keeps_ids_unique(self):
        docs = [
            LangChainDoc(FILLER, "handbook.md"),
            LangChainDoc("Rotate the signing key with keyctl rotate --signing.", "handbook.md"),
            NodeWithScore(LlamaNode("Invoices go out on the first of the month.", "billing.txt")),
            "a plain string about lunch",
        ]
        r = pack_documents(docs, "how do I rotate the signing key", budget=200)
        self.assertIn("keyctl", r.render())
        self.assertEqual([s["name"] for s in r.sources], ["handbook.md", "handbook.md~2", "billing.txt", "doc4"])
        self.assertLessEqual(r.packed_tokens, 200)

    def test_profile_finds_the_big_tool_result_and_the_duplicate(self):
        big = "row | " * 3000
        paste = "Here is our pricing policy. " * 40
        conv = {
            "model": "claude-sonnet-5",
            "system": "You are helpful.",
            "messages": [
                {"role": "user", "content": paste},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "search", "input": {"q": "x"}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": big}]},
                {"role": "user", "content": paste},
            ],
        }
        p = profile_messages(conv)
        self.assertEqual(p.model, "claude-sonnet-5")
        self.assertGreater(p.by_category["tool_result"], p.by_category["user"])
        self.assertEqual(p.findings[0].id, "large_tool_result")
        self.assertIn("duplicate_content", [f.id for f in p.findings])
        self.assertIn("tool_result", p.render())

    def test_openai_messages_profile(self):
        p = profile_messages([{"role": "system", "content": "hi"}, {"role": "tool", "tool_call_id": "c", "content": "x" * 50}])
        self.assertIn("tool_result", p.by_category)

    def test_cli_pack(self):
        import tempfile, os
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "a.md"), "w") as f:
            f.write("# A\n\n## Keys\n\nRotate with keyctl.\n\n## Other\n\n" + FILLER)
        out = io.StringIO()
        with redirect_stdout(out):
            main(["pack", os.path.join(d, "a.md"), "-q", "rotate keys", "--max-tokens", "100"])
        self.assertTrue(out.getvalue().startswith("PACKED"))
        self.assertIn("keyctl", out.getvalue())


if __name__ == "__main__":
    unittest.main()


class PackReadsWhatGitDoes(unittest.TestCase):
    """The CLI reads folders as the TypeScript pack does: git's file list, no links out, each file once."""

    def test_gitignore_symlinks_and_duplicates(self):
        import os
        import subprocess
        import tempfile

        from context_doctor.__main__ import _read

        outside = tempfile.mkdtemp()
        with open(os.path.join(outside, "secret.txt"), "w") as fh:
            fh.write("outside secret")
        repo = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", repo], check=True)
        with open(os.path.join(repo, ".gitignore"), "w") as fh:
            fh.write(".env\n")
        with open(os.path.join(repo, ".env"), "w") as fh:
            fh.write("API_KEY=do-not-pack")
        with open(os.path.join(repo, "guide.md"), "w") as fh:
            fh.write("# Guide\n\nrotate the keys\n")
        try:
            os.symlink(os.path.join(outside, "secret.txt"), os.path.join(repo, "notes.md"))
            linked = True
        except (OSError, NotImplementedError):  # Windows without symlink privilege
            linked = False
        skipped = []
        sources = list(_read([repo, os.path.join(repo, "guide.md")], skipped))
        texts = [s.text for s in sources]
        self.assertEqual(sum("rotate the keys" in t for t in texts), 1, "a file reached twice is read once")
        self.assertFalse(any("do-not-pack" in t for t in texts), ".gitignore'd .env stays out")
        if linked:
            self.assertFalse(any("outside secret" in t for t in texts), "a link out of the folder is not followed")
            self.assertTrue(any("symlink pointing outside" in n for n in skipped))
