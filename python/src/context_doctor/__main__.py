"""python -m context_doctor pack <files...> --query "..." [--max-tokens 4000] | profile <conversation.json>"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

from .pack import PackSource, pack_context
from .profile import profile_messages

# Same folders the TypeScript `pack` skips outside a git repository.
_SKIP = {"node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", "vendor"}


def _git():
    """git's own path, from PATH's absolute folders, or None.

    Run by bare name, git is looked up in the current folder first on Windows
    (CreateProcess, shutil.which), and wherever PATH names "." elsewhere:
    `pack .` in a cloned repository ran a git.exe committed there.
    """
    names = ["git.exe", "git.com"] if os.name == "nt" else ["git"]
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if not d or not os.path.isabs(d):
            continue
        for n in names:
            p = os.path.join(d, n)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return p
    return None


def _git_files(folder):
    """Files git considers part of the repository under `folder` (relative), or None outside git.

    Tracked plus untracked-not-ignored, as `git ls-files` lists them, so
    .gitignore'd build output, data dumps and secrets (.env) never enter a pack.
    """
    git = _git()
    if git is None:
        return None
    try:
        r = subprocess.run(
            # A folder's own .git/config can name a command for ls-files to run (core.fsmonitor).
            [git, "-c", "core.fsmonitor=false", "-C", folder, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    names = [f for f in r.stdout.decode("utf-8", "surrogateescape").split("\0") if f]
    # --cached lists files deleted from the work tree too; only what exists is read.
    return sorted(f for f in names if os.path.lexists(os.path.join(folder, f)))


def _walk(folder, hidden=None):
    """Files under `folder` outside git: dependency, build and hidden folders and hidden files
    (.env, .npmrc, editor state) are passed over; `hidden` counts what was."""
    for root, dirs, files in os.walk(folder):  # does not descend into linked folders
        if hidden is not None:
            hidden[0] += sum(1 for d in dirs if d.startswith(".") and d not in _SKIP) + sum(1 for f in files if f.startswith("."))
        dirs[:] = sorted(d for d in dirs if d not in _SKIP and not d.startswith("."))
        for f in sorted(files):
            if not f.startswith("."):
                yield os.path.join(root, f)


# Files that hold credentials by convention, as the TypeScript `pack` skips them
# (src/pack.ts secretFileReason): skipped even when named or tracked by git,
# unless --include-secrets.
_SECRET_NAMES = {
    ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".pgpass", ".htpasswd", ".vault-token",
    # The agents' own sign-ins: Claude Code's OAuth tokens (Linux, Windows), Gemini CLI's, Terraform's.
    ".credentials.json", "oauth_creds.json", "credentials.tfrc.json",
}
# A file name that holds credentials inside one folder only: Codex's sign-in, Cargo's and RubyGems' tokens.
_SECRET_IN_DIR = {".codex": {"auth.json"}, ".cargo": {"credentials", "credentials.toml"}, ".gem": {"credentials"}}
_SECRET_EXT = {".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"}


def secret_file_reason(path):
    """Why `path` looks like a secrets file, or None."""
    name = os.path.basename(path)
    lower = name.lower()
    if lower == ".env" or lower.startswith(".env."):
        return "an .env file"
    if lower in _SECRET_NAMES:
        return f"a credentials file ({name})"
    if re.match(r"^id_(rsa|dsa|ecdsa|ed25519)", lower) and not lower.endswith(".pub"):
        return "a private SSH key"
    ext = os.path.splitext(lower)[1]
    if ext in _SECRET_EXT:
        return f"a key or certificate store ({ext})"
    parts = re.split(r"[\\/]+", path)
    parent = parts[-2].lower() if len(parts) >= 2 else ""
    if lower == "credentials" and parent == ".aws":
        return "AWS credentials"
    if lower in _SECRET_IN_DIR.get(parent, ()):
        return f"a credentials file ({parent}/{name})"
    return None


def _sensitive_dirs():
    home = os.path.expanduser("~")
    dirs = [os.path.join(home, d) for d in (".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", os.path.join(".config", "gcloud"), os.path.join(".config", "gh"), os.path.join(".config", "github-copilot"), os.path.join("Library", "Keychains"), ".password-store")]
    # Where CLAUDE_CONFIG_DIR and CODEX_HOME put the agents' sign-ins.
    dirs.append(os.path.join(os.environ.get("CLAUDE_CONFIG_DIR", "").strip() or os.path.join(home, ".claude"), ".credentials.json"))
    dirs.append(os.path.join(os.environ.get("CODEX_HOME", "").strip() or os.path.join(home, ".codex"), "auth.json"))
    dirs += ["/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/master.passwd", "/etc/ssh"]
    return sorted(set(dirs + [os.path.realpath(d) for d in dirs]))


def _agent_config_files():
    """The agents' MCP and settings files in the home folder, as src/pack.ts agentConfigFiles lists them.

    An MCP server's `env` there commonly holds an API key. A project's own .mcp.json is not refused.
    """
    home = os.path.expanduser("~")
    claude = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    codex = os.environ.get("CODEX_HOME", "").strip()
    files = [os.path.join(claude or home, ".claude.json"), os.path.join(home, ".claude.json")]
    # Claude Code's copies of it: <config dir>/backups/.claude.json.backup.<ms>, and the older <file>.backup.
    files += [f + ".backup" for f in files]
    for d in {claude or os.path.join(home, ".claude"), os.path.join(home, ".claude")}:
        files += [os.path.join(d, "settings.json"), os.path.join(d, "settings.local.json"), os.path.join(d, "backups")]
    files += [
        os.path.join(home, ".cursor", "mcp.json"),
        os.path.join(codex or os.path.join(home, ".codex"), "config.toml"), os.path.join(home, ".codex", "config.toml"),
        os.path.join(home, ".gemini", "settings.json"),
        os.path.join(home, ".gemini", "config", "mcp_config.json"), os.path.join(home, ".gemini", "antigravity", "mcp_config.json"),
        os.path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        os.path.join(os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"),
        os.path.join(home, ".config", "Claude", "claude_desktop_config.json"),
        os.path.join(os.environ.get("COPILOT_HOME") or os.path.join(home, ".copilot"), "mcp-config.json"),
        os.path.join(home, ".copilot", "mcp-config.json"),
    ]
    for d in _app_data_dirs():
        # Claude Desktop's extension settings, VS Code's user MCP servers (stable and Insiders), Zed's settings.
        files.append(os.path.join(d, "Claude", "Claude Extensions Settings"))
        files += [os.path.join(u, "mcp.json") for u in _vscode_user_dirs(d)]
        files.append(os.path.join(d, "zed", "settings.json"))
    files.append(os.path.join(home, ".codeium", "windsurf", "mcp_config.json"))
    return sorted(set(files + [os.path.realpath(f) for f in files]))


def _app_data_dirs():
    """Where apps keep their settings: macOS's Application Support, Windows' %APPDATA%, Linux's XDG config folder."""
    home = os.path.expanduser("~")
    dirs = [os.path.join(home, "Library", "Application Support"),
            os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming"),
            os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), os.path.join(home, ".config")]
    return sorted(set(dirs))


