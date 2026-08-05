#!/usr/bin/env bash
# A run with no preview must still tell the user when it first changed code.
#
# WHY. `seconds_to_first_preview` only fires for a previewable app. The shape
# the founder measured at 21 minutes -- a scoped GitHub issue fix -- produces no
# running app, so that number is empty and NOTHING marked the moment the run
# first touched the codebase. The user watched an idle terminal until the whole
# iteration ended. Replit shows something at roughly 2 minutes; we showed
# nothing at all, which is why felt time is worse than measured time even when
# measured time is competitive.
#
# WHAT IS ASSERTED. The writer's real behaviour, driven directly:
#   - a run that changed nothing writes NO file (silence, never a fabricated 0)
#   - a run that changed something records the elapsed seconds
#   - the file is WRITE-ONCE: a later iteration must not overwrite the first
#   - the JSON is atomic and parseable (a partial read must never look valid)
#   - the value is rendered, not merely recorded
#
# That last one is the half-shipped pattern this codebase has paid for
# repeatedly: a fact recorded and never surfaced influences nothing. The same
# comment block on first_preview_s says it was "WRITTEN BUT NEVER READ" for a
# whole major version.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: time-to-first-artifact signal"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-firstart-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Reproduce the writer exactly as run.sh runs it, against a real git repo.
write_probe() {
    local target="$1" start="$2" end="$3" iter="$4"
    TARGET_DIR="$target" ITERATION_COUNT="$iter" _S="$start" _E="$end" bash -c '
        log_info() { printf "INFO %s\n" "$*"; }
        end_time="$_E"; start_time="$_S"
        if [ -z "${_LOKI_FIRST_ARTIFACT_DONE:-}" ]; then
            _fa_file="${TARGET_DIR:-.}/.loki/state/first-artifact.json"
            if [ ! -f "$_fa_file" ]; then
                _fa_changed="$(cd "${TARGET_DIR:-.}" 2>/dev/null \
                    && git status --porcelain 2>/dev/null | head -1)"
                if [ -n "$_fa_changed" ]; then
                    mkdir -p "$(dirname "$_fa_file")" 2>/dev/null || true
                    _fa_tmp="${_fa_file}.$$"
                    printf "{\"seconds_to_first_artifact\":%s,\"iteration\":%s}\n" \
                        "$((end_time - start_time))" "${ITERATION_COUNT:-0}" \
                        > "$_fa_tmp" 2>/dev/null \
                        && mv -f "$_fa_tmp" "$_fa_file" 2>/dev/null \
                        && log_info "First code change after $((end_time - start_time))s"
                    rm -f "$_fa_tmp" 2>/dev/null || true
                fi
            fi
        fi
    ' >/dev/null 2>&1
}

mkrepo() {
    local d="$SCRATCH/$1"
    mkdir -p "$d" && (cd "$d" && git init -q 2>/dev/null \
        && git config user.email t@t && git config user.name t \
        && echo base > file.txt && git add file.txt \
        && git commit -qm base 2>/dev/null)
    printf '%s' "$d"
}

# --- no change -> no file (silence, not a fabricated zero) -------------------
clean="$(mkrepo clean)"
write_probe "$clean" 100 160 1
if [ -f "$clean/.loki/state/first-artifact.json" ]; then
    bad "a run that changed nothing recorded a first-artifact time"
else
    ok "no code change -> no file written (silence beats a fabricated 0)"
fi

# --- a change is recorded with the elapsed seconds ---------------------------
dirty="$(mkrepo dirty)"
echo "modified" >> "$dirty/file.txt"
write_probe "$dirty" 100 160 1
_f="$dirty/.loki/state/first-artifact.json"
if [ -f "$_f" ]; then
    ok "a code change writes the signal file"
    got="$(python3 -c "import json;print(json.load(open('$_f'))['seconds_to_first_artifact'])" 2>/dev/null)"
    [ "$got" = "60" ] \
        && ok "records the elapsed seconds (60)" \
        || bad "wrong elapsed value: got '${got:-<unparseable>}', want 60"
else
    bad "a code change did not write the signal file"
fi

# --- WRITE-ONCE: iteration 3 must not overwrite iteration 1 ------------------
# The number means "when did this RUN first do something". A later, larger
# value would silently redefine it as "the most recent change", which is a
# different and far less useful claim.
write_probe "$dirty" 100 900 3
again="$(python3 -c "import json;print(json.load(open('$_f'))['seconds_to_first_artifact'])" 2>/dev/null)"
[ "$again" = "60" ] \
    && ok "write-once: a later iteration does not overwrite the first" \
    || bad "overwritten by a later iteration: now '$again' (was 60)"

# --- the JSON is valid -------------------------------------------------------
if python3 -c "import json;json.load(open('$_f'))" 2>/dev/null; then
    ok "the recorded JSON parses"
else
    bad "the recorded JSON is malformed"
fi

# --- no temp file left behind ------------------------------------------------
if [ -z "$(find "$dirty/.loki/state" -name 'first-artifact.json.*' 2>/dev/null)" ]; then
    ok "no atomic-write temp file left behind"
else
    bad "a .json.PID temp file survived the write"
fi

# --- RENDERED, not merely recorded -------------------------------------------
# The failure this codebase keeps repeating: record a fact, never surface it.
if grep -q 'printf .*"First change:" "\$first_artifact_s"' "$RUN_SH"; then
    ok "the value is rendered in the summary"
else
    bad "recorded but never rendered -- it can influence nothing"
fi

if grep -q 'seconds_to_first_artifact' "$RUN_SH"; then
    ok "WIRING: run.sh reads seconds_to_first_artifact"
else
    bad "WIRING: nothing reads the recorded field"
fi

# The two guards below live in run.sh's REAL writer. write_probe above is a
# faithful copy, so mutating the original leaves it untouched -- both of these
# mutations SURVIVED until asserted against the source. Same lesson as v8.34.0:
# a re-implementation tests the rule, only the source tests the code.
_writer="$(sed -n '/TIME TO FIRST ARTIFACT/,/v7.5.12 Gap A/p' "$RUN_SH")"
if [ -z "$_writer" ]; then
    bad "could not locate the writer block; the guards below are unverified"
else
    # WRITE-ONCE. Without the existence check every iteration overwrites, and
    # the number silently changes meaning from "when this run first did
    # something" to "the most recent change" -- a different, weaker claim.
    case "$_writer" in
        *'if [ ! -f "$_fa_file" ]; then'*)
            ok "GUARD: the writer refuses to overwrite an existing signal" ;;
        *) bad "GUARD: the write-once check is gone; a later iteration overwrites the first" ;;
    esac

    # NO FABRICATION. Without the changed-files check the file is written even
    # when the agent touched nothing, turning silence into a false "it did
    # something after Ns".
    case "$_writer" in
        *'if [ -n "$_fa_changed" ]; then'*)
            ok "GUARD: the writer requires an actual code change" ;;
        *) bad "GUARD: the changed-files check is gone; a no-op run reports a first change" ;;
    esac
fi

# The reader must be defined BEFORE the renderer, or the summary prints an
# unset variable and the line silently never appears.
_r="$(grep -n 'local first_artifact_s=' "$RUN_SH" | head -1 | cut -d: -f1)"
_w="$(grep -n '"First change:"' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -n "$_r" ] && [ -n "$_w" ] && [ "$_r" -lt "$_w" ]; then
    ok "the reader precedes the renderer"
else
    bad "reader/renderer ordering is wrong (reader=$_r renderer=$_w)"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
