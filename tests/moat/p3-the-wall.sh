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
#       Two text-based detectors run against the SAME real captured prompt on
#       both routes: the original exact-phrase check (PRD_CHECKLIST_INIT, the
#       "create/write/... .loki/checklist/" verb+path pattern, and the
#       "verification checks (file_exists" schema phrase), plus a second,
#       broader signature detector (verb + "checklist.json" regardless of
#       path phrasing, a literal `"verification": [` JSON array near
#       checklist-authoring context, and the `(file_exists, ...command)`
#       type-enum shape) added under BACKLOG 40, reworked once under S-09 to
#       fix two findings a split quorum review raised.
#
#       The second detector closes a real gap the first one has: it still
#       fires if PRD_CHECKLIST_INIT is renamed and reworded, as long as the
#       replacement text still names checklist.json or the verification
#       schema shape. Its verb/checklist.json gap is character-distance
#       bounded ACROSS THE WHOLE PROMPT, not per source line: the detector
#       strips carriage returns, then joins the captured text's lines with a
#       real newline at each blank-line paragraph break (so unrelated
#       paragraphs are not silently merged into one matchable run, and grep's
#       own per-line matching enforces the boundary with no ". "-join trick
#       that a trailing period could defeat) before running the
#       character-distance patterns, so an
#       instruction that an LLM wrapped across lines is judged by character
#       distance the same way a single-line instruction is, instead of being
#       missed purely because grep's default matching is per line. Two
#       disclosed ceilings from that join: (1) two unrelated lines can still
#       coincidentally satisfy the character-distance budget once joined, for
#       example a markdown heading immediately followed by an unrelated
#       bullet mentioning checklist.json with no terminal period between
#       them - a real but narrow risk, not eliminated by this fix; (2) the
#       verification-array-literal signature additionally now requires
#       "checklist" to also appear within the same character-distance budget
#       of the array, so an unrelated JSON `"verification": [` array (for
#       example one explicitly prohibited: "do not touch verification: []
#       in ci-config.json") does not by itself fire the signature - but the
#       narrowed check is still blind to negation: an instruction that says
#       NOT to touch a checklist's verification array, if "checklist" also
#       appears nearby, still fires it. BOTH detectors remain purely
#       textual: neither runs, stubs, or simulates an implementer session,
#       so neither can catch a model that goes off-script and authors checks
#       despite a clean prompt. That ceiling is real; closing it would
#       require executing or faithfully stubbing an implementer agent, which
#       is not fast/deterministic enough for this moat suite.
#
#   P3.check-author-context-excludes-implementation
#       The check-authoring step's input contains the spec and none of the
#       repo's implementation files.
#
#   P3.checks-frozen-before-eval
#       A checklist edited after it was frozen is rejected by the deterministic
#       verifier (autonomy/checklist-verify.py) with a hash mismatch reason.
#
#   P3.e10-wall-check-sealed-and-rerun
#       A real default-route engine10 run with a stub provider: the Wall check
#       fails on base, the receipt wall.files lists it with a sha256, a sealed
#       copy sits under <run>/wall, the verify stage reran it green at head, and
#       deleting the sealed copy makes `loki verify` report TAMPERED.
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
#        harness: checklist_freeze_once (autonomy/prd-checklist.sh) runs
#        python3 -I autonomy/checklist-verify.py --checklist <path> --freeze,
#        which prints the digest of the check DEFINITIONS (ids and verification
#        specs, never the result fields the verifier writes back) and writes
#        nothing. The harness keeps the digest in its own memory.
#        Every harness verify passes --expect-digest <sha>. The verifier fails
#        closed (non-zero) when it is missing, empty or malformed, and prints
#        "hash mismatch" and exits non-zero when it differs; it does not report
#        edited checks as verified. The verifier's own write-back must NOT trip
#        the digest on a re-run.
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
MOAT_IDS="P3.implementer-prompt-has-no-check-authoring P3.check-author-context-excludes-implementation P3.checks-frozen-before-eval P3.e10-wall-check-sealed-and-rerun"
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

