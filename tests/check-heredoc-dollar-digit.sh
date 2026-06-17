#!/usr/bin/env bash
# check-heredoc-dollar-digit.sh
#
# CI guard against the v7.41-era HEREDOC $<digit> footgun.
#
# Regression history: an unescaped dollar-amount ($5/$10/$25/$50) was written
# inside a double-quoted `python3 -c "..."` body in autonomy/loki. Because the
# body is a *double-quoted* bash string, bash performed parameter expansion on
# it BEFORE handing the source to python3. Under `set -u`, bash expanded `$5` as
# positional parameter 5, which was unbound, so `loki plan --json` crashed with
# "$5: unbound variable" for every user. The fix was to escape it as `\$5`.
#
# This guard scans autonomy/loki and autonomy/run.sh for an unescaped
# `$<digit>` ($1-$9 or multi-digit like $10, $25) appearing INSIDE a
# `python3 -c "..."` double-quoted body. In that context bash WILL expand the
# token, but the author almost always meant a literal dollar amount (or literal
# text) inside the Python source, not a bash positional. Such a token must be
# written `\$5` so bash leaves it alone.
#
# Why this scope (deliberately narrow, to stay precise and non-vacuous):
#   - Only `python3 -c "..."` (double-quoted) bodies are scanned. That is
#     exactly where the historical bug lived and where bash expansion is both
#     active AND unwanted. Both single-line and multi-line forms are covered.
#   - QUOTED-delimiter heredocs (`<<'EOF'` and `<<"EOF"`) are NOT scanned: a
#     quoted delimiter suppresses parameter expansion, so `$5` there is literal
#     and safe. (The task brief's "double-quoted heredoc" phrasing is inverted
#     re: bash semantics; a quoted delimiter is the SAFE case.)
#   - Legitimate bash positionals `$1`/`$2`/... in ordinary function bodies are
#     NOT scanned, because they are outside any `python3 -c "..."` body.
#   - `$0` is intentionally allowed even inside a python3 -c body: it is the
#     script name, is always set (never unbound under set -u), and is commonly
#     used in legitimate `$(dirname "$0")`-style path construction passed into
#     the Python source.
#
# Exit: 0 if clean, 1 (with file:line) if an unescaped in-context $<digit> is
# found.
#
# Usage: bash tests/check-heredoc-dollar-digit.sh [file ...]
#   Defaults to autonomy/loki and autonomy/run.sh when no files are given.

set -euo pipefail

# Resolve repo root from this script's location so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$#" -gt 0 ]; then
    TARGETS=("$@")
else
    TARGETS=("$REPO_ROOT/autonomy/loki" "$REPO_ROOT/autonomy/run.sh")
fi

# The scan logic lives in python3 for reliable in-string state tracking.
# Targets are passed as argv; findings are printed to stdout; exit code carries
# the verdict (0 clean, 1 found, 2 usage error).
TARGETS_JOINED="$(printf '%s\n' "${TARGETS[@]}")"

_LOKI_HD_TARGETS="$TARGETS_JOINED" python3 - <<'PYCHECK'
import os
import re
import sys

targets = [t for t in os.environ.get("_LOKI_HD_TARGETS", "").split("\n") if t]
if not targets:
    sys.stderr.write("check-heredoc-dollar-digit: no target files\n")
    sys.exit(2)

# Unescaped $1-$9 or multi-digit ($10, $25, ...). $0 is allowed (always set,
# legit script-path usage). The negative lookbehind rejects a backslash-escaped
# \$5 (the correct, safe form). The leading [1-9] excludes $0.
DOLLAR_DIGIT = re.compile(r'(?<!\\)\$([1-9][0-9]*)')

# A python3 -c " opener on a line. We only treat the double-quoted form (the
# one bash expands). After the opener, if there is no closing double quote on
# the same physical line, the body continues across lines until a line whose
# first non-whitespace character is a closing double quote.
OPENER = re.compile(r'python3 -c "')
CLOSER = re.compile(r'^\s*"')

findings = []

for path in targets:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().split("\n")
    except OSError as exc:
        sys.stderr.write("check-heredoc-dollar-digit: cannot read %s: %s\n" % (path, exc))
        sys.exit(2)

    in_block = False
    for idx, line in enumerate(lines, start=1):
        if not in_block:
            m = OPENER.search(line)
            if not m:
                continue
            rest = line[m.end():]
            # Inline (single-line) portion of the python source after the opener.
            if DOLLAR_DIGIT.search(rest):
                findings.append((path, idx, line.strip()))
            # If no closing double quote follows on this line, the body spans
            # subsequent lines (multi-line python3 -c "...").
            if '"' not in rest:
                in_block = True
        else:
            if CLOSER.match(line):
                in_block = False
                continue
            if DOLLAR_DIGIT.search(line):
                findings.append((path, idx, line.strip()))

if findings:
    sys.stderr.write(
        "FAIL: unescaped $<digit> inside a python3 -c \"...\" body "
        "(bash will expand it; under set -u this crashes). Escape as \\$N:\n"
    )
    for path, idx, text in findings:
        snippet = text if len(text) <= 100 else text[:100] + "..."
        sys.stderr.write("  %s:%d: %s\n" % (path, idx, snippet))
    sys.exit(1)

print("OK: no unescaped $<digit> in python3 -c \"...\" bodies (%d file(s) scanned)" % len(targets))
sys.exit(0)
PYCHECK