def _vscode_user_dirs(app_data):
    return [os.path.join(app_data, app, "User") for app in ("Code", "Code - Insiders")]


def _vscode_profile_dirs():
    """The folders of VS Code's profiles, each with an mcp.json of its own (User/profiles/<id>/mcp.json)."""
    dirs = [os.path.join(u, "profiles") for d in _app_data_dirs() for u in _vscode_user_dirs(d)]
    return sorted(set(dirs + [os.path.realpath(d) for d in dirs]))


def _within(root, inner):
    try:
        rel = os.path.relpath(inner, root)
    except ValueError:  # Windows: another drive is never inside
        return False
    return rel == "." or not (rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel))


def _name(path):
    """A source's name: relative to the working directory when it can be (Windows has no relative path across drives)."""
    try:
        return os.path.relpath(path)
    except ValueError:
        return path


def _read(paths, skipped=None, include_secrets=False):
    """Read files and folders into sources, as the TypeScript `pack` does.

    A path named here is read even through a symlink; a symlink met inside a
    folder is not followed (git does not follow one either), so a link to a
    secret beside the repo or to /etc/hosts never enters a pack. A file reached
    twice is read once. What is left out and why goes to `skipped`.
    """
    skipped = [] if skipped is None else skipped
    seen = set()
    denied = [] if include_secrets else _sensitive_dirs()
    configs = [] if include_secrets else _agent_config_files()
    profiles = [] if include_secrets else _vscode_profile_dirs()
    hint = "" if include_secrets else " (--include-secrets packs it)"

    # macOS and Windows disks ignore case by default: ~/.AWS/credentials is ~/.aws/credentials there.
    fold = str.lower if sys.platform in ("darwin", "win32") else (lambda s: s)

    def refused(path, top):
        real = os.path.realpath(path)
        for d in denied:
            if _within(fold(d), fold(real)):
                if top:
                    skipped.append(f"{path}: refused, {d} holds credentials{hint}")
                return True
        for f in configs + (profiles if os.path.basename(real).lower() == "mcp.json" else []):
            if _within(fold(f), fold(real)):
                skipped.append(f"{path}: refused, {f} can hold API keys (an MCP server's env){hint}")
                return True
        return False

    def source(path, name):
        real = os.path.realpath(path)
        if real in seen:
            return None
        # The link's name and its target's: notes.md pointing at an .env is an .env.
        why = None if include_secrets else (secret_file_reason(path) or secret_file_reason(real))
        if why:
            skipped.append(f"{path}: {why}, likely holding secrets; not packed{hint}")
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except UnicodeDecodeError:
            return None
        except OSError as e:
            skipped.append(f"{path}: {e.strerror or 'unreadable'}")
            return None
        seen.add(real)
        return PackSource(name, text)

    for p in paths:
        if p == "-":
            yield PackSource("stdin", sys.stdin.read())
        elif refused(p, True):
            continue
        elif os.path.isdir(p):
            root = os.path.realpath(p)
            listed = _git_files(p)
            hidden = [0]
            candidates = [os.path.join(p, f) for f in listed] if listed is not None else list(_walk(p, hidden))
            if hidden[0]:
                skipped.append(f"{p}: {hidden[0]} hidden file(s) or folder(s) not read (name one to pack it)")
            if listed is not None and not listed:
                skipped.append(f"{p}: git lists no files here (.gitignore'd or empty); not read")
            for full in candidates:
                if os.path.islink(full):
                    target = os.path.realpath(full)
                    if os.path.exists(target) and not _within(root, target):
                        skipped.append(f"{full}: symlink pointing outside the folder (not followed)")
                    continue
                if not os.path.isfile(full) or refused(full, False):
                    continue
                s = source(full, _name(full))
                if s:
                    yield s
        elif os.path.exists(p) and not os.path.isfile(p):
            # /dev/zero, a FIFO: read whole, it never ends.
            skipped.append(f"{p}: not a regular file")
        else:
            s = source(p, p)
            if s:
                yield s


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m context_doctor")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pk = sub.add_parser("pack", help="only the chunks of big files a question needs, within a token budget")
    pk.add_argument("paths", nargs="+")
    pk.add_argument("-q", "--query")
    pk.add_argument("--max-tokens", type=int, default=None)
    pk.add_argument("--ids", default=None, help="comma-separated chunk ids")
    pk.add_argument("--model", default=None)
    pk.add_argument("--include-secrets", action="store_true", help="also pack .env, .npmrc, private keys and other credential files")
    pr = sub.add_parser("profile", help="where a conversation's tokens go")
    pr.add_argument("file")
    pr.add_argument("--model", default=None)
    a = ap.parse_args(argv)
    if a.cmd == "pack":
        skipped = []
        r = pack_context(list(_read(a.paths, skipped, include_secrets=a.include_secrets)), query=a.query, budget=a.max_tokens, ids=a.ids.split(",") if a.ids else None, model=a.model)
        print(r.render())
        for note in skipped:
            print(f"skipped: {note}", file=sys.stderr)
    else:
        with (sys.stdin if a.file == "-" else open(a.file, encoding="utf-8")) as fh:
            print(profile_messages(json.load(fh), a.model).render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
