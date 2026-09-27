#!/usr/bin/env bash
# BACKLOG 134 / S-49 / S-199: files under autonomy/ carry guarded copies of
# run.sh's _loki_snapshot_py_tool for callers that source them on their own.
# run.sh is the source of truth; this asserts every copy found by git grep is
# byte-identical to it, so a fix to one cannot silently leave another behind.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PAT='^_loki_snapshot_py_tool() {'

body() { # <file> -> the function from its "name() {" line to the first "}" line
    awk '/^_loki_snapshot_py_tool\(\) \{$/ {on=1} on {print} on && /^\}$/ {exit}' "$1"
}
lines() { printf '%s\n' "$1" | wc -l | tr -d ' '; }

ref="$(body "$ROOT/autonomy/run.sh")"
if [ "$(lines "$ref")" -lt 10 ]; then
    echo "FAIL: could not extract _loki_snapshot_py_tool from run.sh"
    exit 1
fi

copies=0
fail=0
while IFS= read -r f; do
    [ "$f" = "autonomy/run.sh" ] && continue
    b="$(body "$ROOT/$f")"
    # Vacuity guard: a truncated extraction must not count as a compared copy.
    if [ "$(lines "$b")" -lt 10 ]; then
        echo "FAIL: $f: extracted _loki_snapshot_py_tool body is under 10 lines"
        fail=1
        continue
    fi
    copies=$((copies + 1))
    if [ "$ref" != "$b" ]; then
        echo "FAIL: $f's _loki_snapshot_py_tool differs from run.sh's"
        diff <(printf '%s\n' "$ref") <(printf '%s\n' "$b")
        fail=1
    fi
done < <(git -C "$ROOT" grep -l -e "$PAT" -- autonomy/)

if [ "$copies" -lt 1 ] && [ "$fail" -eq 0 ]; then
    echo "FAIL: no guarded copy of _loki_snapshot_py_tool found under autonomy/ besides run.sh"
    exit 1
fi
[ "$fail" -eq 0 ] || exit 1
echo "PASS: compared $copies copies of _loki_snapshot_py_tool against run.sh; all byte-identical"
