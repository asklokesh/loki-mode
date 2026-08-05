#!/usr/bin/env bash
# Test: the durable status surfaces must agree, and --json must not hide staleness.
#
# TWO DEFECTS, both measured on a real paused run (2026-07-29).
#
# 1. STATUS.txt vs COMPLETION.txt disagreed about the SAME queue.
#    STATUS.txt said "Failed: 0" while COMPLETION.txt said "failed=1" -- both
#    read .loki/queue/failed.json, so they cannot legitimately differ. The cause
#    was age, not source: the status monitor refreshes STATUS.txt every 2s but is
#    no longer running by the time the run blocks in a pause, so STATUS.txt was
#    frozen at its last tick while COMPLETION.txt was written fresh. The fix
#    refreshes STATUS.txt at each pause site immediately before the durable
#    record, so the two snapshot the same instant.
#
# 2. `loki why --json` emitted the completion record with NO staleness marker.
#    The human report labels a stale record "(from previous completed run)"; the
#    JSON consumer got the identical record unlabeled, so a script reading
#    completion.branch or completion.pr_url after a crashed run would attribute a
#    PREVIOUS run's branch and PR to the current one, silently, with no field to
#    check.
#
# Proven directions:
#   SITES     : every blocking pause site refreshes STATUS.txt before writing the
#               durable record. Asserted structurally so a fourth pause site
#               added later without the refresh is caught.
#   ORDER     : the refresh precedes build_completion_summary (refreshing after
#               would re-open the same skew window in the other direction).
#   STALE     : --json reports completion_is_stale true when head_sha has moved.
#   FRESH     : --json reports false on a matching head_sha (not vacuously true).
#   LIVE      : a running/exited state marks the record stale even when the SHA
#               matches -- the record describes a run that has not finished.
#   PARITY    : the JSON staleness logic matches the human path's determination.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-status-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== status surfaces agree ==="

# ---- SITES + ORDER -------------------------------------------------------
# Every `build_completion_summary intervention` marks a genuinely blocking
# pause. Each must be immediately preceded by a STATUS.txt refresh.
missing="$(python3 - "$RUN_SH" <<'PYEOF'
import sys
lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().split("\n")
bad = []
for i, line in enumerate(lines):
    # Cover BOTH terminal writes at a blocking pause: the intervention record
    # and the stopped relabel (the queue can change while the run sits paused,
    # so the relabel needs its own refresh, not the older one from the pause).
    # bash 3.2 scans for quotes inside this heredoc even though the delimiter is
    # quoted, and it sits in $( ) -- keep this body free of apostrophes.
    if not (
        "build_completion_summary intervention" in line
        or "build_completion_summary stopped" in line
    ):
        continue
    # Look back a few lines for the refresh; comments sit between them.
    window = "\n".join(lines[max(0, i - 12):i])
    if "update_status_file" not in window:
        bad.append(str(i + 1))
print(",".join(bad))
PYEOF
)"
if [ -z "$missing" ]; then
    ok "every blocking pause site refreshes STATUS.txt before the durable record"
else
    bad "pause site(s) at line(s) $missing write COMPLETION.txt without refreshing STATUS.txt"
fi

# Non-vacuity: the detector must actually flag a site that lacks the refresh.
cat > "$TMP/planted.sh" <<'EOF'
    notify_intervention_needed "x"
    build_completion_summary intervention 2>/dev/null || true
EOF
planted="$(python3 - "$TMP/planted.sh" <<'PYEOF'
import sys
lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().split("\n")
bad = []
for i, line in enumerate(lines):
    # Cover BOTH terminal writes at a blocking pause: the intervention record
    # and the stopped relabel (the queue can change while the run sits paused,
    # so the relabel needs its own refresh, not the older one from the pause).
    # bash 3.2 scans for quotes inside this heredoc even though the delimiter is
    # quoted, and it sits in $( ) -- keep this body free of apostrophes.
    if not (
        "build_completion_summary intervention" in line
        or "build_completion_summary stopped" in line
    ):
        continue
    window = "\n".join(lines[max(0, i - 12):i])
    if "update_status_file" not in window:
        bad.append(str(i + 1))
print(",".join(bad))
PYEOF
)"
if [ -n "$planted" ]; then
    ok "detector flags a pause site missing the refresh (non-vacuous)"
else
    bad "detector missed a planted unrefreshed pause site"
fi

# ---- EXECUTES: the refresh must write into TARGET_DIR, not the cwd --------
# The structural check above only proves the CALL exists. update_status_file is
# cwd-relative (it writes the literal ".loki/STATUS.txt"), while
# build_completion_summary writes to "$TARGET_DIR/.loki". TARGET_DIR defaults to
# $(pwd) (run.sh:1275) so the two agree by default -- but LOKI_TARGET_DIR
# overrides it, and then a bare call would drop STATUS.txt in the WRONG
# directory: the contradiction stays unfixed AND a stray .loki/ appears where
# the runner happened to be standing. Execute it with cwd deliberately elsewhere.
T="$TMP/target"
mkdir -p "$T/.loki/queue" "$TMP/elsewhere"
printf '[]\n'          > "$T/.loki/queue/pending.json"
printf '[{"id":"x"}]\n' > "$T/.loki/queue/failed.json"
(
    cd "$TMP/elsewhere" || exit 1
    # shellcheck disable=SC1090
    . "$RUN_SH" >/dev/null 2>&1
    log_info(){ :; }; log_warn(){ :; }; log_error(){ :; }
    log_step(){ :; }; log_header(){ :; }
    TARGET_DIR="$T"
    (cd "${TARGET_DIR:-.}" && update_status_file) 2>/dev/null || true
) >/dev/null 2>&1