# Broader signature detector (BACKLOG 40; reworked under S-09, round 2).
# Independent of detect_check_authoring above and never substituted for it:
# this only ADDS coverage. It matches check-authoring signatures that survive
# a rename of PRD_CHECKLIST_INIT and a reword of its instruction text: any
# authoring verb near "checklist.json" (the "([^.]|\.[^[:space:]]){0,160}"
# gap crosses a dotted path such as ".loki/checklist/checklist.json" without
# stopping at the first dot, but still stops at a ". " sentence break inside
# a paragraph, or at a real line break where the joined text puts a
# paragraph boundary), a
# literal JSON "verification": [ array that also has "checklist" within the
# same gap budget, or the "(file_exists, ...command)" type-enum shape.
#
# grep's default matching is per line: a verb and "checklist.json" on
# separate source lines are invisible to a character-distance pattern no
# matter how close together they are, because the regex engine never sees
# past the line boundary. Real LLM-authored prose wraps constantly, so a
# character-budget claim that silently stops at every line break is far
# narrower than it looks. To make the character-distance behavior in the
# comment above true in practice, this detector runs the three patterns
# against a JOINED copy of the file: a mid-paragraph line wrap (a newline
# with no blank line around it) becomes a single space, so a wrapped
# sentence still reads as one line for grep. A blank line (a paragraph
# break) becomes a REAL newline in the joined output instead - not a fake
# ". " marker - so grep's own per-line matching enforces the paragraph
# boundary for free. Round 1 used ". " for this, but a paragraph that
# already ends in a period then joined to "..", and the gap pattern's
# "\.[^[:space:]]" branch treats two periods in a row as a non-terminating
# character and lets the match cross the paragraph boundary anyway - the
# opposite of the intended fix. A real newline has no such edge case: the
# paragraph break is a genuine line break in the joined text, not an in-line
# character sequence a regex can slip through. Carriage returns are also
# stripped from each line before the blank-line test runs, because a CRLF
# blank line's raw content is the single character "\r", not the empty
# string - without stripping first, awk's own "$0==\"\"" test never
# recognizes it as blank, so the line joins with a plain space instead of a
# real newline and the paragraph break is silently erased, letting a match
# cross a genuine CRLF paragraph boundary it should have stopped at (a false
# positive, the same class of bug the round-1 fix ". " join produced, just
# reached through CRLF instead of a trailing period).
# Only the joined copy is matched here; detect_check_authoring above is
# untouched and still line-oriented.
#
# Disclosed ceilings, not fixed here:
#   - the join can still coincidentally satisfy the character budget for two
#     unrelated lines joined by a mid-paragraph wrap (no blank line between
#     them), for example a markdown heading directly followed on the next
#     line by an unrelated bullet that mentions checklist.json - only a
#     blank-line paragraph break stops a match, a bare line wrap does not
#     (that is the gap this detector exists to close);
#   - the verification-array-literal signature requires "checklist" nearby
#     to avoid firing on an unrelated JSON "verification": [ array (for
#     example one explicitly prohibited: "do not touch verification: [] in
#     ci-config.json"), but it is still blind to negation - a sentence that
#     says NOT to touch a checklist's verification array still fires it;
#   - the type-enum signature requires file_exists to appear before command
#     inside the parens, in that order, so a verification-type list in a
#     different order or spelled out prose would still slip it.
# Measured against the real captured prompts on both routes (see
# case_prompt_no_check_authoring): today's PRD_CHECKLIST_INIT text fires the
# verb and type-enum signatures on both cold prompts, and all three
# signatures are silent on both warm prompts, which carry no checklist text
# at all in this fixture.
detect_check_authoring_signatures() {  # <file>
    local f="$1" hits="" j
    j="$f.joined"
    # ponytail: awk avoids a pipe into grep -q, which would take a SIGPIPE
    # (set -o pipefail) on the first match and silently swallow the hit.
    # A blank line emits a real newline (grep then enforces the paragraph
    # boundary itself); any other line join is a plain space, so a
    # mid-paragraph wrap still reads as one line. \r is stripped first so a
    # CRLF-terminated wrap joins the same way an LF-terminated one does.
    awk 'BEGIN{first=1} { gsub(/\r/, ""); if (!first && $0=="") printf "\n"; else if (!first) printf " "; printf "%s", $0; first=0 }' "$f" > "$j"
    grep -Eqi '(create|write|generate|author|produce|emit|draft|populate|update|edit)([^.]|\.[^[:space:]]){0,160}checklist\.json' "$j" \
        && hits="$hits verb-checklist.json"
    if grep -Eq '"verification"[[:space:]]*:[[:space:]]*\[' "$j" \
        && grep -Eqi 'checklist([^.]|\.[^[:space:]]){0,160}"verification"[[:space:]]*:[[:space:]]*\[|"verification"[[:space:]]*:[[:space:]]*\[([^.]|\.[^[:space:]]){0,160}checklist' "$j"; then
        hits="$hits verification-array-literal"
    fi
    grep -Eqi '\(file_exists,[^)]*command\)' "$j" && hits="$hits verification-type-enum"
    rm -f "$j"
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
    # Sanity: the new signature detector also flags the known-bad line (it is
    # additive coverage, not a replacement for the phrase check above).
    if ! detect_check_authoring_signatures "$MOAT_TMP/known-bad.txt" >/dev/null; then
        nok "signature-detector positive control failed: a known check-authoring line was not flagged"
        return
    fi

    # S-09 rework fixture 1: line-boundary blind spot. The verb and
    # "checklist.json" sit on separate source lines, well within the 160-char
    # budget once joined (a few dozen chars), the way real LLM-wrapped prose
    # commonly reads. Before the join fix this was invisible to grep's
    # per-line matching; after it, the joined text must be judged purely by
    # character distance, so it must match.
    printf 'Create the full set of checklist entries for review\nchecklist.json holds the final results.\n' \
        > "$MOAT_TMP/line-split.txt"
    if ! detect_check_authoring_signatures "$MOAT_TMP/line-split.txt" >/dev/null; then
        nok "S-09 regression: verb and checklist.json on separate lines (within budget once joined) went undetected - the line-boundary gap is back"
    fi

    # S-09 rework fixture 2: the same verb/target pair, but split by a
    # blank-line paragraph break, which now becomes a real newline in the
    # joined output and stops the match on its own regardless of character
    # count (the pair is also written far enough apart to stay out of
    # budget even if the paragraph break did not apply). Proves the join
    # does not turn every cross-line pair into a false positive.
    printf 'Create a comprehensive glossary of terms for the onboarding guide so that new engineers understand every acronym used across the platform before their first week begins in earnest and nothing is left ambiguous for long.\n\nchecklist.json is unrelated and lives elsewhere in a totally different subsystem that this paragraph never discusses at all.\n' \
        > "$MOAT_TMP/line-split-far.txt"
    if hits="$(detect_check_authoring_signatures "$MOAT_TMP/line-split-far.txt")"; then
        case " $hits " in
            *' verb-checklist.json '*)
                nok "S-09 regression: joining lines created a false positive across an unrelated paragraph break, well outside the 160-char budget (hits: $hits)" ;;
        esac
    fi

    # S-09 rework fixture 3: the disclosed false-positive vector. An
    # unrelated, explicitly-prohibited JSON "verification": [ array with no
    # checklist-authoring context nearby must not fire the signature.
    printf 'Do not touch "verification": [] in ci-config.json; that array belongs to a different system.\n' \
        > "$MOAT_TMP/unrelated-verification-array.txt"
    if hits="$(detect_check_authoring_signatures "$MOAT_TMP/unrelated-verification-array.txt")"; then
        case " $hits " in
            *' verification-array-literal '*)
                nok "S-09 regression: an unrelated verification array with no checklist context fired verification-array-literal (hits: $hits)" ;;
        esac
    fi
    # Positive control for fixture 3's narrowing: the SAME array literal DOES
    # fire once checklist-authoring context is nearby, so the fix narrows
    # rather than disables the signature.
    printf 'Populate the checklist definitions with a "verification": [{"type": "file_exists"}] array for each item.\n' \
        > "$MOAT_TMP/checklist-verification-array.txt"
    hits="$(detect_check_authoring_signatures "$MOAT_TMP/checklist-verification-array.txt")" || hits=""
    case " $hits " in
        *' verification-array-literal '*) ;;
        *) nok "S-09 regression: verification-array-literal no longer fires even WITH checklist context nearby (over-narrowed, hits: ${hits:-none})" ;;
    esac

    # S-09 rework round 2 fixture: the round-1 fix's own regression. A
    # paragraph that already ends in a period, a blank line, then an
    # unrelated paragraph mentioning checklist.json. Round 1 joined the
    # blank line to ". ", which after an existing trailing period produced
    # "..", and the gap pattern's "\.[^[:space:]]" branch treated the double
    # period as a non-terminating character and matched straight through the
    # paragraph boundary. These are two separate sentences about different
    # things and must not match.
    printf 'Update the README.\n\nchecklist.json is unrelated.\n' \
        > "$MOAT_TMP/double-period-paragraph.txt"
    if hits="$(detect_check_authoring_signatures "$MOAT_TMP/double-period-paragraph.txt")"; then
        case " $hits " in
            *' verb-checklist.json '*)
                nok "S-09 round 2 regression: a period-ending sentence followed by a blank-line paragraph break and unrelated checklist.json text matched (double-period gap-tolerance bypass, hits: $hits)" ;;
        esac
    fi

    # S-09 rework round 2 fixture: multiple consecutive blank lines between
    # paragraphs must still stop a match (each blank line becomes its own
    # real newline in the joined output; several in a row are still just
    # several newlines, which grep still treats as line boundaries).
    printf 'Update the README.\n\n\n\nchecklist.json is unrelated.\n' \
        > "$MOAT_TMP/multi-blank-paragraph.txt"
    if hits="$(detect_check_authoring_signatures "$MOAT_TMP/multi-blank-paragraph.txt")"; then
        case " $hits " in
            *' verb-checklist.json '*)
                nok "S-09 round 2 regression: multiple consecutive blank lines between paragraphs still matched across the boundary (hits: $hits)" ;;
        esac
    fi

    # S-09 rework round 2 fixture: a paragraph that does NOT end in a period
    # before the blank line. A blank line is treated as a paragraph break
    # regardless of the preceding line's trailing punctuation - the boundary
    # is structural (a real newline in the joined output), not dependent on
    # sentence-final punctuation, so this must not match either. Anything
    # else would mean an incomplete sentence joins more permissively than a
    # complete one, which has no principled justification.
    printf 'Update the README\n\nchecklist.json is unrelated.\n' \
        > "$MOAT_TMP/no-period-before-blank.txt"
    if hits="$(detect_check_authoring_signatures "$MOAT_TMP/no-period-before-blank.txt")"; then
        case " $hits " in
            *' verb-checklist.json '*)
                nok "S-09 round 2 regression: a paragraph break not preceded by a period still matched across the boundary (hits: $hits)" ;;
        esac
    fi

    # S-09 rework round 2 fixture: CRLF line endings. A verb and
    # checklist.json wrapped across two CRLF-terminated lines (no blank line
    # between them - a plain wrap) must still match, the same as the LF
    # case above. This holds with or without CR-stripping (the grep gap
    # pattern's own "[^.]" already matches a bare "\r"), so this fixture alone
    # does not prove the strip is load-bearing - it only guards that CRLF
    # text does not regress the ORIGINAL line-wrap fix from round 1.
    printf 'Create the full set of checklist entries for review\r\nchecklist.json holds the final results.\r\n' \
        > "$MOAT_TMP/crlf-wrap.txt"
    if ! detect_check_authoring_signatures "$MOAT_TMP/crlf-wrap.txt" >/dev/null; then
        nok "S-09 round 2 regression: CRLF-terminated line wrap (verb and checklist.json on adjacent \\r\\n lines) went undetected"
    fi

    # S-09 rework round 2 fixture: the actual CR defect the strip fixes. A
    # CRLF blank line between two CRLF-terminated paragraphs (no trailing
    # period on the first line, so this is the same "no terminal period"
    # shape as the no-period-before-blank fixture above, but over "\r\n\r\n")
    # is a false POSITIVE, not a false negative: without stripping "\r"
    # first, awk sees that "blank" line's content as the single character
    # "\r", not the empty string, so its own blank-line test ($0=="") never
    # fires, the line is joined with a plain space instead of a real
    # newline, and the paragraph break is silently erased - letting the
    # match cross a real paragraph boundary the LF case would have stopped.
    # Stripping "\r" first makes a CRLF blank line read as truly empty, so
    # it is recognized as a paragraph break exactly like an LF blank line.
    printf 'Update the README\r\n\r\nchecklist.json is unrelated.\r\n' \
        > "$MOAT_TMP/crlf-paragraph.txt"
    if hits="$(detect_check_authoring_signatures "$MOAT_TMP/crlf-paragraph.txt")"; then
        case " $hits " in
            *' verb-checklist.json '*)
                nok "S-09 round 2 regression: a CRLF blank line was not recognized as a paragraph break, letting the match cross a real CRLF paragraph boundary (hits: $hits)" ;;
        esac
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

        # New-signature arm (BACKLOG 40), independent of the phrase check
        # above, testing the SAME property (the prompt must carry no
        # check-authoring instruction): same negative control (warm must stay
        # clean) and the SAME polarity as the phrase check (a hit on the real
        # cold prompt is a FAILURE, not a pass condition - the property is
        # "carries no check-authoring", so once check authoring is actually
        # removed from the builders, both detectors must go quiet together).
        if hits="$(detect_check_authoring_signatures "$warm.out")"; then
            nok "$route route: signature detector over-matches (hits with checklist present: $hits)"
        fi
        if hits="$(detect_check_authoring_signatures "$cold.out")"; then
            nok "$route route: implementer prompt instructs check authoring (signatures: $hits)"
        fi

        # RED self-test: prove the signature detector catches what the phrase
        # detector misses, using a prompt derived from the SAME real cold
        # prompt captured above (not a toy string). Rename PRD_CHECKLIST_INIT
        # and reword its instruction so none of the three phrase-check
        # patterns match, while it still tells the implementer to author
        # checklist.json with a verification schema - the exact gap BACKLOG 40
        # names. If the exact PRD_CHECKLIST_INIT line is no longer present to
        # rewrite (for example after the M2 fix lands and removes it), fall
        # back to appending the reworded instruction to a copy of cold, so
        # this arm always runs and never silently no-ops; it is testing the
        # detectors' text-matching behavior, not asserting anything about
        # what the builder currently emits.
        local reworded="$MOAT_TMP/reworded-$route.out" reworded_line
        reworded_line='PRD_CHECKS_BOOTSTRAP: Produce .loki/checklist/checklist.json from the PRD by emitting a JSON object with categories and items; each item needs id, title, description, priority, and a "verification": [{"type": ...}] array (file_exists, command). Re-checked every 5 iterations.'
        sed -E 's/PRD_CHECKLIST_INIT: Create \.loki\/checklist\/checklist\.json from the PRD\. Extract requirements into categories with items\. Each item needs: id, title, description, priority \(critical\|major\|minor\), and verification checks \(file_exists, file_contains, tests_pass, grep_codebase, command\)\. This checklist will be auto-verified every [0-9]+ iterations\./'"$(printf '%s' "$reworded_line" | sed -e 's/[\/&]/\\&/g')"'/' \
            "$cold.out" > "$reworded"
        if diff -q "$cold.out" "$reworded" >/dev/null 2>&1; then
            cp "$cold.out" "$reworded"
            printf '%s\n' "$reworded_line" >> "$reworded"
        fi
        if detect_check_authoring "$reworded" >/dev/null; then
            nok "$route route: RED fixture setup invalid - the reworded prompt was still flagged by the phrase detector"
        elif hits="$(detect_check_authoring_signatures "$reworded")"; then
            case " $hits " in
                *' verb-checklist.json '*) ;;
                *) nok "$route route: RED fixture missed the verb-checklist.json signature (hits: $hits)" ;;
            esac
            case " $hits " in
                *' verification-array-literal '*) ;;
                *) nok "$route route: RED fixture missed the verification-array-literal signature (hits: $hits)" ;;
            esac
            case " $hits " in
                *' verification-type-enum '*) ;;
                *) nok "$route route: RED fixture missed the verification-type-enum signature (hits: $hits)" ;;
            esac
        else
            nok "$route route: signature detector failed to catch a reworded check-authoring instruction the phrase check misses (RED case not closed)"
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
    printf '{"name":"fixture"}\n' > "$repo/package.json"
    printf 'export const impl = "%s";\n' "$impl_canary" > "$repo/src/vitest.config.ts"
    # Tracked fixture: check_author.py selects from git ls-files, so a plain dir would
    # take its non-git spec-only path and pass with the CONFIG/TESTISH filter removed.
    if ! { git -C "$repo" init -q \
        && git -C "$repo" add prd.md package.json src/app.py src/vitest.config.ts tests/test_app.py \
        && git -C "$repo" -c user.name=moat -c user.email=moat@example.invalid -c commit.gpgsign=false commit -q -m fixture; }; then
        nok "fixture git setup failed"
        return
    fi
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
if "package.json" not in paths:
    bad.append("tracked root runner config package.json not listed (git path not exercised)")
