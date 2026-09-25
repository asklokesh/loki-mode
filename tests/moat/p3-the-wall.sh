#!/usr/bin/env bash
set -uo pipefail
#===============================================================================
# MOAT P3 - The Wall
#
# Property: the agent that writes the code never writes, sees the authoring of,
# or edits the acceptance checks it is graded against.
#
#   P3.implementer-prompt-has-no-check-authoring
#       The implementer's build prompt, produced by the REAL prompt builders on
#       both routes (bash build_prompt in autonomy/run.sh, Bun buildPrompt in
#       loki-ts/src/runner/build_prompt.ts) for a PRD-mode first iteration, must
#       not instruct the implementer to author acceptance checks. Today both
#       emit PRD_CHECKLIST_INIT ("Create .loki/checklist/checklist.json from the
#       PRD ... verification checks ...").
#
#   P3.check-author-context-excludes-implementation
#       The check-authoring step's input contains the spec and none of the
#       repo's implementation files.
#
#   P3.checks-frozen-before-eval
#       A checklist edited after it was frozen is rejected by the deterministic
#       verifier (autonomy/checklist-verify.py) with a hash mismatch reason.
#
# ASSUMED INTERFACES (not built yet; the milestone builder implements to these):
#
#   A. Check-author context (P3.check-author-context-excludes-implementation):
#        python3 autonomy/lib/check_author.py context --spec <spec> --repo <dir>
#      Prints to stdout, and exits 0, ONE JSON object that is the exact and
#      complete input handed to the check-authoring model. No model call, no
#      network, deterministic:
#        {"spec_sha256": "<hex>",
#         "inputs": [{"path": "<path>", "sha256": "<hex>"}, ...],
#         "prompt": "<full text given to the check author>"}
#      "inputs" lists every file whose content reaches the check author. The
#      spec must be among them; no file of the repo's implementation may be.
#
#   B. Freeze (P3.checks-frozen-before-eval):
#        python3 autonomy/checklist-verify.py --checklist <path> --freeze
#      Records a digest of the check DEFINITIONS (ids and verification specs,
#      never the result fields the verifier writes back: passed, output,
#      status, verified_at, summary, last_verified_at). Exit 0 on success.
#      Afterwards a plain verify run (no --freeze) recomputes the digest; on a
#      mismatch it exits non-zero, prints a reason containing "hash mismatch"
#      to stdout or stderr, and does not report the edited checks as verified.
#      The verifier's own write-back must NOT trip the digest on a re-run.
#
# Contract: one "CASE <ID> PASS|FAIL <desc>" stdout line per case; diagnostics
# on stderr; exit 0 when the script ran to completion. Hermetic, no network.
#===============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
BP_TS="$REPO_ROOT/loki-ts/src/runner/build_prompt.ts"
VERIFIER="$REPO_ROOT/autonomy/checklist-verify.py"
CHECK_AUTHOR="$REPO_ROOT/autonomy/lib/check_author.py"
FIXTURE_ENV="$REPO_ROOT/loki-ts/tests/fixtures/build_prompt/fixture-1/env.sh"

export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
       LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false

MOAT_START=$(date +%s)
MOAT_MAIN_PID=$$
MOAT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/moat-p3.XXXXXX")" || { echo "p3: mktemp failed" >&2; exit 1; }
MOAT_IDS="P3.implementer-prompt-has-no-check-authoring P3.check-author-context-excludes-implementation P3.checks-frozen-before-eval"
MOAT_EMITTED=" "

moat_emit() {
    local msg esc
    esc="$(printf '\033')"
    msg="$(printf '%s' "$3" | tr '\n\r\t' '   ' | sed "s/${esc}\[[0-9;]*m//g")"
    printf 'CASE %s %s %s\n' "$1" "$2" "$msg"
    MOAT_EMITTED="${MOAT_EMITTED}$1 "
}
moat_cleanup() {
    [ "${BASHPID:-$$}" = "$MOAT_MAIN_PID" ] || return 0
    local id
    for id in $MOAT_IDS; do
        case "$MOAT_EMITTED" in
            *" $id "*) ;;
            *) moat_emit "$id" FAIL "case never ran - the script ended early (harness crash)" ;;
        esac
    done
    rm -rf "$MOAT_TMP"
    echo "p3 runtime: $(( $(date +%s) - MOAT_START ))s" >&2
}
trap moat_cleanup EXIT

