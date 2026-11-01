import argparse
import sys
from typing import Optional

from . import report, store


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="todo")
    parser.add_argument("--file", default="todo.json", help="task file (default: todo.json)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="list tasks")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    tasks = store.load(args.file)
    if args.command == "list":
        out = report.render_text(tasks)
        if out:
            print(out)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
