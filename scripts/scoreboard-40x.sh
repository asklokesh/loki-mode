#!/usr/bin/env bash
# scripts/scoreboard-40x.sh -- D92 40x scoreboard: per-release cost, wall-time and human-minutes factors plus
# EFFICIENCY against the 11.3.1 baseline. Reads loki run TSVs (task run verified solved wall_s usd human_min; a legacy 6-column file exits 2), such as
# the loki rows of scripts/b9-scoreboard.sh --ab plus the recorded human_min. Math: scripts/scoreboard-40x.py.
#   --current TSV --baseline TSV --version V [--baseline-version 11.3.1] --json-out F [--metrics-out F]
#   --human-floor-min M   labelled review floor: human_min = max(recorded, M); never applied to NOT RECORDED;
#                         default unset (a recorded 0 stays NOT COMPUTABLE)
#   --dry   use the recorded fixtures in scripts/b9-fixtures/recorded-40x/ (no runs, CI-safe)
# Fixed task set: trivial-sum, two-bug, medium, mass-10 (declared slot, NOT RUN until MASS-1 ships).
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FLOOR="" CUR="" BASE="" VER="unknown" BVER="11.3.1" JSON="" METRICS="" DRY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --current) CUR="${2:-}"; shift ;;
        --baseline) BASE="${2:-}"; shift ;;
        --version) VER="${2:-}"; shift ;;
        --baseline-version) BVER="${2:-}"; shift ;;
        --json-out) JSON="${2:-}"; shift ;;
        --metrics-out) METRICS="${2:-}"; shift ;;
        --human-floor-min) FLOOR="${2:-}"; shift ;;
        --dry) DRY=1 ;;
        *) echo "usage: $0 --current TSV --baseline TSV --version V --json-out F [--metrics-out F] | --dry --json-out F" >&2; exit 2 ;;
    esac
    shift
done
if [ "$DRY" -eq 1 ]; then
    CUR="$REPO_ROOT/scripts/b9-fixtures/recorded-40x/current.tsv"
    BASE="$REPO_ROOT/scripts/b9-fixtures/recorded-40x/baseline-11.3.1.tsv"
fi
[ -f "$CUR" ] && [ -f "$BASE" ] && [ -n "$JSON" ] || { echo "need existing --current and --baseline TSVs and --json-out (or --dry)" >&2; exit 2; }
python3 -I "$REPO_ROOT/scripts/scoreboard-40x.py" --current "$CUR" --baseline "$BASE" --version "$VER" \
    --baseline-version "$BVER" --json-out "$JSON" ${METRICS:+--metrics-out "$METRICS"} ${FLOOR:+--human-floor-min "$FLOOR"}