leaked = [p for p in paths if p.endswith(("src/app.py", "tests/test_app.py", "src/vitest.config.ts"))]
if leaked:
    bad.append("implementation files in inputs: %s" % ",".join(leaked))
print("; ".join(bad))
PY
)"
    [ -n "$verdict" ] && nok "$verdict"
}

#-------------------------------------------------------------------------------
case_checks_frozen() {
    # Drives the harness path (autonomy/prd-checklist.sh): the harness freezes the
    # check definitions in its own memory and passes the digest to every verify.
    local proj="$MOAT_TMP/frozen" cl out
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
    cat > "$MOAT_TMP/frozen-driver.sh" <<DRV
log_info() { :; }
log_step() { :; }
log_warn() { printf '%s\n' "\$*" >> "$MOAT_TMP/frozen-harness.log"; }
export CHECKLIST_ENABLED=true CHECKLIST_TIMEOUT=5
. "$REPO_ROOT/autonomy/prd-checklist.sh"
checklist_init ""
checklist_select_heldout() { :; }
checklist_oracle_triangulate() { :; }
checklist_freeze_once || echo "freeze-failed"
checklist_verify; c1=\$?
checklist_verify; c2=\$?
if [ "\${1:-}" = tamper ]; then
    python3 - "$cl" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for c in d["categories"]:
    for i in c["items"]:
        if i["id"] == "B":
            i["verification"][0]["path"] = "present.txt"
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
fi
checklist_freeze_once
checklist_verify; fin=\$?
echo "clean1=\$c1 clean2=\$c2 final=\$fin"
DRV
    : > "$MOAT_TMP/frozen-harness.log"
    out="$( cd "$proj" && bash "$MOAT_TMP/frozen-driver.sh" 2>/dev/null )"
    case "$out" in
        *"clean1=0 clean2=0 final=0") ;;
        *) nok "clean harness verifies did not all succeed ($out)"; return ;;
    esac
    grep -qi 'hash mismatch' "$MOAT_TMP/frozen-harness.log" && nok "clean harness run reported a hash mismatch (digest unstable across the verifier's own write-back)"
    [ "$(item_status "$cl" A)" = "verified" ] || nok "clean run: item A not verified ($(item_status "$cl" A))"
    [ "$(item_status "$cl" B)" = "failing" ] || nok "clean run: item B not failing ($(item_status "$cl" B))"
    [ -z "$CASE_FAILS" ] || return

    : > "$MOAT_TMP/frozen-harness.log"
    out="$( cd "$proj" && bash "$MOAT_TMP/frozen-driver.sh" tamper 2>/dev/null )"
    case "$out" in
        *"final=0") nok "harness verify returned 0 on a checklist edited after freezing" ;;
    esac
    grep -qi 'hash mismatch' "$MOAT_TMP/frozen-harness.log" || nok "no 'hash mismatch' reason from the harness: $(tail -1 "$MOAT_TMP/frozen-harness.log")"
    [ "$(item_status "$cl" B)" != "verified" ] || nok "the edited check B was reported verified"
}

