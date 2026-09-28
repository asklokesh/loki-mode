#!/usr/bin/env bash
# tests/test-eval-archive.sh (E-101)
#
# EV-14 incident: eval/loki10/results/*/results.jsonl (gitignored, lives only
# inside an agent worktree) was destroyed when that worktree was force-removed.
# eval/loki10/harness.py now archives every row outside the worktree's
# gitignored tree: redact_row() must drop the log-file paths (arm stdout etc.,
# which can hold whatever the arm printed) and any secret-shaped string,
# while keeping the fields summarize() needs; and a dirty-tree check that
# excludes the in-repo archive path must still catch real, unrelated dirt.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERE="$SCRIPT_DIR/../eval/loki10"

PASS=0; FAIL=0
pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

TMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
WORK="$(mktemp -d "$TMP_ROOT/loki-test-eval-archive.XXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT

# ---- T1: redact_row strips log paths and planted secrets, keeps real fields.
cat >"$WORK/t1.py" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
import harness

# Each planted secret is joined from parts at runtime so this file (and the
# t1.py it writes) never contains a secret-shaped literal gitleaks can flag
# (E-110: the 3 synthetic fixtures below were what tripped CI's full-history
# gitleaks scan on commit bbe83c7a).
_ghp = "ghp_" + "1234567890abcdefghij"
_aws = "AWS_SECRET_ACCESS_KEY" + "=" + "shh"
_ant = "sk-ant-" + "planted" + "TOKEN9999"

planted = {
    "run_id": "task-a.v10.abc123", "task": "task-a", "arm": "v10",
    "harness_sha": "a" * 40, "status": "harness_error", "completed": False,
    "cost_usd": 0.12,
    "error": "boom: token=" + _ghp + " key " + _aws + " " + _ant,
    "logs": {"arm_stdout": "/some/worktree/eval/loki10/results/logs/x/arm_stdout.log",
             "arm_stderr": "/some/worktree/.../arm_stderr.log"},
}
clean = harness.redact_row(planted)

fails = []
if "logs" in clean:
    fails.append("logs key survived")
blob = json.dumps(clean)
for secret in (_ghp, _aws, _ant):
    if secret in blob:
        fails.append("planted secret survived: " + secret)
for keep in ("task-a.v10.abc123", "task-a", "a" * 40, "harness_error"):
    if keep not in blob:
        fails.append("real field lost: " + keep)
if clean.get("cost_usd") != 0.12:
    fails.append("cost_usd corrupted: %r" % clean.get("cost_usd"))

if fails:
    print("\n".join(fails))
    sys.exit(1)
print("ok")
PY
if out="$(python3 "$WORK/t1.py" "$HERE" 2>&1)" && [ "$out" = ok ]; then
    pass "redact_row drops logs and planted secrets, keeps real fields"
else
    fail "redact_row: $out"
fi

# ---- T2: redacted rows still summarize (no over-stripping: an empty/broken
# archive would otherwise pass T1 too).
cat >"$WORK/t2.py" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
import harness

# Built from parts at runtime, same reason as t1.py's _ghp/_aws/_ant above.
_akia = "AKIA" + "ABCDEFGHIJKLMNOP"

rows = [
    {"run_id": "a1", "task": "a", "arm": "v10", "harness_sha": "b" * 40,
     "model": "claude-x", "status": "ok", "completed": True, "cost_usd": None,
     "error": _akia + " leaked", "logs": {"arm_stdout": "/x"}},
    {"run_id": "a2", "task": "a", "arm": "raw-claude", "harness_sha": "b" * 40,
     "model": "claude-x", "status": "ok", "completed": False, "cost_usd": None,
     "logs": {"arm_stdout": "/y"}},
]
path = sys.argv[2]
with open(path, "w") as f:
    for r in rows:
        f.write(json.dumps(harness.redact_row(r)) + "\n")

loaded = [json.loads(l) for l in open(path)]
assert len(loaded) == 2, loaded
assert all("logs" not in r for r in loaded)
assert _akia not in open(path).read()
report = harness.summarize_rows(loaded)
assert len(report) == 1, report
assert report[0]["arms"]["v10"]["completed"] == 1, report
print("ok")
PY
if out="$(python3 "$WORK/t2.py" "$HERE" "$WORK/archived.results.jsonl" 2>&1)" && [ "$out" = ok ]; then
    pass "archived (redacted) rows still summarize; row count and ids survive"
else
    fail "archive+summarize round trip: $out"
fi

# ---- T3: the dirty-check pathspec exclude ignores eval/loki10/archive but
# still catches real, unrelated dirt (harness.py cmd_run's harness_sha check).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
REPO="$WORK/repo"
git init -q -b main "$REPO"
printf 'x\n' >"$REPO/a.txt"
git -C "$REPO" add a.txt >/dev/null
git -C "$REPO" commit -q -m init
mkdir -p "$REPO/eval/loki10/archive"
touch "$REPO/eval/loki10/archive/run1.results.jsonl"
if [ -z "$(git -C "$REPO" status --porcelain -- . ":(exclude)eval/loki10/archive")" ]; then
    pass "archive-only changes read as clean (excluded pathspec)"
else
    fail "archive-only changes still read as dirty"
fi
printf 'y\n' >"$REPO/b.txt"
if [ -n "$(git -C "$REPO" status --porcelain -- . ":(exclude)eval/loki10/archive")" ]; then
    pass "real, unrelated dirt is still caught with the archive excluded"
else
    fail "real dirt was hidden by the archive exclude"
fi
grep -q ':(exclude)eval/loki10/archive' "$HERE/harness.py" \
    && pass "cmd_run's dirty check excludes eval/loki10/archive" \
    || fail "cmd_run's dirty check does not exclude eval/loki10/archive"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
