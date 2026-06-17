#!/usr/bin/env bash
# Test: create_checkpoint index rebuild must sort checkpoints by epoch even when
# the cwd / parent path contains hyphens.
#
# Checkpoint ids are cp-<iteration>-<epoch>. The index rebuild in
# autonomy/run.sh sorted metadata.json FULL PATHS with `sort -t'-' -k3 -n`.
# Under a path that contains hyphens (the repo dir is literally `loki-mode`),
# the `-` split shifts the epoch out of field 3, so the index was ordered wrong.
# The fix sorts on the checkpoint dir BASENAME instead. This test verifies the
# correct ordering and asserts NON-VACUITY: the old full-path sort really does
# produce the wrong order under a hyphenated parent path.
set -euo pipefail

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-cp-sort.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Parent dir that CONTAINS A HYPHEN, mirroring the real `loki-mode` cwd.
CKPT="$WORK/loki-mode/.loki/state/checkpoints"
mkdir -p "$CKPT"

# Epochs deliberately chosen so numeric vs lexical ordering differ and so the
# misplaced field would reorder them: 100 < 200 < 1000 numerically.
for id in cp-1-100 cp-2-200 cp-10-1000; do
    mkdir -p "$CKPT/$id"
    printf '{}\n' > "$CKPT/$id/metadata.json"
done

expected_order="cp-1-100 cp-2-200 cp-10-1000"

# --- NEW logic (the fix): sort on basename-derived key, then strip it ---
new_order=$(
    find "$CKPT" -maxdepth 2 -name "metadata.json" -path "*/cp-*/*" 2>/dev/null \
        | while read -r mp; do printf '%s\t%s\n' "$(basename "$(dirname "$mp")")" "$mp"; done \
        | sort -t'-' -k3 -n | cut -f2- \
        | while read -r p; do basename "$(dirname "$p")"; done | tr '\n' ' ' | sed 's/ $//'
)

# --- OLD logic (the bug): sort the full metadata.json paths on -k3 ---
old_order=$(
    find "$CKPT" -maxdepth 2 -name "metadata.json" -path "*/cp-*/*" 2>/dev/null \
        | sort -t'-' -k3 -n \
        | while read -r p; do basename "$(dirname "$p")"; done | tr '\n' ' ' | sed 's/ $//'
)

echo "expected (epoch order): $expected_order"
echo "new (fixed)           : $new_order"
echo "old (buggy)           : $old_order"

fail=0

if [ "$new_order" != "$expected_order" ]; then
    echo "FAIL: fixed sort did not produce epoch order"
    fail=1
else
    echo "PASS: fixed sort orders by epoch under hyphenated parent path"
fi

# Non-vacuity: the old full-path sort MUST be wrong under this hyphenated path,
# otherwise this test would prove nothing.
if [ "$old_order" = "$expected_order" ]; then
    echo "FAIL (non-vacuity): old full-path sort already produced the right order;"
    echo "                    the test does not exercise the bug."
    fail=1
else
    echo "PASS (non-vacuity): old full-path sort is wrong ($old_order), bug reproduced"
fi

if [ "$fail" -ne 0 ]; then
    exit 1
fi
echo "ALL CHECKS PASSED"
