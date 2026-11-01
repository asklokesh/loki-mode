import argparse
import sys
from typing import Optional

from . import report, store


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="todo")
    parser.add_argument("--file", default="todo.json", help="task file (default: todo.json)")
    sub = parser.add_subparsers(dest="command", required=True)
    ls = sub.add_parser("list", help="list tasks")
    ls.add_argument("--format", choices=["text", "json"], default="text")
    state = ls.add_mutually_exclusive_group()
    state.add_argument("--done", action="store_true")
    state.add_argument("--pending", action="store_true")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    tasks = store.load(args.file)
    if args.command == "list":
        if args.done:
            tasks = [t for t in tasks if t.done]
        elif args.pending:
            tasks = [t for t in tasks if not t.done]
        if args.format == "json":
            print(report.render_json(tasks))
            return 0
        out = report.render_text(tasks)
        if out:
            print(out)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
