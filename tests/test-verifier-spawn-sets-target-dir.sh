#!/usr/bin/env bash
# FC-29 guard: a test that spawns the receipt verifier through the CLI must pin
# the tree it verifies. `loki proof verify` and loki_remote_verify_receipt run
# `proof-verify.py "$pj" "${TARGET_DIR:-.}"`, so an unset TARGET_DIR makes the
# verifier hash and git-diff the CALLER's cwd. In a fresh worktree that is a few
# thousand files; in a checkout holding many worktrees it is a million-file
# walk, and the suite hangs only for the person who runs it there.
#
# A spawn passes when its logical command, or the 12 lines before it, sets
# TARGET_DIR= or moves into a directory it owns (`cd "..."`). A deliberate
# exception carries `# target-dir-ok: <reason>` on the same line.
#
# Direct python runs of proof-verify.py are out of scope: they take the repo as
# an explicit argument.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${LOKI_GUARD_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: tests that spawn the verifier pin TARGET_DIR (FC-29)"

_scan="$(python3 -I - "$ROOT/tests" <<'PY'
import os, re, sys

spawn = re.compile(
    r'(?:\bproof\s+verify\s+["$A-Za-z0-9_-])|(?:\bloki_remote_verify_receipt\s+["\x27$])')
skip_line = re.compile(r'^\s*(#|ok\b|bad\b|echo\b|printf\b|pass\b|fail\b|_ok\b|_bad\b)|\bgrep\b|\bsed\b|\bawk\b|\brun_test\b|^\s*for\s|^\s*\*')
pinned = re.compile(r'TARGET_DIR=|(?:^|[;&(\s])cd\s+["$/]')
hits = []
d = sys.argv[1]
for name in sorted(os.listdir(d)):
    if not name.endswith(".sh") or name == "test-verifier-spawn-sets-target-dir.sh":
        continue
    lines = open(os.path.join(d, name), errors="replace").read().splitlines()
    for i, line in enumerate(lines):
        if skip_line.search(line) or not spawn.search(line):
            continue
        if "target-dir-ok:" in line:
            continue
        window = "\n".join(lines[max(0, i - 12):i + 1])
        # a continued command belongs to the lines above it; also scan its tail
        j = i
        while lines[j].rstrip().endswith("\\") and j + 1 < len(lines):
            j += 1
            window += "\n" + lines[j]
        if pinned.search(window):
            continue
        hits.append("%s:%d: %s" % (name, i + 1, line.strip()[:110]))
print("\n".join(hits))
PY
)"

if [ -z "$_scan" ]; then
  ok "every verifier spawn pins TARGET_DIR or a temp cwd"
else
  bad "verifier spawned without TARGET_DIR or a temp cwd (inherits the caller's cwd):"
  printf '%s\n' "$_scan" | sed 's/^/    /'
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
