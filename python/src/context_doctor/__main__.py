"""python -m context_doctor pack <files...> --query "..." [--max-tokens 4000] | profile <conversation.json>"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .pack import PackSource, pack_context
from .profile import profile_messages

_SKIP = {"node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv"}


def _read(paths):
    for p in paths:
        if p == "-":
            yield PackSource("stdin", sys.stdin.read())
        elif os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = sorted(d for d in dirs if d not in _SKIP and not d.startswith("."))
                for f in sorted(files):
                    full = os.path.join(root, f)
                    try:
                        with open(full, encoding="utf-8") as fh:
                            yield PackSource(os.path.relpath(full), fh.read())
                    except (UnicodeDecodeError, OSError):
                        continue
        else:
            with open(p, encoding="utf-8") as fh:
                yield PackSource(p, fh.read())


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
        r = pack_context(list(_read(a.paths)), query=a.query, budget=a.max_tokens, ids=a.ids.split(",") if a.ids else None, model=a.model)
        print(r.render())
    else:
        with (sys.stdin if a.file == "-" else open(a.file, encoding="utf-8")) as fh:
            print(profile_messages(json.load(fh), a.model).render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