# A case function records failures with nok and ends; moat_run emits one line.
CASE_FAILS=""
nok() { CASE_FAILS="${CASE_FAILS:+$CASE_FAILS; }$1"; }
moat_run() {
    local id="$1" desc="$2" fn="$3"
    CASE_FAILS=""
    "$fn"
    if [ -z "$CASE_FAILS" ]; then
        moat_emit "$id" PASS "$desc"
    else
        moat_emit "$id" FAIL "$desc - $CASE_FAILS"
    fi
}

log() { printf 'p3: %s\n' "$*" >&2; }

#-------------------------------------------------------------------------------
# Prompt capture on both routes, in a scrubbed environment so host LOKI_* vars
# (LOKI_SIMPLE, LOKI_LEGACY_PROMPT_ORDERING, ...) cannot change the prompt.
#-------------------------------------------------------------------------------
mkdir -p "$MOAT_TMP/home"
SPEC_TEXT='# PRD: Greeter

Build a greet(name) function in greeter.py that returns "hello <name>".
Acceptance: greet("ada") returns "hello ada".'

mk_prompt_fixture() {  # <dir> <with_checklist:0|1>
    mkdir -p "$1"
    printf '%s\n' "$SPEC_TEXT" > "$1/prd.md"
    if [ "$2" = "1" ]; then
        mkdir -p "$1/.loki/checklist"
        printf '{"categories": []}\n' > "$1/.loki/checklist/checklist.json"
    fi
}

cat > "$MOAT_TMP/bp_bash.sh" <<'DRIVER'
# Driver: source the real run.sh and call the real build_prompt(retry, prd, iteration).
# Sourcing is safe (main is guarded by BASH_SOURCE == $0). LOKI_RUNNING_FROM_TEMP
# must stay unset: run.sh installs an EXIT trap deleting BASH_SOURCE under it.
run_sh="$1"; fixture_env="$2"; workdir="$3"
cd "$workdir" || exit 41
unset LOKI_RUNNING_FROM_TEMP
# shellcheck disable=SC1090
[ -f "$fixture_env" ] && . "$fixture_env"
export TARGET_DIR="$workdir"
# shellcheck disable=SC1090
. "$run_sh" >/dev/null 2>&1 || true
declare -f build_prompt >/dev/null 2>&1 || exit 42
build_prompt 0 ./prd.md 1
DRIVER

capture_bash_prompt() {  # <workdir> <out>
    env -i HOME="$MOAT_TMP/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" LANG=C \
        LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
        LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false \
        bash "$MOAT_TMP/bp_bash.sh" "$RUN_SH" "$FIXTURE_ENV" "$1" >"$2" 2>"$2.err"
}