#-------------------------------------------------------------------------------
# Default engine10 route, stub provider only (no paid call). A real
# `loki start` run: the Wall check is red on base, the receipt lists it with a
# sha256, the sealed copy sits under <run>/wall, the verify stage reran it at
# head, and `loki verify` flags a deleted sealed copy as TAMPERED.
#-------------------------------------------------------------------------------
case_e10_wall_sealed_and_rerun() {
    local fx="$MOAT_TMP/e10" w run rid rc out i
    mkdir -p "$fx/bin" "$fx/w" "$fx/home"
    w="$fx/w"
    command -v node >/dev/null 2>&1 || { nok "node not on PATH"; return; }
    printf '{"name":"fx","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$w/package.json"
    printf 'function sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$w/sum.js"
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('empty is 0', () => { assert.strictEqual(sum([]), 0); });\n" > "$w/sum.test.js"
    {
        printf '# PRD\n\nsum() in sum.js skips the first element of the array. Fix it so sum([1,2,3]) is 6.\n\n'
        for i in 1 2 3 4 5 6 7 8; do
            printf 'Detail %s: the fix must keep sum([]) at 0, must not change the module export shape, and must leave package.json untouched so the existing test command keeps working.\n' "$i"
        done
    } > "$w/prd.md"
    cat > "$fx/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in
    *" --help "* | *" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions -p --print"; exit 0 ;;
esac
prompt=""
while [ $# -gt 0 ]; do
    if [ "$1" = "-p" ]; then prompt="${2:-}"; shift; fi
    shift
done
case "$prompt" in
  *"Loki 10 Wall author"*)
    echo wall >> "$X_LOG"
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sum adds every element', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\n" > loki_wall_sum.test.js ;;
  *"Loki 10 implement stage"*)
    echo implement >> "$X_LOG"
    sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak ;;
