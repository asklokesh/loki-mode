#!/usr/bin/env bash
# test-project-memory.sh -- learnings persisted by one run are injected, bounded,
# into the next run in the same project (autonomy/run.sh project memory).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$ROOT/autonomy/run.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$T"' EXIT
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# Print the body of the python heredoc (terminated by TAG) inside shell function FN.
heredoc() {
  awk -v tag="$2" -v fn="$1" '
    index($0, fn "() {") == 1 {infn=1}
    infn && !grab && index($0, "<< \x27" tag "\x27") {grab=1; next}
    grab && $0 == tag {exit}
    grab {print}' "$RUN_SH"
}
heredoc extract_learnings_from_session EXTRACT_SCRIPT > "$T/extract.py"
heredoc get_relevant_learnings LEARNINGS_SCRIPT > "$T/inject.py"
if [ -s "$T/extract.py" ] && [ -s "$T/inject.py" ]; then ok "scripts extracted"; else bad "scripts extracted"; exit 1; fi

P="$T/proj"; K="$T/know"
mkdir -p "$P/.loki/state" "$K" "$T/empty"
cat > "$P/.loki/CONTINUITY.md" <<'MD'
## Mistakes & Learnings
- Never run migrations before the schema lock is taken
## Architecture Decisions
- Use sqlite for the job queue
MD
cd "$P" || exit 1
_LOKI_LEARNINGS_DIR="$K" python3 "$T/extract.py" >/dev/null
if [ -s ".loki/memory/learnings/project-mistakes.jsonl" ]; then ok "run 1 persisted project memory"; else bad "run 1 persisted project memory"; fi

# run 2: empty global store, same project
_LOKI_LEARNINGS_DIR="$T/empty" LOKI_CONTEXT="unrelated" python3 "$T/inject.py"
if grep -q "schema lock" .loki/state/relevant-learnings.json; then ok "run 2 injects project memory"; else bad "run 2 injects project memory"; fi

_LOKI_LEARNINGS_DIR="$T/empty" LOKI_CONTEXT="x" LOKI_PROJECT_MEMORY_MAX_CHARS=10 python3 "$T/inject.py"
if grep -q "schema lock" .loki/state/relevant-learnings.json; then bad "char cap bounds summary"; else ok "char cap bounds summary"; fi

_LOKI_LEARNINGS_DIR="$T/empty" LOKI_CONTEXT="x" LOKI_PROJECT_MEMORY=0 python3 "$T/inject.py"
if grep -q "project_memory" .loki/state/relevant-learnings.json; then bad "opt-out"; else ok "opt-out"; fi

echo "test-project-memory: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