capture_ts_prompt() {  # <workdir> <out>
    ( cd "$1" && env -i HOME="$MOAT_TMP/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
        P3_BP="$BP_TS" P3_CWD="$1" bun -e '
const { buildPrompt } = await import(process.env.P3_BP);
// Explicit env object: nothing from the host process leaks into the prompt.
const env = { TARGET_DIR: ".", MAX_PARALLEL_AGENTS: "10", AUTONOMY_MODE: "standard" };
const out = await buildPrompt({ retry: 0, prd: "./prd.md", iteration: 1,
                                ctx: { cwd: process.env.P3_CWD, env } });
process.stdout.write(out);
' ) >"$2" 2>"$2.err"
}

# Check-authoring detector. Echoes the matched markers; returns 0 when any hit.
# Each pattern names an instruction to AUTHOR the acceptance checklist, not to
# read or fix it (PRD_CHECKLIST_STATUS "fix failing items" is allowed).
detect_check_authoring() {  # <file>
    local f="$1" hits=""
    grep -q 'PRD_CHECKLIST_INIT' "$f" && hits="$hits PRD_CHECKLIST_INIT"
    grep -Eqi '(create|write|generate|author|populate|update|edit)[^.]{0,120}\.loki/checklist/' "$f" \
        && hits="$hits create-.loki/checklist"
    grep -Eqi 'verification checks \(file_exists' "$f" && hits="$hits verification-check-schema"
    [ -n "$hits" ] || return 1
    printf '%s' "${hits# }"
}

BP_BASH_STATE=""   # measured by case 1, reused as evidence by case 2

case_prompt_no_check_authoring() {
    local route out hits
    # Detector positive control: the known-bad instruction must be flagged.
    printf 'PRD_CHECKLIST_INIT: Create .loki/checklist/checklist.json from the PRD. Each item needs verification checks (file_exists, command).\n' \
        > "$MOAT_TMP/known-bad.txt"
    if ! detect_check_authoring "$MOAT_TMP/known-bad.txt" >/dev/null; then
        nok "detector positive control failed: a known check-authoring line was not flagged"
        return
    fi

    for route in bash ts; do
        if [ "$route" = "ts" ] && ! command -v bun >/dev/null 2>&1; then
            nok "ts route: prerequisite missing: bun"
            continue
        fi
        local cold="$MOAT_TMP/prompt-$route-cold" warm="$MOAT_TMP/prompt-$route-warm"
        mk_prompt_fixture "$cold" 0
        mk_prompt_fixture "$warm" 1
        "capture_${route}_prompt" "$cold" "$cold.out"
        local rc=$?
        "capture_${route}_prompt" "$warm" "$warm.out"
        # Vacuity guard: the builder must have emitted a real PRD-mode prompt.
        if [ "$rc" -ne 0 ] || ! grep -q 'Loki Mode with PRD' "$cold.out"; then
            nok "$route route: build prompt did not emit a PRD-mode prompt (rc=$rc; $(head -c 200 "$cold.out.err" | tr '\n' ' '))"
            continue
        fi
        # Negative control: with a checklist already present the builder emits
        # no authoring instruction, so any hit there means the detector is too broad.
        if hits="$(detect_check_authoring "$warm.out")"; then
            nok "$route route: detector over-matches (hits with checklist present: $hits)"
            continue
        fi
        if hits="$(detect_check_authoring "$cold.out")"; then
            nok "$route route: implementer prompt instructs check authoring ($hits)"
            [ "$route" = "bash" ] && BP_BASH_STATE="yes ($hits)"
        else
            [ "$route" = "bash" ] && BP_BASH_STATE="no"
        fi
        log "$route prompt: $(wc -c < "$cold.out" | tr -d ' ') bytes"
    done
}

#-------------------------------------------------------------------------------
case_check_author_context() {
    local repo="$MOAT_TMP/author-repo" spec_canary impl_canary out
    spec_canary="SPEC_CANARY_$$_${RANDOM}"
    impl_canary="IMPL_CANARY_$$_${RANDOM}"
    mkdir -p "$repo/src" "$repo/tests"
    printf '# PRD\n\nThe service must expose greet(name). Marker: %s\n' "$spec_canary" > "$repo/prd.md"
    printf 'MARKER = "%s"\n\ndef greet(name):\n    return "hello " + name\n' "$impl_canary" > "$repo/src/app.py"
    printf 'from src.app import greet, MARKER  # %s\n\ndef test_greet():\n    assert greet("a") == "hello a"\n' \
        "$impl_canary" > "$repo/tests/test_app.py"
    # Canary positive control: the probe can see the canary in the implementation.
    if ! grep -rqF "$impl_canary" "$repo/src" "$repo/tests"; then
        nok "canary positive control failed: fixture implementation lacks the canary"
        return
    fi

    if [ ! -f "$CHECK_AUTHOR" ]; then
        nok "check-author step not built: autonomy/lib/check_author.py absent (assumed interface A); today the only check-authoring step is the implementer session itself, which sees the whole repo (bash implementer prompt instructs check authoring: ${BP_BASH_STATE:-not measured})"
        return
    fi
    out="$MOAT_TMP/author-context.json"
    ( cd "$repo" && python3 "$CHECK_AUTHOR" context --spec "$repo/prd.md" --repo "$repo" ) \
        >"$out" 2>"$out.err"
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        nok "check_author.py context exited $rc: $(head -c 200 "$out.err" | tr '\n' ' ')"
        return
    fi
    if grep -qF "$impl_canary" "$out"; then
        nok "implementation content reached the check author (implementation canary found in its input)"
    fi
    local verdict
    verdict="$(python3 - "$out" "$spec_canary" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("unparseable context JSON: %s" % e); raise SystemExit
bad = []
if sys.argv[2] not in str(d.get("prompt", "")):
    bad.append("spec canary missing from prompt (spec did not reach the check author)")
paths = [str(i.get("path", "")) for i in (d.get("inputs") or []) if isinstance(i, dict)]
if not any(p.endswith("prd.md") for p in paths):
    bad.append("spec not listed in inputs")
leaked = [p for p in paths if p.endswith(("src/app.py", "tests/test_app.py"))]
if leaked:
    bad.append("implementation files in inputs: %s" % ",".join(leaked))
print("; ".join(bad))
PY
)"
    [ -n "$verdict" ] && nok "$verdict"
}