esac
echo "stub done"
STUB
    chmod +x "$fx/bin/claude"
    ( cd "$w" && git init -q && git config user.email m@m.m && git config user.name moat \
        && git add package.json sum.js sum.test.js prd.md && git commit -qm init ) >/dev/null 2>&1 \
        || { nok "fixture repo setup failed"; return; }

    : > "$fx/stub.log"
    ( cd "$w" && env -i PATH="$fx/bin:$PATH" HOME="$fx/home" TERM=dumb LANG=C X_LOG="$fx/stub.log" \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$fx/bin/claude" LOKI_NO_BROWSER=1 LOKI_DASHBOARD=false \
        LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
        perl -e 'alarm shift; exec @ARGV' 240 "$REPO_ROOT/bin/loki" start prd.md --no-pr \
        < /dev/null > "$fx/out.txt" 2> "$fx/err.txt" )
    rc=$?

    grep -qx wall "$fx/stub.log" || { nok "the stub Wall author was never invoked (rc=$rc)"; return; }
    grep -qx implement "$fx/stub.log" || { nok "the stub implement stage was never invoked (rc=$rc)"; return; }
    run="$(ls -d "$w"/.loki/runs/e10-* 2>/dev/null | head -1)"
    [ -n "$run" ] && [ -f "$run/receipt.json" ] || { nok "no e10-* run dir with a receipt (default route not taken, rc=$rc)"; return; }
    rid="$(basename "$run")"

    out="$(RUN="$run" python3 - <<'PY' 2>&1
