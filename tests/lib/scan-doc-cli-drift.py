#!/usr/bin/env python3
"""DOC-02: report docs that name a CLI surface main does not have.

Generalizes the M-30 check (tests/test-modernize-docs.sh) from one guide to
every user doc. Rules, each checked against the code at scan time:

  R1 command  `loki <word>` inside a fenced code block or an inline code span
              must be a command the CLI dispatches: a top-level case arm of
              main() in autonomy/loki, or a case in loki-ts/src/cli.ts.
  R2 flag     a `--flag` in the same `loki ...` invocation (up to a pipe, `;`,
              `&&`, `>` or a shell comment) must appear as a literal somewhere
              in the CLI sources (autonomy/, bin/loki, loki-ts/src).
  R3 version  a version presented as current (a `Version:` or `Loki Mode:`
              header in a file's first 15 lines, or "current version ... vX.Y")
              must not be older than VERSION's major.minor.

Known limits (ponytail: lenient on purpose, tighten when a real miss shows up):
R2 accepts any flag literal in the sources (help strings included), so it does
not prove a flag is valid for that particular command. R1 checks only the
top-level command, not subcommands. Prose outside code spans is not parsed.

Output: one finding per line, path<TAB>line<TAB>rule<TAB>token.
Exit 0 = no findings, 1 = findings, 2 = ground truth could not be read (the
scan would be inert, so it is never reported as clean).
Env: DOCS_DRIFT_FILES (space separated) replaces the default doc set.
"""
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
DOC_DIRS = ("docs", "wiki", "examples", "deploy")
TOP_FILES = ("README.md", "SKILL.md")
# Historical logs: every past command and version is meant to stay there.
# BOARD.md and BACKLOG.md are live coordination queues the leader rewrites
# every cycle; their rows quote findings and propose commands not built yet.
EXCLUDE = {"CHANGELOG.md", "docs/v10/DECISIONS.md", "docs/v10/PROGRESS.md",
           "docs/v10/BOARD.md", "docs/v10/BACKLOG.md"}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "__pycache__"}


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8", errors="replace") as fh:
        return fh.read()


def die(msg):
    print(f"scan is inert: {msg}", file=sys.stderr)
    sys.exit(2)


def commands():
    lines = read("autonomy/loki").splitlines()
    starts = [i for i, l in enumerate(lines[:-1])
              if l.startswith('    case "$command" in') and lines[i + 1].startswith("        run)")]
    if not starts:
        die("main() dispatch block not found in autonomy/loki")
    cmds = set()
    for l in lines[starts[-1] + 1:]:
        if l.startswith("    esac"):
            break
        m = re.match(r"^(?:        |\t)([a-z0-9|_-]+)\)", l)
        if m:
            cmds.update(m.group(1).split("|"))
    cmds |= set(re.findall(r'case "([a-z0-9-]+)":', read("loki-ts/src/cli.ts")))
    # bin/loki handles `loki legacy` (D48) before either dispatcher sees it.
    cmds |= set(re.findall(r"^    ([a-z0-9-]+)\)\n        shift\n", read("bin/loki"), re.M))
    return cmds


def flags():
    paths = ["bin/loki", "autonomy/loki"]
    for top, exts in (("autonomy", (".sh", ".py")), ("loki-ts/src", (".ts",))):
        for d, dirs, files in os.walk(os.path.join(ROOT, top)):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            paths += [os.path.relpath(os.path.join(d, f), ROOT) for f in files if f.endswith(exts)]
    out = set()
    for p in paths:
        out |= set(re.findall(r"--[a-z][a-z0-9-]*", read(p)))
    return out


def doc_files():
    env = os.environ.get("DOCS_DRIFT_FILES")
    if env:
        return env.split()
    out = [f for f in TOP_FILES if os.path.isfile(os.path.join(ROOT, f))]
    for top in DOC_DIRS:
        for d, dirs, files in os.walk(os.path.join(ROOT, top)):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            out += [os.path.relpath(os.path.join(d, f), ROOT) for f in files if f.endswith(".md")]
    pk = os.path.join(ROOT, "packages")
    if os.path.isdir(pk):
        out += [f"packages/{p}/README.md" for p in sorted(os.listdir(pk))
                if os.path.isfile(os.path.join(pk, p, "README.md"))]
    return sorted(f for f in out if f not in EXCLUDE)


# `loki <word>` not preceded by a path/identifier char (so ~/.loki, loki-mode,
# $loki do not match) and not followed by a path or URL char (so
# `loki owner/repo#1` and `loki https://...` are positional args, not commands).
INVOKE = re.compile(r"(?<![\w/.\-$])loki ([a-z][a-z0-9_-]*)(?![/:.\w-])([^|;&#>`)]*)")
FLAG = re.compile(r"(?<![\w-])(--[a-z][a-z0-9-]*)")
HEADER_VER = re.compile(r"(?:Version|Loki Mode)\**:?\**\s*v(\d+)\.(\d+)")
CURRENT_VER = re.compile(r"current version[^.\n]{0,20}?v(\d+)\.(\d+)", re.I)


def main():
    cmds, known_flags = commands(), flags()
    m = re.match(r"(\d+)\.(\d+)", read("VERSION").strip())
    if not m:
        die("VERSION is not semver")
    cur = (int(m.group(1)), int(m.group(2)))
    if len(cmds) < 80 or not {"start", "status", "help"} <= cmds:
        die(f"extracted only {len(cmds)} commands")
    if len(known_flags) < 200:
        die(f"extracted only {len(known_flags)} flags")
    print(f"# ground truth: {len(cmds)} commands, {len(known_flags)} flags, current {cur[0]}.{cur[1]}",
          file=sys.stderr)

    findings = []
    for rel in doc_files():
        fence = False
        for n, line in enumerate(read(rel).splitlines(), 1):
            for vm in ([HEADER_VER.search(line)] if n <= 15 else []) + [CURRENT_VER.search(line)]:
                if vm and (int(vm.group(1)), int(vm.group(2))) < cur:
                    findings.append((rel, n, "version", f"v{vm.group(1)}.{vm.group(2)}"))
            if line.lstrip().startswith(("```", "~~~")):
                fence = not fence
                continue
            segs = [re.sub(r"(^|\s)#.*$", "", line)] if fence else re.findall(r"`([^`]+)`", line)
            for seg in segs:
                for im in INVOKE.finditer(seg):
                    if im.group(1) not in cmds:
                        findings.append((rel, n, "command", f"loki {im.group(1)}"))
                    for f in FLAG.findall(im.group(2)):
                        if f not in known_flags:
                            findings.append((rel, n, "flag", f))
    for f in findings:
        print("\t".join(map(str, f)))
    return 1 if findings else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # a crash is unmeasured, never clean
        die(f"{type(exc).__name__}: {exc}")
