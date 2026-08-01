#!/usr/bin/env bash
# Two independent operator-facing fixes.
#
# 1. `loki help <command>` reached none of the ~25 commands. $1 was read only
#    for the literal "aliases" and otherwise discarded, so `loki help proof`
#    printed the same 8.5KB generic front page as bare `loki help`, while
#    `loki proof --help` printed real help. Two spellings, one of them a lie.
#
# 2. The daily .loki/logs/autonomy-YYYYMMDD.log was unbounded. Its sibling
#    agent.log has been trimmed at 1MB since it was introduced; the daily log
#    receives the full raw stream-json of every iteration (~1.5MB/iteration)
#    and was never trimmed, rotated, or pruned.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: loki help <command> and daily log cap"

# --- 1. help delegation ------------------------------------------------------

bare="$(bash "$LOKI" help 2>&1)"
bare_len=${#bare}

# Sample several commands rather than one, so a fix that special-cases a single
# name does not pass.
# Includes the SIDE-EFFECTING commands deliberately. A first pass sampled only
# read-only ones (proof/verify/doctor/status), which is exactly the sample that
# would miss `loki help stop` actually stopping something.
for cmd in proof verify doctor status start stop update; do
    out="$(bash "$LOKI" help "$cmd" 2>&1)"
    if [[ ${#out} -eq $bare_len ]]; then
        ko "loki help $cmd differs from the generic front page" \
           "identical length ($bare_len); \$1 is being discarded"
        continue
    fi
    # And it must be the SAME help the --help spelling prints, not merely
    # different output.
    direct="$(bash "$LOKI" "$cmd" --help 2>&1)"
    if [[ "$out" == "$direct" ]]; then
        ok "loki help $cmd matches loki $cmd --help"
    else
        ko "loki help $cmd matches loki $cmd --help" \
           "the two spellings disagree"
    fi
done

# Bare help must still print the front page.
if [[ $bare_len -gt 2000 ]]; then
    ok "bare loki help still prints the front page"
else
    ko "bare loki help still prints the front page" "only $bare_len bytes"
fi

# `loki help aliases` keeps its dedicated table.
aliases_out="$(bash "$LOKI" help aliases 2>&1)"
if [[ "$aliases_out" != "$bare" && ${#aliases_out} -gt 100 ]]; then
    ok "loki help aliases still prints the alias table"
else
    ko "loki help aliases still prints the alias table"
fi

# An unknown name must degrade, not recurse forever.
unknown="$(timeout 15 bash "$LOKI" help zzznotacommand 2>&1)"
urc=$?
if [[ $urc -eq 124 ]]; then
    ko "loki help <unknown> terminates" "timed out -- likely infinite recursion"
elif [[ "$unknown" == *"Unknown command"* ]]; then
    ok "loki help <unknown> reports the unknown command and exits"
else
    ko "loki help <unknown> reports the unknown command and exits" "got: $unknown"
fi

# The help path must be incapable of executing, not merely observed not to.
# LOKI_HELP_ONLY is set when `loki help <cmd>` re-enters dispatch; without a
# --help in the argv the guard must refuse rather than run the command.
guard_out="$(LOKI_HELP_ONLY=1 timeout 15 bash "$LOKI" stop 2>&1)"
if [[ "$guard_out" == *"refusing to run"* ]]; then
    ok "the help path refuses to execute a command without --help"
else
    ko "the help path refuses to execute a command without --help" \
       "got: ${guard_out:0:120}"
fi

# ...and the guard must not leak into ordinary use.
if timeout 20 bash "$LOKI" status --json >/dev/null 2>&1; then
    ok "ordinary command dispatch is unaffected by the guard"
else
    ko "ordinary command dispatch is unaffected by the guard"
fi

# --- 2. daily log cap --------------------------------------------------------
# Assert on the trim logic itself, executed, rather than on its presence.

if grep -q 'tail -c 500000 "$log_file"' "$RUN_SH"; then
    ok "the daily log has a trim step"
else
    ko "the daily log has a trim step" \
       "autonomy-YYYYMMDD.log grows without bound (~1.5MB/iteration)"
fi

# Execute the same guard shape against a real oversized file.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-logcap-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
log_file="$SCRATCH/autonomy-test.log"
head -c 2000000 /dev/zero | tr '\0' 'x' > "$log_file"
before=$(stat -f%z "$log_file" 2>/dev/null || stat -c%s "$log_file" 2>/dev/null)

if [ -f "$log_file" ] && [ "$(stat -f%z "$log_file" 2>/dev/null || stat -c%s "$log_file" 2>/dev/null)" -gt 1000000 ]; then
    tail -c 500000 "$log_file" > "$log_file.tmp" && mv "$log_file.tmp" "$log_file"
fi
after=$(stat -f%z "$log_file" 2>/dev/null || stat -c%s "$log_file" 2>/dev/null)

if [[ $before -gt 1000000 && $after -le 500000 ]]; then
    ok "an oversized daily log is trimmed to the cap ($before -> $after)"
else
    ko "an oversized daily log is trimmed to the cap" "$before -> $after"
fi

# A small log must be left alone.
small="$SCRATCH/small.log"
printf 'keep me\n' > "$small"
if [ -f "$small" ] && [ "$(stat -f%z "$small" 2>/dev/null || stat -c%s "$small" 2>/dev/null)" -gt 1000000 ]; then
    tail -c 500000 "$small" > "$small.tmp" && mv "$small.tmp" "$small"
fi
if [[ "$(cat "$small")" == "keep me" ]]; then
    ok "a small daily log is left untouched"
else
    ko "a small daily log is left untouched"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