import json, os, hashlib
run = os.environ["RUN"]
r = json.load(open(os.path.join(run, "receipt.json")))
wall = r.get("wall") or {}
files = wall.get("files") or []
bad = []
if not files:
    bad.append("receipt wall.files is empty")
if wall.get("passed") is not True:
    bad.append("receipt wall.passed is not true")
for f in files:
    base = os.path.basename(f.get("path", ""))
    sealed = os.path.join(run, "wall", base)
    if not os.path.isfile(sealed):
        bad.append("no sealed copy for " + base)
    elif hashlib.sha256(open(sealed, "rb").read()).hexdigest() != f.get("sha256"):
        bad.append("sealed copy sha256 differs from receipt for " + base)
names = [os.path.basename(f.get("path", "")) for f in files]
if "loki_wall_sum.test.js" not in names:
    bad.append("loki_wall_sum.test.js not in wall.files")
hit = [c for c in r.get("checks", []) if "loki_wall_sum" in (c.get("name") or "") + (c.get("cmd") or "")]
if not hit or any(c.get("result") != "pass" for c in hit):
    bad.append("verify stage did not rerun the Wall check green at head")
base_fail = None
for line in open(os.path.join(run, "events.jsonl")):
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if e.get("type") == "stage.completed" and e.get("stage") == "wall":
        base_fail = ((e.get("data") or {}).get("base_run") or {}).get("fail")
