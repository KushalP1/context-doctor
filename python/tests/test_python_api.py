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

    def test_credential_folder_in_another_case(self):
        import os
        import tempfile
        from unittest import mock

        from context_doctor.__main__ import _read, secret_file_reason

        self.assertTrue(secret_file_reason("h/.AWS/credentials"))
        home = tempfile.mkdtemp()
        os.makedirs(os.path.join(home, ".config", "gh"))
        with open(os.path.join(home, ".config", "gh", "hosts.yml"), "w") as fh:
            fh.write("oauth_token: gho_case\n")
        spelled = os.path.join(home, ".CONFIG", "GH", "hosts.yml")
        if not os.path.exists(spelled):
            return  # a case-sensitive disk: that path is not the file
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            skipped = []
            self.assertEqual(list(_read([spelled], skipped)), [])
        self.assertTrue(any("holds credentials" in s for s in skipped), skipped)

    def test_agent_config_files_refused(self):
        import os
        import tempfile
        from unittest import mock

        from context_doctor.__main__ import _read

        home = tempfile.mkdtemp()
        files = [".claude.json", os.path.join(".claude", "settings.json"), os.path.join(".cursor", "mcp.json"),
                 os.path.join(".codex", "config.toml"), os.path.join(".gemini", "settings.json"),
                 os.path.join(".gemini", "config", "mcp_config.json"), os.path.join(".copilot", "mcp-config.json"),
                 os.path.join(".config", "Claude", "claude_desktop_config.json"),
                 # Claude Code's backups of ~/.claude.json, which carry the same env.
                 ".claude.json.backup", os.path.join(".claude", "backups", ".claude.json.backup.1762700000000"),
                 # Other agents' MCP files: VS Code's (each OS, a profile's), Windsurf's, Zed's settings, Claude Desktop's extensions.
                 os.path.join("Library", "Application Support", "Code", "User", "mcp.json"),
                 os.path.join("AppData", "Roaming", "Code", "User", "mcp.json"),
                 os.path.join(".config", "Code - Insiders", "User", "mcp.json"),
                 os.path.join(".config", "Code", "User", "profiles", "-4a1b2c3d", "mcp.json"),
                 os.path.join(".codeium", "windsurf", "mcp_config.json"), os.path.join(".config", "zed", "settings.json"),
                 os.path.join(".config", "Claude", "Claude Extensions Settings", "ant.dir.gh.stripe.json")]
        for f in files:
            os.makedirs(os.path.dirname(os.path.join(home, f)), exist_ok=True)
            with open(os.path.join(home, f), "w") as fh:
                fh.write('{"env": {"API_KEY": "sk-live-config"}}\n')
        repo = os.path.join(home, "repo")
        os.makedirs(repo)
        with open(os.path.join(repo, ".mcp.json"), "w") as fh:
            fh.write('{"mcpServers": {}}\n')
        env = {"HOME": home, "USERPROFILE": home, "APPDATA": os.path.join(home, "AppData", "Roaming")}
        with mock.patch.dict(os.environ, env):
            for k in ("CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME", "XDG_CONFIG_HOME"):
                os.environ.pop(k, None)
            skipped = []
            texts = [s.text for s in _read([os.path.join(home, f) for f in files] + [os.path.join(repo, ".mcp.json")], skipped)]
        self.assertEqual(texts, ['{"mcpServers": {}}\n'])
        self.assertEqual(sum("can hold API keys" in s for s in skipped), len(files), skipped)

    def test_folder_git_config_runs_nothing(self):
        import os
        import subprocess
        import tempfile

        from context_doctor.__main__ import _read

        repo = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", repo], check=True)
        with open(os.path.join(repo, "guide.md"), "w") as fh:
            fh.write("# Guide\n\nhello\n")
        # An unpacked archive's own .git/config: git runs this from the work tree's top.
        subprocess.run(["git", "-C", repo, "config", "core.fsmonitor", "echo ran > fsmonitor-ran"], check=True)
        list(_read([repo], []))
        self.assertFalse(os.path.exists(os.path.join(repo, "fsmonitor-ran")), "git ran the folder's fsmonitor command")

    @unittest.skipIf(__import__("os").name == "nt", "a stand-in git must be an executable on Windows")
    def test_git_in_the_current_folder_is_not_run(self):
        # Windows looks a bare name up in the current folder first; elsewhere a "." in PATH does the same.
        import os
        import subprocess
        import tempfile

        from context_doctor.__main__ import _read

        repo = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", repo], check=True)
        with open(os.path.join(repo, "guide.md"), "w") as fh:
            fh.write("# Guide\n\nhello\n")
        marker = os.path.join(repo, "planted-git-ran")
        with open(os.path.join(repo, "git"), "w") as fh:
            fh.write("#!/bin/sh\ntouch '%s'\nexit 1\n" % marker)
        os.chmod(os.path.join(repo, "git"), 0o755)
        cwd, path = os.getcwd(), os.environ.get("PATH", "")
        os.chdir(repo)
        os.environ["PATH"] = "." + os.pathsep + path
        try:
            names = [s.name for s in _read([repo], [])]
        finally:
            os.chdir(cwd)
            os.environ["PATH"] = path
        self.assertFalse(os.path.exists(marker), "the folder's own git ran")
        self.assertTrue(any(n.endswith("guide.md") for n in names), names)


