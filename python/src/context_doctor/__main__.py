"""python -m context_doctor pack <files...> --query "..." [--max-tokens 4000] | profile <conversation.json>"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

from .pack import PackSource, pack_context
from .profile import profile_messages

# Same folders the TypeScript `pack` skips outside a git repository.
_SKIP = {"node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", "vendor"}


def _git_files(folder):
    """Files git considers part of the repository under `folder` (relative), or None outside git.

    Tracked plus untracked-not-ignored, as `git ls-files` lists them, so
    .gitignore'd build output, data dumps and secrets (.env) never enter a pack.
    """
    try:
        r = subprocess.run(
            ["git", "-C", folder, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    names = [f for f in r.stdout.decode("utf-8", "surrogateescape").split("\0") if f]
    # --cached lists files deleted from the work tree too; only what exists is read.
    return sorted(f for f in names if os.path.lexists(os.path.join(folder, f)))


def _walk(folder):
    for root, dirs, files in os.walk(folder):  # does not descend into linked folders
        dirs[:] = sorted(d for d in dirs if d not in _SKIP and not d.startswith("."))
        for f in sorted(files):
            yield os.path.join(root, f)


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


def _read(paths, skipped=None):
    """Read files and folders into sources, as the TypeScript `pack` does.

    A path named here is read even through a symlink; a symlink met inside a
    folder is not followed (git does not follow one either), so a link to a
    secret beside the repo or to /etc/hosts never enters a pack. A file reached
    twice is read once. What is left out and why goes to `skipped`.
    """
    skipped = [] if skipped is None else skipped
    seen = set()

    def source(path, name):
        real = os.path.realpath(path)
        if real in seen:
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except (UnicodeDecodeError, OSError):
            return None
        seen.add(real)
        return PackSource(name, text)

    for p in paths:
        if p == "-":
            yield PackSource("stdin", sys.stdin.read())
        elif os.path.isdir(p):
            root = os.path.realpath(p)
            listed = _git_files(p)
            candidates = [os.path.join(p, f) for f in listed] if listed is not None else list(_walk(p))
            if listed is not None and not listed:
                skipped.append(f"{p}: git lists no files here (.gitignore'd or empty); not read")
            for full in candidates:
                if os.path.islink(full):
                    target = os.path.realpath(full)
                    if os.path.exists(target) and not _within(root, target):
                        skipped.append(f"{full}: symlink pointing outside the folder (not followed)")
                    continue
                if not os.path.isfile(full):
                    continue
                s = source(full, _name(full))
                if s:
                    yield s
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
    pr = sub.add_parser("profile", help="where a conversation's tokens go")
    pr.add_argument("file")
    pr.add_argument("--model", default=None)
    a = ap.parse_args(argv)
    if a.cmd == "pack":
        skipped = []
        r = pack_context(list(_read(a.paths, skipped)), query=a.query, budget=a.max_tokens, ids=a.ids.split(",") if a.ids else None, model=a.model)
        print(r.render())
        for note in skipped:
            print(f"skipped: {note}", file=sys.stderr)
    else:
        with (sys.stdin if a.file == "-" else open(a.file, encoding="utf-8")) as fh:
            print(profile_messages(json.load(fh), a.model).render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