if not isinstance(base_fail, int) or base_fail < 1:
    bad.append("Wall check was not red on base (base_run.fail=%r)" % (base_fail,))
print("; ".join(bad))
PY
)"
    [ -z "$out" ] || { nok "$out"; return; }

    ( cd "$w" && env -i PATH="$PATH" HOME="$fx/home" "$REPO_ROOT/bin/loki" verify "$rid" --allow-unsigned ) > "$fx/v1.txt" 2>&1
    grep -q 'VERIFIED' "$fx/v1.txt" || nok "loki verify on the intact run was not VERIFIED: $(tail -1 "$fx/v1.txt")"
    [ -z "$CASE_FAILS" ] || return

    rm -f "$run/wall/loki_wall_sum.test.js"
    ( cd "$w" && env -i PATH="$PATH" HOME="$fx/home" "$REPO_ROOT/bin/loki" verify "$rid" --allow-unsigned ) > "$fx/v2.txt" 2>&1
    rc=$?
    grep -q 'TAMPERED' "$fx/v2.txt" || nok "deleting the sealed Wall copy did not give TAMPERED: $(tail -1 "$fx/v2.txt")"
    [ "$rc" -ne 0 ] || nok "loki verify exited 0 after the sealed Wall copy was deleted"
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
moat_run "P3.e10-wall-check-sealed-and-rerun" \
    "default engine10 route: Wall check red on base, sealed under the run dir, rerun green at head, deleted copy is TAMPERED" \
    case_e10_wall_sealed_and_rerun
exit 0