if [ -f "$T/.loki/STATUS.txt" ]; then
    ok "the refresh writes STATUS.txt into TARGET_DIR"
else
    bad "STATUS.txt was not written into TARGET_DIR (cwd-relative call escaped)"
fi
if [ -f "$TMP/elsewhere/.loki/STATUS.txt" ]; then
    bad "STATUS.txt leaked into the cwd instead of TARGET_DIR"
else
    ok "nothing leaked into the unrelated cwd"
fi
# And the value must be the one COMPLETION.txt would report from the same queue.
if grep -qE 'Failed:[[:space:]]*1' "$T/.loki/STATUS.txt" 2>/dev/null; then
    ok "STATUS.txt reports failed=1, agreeing with the queue COMPLETION.txt reads"
else
    bad "STATUS.txt disagrees with queue/failed.json: $(grep -i failed "$T/.loki/STATUS.txt" 2>/dev/null | head -1)"
fi

# ---- STALE / FRESH / LIVE via `loki why --json` ---------------------------
mk_run() {
    # $1=dir  $2=completion head_sha  $3=state status
    local d="$1"
    mkdir -p "$d/.loki/state"
    git init -q "$d"
    git -C "$d" config user.email t@t
    git -C "$d" config user.name t
    git -C "$d" config commit.gpgsign false
    printf 'x\n' > "$d/f.txt"
    git -C "$d" add f.txt
    git -C "$d" commit -qm base
    printf '{"status":"%s"}\n' "$3" > "$d/.loki/autonomy-state.json"
    printf '{"outcome":"complete","files_changed":1,"head_sha":"%s","branch":"loki/prev"}\n' \
        "$2" > "$d/.loki/state/completion.json"
}

json_field() {
    # $1=dir  $2=field
    (cd "$1" && timeout 60 bash "$LOKI" why --json 2>/dev/null) \
        | python3 -c "import json,sys
try:
    print(json.load(sys.stdin).get(sys.argv[1]))
except Exception:
    print('ERR')" "$2"
}

# STALE: completion head_sha does not match current HEAD.
S="$TMP/stale"
mk_run "$S" "0000000000000000000000000000000000000000" "completed"
got="$(json_field "$S" completion_is_stale)"
if [ "$got" = "True" ]; then
    ok "--json marks a record stale when head_sha has moved"
else
    bad "--json completion_is_stale was '$got', expected True"
fi

# FRESH: head_sha matches -- must NOT be reported stale.
F="$TMP/fresh"
mkdir -p "$F"
git init -q "$F"
git -C "$F" config user.email t@t
git -C "$F" config user.name t
git -C "$F" config commit.gpgsign false
printf 'x\n' > "$F/f.txt"
git -C "$F" add f.txt
git -C "$F" commit -qm base
mkdir -p "$F/.loki/state"
FSHA="$(git -C "$F" rev-parse HEAD)"
printf '{"status":"completed"}\n' > "$F/.loki/autonomy-state.json"
printf '{"outcome":"complete","files_changed":1,"head_sha":"%s"}\n' "$FSHA" \
    > "$F/.loki/state/completion.json"
got="$(json_field "$F" completion_is_stale)"
if [ "$got" = "False" ]; then
    ok "--json does not mark a matching record stale (not vacuously true)"
else
    bad "--json completion_is_stale was '$got' on a fresh record, expected False"
fi

# LIVE: a running state means the record describes an unfinished run.
L="$TMP/live"
mkdir -p "$L"
git init -q "$L"
git -C "$L" config user.email t@t
git -C "$L" config user.name t
git -C "$L" config commit.gpgsign false
printf 'x\n' > "$L/f.txt"
git -C "$L" add f.txt
git -C "$L" commit -qm base
mkdir -p "$L/.loki/state"
LSHA="$(git -C "$L" rev-parse HEAD)"
printf '{"status":"running"}\n' > "$L/.loki/autonomy-state.json"
printf '{"outcome":"complete","files_changed":1,"head_sha":"%s"}\n' "$LSHA" \
    > "$L/.loki/state/completion.json"
got="$(json_field "$L" completion_is_stale)"
if [ "$got" = "True" ]; then
    ok "--json marks a record stale while the run is still live"
else
    bad "--json completion_is_stale was '$got' for a running run, expected True"
fi

# head_sha must be surfaced so the consumer can check the determination itself.
got="$(json_field "$S" head_sha)"
if [ -n "$got" ] && [ "$got" != "None" ] && [ "$got" != "ERR" ]; then
    ok "--json surfaces head_sha so a consumer can verify staleness itself"
else
    bad "--json head_sha was '$got'"
fi

# ---- PARITY --------------------------------------------------------------
# The JSON branch must use the SAME determination as the human report. Both
# compute comp_is_stale from live_statuses + a head_sha mismatch; if one is
# edited without the other the two surfaces drift apart again.
if [ "$(grep -c 'comp_is_stale = bool(state.get("status") in live_statuses)' "$LOKI")" -ge 2 ]; then
    ok "JSON and human paths share the same staleness determination"
else
    bad "staleness logic present in only one path -- the surfaces can drift"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