#-------------------------------------------------------------------------------
case_checks_frozen() {
    local proj="$MOAT_TMP/frozen" cl out rc
    mkdir -p "$proj/.loki/checklist"
    printf 'present\n' > "$proj/present.txt"
    cl="$proj/.loki/checklist/checklist.json"
    cat > "$cl" <<'JSON'
{"categories": [{"name": "core", "items": [
  {"id": "A", "title": "present file exists", "priority": "critical",
   "verification": [{"type": "file_exists", "path": "present.txt"}]},
  {"id": "B", "title": "missing file exists", "priority": "critical",
   "verification": [{"type": "file_exists", "path": "missing.txt"}]}
]}]}
JSON
    item_status() {  # <checklist> <id> -> status written by the verifier
        python3 - "$1" "$2" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("unreadable"); raise SystemExit
for c in d.get("categories", []):
    for i in c.get("items", []):
        if i.get("id") == sys.argv[2]:
            print(i.get("status", "none")); raise SystemExit
print("absent")
PY
    }
    verify() {  # <log> ; sets rc
        ( cd "$proj" && python3 "$VERIFIER" --checklist "$cl" ) >"$1" 2>&1
    }
    tamper() {  # rewrite a DEFINITION field so the failing check trivially passes
        python3 - "$cl" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for c in d["categories"]:
    for i in c["items"]:
        if i["id"] == "B":
            i["verification"][0]["path"] = "present.txt"
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
    }

    cp "$cl" "$MOAT_TMP/frozen-pristine.json"
    ( cd "$proj" && python3 "$VERIFIER" --checklist "$cl" --freeze ) >"$MOAT_TMP/freeze.log" 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then
        # Measure what the gap costs today: a tampered checklist on the current
        # verifier. Same probe that must go red once the freeze exists.
        cp "$MOAT_TMP/frozen-pristine.json" "$cl"
        tamper
        verify "$MOAT_TMP/tamper-today.log"
        local trc=$?
        nok "freeze interface absent (checklist-verify.py --freeze rc=$rc: $(tail -1 "$MOAT_TMP/freeze.log")); today a checklist edited after authoring verifies with no integrity check (tampered item B status=$(item_status "$cl" B), verifier rc=$trc)"
        return
    fi

    # Positive controls: clean runs are honest, and the verifier's own
    # write-back does not trip the digest on a second run.
    local pass_no
    for pass_no in 1 2; do
        verify "$MOAT_TMP/clean-$pass_no.log"
        if grep -qi 'hash mismatch' "$MOAT_TMP/clean-$pass_no.log"; then
            nok "clean verify run $pass_no reported a hash mismatch (digest covers result fields, or is unstable)"
        fi
        [ "$(item_status "$cl" A)" = "verified" ] || nok "clean run $pass_no: item A not verified ($(item_status "$cl" A))"
        [ "$(item_status "$cl" B)" = "failing" ] || nok "clean run $pass_no: item B not failing ($(item_status "$cl" B))"
    done
    [ -z "$CASE_FAILS" ] || return

    tamper
    out="$MOAT_TMP/tampered.log"
    verify "$out"
    rc=$?
    [ "$rc" -ne 0 ] || nok "verifier exited 0 on a checklist edited after freezing"
    grep -qi 'hash mismatch' "$out" || nok "no 'hash mismatch' reason in verifier output: $(tail -1 "$out")"
    [ "$(item_status "$cl" B)" != "verified" ] || nok "the edited check B was reported verified"
}

moat_run "P3.implementer-prompt-has-no-check-authoring" \
    "implementer build prompt (bash + Bun builders, PRD mode) carries no check-authoring instruction" \
    case_prompt_no_check_authoring
moat_run "P3.check-author-context-excludes-implementation" \
    "check-author input contains the spec and no implementation file" \
    case_check_author_context
moat_run "P3.checks-frozen-before-eval" \
    "deterministic verifier rejects checks edited after freezing with a hash mismatch" \
    case_checks_frozen
exit 0
