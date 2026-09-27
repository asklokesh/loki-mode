#!/usr/bin/env bash
# EV-6 prep: merge the three arms' results.jsonl files and run gate_report.py
# (E-33) over the merged rows, writing docs/v10/METRICS.md and a CHANGELOG
# block via its begin/end markers.
#
# Usage: publish_gate.sh <v10.jsonl> <raw-claude.jsonl> <legacy.jsonl> \
#            [--metrics PATH] [--changelog PATH]
#
# Merging is just concatenation: every row already carries its own "arm"
# field, and gate_report.py (via harness.summarize_rows) groups by that field
# itself, so this script does no arm bookkeeping of its own. The one thing it
# must get right is the join: `awk 1` re-terminates every input with a
# newline before concatenating, so a results.jsonl whose last line lacks one
# cannot fuse with the next file's first line into a single invalid JSON row.
#
# gate_report.py itself is E-33's file, not committed by this slice. Until
# E-33 merges, point LOKI_GATE_REPORT at a checkout that has it (its own
# branch or a clone) for local testing; the default here is where E-33 lands
# it on main.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

usage() {
    echo "usage: publish_gate.sh <v10.jsonl> <raw-claude.jsonl> <legacy.jsonl> [--metrics PATH] [--changelog PATH]" >&2
}

if [ "$#" -lt 3 ]; then
    usage
    exit 2
fi
V10_FILE="$1"; RAW_FILE="$2"; LEGACY_FILE="$3"
shift 3
METRICS="$REPO/docs/v10/METRICS.md"
CHANGELOG="$REPO/CHANGELOG.md"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --metrics) METRICS="$2"; shift 2 ;;
        --changelog) CHANGELOG="$2"; shift 2 ;;
        *) usage; exit 2 ;;
    esac
done

for f in "$V10_FILE" "$RAW_FILE" "$LEGACY_FILE"; do
    if [ ! -f "$f" ]; then
        echo "error: results file not found: $f" >&2
        exit 2
    fi
done

GEN="${LOKI_GATE_REPORT:-$HERE/gate_report.py}"
if [ ! -f "$GEN" ]; then
    echo "error: gate_report.py not found at $GEN (E-33 has not merged yet; set LOKI_GATE_REPORT to a checkout that has it)" >&2
    exit 2
fi

# `awk 1` prints every line of every input, adding a trailing newline where
# one is missing, so gate_report.py always sees one JSON object per line.
awk 1 "$V10_FILE" "$RAW_FILE" "$LEGACY_FILE" | python3 "$GEN" /dev/stdin --metrics "$METRICS" --changelog "$CHANGELOG"