class Fixes(unittest.TestCase):
    def test_pack_documents_ids_stay_unique_when_a_name_looks_generated(self):
        docs = [{"name": "x.md", "text": "alpha one"}, {"name": "x.md", "text": "beta two"}, {"name": "x.md~2", "text": "gamma three"}]
        r = pack_documents(docs)
        names = [s["name"] for s in r.sources]
        self.assertEqual(len(names), len(set(names)), names)
        ids = [c.id for c in r.chunks]
        self.assertEqual(len(ids), len(set(ids)), ids)
        self.assertIn("x.md~2", names)

    def test_hex_runs_are_not_base64_but_real_base64_is(self):
        import base64
        import os
        hex_run = "deadbeef0123456789abcdef" * 40
        p = profile_messages([{"role": "user", "content": "digest " + hex_run}])
        self.assertFalse([f for f in p.findings if f.id == "base64_blob"])
        blob = base64.b64encode(os.urandom(3000)).decode()
        p = profile_messages([{"role": "user", "content": "image " + blob}])
        self.assertTrue([f for f in p.findings if f.id == "base64_blob"])
        p = profile_messages([{"role": "user", "content": "a" * 5000}])
        self.assertFalse([f for f in p.findings if f.id == "base64_blob"])

    def test_one_huge_line_packs_in_linear_time(self):
        import time
        from context_doctor.pack import chunk_source, PackSource
        start = time.time()
        chunks = chunk_source(PackSource("min.js", "var a=1;" * 600_000))
        self.assertLess(time.time() - start, 5)
        self.assertGreater(len(chunks), 100)
        self.assertEqual("".join(c.text for c in chunks), "var a=1;" * 600_000)



class PackSecrets(unittest.TestCase):
    def _folder(self):
        import os
        import tempfile
        d = tempfile.mkdtemp()
        for name, text in [(".env", "OPENAI_API_KEY=sk-live-123"), (".npmrc", "//r/:_authToken=npm_secret"), (".prettierrc", "{}"), ("server.pem", "-----BEGIN PRIVATE KEY-----"), ("guide.md", "# Guide\n\nHello.\n")]:
            with open(os.path.join(d, name), "w") as fh:
                fh.write(text)
        return d

    def test_folder_outside_git_skips_hidden_files_and_secrets(self):
        from context_doctor.__main__ import _read
        d = self._folder()
        skipped = []
        sources = list(_read([d], skipped))
        self.assertEqual([s.name.replace("\\", "/").split("/")[-1] for s in sources], ["guide.md"])
        self.assertFalse(any("sk-live" in s.text or "npm_secret" in s.text or "PRIVATE KEY" in s.text for s in sources))
        self.assertTrue(any("server.pem: a key or certificate store" in n for n in skipped), skipped)
        self.assertTrue(any("hidden file(s)" in n for n in skipped), skipped)

    def test_named_secrets_are_skipped_unless_included(self):
        import os
        from context_doctor.__main__ import _read
        d = self._folder()
        skipped = []
        names = [s.name for s in _read([os.path.join(d, ".env"), os.path.join(d, ".prettierrc")], skipped)]
        self.assertEqual([n.replace("\\", "/").split("/")[-1] for n in names], [".prettierrc"])
        self.assertTrue(any("an .env file" in n and "--include-secrets" in n for n in skipped), skipped)
        opted = list(_read([os.path.join(d, ".env")], [], include_secrets=True))
        self.assertIn("sk-live-123", opted[0].text)

    def test_agent_sign_ins_are_skipped(self):
        from context_doctor.__main__ import secret_file_reason
        for f in ["h/.claude/.credentials.json", "h/.codex/auth.json", "h/.gemini/oauth_creds.json", "h/.cargo/credentials.toml", ".vault-token"]:
            self.assertTrue(secret_file_reason(f), f)
        for f in ["src/auth.json", "docs/credentials", "oauth.md"]:
            self.assertIsNone(secret_file_reason(f), f)

    def test_shell_histories_and_home_registry_sign_ins_are_skipped(self):
        import os
        import tempfile
        from unittest import mock

        from context_doctor.__main__ import _read, secret_file_reason
        for f in ["h/.bash_history", "h/.zsh_history", "h/.local/share/fish/fish_history", "h/PSReadLine/ConsoleHost_history.txt"]:
            self.assertTrue(secret_file_reason(f), f)
        home, project = tempfile.mkdtemp(), tempfile.mkdtemp()
        os.mkdir(os.path.join(home, ".m2"))
        for path, text in [(os.path.join(home, ".m2", "settings.xml"), "<password>hunter2</password>"), (os.path.join(home, ".yarnrc.yml"), "npmAuthToken: npm_secret"), (os.path.join(project, ".yarnrc.yml"), "nodeLinker: node-modules")]:
            with open(path, "w") as fh:
                fh.write(text)
        skipped = []
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            texts = [s.text for s in _read([os.path.join(home, ".m2", "settings.xml"), os.path.join(home, ".yarnrc.yml"), os.path.join(project, ".yarnrc.yml")], skipped)]
        self.assertEqual(texts, ["nodeLinker: node-modules"], skipped)

    def test_a_device_named_outright_is_not_read(self):
        import os
        from context_doctor.__main__ import _read
        if not os.path.exists("/dev/zero"):
            self.skipTest("no /dev/zero")
        skipped = []
        self.assertEqual(list(_read(["/dev/zero"], skipped)), [])
        self.assertTrue(any("not a regular file" in n for n in skipped), skipped)
