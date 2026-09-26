#!/usr/bin/env bash
# tests/test-pause-tty-and-receipt-surface.sh
#
# Guards two shipped behaviors in autonomy/run.sh that no other suite covers.
#
# ---------------------------------------------------------------------------
# PART 1 (#205): handle_pause must not depend on a keypress that cannot arrive.
#
# The wait loop's keypress arm was a bare `read -t 1 -n 1`. Off a TTY that is
# wrong in BOTH directions, and both were reproduced directly with bash:
#
#   stdin = /dev/null  -> read returns non-zero forever, so the loop spins on
#                         `sleep 1` with nobody able to press anything. This is
#                         the reported hang (--bg, a container, a CI job).
#   stdin = bytes      -> read SUCCEEDS on the first stray byte, and the very
#                         next line is `rm -f "$loki_dir/PAUSE"`. A gate
#                         escalation that paused at GATE_PAUSE_LIMIT is then
#                         silently resumed by data nobody typed. This FALSE
#                         RESUME is the worse of the two: the run continues past
#                         a blocking gate.
#
# The fix gates the arm on `[ -t 0 ]`. The file-based escapes (STOP, and
# PAUSE-file removal) are untouched and still run every second, so a
# non-interactive operator keeps every way out they had.
#
# Proven directions:
#   RED-1 : non-TTY stdin WITH BYTES must not delete .loki/PAUSE.
#   GREEN : PAUSE removed by someone else still returns 0 (file escape intact).
#   GREEN : a STOP file still returns 1 (stop escape intact).
#   STRUCT: the keypress arm is GUARDED, not REMOVED -- an interactive terminal
#           must keep its keypress resume. There is no pty here, so this one is
#           asserted structurally.
#   BANNER: the "or press Enter" advice is not shown when it cannot work.
#
# ---------------------------------------------------------------------------
# PART 2 (#209): a finished run must state that a checkable receipt exists.
#
# The Evidence Receipt is generated automatically and opt-OUT, but its location
# only ever reached the user through the zero-config first-run block. Every
# other run could finish without the user learning a receipt was written.
#
# Both user-facing summaries must now name the receipt path, the deterministic
# verdict, and the re-check command -- and must print NOTHING when no receipt
# exists yet (mid-pause, or the first summary on the success path), because a
# path that does not exist is a promise, not a fact.
#
# ---------------------------------------------------------------------------
# NO COUNT THRESHOLDS. Every required thing is asserted individually by name, so
# a failure says WHICH one broke. A threshold cannot.
#
# VACUITY: every extraction from run.sh is checked for emptiness and FAILS
# (never skips) when it finds nothing. A probe that examines zero items would
# otherwise report a clean pass forever.
#
# RUN_SH is overridable via LOKI_RUN_SH_OVERRIDE so this suite can be pointed at
# a pre-fix copy of run.sh to prove it actually goes red.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); shift; [ $# -gt 0 ] && printf '        %s\n' "$*"; return 0; }

echo "TEST: pause needs no TTY, and a finished run names its Evidence Receipt"

if [ ! -f "$RUN_SH" ]; then
    bad "run.sh is readable at $RUN_SH" "cannot guard what cannot be read"
    echo ""
    echo "  Passed: $PASS   Failed: $FAIL"
    exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-pause-receipt-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ===========================================================================
# PART 1: handle_pause
# ===========================================================================
echo ""
echo "--- #205: a pause must not wait on a keypress that cannot arrive ---"

# Extract ONLY the real wait loop from the real handle_pause. Testing a mirror
# would not catch a wrong condition in the source.
LOOP="$TMP/loop.sh"
python3 - "$RUN_SH" > "$LOOP" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
start = s.index("    # Wait for resume signal")
end = s.index("\n    done\n", start) + len("\n    done\n")
sys.stdout.write(s[start:end])
PYEOF

# VACUITY GUARD: an extraction that found nothing must FAIL, not pass.
if [ -s "$LOOP" ] && grep -q 'while \[ "$PAUSED" = "true" \]' "$LOOP"; then
    ok "extracted the real pause wait loop from run.sh"
else
    bad "extracted the real pause wait loop from run.sh" \
        "extraction was empty or did not contain the loop -- every assertion below would be vacuous"
    echo ""
    echo "  Passed: $PASS   Failed: $FAIL"
    exit 1
fi

# Build a driver around the extracted loop. Only the loop's own dependencies
# are stubbed; the loop body itself is the real source text.
make_driver() {
    local dir="$1"
    {
        echo 'set -u'
        echo 'PAUSED=true'
        echo '_PAUSE_IN_PROGRESS=1'
        printf 'loki_dir=%q\n' "$dir"
        cat "$LOOP"
        echo 'exit 0'
    } > "$TMP/drive.sh"
}

# --- RED-1: non-TTY stdin carrying BYTES must not clear the pause -----------
# stdin here is a regular file with data: exactly the inherited-stdin / heredoc
# / `< somefile` shape. Pre-fix, `read` succeeds on the first byte and deletes
# PAUSE almost immediately. Post-fix, the loop keeps waiting and `timeout` kills
# it -- so we assert on the FILE, never on the exit code. rc=124 is CORRECT.
D1="$TMP/bytes"
mkdir -p "$D1"
touch "$D1/PAUSE"
printf 'yyyyyyyy\nyyyyyyyy\n' > "$TMP/bytes.in"
make_driver "$D1"
timeout 3 bash "$TMP/drive.sh" < "$TMP/bytes.in" >/dev/null 2>&1
if [ -f "$D1/PAUSE" ]; then
    ok "stray bytes on a non-TTY stdin do NOT clear .loki/PAUSE (no false resume)"
else
    bad "stray bytes on a non-TTY stdin do NOT clear .loki/PAUSE (no false resume)" \
        "PAUSE was deleted by data nobody typed -- a blocked gate silently resumed"
fi

# --- GREEN: the PAUSE-file escape still works off a TTY ---------------------
# Someone else (dashboard, CLI, `rm .loki/PAUSE`) removes the file while the
# loop waits. It must notice and return 0. This is the escape a non-interactive
# operator actually uses, so breaking it would be worse than the bug.
D2="$TMP/fileescape"
mkdir -p "$D2"
touch "$D2/PAUSE"
make_driver "$D2"
( sleep 1; rm -f "$D2/PAUSE" ) &
_helper=$!
timeout 10 bash "$TMP/drive.sh" < /dev/null >/dev/null 2>&1
_rc=$?
wait "$_helper" 2>/dev/null || true
if [ "$_rc" -eq 0 ] && [ ! -f "$D2/PAUSE" ]; then
    ok "removing .loki/PAUSE still resumes a non-TTY run (file escape intact)"
else
    bad "removing .loki/PAUSE still resumes a non-TTY run (file escape intact)" \
        "rc=$_rc -- the documented non-interactive escape path regressed"
fi

# --- GREEN: the STOP escape still works off a TTY ---------------------------
D3="$TMP/stopescape"
mkdir -p "$D3"
touch "$D3/PAUSE"
touch "$D3/STOP"
make_driver "$D3"
# The loop returns 1 on STOP; the driver's trailing `exit 0` is unreachable
# because `return` leaves the sourced body. Assert on the consumed STOP file
# plus a non-hanging exit, which is what the caller keys on.
timeout 5 bash "$TMP/drive.sh" < /dev/null >/dev/null 2>&1
if [ ! -f "$D3/STOP" ]; then
    ok "a STOP file still stops a non-TTY run (stop escape intact)"
else
    bad "a STOP file still stops a non-TTY run (stop escape intact)" \
        "STOP was not consumed -- the run would keep waiting"
fi

# --- STRUCT: the keypress arm is GUARDED, not DELETED -----------------------
# An interactive terminal must keep its keypress resume: removing the read
# outright would fix the hang by taking away a working feature. No pty is
# available here, so this is asserted on the source.
if grep -q 'read -t 1 -n 1' "$RUN_SH"; then
    ok "the interactive keypress resume still exists (not deleted)"
else
    bad "the interactive keypress resume still exists (not deleted)" \
        "a TTY user lost the ability to resume by pressing a key"
fi
if grep -q '\[ -t 0 \] && read -t 1 -n 1' "$RUN_SH"; then
    ok "the keypress arm is gated on an interactive stdin ([ -t 0 ])"
else
    bad "the keypress arm is gated on an interactive stdin ([ -t 0 ])" \
        "off a TTY this arm either spins forever or fires on stray stdin bytes"
fi

# --- BANNER: do not advertise a keypress that cannot work -------------------
if grep -q 'keypress resume unavailable' "$RUN_SH"; then
    ok "the pause banner does not promise 'press Enter' when there is no TTY"
else
    bad "the pause banner does not promise 'press Enter' when there is no TTY" \
        "a non-interactive operator is told to do something that cannot work"
fi

# ===========================================================================
# PART 2: the Evidence Receipt is announced
# ===========================================================================
echo ""
echo "--- #209: a finished run states its Evidence Receipt ---"

# Extract the real helper and drive it against a REAL generated proof.json.
HELPER="$TMP/helper.sh"
awk '/^_loki_receipt_facts\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" > "$HELPER" 2>/dev/null || true

if [ -s "$HELPER" ] && grep -q '_loki_receipt_facts()' "$HELPER"; then
    ok "extracted the real receipt-facts helper from run.sh"
else
    bad "extracted the real receipt-facts helper from run.sh" \
        "run.sh has no _loki_receipt_facts -- the receipt is never announced"
fi

GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
PROOF_DIR="$TMP/proj/.loki"
mkdir -p "$PROOF_DIR/state"
printf '{"outcome":"complete"}\n' > "$PROOF_DIR/state/completion.json"
_gen_ok=0
if [ -f "$GEN" ]; then
    python3 "$GEN" --loki-dir "$PROOF_DIR" --loki-version 0.0.0 \
        --provider claude --session-exit-code 0 --run-id probe-run --quiet \
        >/dev/null 2>&1 || true
    [ -f "$PROOF_DIR/proofs/probe-run/proof.json" ] && _gen_ok=1
fi

# VACUITY GUARD: without a real proof.json the helper assertions below would be
# testing nothing at all, so this fails rather than quietly passing.
if [ "$_gen_ok" -eq 1 ]; then
    ok "generated a real proof.json to read (assertions below are not vacuous)"
else
    bad "generated a real proof.json to read (assertions below are not vacuous)" \
        "proof-generator.py produced no receipt -- every receipt assertion would be vacuous"
fi

if [ -s "$HELPER" ] && [ "$_gen_ok" -eq 1 ]; then
    printf 'probe-run' > "$PROOF_DIR/state/last-proof-id.txt"
    { cat "$HELPER"; printf '_loki_receipt_facts %q\n' "$PROOF_DIR"; } > "$TMP/hdrive.sh"
    _facts="$(bash "$TMP/hdrive.sh" 2>/dev/null || true)"

    _rid="$(printf '%s' "$_facts" | awk -F'\t' '{print $1}')"
    _dir="$(printf '%s' "$_facts" | awk -F'\t' '{print $2}')"
    _head="$(printf '%s' "$_facts" | awk -F'\t' '{print $3}')"

    if [ "$_rid" = "probe-run" ]; then
        ok "the helper resolves the run id from the persisted pointer"
    else
        bad "the helper resolves the run id from the persisted pointer" "got '$_rid'"
    fi
    if [ -d "$_dir" ]; then
        ok "the helper names a receipt directory that exists"
    else
        bad "the helper names a receipt directory that exists" "got '$_dir'"
    fi
    # The verdict must be the generator's DETERMINISTIC headline, never an
    # invented string and never the council's AI opinion.
    case "$_head" in
        "VERIFIED"|"VERIFIED WITH GAPS"|"NOT VERIFIED")
            ok "the verdict is the generator's deterministic headline ($_head)" ;;
        "")
            bad "the verdict is the generator's deterministic headline" \
                "empty -- the reader is reading a key the generator does not emit" ;;
        *)
            bad "the verdict is the generator's deterministic headline" \
                "got '$_head', which is not a headline this generator produces" ;;
    esac

    # NEGATIVE CONTROL 1: a STALE pointer left by a PREVIOUS run, whose proof is
    # gone, must not produce a receipt claim. The pointer is never cleared at run
    # start, so this is the real second-run-in-one-directory shape, not a
    # hypothetical -- and naming a previous run's verdict as this run's would be
    # exactly the fabrication the fix exists to avoid.
    rm -rf "$PROOF_DIR/proofs/probe-run"
    _stale="$(bash "$TMP/hdrive.sh" 2>/dev/null || true)"
    if [ -z "$_stale" ]; then
        ok "a stale pointer with no proof behind it yields no receipt claim"
    else
        bad "a stale pointer with no proof behind it yields no receipt claim" \
            "emitted '$_stale' -- a previous run's receipt would be shown as this run's"
    fi

    # NEGATIVE CONTROL 2: no pointer means no receipt, and the helper must stay
    # silent rather than name a path that is not there.
    rm -f "$PROOF_DIR/state/last-proof-id.txt"
    _neg="$(bash "$TMP/hdrive.sh" 2>/dev/null || true)"
    if [ -z "$_neg" ]; then
        ok "with no receipt written, the helper prints nothing (no invented path)"
    else
        bad "with no receipt written, the helper prints nothing (no invented path)" \
            "emitted '$_neg'"
    fi
fi

# --- The two user-facing summaries must actually USE it ---------------------
# A helper nobody calls is the half-registration failure this repo has shipped
# before, so each call site is asserted individually by name.
_durable="$(python3 - "$RUN_SH" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
try:
    start = s.index("    # ---- Durable human-readable file: .loki/COMPLETION.txt")
    end = s.index('} > "$loki_dir/COMPLETION.txt"', start)
except ValueError:
    sys.exit(0)
sys.stdout.write(s[start:end])
PYEOF
)"
if [ -n "$_durable" ]; then
    ok "extracted the COMPLETION.txt block from run.sh"
else
    bad "extracted the COMPLETION.txt block from run.sh" \
        "cannot verify the durable summary -- assertions would be vacuous"
fi

_card="$(awk '/^print_completion_card\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
if [ -n "$_card" ]; then
    ok "extracted the completion card from run.sh"
else
    bad "extracted the completion card from run.sh" \
        "cannot verify the on-screen summary -- assertions would be vacuous"
fi

# COMPLETION.txt is what a --bg / dashboard / CI user reads.
if printf '%s' "$_durable" | grep -q '_loki_receipt_facts'; then
    ok "COMPLETION.txt reads the receipt facts"
else
    bad "COMPLETION.txt reads the receipt facts" \
        "a --bg or dashboard user never learns a receipt was written"
fi
if printf '%s' "$_durable" | grep -q 'loki proof verify'; then
    ok "COMPLETION.txt names the 'loki proof verify' re-check command"
else
    bad "COMPLETION.txt names the 'loki proof verify' re-check command" \
        "the user is told a receipt exists but not how to check it"
fi
if printf '%s' "$_durable" | grep -q 'index.html'; then
    ok "COMPLETION.txt names the receipt path"
else
    bad "COMPLETION.txt names the receipt path" "the receipt location is still unstated"
fi

# The foreground TTY user -- the reader #209 names, who finishes a run without
# ever hearing of `loki proof` -- must be told on screen.
if grep -q 'Evidence Receipt for this run' "$RUN_SH"; then
    ok "a foreground run announces the Evidence Receipt on screen"
else
    bad "a foreground run announces the Evidence Receipt on screen" \
        "a TTY user finishes a run never learning the receipt exists"
fi

# ORDER (the assertion that would have caught the first version of this fix).
# A structural grep for the helper passed while the announcement was DEAD: it
# sat in print_completion_card, which renders from inside run_autonomous --
# thousands of lines before this run's receipt is generated. So the site must
# come AFTER the last generate_proof_of_run, which is the only point where the
# receipt exists and the pointer is guaranteed to name THIS run.
_last_gen="$(grep -n 'generate_proof_of_run "' "$RUN_SH" | tail -1 | cut -d: -f1)"
_announce="$(grep -n 'Evidence Receipt for this run' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -n "$_last_gen" ] && [ -n "$_announce" ]; then
    ok "located both the final proof generation and the announcement site"
    if [ "$_announce" -gt "$_last_gen" ]; then
        ok "the announcement comes AFTER the final proof generation (receipt exists)"
    else
        bad "the announcement comes AFTER the final proof generation (receipt exists)" \
            "announce at line $_announce precedes proof generation at line $_last_gen -- it would print nothing, or a STALE previous run's receipt"
    fi
else
    bad "located both the final proof generation and the announcement site" \
        "cannot check ordering -- the order assertion would be vacuous"
fi

# The card must NOT announce: it renders too early to be correct, and the
# pointer it would read survives from a previous run in the same directory.
if printf '%s' "$_card" | grep -qE '_loki_receipt_facts|loki proof verify'; then
    bad "the completion card does not announce a receipt it cannot know" \
        "the card renders before this run's proof exists, so it prints nothing or a PREVIOUS run's verdict"
else
    ok "the completion card does not announce a receipt it cannot know"
fi

# --- No fabrication: the verdict must be read, never hardcoded -------------
# An invented "VERIFIED" would be far worse than no line at all.
if printf '%s' "$_durable" | grep -qE 'echo "  Verdict: (VERIFIED|NOT VERIFIED)"'; then
    bad "the verdict is never a hardcoded literal" \
        "COMPLETION.txt prints a fixed verdict instead of the generated one"
else
    ok "the verdict is never a hardcoded literal in COMPLETION.txt"
fi
if printf '%s' "$_card" | grep -qE 'Evidence Receipt:.*\$\{?(BOLD)?\}?(VERIFIED|NOT VERIFIED)'; then
    bad "the card's verdict is never a hardcoded literal" \
        "the card prints a fixed verdict instead of the generated one"
else
    ok "the card's verdict is never a hardcoded literal"
fi

# ===========================================================================
# PART 3: the two fabrication mutants the round-1 fixtures could not see
# ===========================================================================
# The assertions above are fed ONE shape: a generator-written proof.json that
# always HAS honesty.headline, and a single proof dir. Two mutations of the
# helper therefore survived a 25/0 green run, and both fabricate:
#
#   M12  `.get('headline') or ''`  ->  `or 'VERIFIED'`
#        The `or ''` branch is never reached when every fixture has a headline,
#        so a mutant that INVENTS the strongest possible verdict is invisible.
#   M9   `[ -f "$pj" ] || return 0`  ->  newest-by-mtime fallback
#        With only one proof dir, a fallback finds nothing and stays silent by
#        accident. It needs a SECOND, newer dir to have something wrong to find.
#
# Each fixture below gets its own tree and its own driver: PROOF_DIR above is
# deliberately torn down by the stale-pointer controls.
echo ""
echo "--- fabrication guards: an absent headline, and a stale pointer with a rival receipt ---"

# Drive the extracted helper against an arbitrary .loki dir.
_drive_helper() {
    { cat "$HELPER"; printf '_loki_receipt_facts %q\n' "$1"; } > "$TMP/pdrive.sh"
    bash "$TMP/pdrive.sh" 2>/dev/null || true
}

if [ -s "$HELPER" ]; then

# --- M12: honesty exists but carries NO headline ----------------------------
# The generator always writes a headline, so this shape is hand-built. It is
# not hypothetical: an older receipt, a partial write, or a future generator
# that renames the key all produce it, and the helper's documented contract
# (run.sh:4356-4358) is an EMPTY third field so the callers omit the verdict.
H1="$TMP/nohead/.loki"
mkdir -p "$H1/proofs/run-nohead" "$H1/state"
cat > "$H1/proofs/run-nohead/proof.json" <<'JSONEOF'
{
  "run_id": "run-nohead",
  "honesty": {
    "degraded": false,
    "evidence_gate": {"status": "not_run"}
  }
}
JSONEOF
printf 'run-nohead' > "$H1/state/last-proof-id.txt"

# POSITIVE CONTROL. If this JSON does not parse, the helper's `except` arm
# prints '' and the emptiness assertion below goes green WITHOUT the mutated
# line ever executing -- the fixture would pass under base and mutant alike.
# So prove the file parses AND that honesty is a dict AND that it genuinely
# lacks the key, before trusting anything the helper says about it.
if python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
h=d.get('honesty')
assert isinstance(h,dict), 'honesty is not an object'
assert 'headline' not in h, 'fixture still has a headline key'
" "$H1/proofs/run-nohead/proof.json" 2>/dev/null; then
    ok "the no-headline fixture parses and really lacks honesty.headline (mutated line is reached)"
else
    bad "the no-headline fixture parses and really lacks honesty.headline (mutated line is reached)" \
        "malformed fixture -- the helper's except arm would print '' and the assertion below would be vacuous"
fi

_nh="$(_drive_helper "$H1")"
_nh_rid="$(printf '%s' "$_nh" | awk -F'\t' '{print $1}')"
_nh_dir="$(printf '%s' "$_nh" | awk -F'\t' '{print $2}')"
_nh_head="$(printf '%s' "$_nh" | awk -F'\t' '{print $3}')"

# The first two fields pin this as a REAL emission, not silence. Asserting only
# "third field is empty" would be satisfied by the helper printing nothing at
# all, which is a different behavior and not what is under test here.
if [ "$_nh_rid" = "run-nohead" ] && [ "$_nh_dir" = "$H1/proofs/run-nohead" ]; then
    ok "a receipt with no headline is still ANNOUNCED (id and path are emitted)"
else
    bad "a receipt with no headline is still ANNOUNCED (id and path are emitted)" \
        "got id='$_nh_rid' dir='$_nh_dir' -- the helper went silent instead of naming the receipt it can see"
fi

if [ -z "$_nh_head" ]; then
    ok "a missing honesty.headline yields an EMPTY verdict field (no verdict invented)"
else
    bad "a missing honesty.headline yields an EMPTY verdict field (no verdict invented)" \
        "emitted verdict '$_nh_head' for a receipt that states none -- the product's one claim is a verdict the user can check, and this one was manufactured"
fi

# Belt and braces: name the fabrication literals explicitly. A mutant that
# defaults to any real headline string is the whole hazard, so say so by name
# rather than relying on emptiness alone.
case "$_nh_head" in
    "VERIFIED"|"VERIFIED WITH GAPS"|"NOT VERIFIED")
        bad "an absent headline never becomes a real verdict string" \
            "fabricated '$_nh_head' from a receipt whose honesty block has no headline key" ;;
    *)
        ok "an absent headline never becomes a real verdict string" ;;
esac

# --- M9: a stale pointer must not fall back to a RIVAL receipt --------------
# Two proof dirs. The pointer names run-A, whose directory is gone; run-B is
# newer and intact. A newest-by-mtime reader emits run-B's receipt and presents
# ANOTHER run's verdict as this run's. The existing stale-pointer control above
# cannot see this: it leaves zero dirs behind, so a fallback finds nothing and
# looks correct by accident.
H2="$TMP/rival/.loki"
mkdir -p "$H2/proofs/run-A" "$H2/proofs/run-B" "$H2/state"
printf '{"run_id":"run-A","honesty":{"headline":"NOT VERIFIED"}}\n' > "$H2/proofs/run-A/proof.json"
printf '{"run_id":"run-B","honesty":{"headline":"VERIFIED"}}\n'     > "$H2/proofs/run-B/proof.json"
printf 'run-A' > "$H2/state/last-proof-id.txt"

# POSITIVE CONTROL. Prove the pointed-at run resolves BEFORE deleting it. If
# the helper could not read this tree at all, the silence asserted afterwards
# would prove nothing about the fallback.
_riv_live="$(_drive_helper "$H2")"
if [ "$(printf '%s' "$_riv_live" | awk -F'\t' '{print $1}')" = "run-A" ]; then
    ok "with both receipts present the helper follows the POINTER (reads run-A, not the newer run-B)"
else
    bad "with both receipts present the helper follows the POINTER (reads run-A, not the newer run-B)" \
        "got '$_riv_live' -- the helper is not pointer-driven, so the silence assertion below would be vacuous"
fi

# Now delete only the pointed-at receipt. run-B survives, is newer, and holds
# the most flattering verdict in the tree.
rm -rf "$H2/proofs/run-A"
touch "$H2/proofs/run-B/proof.json"

_riv="$(_drive_helper "$H2")"
if [ -z "$_riv" ]; then
    ok "a stale pointer does NOT fall back to a newer rival receipt (stays silent)"
else
    bad "a stale pointer does NOT fall back to a newer rival receipt (stays silent)" \
        "emitted '$_riv' -- another run's receipt would be presented as this run's"
fi
case "$_riv" in
    *run-B*) bad "the rival run's id and verdict never leak into this run's receipt" \
                 "run-B leaked: '$_riv'" ;;
    *)       ok "the rival run's id and verdict never leak into this run's receipt" ;;
esac

else
    bad "fabrication guards ran against the real helper" \
        "the helper extraction was empty -- PART 3 would be vacuous"
fi

# --- DOWNSTREAM: an empty verdict field must not print a verdict line -------
# The helper emitting '' is only half the guarantee. Both user-facing sites read
# that third field, so each must GUARD its verdict line on it being non-empty --
# otherwise a headline-less receipt prints "Verdict: " or, worse, a bare label a
# reader completes themselves. Asserted structurally at both call sites by name.
if printf '%s' "$_durable" | grep -q 'if \[ -n "\$_cs_headline" \]'; then
    ok "COMPLETION.txt prints its Verdict line only when a headline was actually read"
else
    bad "COMPLETION.txt prints its Verdict line only when a headline was actually read" \
        "the durable summary prints a verdict line unconditionally -- a receipt with no headline yields an empty or invented verdict"
fi
if grep -q 'if \[ -n "\$_rcpt_headline" \]' "$RUN_SH"; then
    ok "the on-screen announcement states a verdict only when a headline was actually read"
else
    bad "the on-screen announcement states a verdict only when a headline was actually read" \
        "the TTY summary prints a verdict line unconditionally -- a headline-less receipt is announced with a verdict it does not contain"
fi

# ===========================================================================
# PART 4: the four round-2 survivors
# ===========================================================================
# Every assertion below was written because a mutation of shipped code survived
# a 34/0 green run. Each one is proven to go RED against its mutation; a guard
# that cannot be driven red is decoration.

# --- HOLE 1: PAUSED.md is the surface a non-TTY operator actually reads ------
# The console banner was TTY-gated, but the durable file still said
# "Press Enter in terminal" unconditionally. For a --bg / container / CI run
# that file IS the interface -- nobody is watching the console -- so it was the
# one surface where the wrong advice did the most damage. No assertion covered
# it at all: `grep -c 'PAUSED\.md'` over this suite was 0 against 22 PAUSE hits.
#
# Executed, not grepped. A structural grep cannot see a `>`/`>>` slip in the
# heredoc split silently truncating the file, nor a dropped body line.
echo ""
echo "--- #205 (cont): the durable PAUSED.md must not promise a keypress either ---"

PMD="$TMP/pmd.sh"
python3 - "$RUN_SH" > "$PMD" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
try:
    start = s.index('    # Create resume instructions file')
    anchor = s.index('2. **Add Instructions**', start)
    end = s.index('\nEOF\n', anchor) + len('\nEOF\n')
except ValueError:
    sys.exit(0)
# `local` is illegal outside a function body; neutralise it for the driver.
print('loki_dir="$1"; local(){ :; }')
sys.stdout.write(s[start:end])
PYEOF

# VACUITY GUARD: an empty extraction must FAIL, never quietly pass.
if [ -s "$PMD" ] && grep -q 'PAUSED.md' "$PMD"; then
    ok "extracted the real PAUSED.md writer from run.sh"
else
    bad "extracted the real PAUSED.md writer from run.sh" \
        "extraction was empty -- every PAUSED.md assertion below would be vacuous"
fi

if [ -s "$PMD" ]; then
    # --- non-TTY: run it with stdin on /dev/null, which is the real --bg shape.
    PD_N="$TMP/pmd-notty/.loki"
    mkdir -p "$PD_N"
    bash "$PMD" "$PD_N" < /dev/null >/dev/null 2>&1
    _pmd_n="$(cat "$PD_N/PAUSED.md" 2>/dev/null || true)"

    if [ -n "$_pmd_n" ]; then
        ok "the non-TTY PAUSED.md was actually written (assertions below are not vacuous)"
    else
        bad "the non-TTY PAUSED.md was actually written (assertions below are not vacuous)" \
            "no file produced -- a heredoc split that writes nothing would pass every grep below"
    fi

    # THE DEFECT ITSELF. A non-interactive operator must not be told to press a
    # key that cannot be read.
    if printf '%s' "$_pmd_n" | grep -q 'Press Enter'; then
        bad "PAUSED.md does not promise 'Press Enter' when there is no TTY" \
            "the durable file a --bg operator reads still advertises a keypress that cannot arrive"
    else
        ok "PAUSED.md does not promise 'Press Enter' when there is no TTY"
    fi

    # The honest wording must match the console banner's literal, so one grep
    # spans both surfaces and a future divergence is visible.
    if printf '%s' "$_pmd_n" | grep -q 'no TTY: keypress resume unavailable'; then
        ok "the non-TTY PAUSED.md states the same reason as the console banner"
    else
        bad "the non-TTY PAUSED.md states the same reason as the console banner" \
            "the two surfaces have diverged -- one of them is now lying to the operator"
    fi

    # The working escape must still be named. Removing the false advice while
    # also dropping the true advice would leave the operator with nothing.
    if printf '%s' "$_pmd_n" | grep -q 'rm .loki/PAUSE'; then
        ok "the non-TTY PAUSED.md still names the escape that DOES work (rm .loki/PAUSE)"
    else
        bad "the non-TTY PAUSED.md still names the escape that DOES work (rm .loki/PAUSE)" \
            "the operator is left with no documented way out at all"
    fi

    # A quoted heredoc keeps backticks literal. If someone unquotes it to
    # interpolate the resume line, `rm .loki/PAUSE` and `touch .loki/STOP`
    # become command substitutions -- deleting the PAUSE file this very
    # function just wrote, and silently resuming a blocked run.
    if printf '%s' "$_pmd_n" | grep -q 'touch .loki/STOP'; then
        ok "the heredoc stayed quoted (backticked commands are literal text, not executed)"
    else
        bad "the heredoc stayed quoted (backticked commands are literal text, not executed)" \
            "the backticked commands were EXECUTED during the write -- unquoting this heredoc runs 'rm .loki/PAUSE' and deletes the pause it just set"
    fi

    # A heredoc split commonly loses a line. Name each survivor individually:
    # a count threshold cannot say WHICH one vanished.
    for _need in 'Add Instructions' 'Stop' 'CONTINUITY.md' 'STATUS.txt' '.loki/logs/'; do
        if printf '%s' "$_pmd_n" | grep -qF "$_need"; then
            ok "the split PAUSED.md still contains '$_need'"
        else
            bad "the split PAUSED.md still contains '$_need'" \
                "this line was lost when the heredoc was split -- the first write may have truncated the second"
        fi
    done

    # STRUCT: the TTY branch must still offer the keypress. Fixing the non-TTY
    # lie by deleting a working interactive feature would be a regression, and
    # there is no pty here, so this is asserted on the source.
    if grep -q "_resume_line='1\. \*\*Resume\*\*: Press Enter in terminal" "$RUN_SH"; then
        ok "the TTY branch of PAUSED.md still offers the keypress resume"
    else
        bad "the TTY branch of PAUSED.md still offers the keypress resume" \
            "an interactive user lost the documented keypress resume"
    fi

    # The resume line must be BRANCHED, not a single unconditional string.
    if printf '%s' "$(sed -n '/# Create resume instructions file/,/PAUSED.md" << .EOF./p' "$RUN_SH")" | grep -q '\[ -t 0 \]'; then
        ok "the PAUSED.md resume line is chosen by a TTY test, not printed unconditionally"
    else
        bad "the PAUSED.md resume line is chosen by a TTY test, not printed unconditionally" \
            "the file is back to one fixed resume line, so one of the two audiences is being misinformed"
    fi
fi

# --- HOLE 2 (N1): the helper must always emit exactly three fields ----------
# Mutation: the final printf emits only TWO fields when $headline is empty.
# Both callers parse with ${var#*<TAB>}, which on a two-field line silently
# yields the WRONG substring rather than an empty verdict -- so the path would
# read a directory where it expects a headline. A with-headline fixture cannot
# see this (the mutation is conditioned on an EMPTY headline), so this is
# asserted on the no-headline fixture built above.
echo ""
echo "--- N1: the receipt helper never drops a field ---"

if [ -s "$HELPER" ] && [ -d "$TMP/nohead/.loki" ]; then
    _nf_out="$(_drive_helper "$TMP/nohead/.loki")"

    # Command substitution strips the trailing newline but NOT a trailing tab,
    # so a three-field line with an empty third field still reads NF=3.
    _nf="$(printf '%s' "$_nf_out" | awk -F'\t' '{print NF}')"

    if [ -n "$_nf_out" ]; then
        ok "the no-headline fixture produced an emission to count fields on"
    else
        bad "the no-headline fixture produced an emission to count fields on" \
            "the helper printed nothing -- a field-count assertion over zero lines is vacuous"
    fi

    if [ "$_nf" = "3" ]; then
        ok "the helper emits exactly 3 tab-separated fields even with an empty headline"
    else
        bad "the helper emits exactly 3 tab-separated fields even with an empty headline" \
            "got NF=$_nf -- callers parse with \${var#*<TAB>}, so a dropped field makes them read the wrong substring"
    fi

    # Pin the count exactly: two tabs, no more and no fewer. A mutant that
    # ADDED a field would also break the callers.
    _tabs="$(printf '%s' "$_nf_out" | awk '{n=gsub(/\t/,"\t"); print n}')"
    if [ "$_tabs" = "2" ]; then
        ok "the emitted line carries exactly 2 tab separators (no field added or lost)"
    else
        bad "the emitted line carries exactly 2 tab separators (no field added or lost)" \
            "counted $_tabs tabs -- the caller's field split no longer lines up with the helper's output"
    fi
fi

# --- HOLE 3 (N3b): the verdict must never fall back to the council ----------
# Mutation: `.get('headline') or (d.get('council') or {}).get('final_verdict')`.
# This is the worst survivor in the set. council.final_verdict genuinely exists
# and is populated in real receipts, and the generator ITSELF labels it
# "AI judgment, not deterministic proof" (run.sh:4355-4358). Printing it as the
# receipt verdict is precisely the fabrication this feature exists to prevent:
# the user is shown an AI opinion in the slot reserved for a checkable fact.
#
# The existing no-headline fixture cannot catch it -- it has no council block,
# so the mutant's fallback finds nothing and stays empty by accident.
echo ""
echo "--- N3b: an AI council verdict must never be printed as the deterministic verdict ---"

if [ -s "$HELPER" ]; then
    H3="$TMP/council/.loki"
    mkdir -p "$H3/proofs/run-council" "$H3/state"
    cat > "$H3/proofs/run-council/proof.json" <<'JSONEOF'
{
  "run_id": "run-council",
  "honesty": {
    "degraded": false,
    "evidence_gate": {"status": "not_run"}
  },
  "council": {
    "final_verdict": "COUNCIL_APPROVED",
    "note": "AI judgment, not deterministic proof"
  }
}
JSONEOF
    printf 'run-council' > "$H3/state/last-proof-id.txt"

    # POSITIVE CONTROL. If this JSON did not parse, the helper's `except` arm
    # prints '' and the emptiness assertion below would go green WITHOUT the
    # mutated line ever running -- passing under base and mutant alike. Prove
    # the file parses, that honesty genuinely lacks headline, AND that the
    # council value the mutant would reach is actually populated.
    if python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
h=d.get('honesty')
assert isinstance(h,dict), 'honesty is not an object'
assert 'headline' not in h, 'fixture still has a headline key'
c=d.get('council')
assert isinstance(c,dict), 'council is not an object'
assert c.get('final_verdict'), 'council.final_verdict is empty -- the mutant would find nothing to fall back to'
" "$H3/proofs/run-council/proof.json" 2>/dev/null; then
        ok "the council fixture parses, lacks honesty.headline, and HAS a populated council.final_verdict"
    else
        bad "the council fixture parses, lacks honesty.headline, and HAS a populated council.final_verdict" \
            "malformed fixture -- the fallback would find nothing and the assertion below would be vacuous"
    fi

    _cv="$(_drive_helper "$H3")"
    _cv_rid="$(printf '%s' "$_cv" | awk -F'\t' '{print $1}')"
    _cv_head="$(printf '%s' "$_cv" | awk -F'\t' '{print $3}')"

    # Pin this as a REAL emission. "third field empty" would also be satisfied
    # by the helper printing nothing, which is a different behavior.
    if [ "$_cv_rid" = "run-council" ]; then
        ok "the council-only receipt is still ANNOUNCED (the emission is real, not silence)"
    else
        bad "the council-only receipt is still ANNOUNCED (the emission is real, not silence)" \
            "got id='$_cv_rid' -- the helper went silent, so the verdict assertion below proves nothing"
    fi

    if [ -z "$_cv_head" ]; then
        ok "a receipt with only a council verdict yields an EMPTY deterministic verdict"
    else
        bad "a receipt with only a council verdict yields an EMPTY deterministic verdict" \
            "emitted '$_cv_head' -- an AI opinion is being printed in the slot reserved for a deterministic, checkable fact"
    fi

    # Name the leak literal explicitly. Emptiness alone would not say WHAT
    # leaked, and the council value is the specific hazard here.
    case "$_cv" in
        *COUNCIL_APPROVED*)
            bad "the council's final_verdict never leaks into the receipt verdict" \
                "council value leaked into the emission: '$_cv'" ;;
        *)
            ok "the council's final_verdict never leaks into the receipt verdict" ;;
    esac
fi

# --- HOLE 4 (N2): the right text must be bound to the right branch ----------
# Mutation: swap the two log_info bodies inside `if [ -t 0 ]`. Both strings
# still exist in the file, so every "does this string appear" grep stays green
# while a TTY user is told keypress resume is unavailable and a --bg operator
# is told to press Enter -- the exact inversion of the truth.
#
# The extraction deliberately anchors on `log_header "Execution Paused"`, NOT
# on either string under test: anchoring on the strings would let the swap
# break the anchor and produce a vacuity failure instead of this assertion
# firing on the real defect.
echo ""
echo "--- N2: the pause banner binds the correct text to the correct branch ---"

_banner="$(python3 - "$RUN_SH" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
try:
    anchor = s.index('log_header "Execution Paused"')
    start = s.index('if [ -t 0 ]; then', anchor)
    end = s.index('\n    fi\n', start)
except ValueError:
    sys.exit(0)
sys.stdout.write(s[start:end])
PYEOF
)"

if [ -n "$_banner" ] && printf '%s' "$_banner" | grep -q 'else'; then
    ok "extracted the pause banner's TTY conditional (both arms present)"
else
    bad "extracted the pause banner's TTY conditional (both arms present)" \
        "extraction empty or has no else arm -- the branch-binding assertions would be vacuous"
fi

if [ -n "$_banner" ] && printf '%s' "$_banner" | grep -q 'else'; then
    _then_arm="$(printf '%s' "$_banner" | sed -n '1,/^[[:space:]]*else/p')"
    _else_arm="$(printf '%s' "$_banner" | sed -n '/^[[:space:]]*else/,$p')"

    if [ -n "$_then_arm" ] && [ -n "$_else_arm" ]; then
        ok "split the banner into its TTY and non-TTY arms"
    else
        bad "split the banner into its TTY and non-TTY arms" \
            "one arm came back empty -- the four assertions below would be vacuous"
    fi

    # POSITIVE binding: each arm carries the text that is TRUE for its audience.
    if printf '%s' "$_then_arm" | grep -q 'press Enter'; then
        ok "the TTY arm offers the keypress resume (true on an interactive terminal)"
    else
        bad "the TTY arm offers the keypress resume (true on an interactive terminal)" \
            "an interactive user is not told about the keypress that does work for them"
    fi
    if printf '%s' "$_else_arm" | grep -q 'keypress resume unavailable'; then
        ok "the non-TTY arm states the keypress is unavailable (true off a terminal)"
    else
        bad "the non-TTY arm states the keypress is unavailable (true off a terminal)" \
            "a --bg operator is not told the keypress cannot work for them"
    fi

    # CROSS-NEGATIVES: these are what actually kill the swap. Without them, a
    # mutant that moved each string into the opposite arm keeps both positives
    # green, because each string still exists somewhere in the conditional.
    if printf '%s' "$_then_arm" | grep -q 'keypress resume unavailable'; then
        bad "the TTY arm does NOT claim the keypress is unavailable" \
            "the two banner bodies are SWAPPED -- an interactive user is told their working keypress does not work"
    else
        ok "the TTY arm does NOT claim the keypress is unavailable"
    fi
    if printf '%s' "$_else_arm" | grep -q 'press Enter'; then
        bad "the non-TTY arm does NOT advertise 'press Enter'" \
            "the two banner bodies are SWAPPED -- a --bg operator is told to press a key that cannot be read"
    else
        ok "the non-TTY arm does NOT advertise 'press Enter'"
    fi
fi

# ===========================================================================
# PART 5: the round-3 survivors -- fix the METHOD, not just the cases
# ===========================================================================
# ROOT CAUSE of every survivor below: the helper was tested by EXECUTING it,
# but both CONSUMERS were tested by TEXT EXTRACTION (grepping run.sh for
# literals). Text extraction cannot see a BINDING error. Swap two variable
# assignments and every grep still matches, because both strings are still
# present in the file -- only their meanings traded places.
#
# So: drive the REAL consumer blocks with a REAL helper emission and assert on
# what they PRINT.

echo ""
echo "--- round-3: the consumer blocks are EXECUTED, not grepped ---"

# Extract each consumer's receipt sub-block from the real source.
#
# The teardown block's OUTER wrapper is `if [ -t 1 ] && ...`. Under a driver,
# stdout is a pipe, so extracting the wrapper would make the block print
# NOTHING and every negative assertion below would pass vacuously. Extract the
# INNER block only, and assert the wrapper still guards it structurally.
_extract_consumer() {
    python3 - "$RUN_SH" "$1" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
try:
    start = s.index(sys.argv[2])
    end = s.index('\n        fi\n', start) + len('\n        fi\n')
except ValueError:
    sys.exit(0)
sys.stdout.write(s[start:end])
PYEOF
}

CONS_CS="$TMP/cons_cs.sh"
CONS_TD="$TMP/cons_td.sh"
_extract_consumer '        _cs_receipt="$(_loki_receipt_facts' > "$CONS_CS"
_extract_consumer '        _rcpt="$(_loki_receipt_facts'      > "$CONS_TD"

for _pair in "COMPLETION.txt:$CONS_CS" "teardown:$CONS_TD"; do
    _nm="${_pair%%:*}"; _pf="${_pair#*:}"
    if [ -s "$_pf" ] && grep -q 'index.html' "$_pf"; then
        ok "extracted the $_nm receipt consumer block from run.sh"
    else
        bad "extracted the $_nm receipt consumer block from run.sh" \
            "extraction empty or missing index.html -- every assertion below would be vacuous"
    fi
done

# A fixture whose two fields are MUTUALLY NON-SATISFIABLE: the headline is a
# real verdict literal with no slash, the dir is an absolute path. Under the
# field swap the verdict slot holds a path and the receipt slot holds
# "VERIFIED/index.html", so each field kills the swap independently.
CFX="$TMP/consumer/.loki"
mkdir -p "$CFX/proofs/run-cons" "$CFX/state"
printf '{"run_id":"run-cons","honesty":{"headline":"VERIFIED"}}\n' > "$CFX/proofs/run-cons/proof.json"
printf 'rendered page\n' > "$CFX/proofs/run-cons/index.html"
printf 'run-cons' > "$CFX/state/last-proof-id.txt"

# Drive a consumer block with the REAL helper against a REAL .loki dir.
#   $1 = extracted consumer file, $2 = .loki dir
_drive_consumer() {
    {
        cat "$HELPER"
        printf 'loki_dir=%q\n' "$2"
        printf 'TARGET_DIR=%q\n' "${2%/.loki}"
        cat "$1"
    } > "$TMP/cdrive.sh"
    bash "$TMP/cdrive.sh" 2>/dev/null || true
}

if [ -s "$HELPER" ] && [ -s "$CONS_CS" ] && [ -s "$CONS_TD" ]; then

    _out_cs="$(_drive_consumer "$CONS_CS" "$CFX")"
    _out_td="$(_drive_consumer "$CONS_TD" "$CFX")"

    # POSITIVE CONTROL: silence would satisfy every negative assertion below.
    if [ -n "$_out_cs" ] && [ -n "$_out_td" ]; then
        ok "both consumer blocks actually printed something (assertions are not vacuous)"
    else
        bad "both consumer blocks actually printed something (assertions are not vacuous)" \
            "COMPLETION='$_out_cs' teardown='$_out_td' -- a silent block passes every negative check"
    fi

    # --- SURVIVOR 1: COMPLETION.txt field binding --------------------------
    # Parse what the block PRINTED, not what run.sh contains.
    _v_cs="$(printf '%s\n' "$_out_cs" | sed -n 's/^  Verdict: //p')"
    _r_cs="$(printf '%s\n' "$_out_cs" | sed -n 's/^  Receipt: //p')"

    case "$_v_cs" in
        "VERIFIED"|"VERIFIED WITH GAPS"|"NOT VERIFIED")
            ok "COMPLETION.txt prints a real VERDICT in the verdict slot ($_v_cs)" ;;
        */*)
            bad "COMPLETION.txt prints a real VERDICT in the verdict slot" \
                "printed a PATH ('$_v_cs') where the verdict belongs -- the dir and headline assignments are SWAPPED, which is the fabrication class #209 exists to prevent" ;;
        *)
            bad "COMPLETION.txt prints a real VERDICT in the verdict slot" \
                "printed '$_v_cs', which is not a headline this generator produces" ;;
    esac

    if [ "$_r_cs" = "$CFX/proofs/run-cons/index.html" ]; then
        ok "COMPLETION.txt prints the receipt PATH in the receipt slot"
    else
        bad "COMPLETION.txt prints the receipt PATH in the receipt slot" \
            "printed '$_r_cs', expected '$CFX/proofs/run-cons/index.html' -- a swap yields 'VERIFIED/index.html', a path that does not exist"
    fi

    # --- SURVIVOR 2: the teardown call site, same swap ----------------------
    # Different format: the headline rides on the LABEL line, so strip after
    # the colon rather than copying the COMPLETION parse.
    _v_td="$(printf '%s\n' "$_out_td" | sed -n 's/^Evidence Receipt for this run: //p')"
    _r_td="$(printf '%s\n' "$_out_td" | sed -n 's|^  \(/.*index\.html\)$|\1|p')"

    case "$_v_td" in
        "VERIFIED"|"VERIFIED WITH GAPS"|"NOT VERIFIED")
            ok "the teardown announcement prints a real VERDICT in the verdict slot ($_v_td)" ;;
        */*)
            bad "the teardown announcement prints a real VERDICT in the verdict slot" \
                "printed a PATH ('$_v_td') where the verdict belongs -- the dir and headline assignments are SWAPPED at the teardown site" ;;
        *)
            bad "the teardown announcement prints a real VERDICT in the verdict slot" \
                "printed '$_v_td', which is not a headline this generator produces" ;;
    esac

    if [ "$_r_td" = "$CFX/proofs/run-cons/index.html" ]; then
        ok "the teardown announcement prints the receipt PATH on its own line"
    else
        bad "the teardown announcement prints the receipt PATH on its own line" \
            "printed '$_r_td', expected '$CFX/proofs/run-cons/index.html'"
    fi

    # The teardown block must stay behind its TTY / background guard: machine
    # output and --bg readers stay byte-identical. Structural by necessity --
    # there is no pty here.
    #
    # Anchored on the guard line PLUS the `_rcpt=` line it wraps. run.sh holds
    # five TTY/BACKGROUND_MODE guards, so a bare match on the guard text alone
    # could stay green if THIS block's guard were deleted while another site's
    # survived. The compound anchor names the one guard under test, and is
    # asserted to appear EXACTLY once so a future duplicate cannot mask a loss.
    if python3 - "$RUN_SH" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
anchor = ('    if [ -t 1 ] && [ "${BACKGROUND_MODE:-false}" != "true" ]; then\n'
          '        _rcpt=')
sys.exit(0 if s.count(anchor) == 1 else 1)
PYEOF
    then
        ok "the teardown announcement is still gated on a TTY and non-background run"
    else
        bad "the teardown announcement is still gated on a TTY and non-background run" \
            "the on-screen block would now also fire for --bg and machine output"
    fi

    # --- SURVIVOR 5: never NAME a page that is not on disk ------------------
    # The helper gates on proof.json, but proof-generator.py writes proof.json
    # and THEN renders index.html unwrapped, so a render failure leaves the
    # data present and the page absent. Precedent: proof.ts:118 refuses a
    # pointer to an absent proof ("worse than an absent one"), and
    # `loki proof open` refuses with "Proof page not found".
    #
    # DECISION: gate only the PAGE line, not the whole helper. `loki proof
    # verify` reads proof.json, so gating the helper would suppress an id, a
    # verdict, and a re-check command that all still work. Fail closed on the
    # CLAIM, not on the data -- which is exactly what proof.ts does.
    rm -f "$CFX/proofs/run-cons/index.html"

    _noht_cs="$(_drive_consumer "$CONS_CS" "$CFX")"
    _noht_td="$(_drive_consumer "$CONS_TD" "$CFX")"

    # POSITIVE CONTROL: the receipt must still be announced, or "no index.html
    # printed" is satisfied by the block having gone silent entirely.
    if printf '%s' "$_noht_cs" | grep -q 'loki proof verify run-cons' && \
       printf '%s' "$_noht_td" | grep -q 'loki proof verify run-cons'; then
        ok "with the page absent, both sites still name the id and the working re-check command"
    else
        bad "with the page absent, both sites still name the id and the working re-check command" \
            "a missing HTML render silenced the whole receipt -- 'loki proof verify' reads proof.json and still works, so the id and re-check must survive"
    fi

    if printf '%s' "$_noht_cs" | grep -q 'index.html'; then
        bad "COMPLETION.txt does not name an index.html that is not on disk" \
            "announced a page the generator never rendered -- proof.ts:118 calls naming an absent artifact 'worse than an absent one'"
    else
        ok "COMPLETION.txt does not name an index.html that is not on disk"
    fi
    if printf '%s' "$_noht_td" | grep -q 'index.html'; then
        bad "the teardown announcement does not name an index.html that is not on disk" \
            "announced a page the generator never rendered, which 'loki proof open' itself refuses to do"
    else
        ok "the teardown announcement does not name an index.html that is not on disk"
    fi

    # ---- GAP 1: the re-check line must END at the run id -------------------
    # Substring `grep -q 'loki proof verify'` matches both base and a mutant
    # that widened the id, because the mutant output is the base output plus
    # trailing junk. Greedy-to-non-greedy at run.sh (`${v%%<TAB>*}` -> `${v%<TAB>*}`)
    # therefore survived at 79/0: the printed command became
    # `loki proof verify <id><TAB><dir><TAB><verdict>`, which cannot be pasted
    # and names fields that are not an id. Assert the EXACT id at both consumers.
    _rc_cs="$(printf '%s' "$_out_cs" | grep 'loki proof verify' | tail -1)"
    _rc_td="$(printf '%s' "$_out_td" | grep 'loki proof verify' | tail -1)"
    _rc_tab="$(printf '\t')"

    # POSITIVE CONTROL: a re-check line must exist, or the exactness checks
    # below are satisfied by there being no line at all.
    if [ -n "$_rc_cs" ] && [ -n "$_rc_td" ]; then
        ok "both consumers print a re-check command (control for the exactness checks)"
    else
        bad "both consumers print a re-check command (control for the exactness checks)" \
            "cs='$_rc_cs' td='$_rc_td' -- the exactness assertions would be vacuous"
    fi

    # Two shapes are legitimate, because the command is cwd-independent:
    #   bare    "    loki proof verify <id>"
    #   wrapped "    (cd <root> && loki proof verify <id>)"
    # Both END at the id (the wrapped form closes its subshell immediately
    # after). A widened id appends record fields and matches neither.
    case "$_rc_cs" in
        *"loki proof verify run-cons"|*"loki proof verify run-cons)")
            ok "COMPLETION.txt re-check command ends at the run id (no widened field)" ;;
        *)
            bad "COMPLETION.txt re-check command ends at the run id (no widened field)" \
                "got '$_rc_cs' -- a widened id makes the command unpastable" ;;
    esac
    case "$_rc_td" in
        *"loki proof verify run-cons"|*"loki proof verify run-cons)")
            ok "the teardown re-check command ends at the run id (no widened field)" ;;
        *)
            bad "the teardown re-check command ends at the run id (no widened field)" \
                "got '$_rc_td' -- same defect on the surface the user sees" ;;
    esac

    # A tab inside the printed command is the exact signature of a non-greedy
    # expansion absorbing adjacent record fields, and is invisible to substring.
    case "$_rc_cs$_rc_td" in
        *"$_rc_tab"*)
            bad "no re-check command carries a tab (the non-greedy signature)" \
                "a tab means the id absorbed adjacent record fields" ;;
        *)
            ok "no re-check command carries a tab (the non-greedy signature)" ;;
    esac

    # And the page line must come BACK when the render did succeed: a gate that
    # never prints the path would also pass both assertions above.
    printf 'rendered page\n' > "$CFX/proofs/run-cons/index.html"
    if printf '%s' "$(_drive_consumer "$CONS_CS" "$CFX")" | grep -q 'index.html' && \
       printf '%s' "$(_drive_consumer "$CONS_TD" "$CFX")" | grep -q 'index.html'; then
        ok "with the page present, both sites announce it again (the gate is conditional, not a deletion)"
    else
        bad "with the page present, both sites announce it again (the gate is conditional, not a deletion)" \
            "the receipt page is never named even when it exists -- the fix removed the announcement instead of gating it"
    fi
fi

# --- SURVIVOR 3: heredoc 1's body is unasserted -----------------------------
# The _need loop above covers only heredoc-2 strings, so NOTHING pins the title
# or the intro. Emptying heredoc 1's body leaves the suite 60/0 green while the
# file loses its title and its "Options:" lead-in. Asserted against the WRITTEN
# FILE, by name, individually.
echo ""
echo "--- survivor 3: PAUSED.md's first heredoc has a body too ---"

if [ -s "$PMD" ] && [ -n "${_pmd_n:-}" ]; then
    for _need1 in '# Loki Mode - Paused' 'Execution is currently paused. Options:'; do
        if printf '%s' "$_pmd_n" | grep -qF "$_need1"; then
            ok "the written PAUSED.md contains '$_need1'"
        else
            bad "the written PAUSED.md contains '$_need1'" \
                "heredoc 1's body was lost -- the file a --bg operator reads has no title or lead-in, and nothing else in this suite asserts it"
        fi
    done
else
    bad "heredoc 1's body was checked against a written PAUSED.md" \
        "no written file available -- these assertions would be vacuous"
fi

# --- SURVIVOR 4: the headline sanitizer ------------------------------------
# `.replace('\t',' ').replace('\n',' ')` survives every fixture above because
# each one carries a clean headline. The emission is ONE tab-separated line, so
# an unsanitized tab forges an extra field and an unsanitized newline forges an
# extra record -- both callers then parse garbage.
#
# The control chars must be INTERIOR. `.strip()` runs after the replaces, so a
# leading or trailing tab/newline is removed by .strip() alone and the mutation
# survives.
echo ""
echo "--- survivor 4: a headline carrying a tab and a newline is sanitized ---"

if [ -s "$HELPER" ]; then
    H4="$TMP/dirty/.loki"
    mkdir -p "$H4/proofs/run-dirty" "$H4/state"
    python3 -c "
import json, sys
json.dump({'run_id':'run-dirty','honesty':{'headline':'VER\tIFIED\nGAPS'}},
          open(sys.argv[1],'w'))
" "$H4/proofs/run-dirty/proof.json"
    printf 'run-dirty' > "$H4/state/last-proof-id.txt"

    # POSITIVE CONTROL: prove the headline really carries BOTH control chars,
    # INTERIOR (not merely leading/trailing, which .strip() alone would fix).
    # A mis-escaped fixture would make the mutated line a no-op and the
    # assertions below would pass under base and mutant alike.
    if python3 -c "
import json,sys
h=json.load(open(sys.argv[1]))['honesty']['headline']
assert '\t' in h[1:-1], 'no interior tab'
assert '\n' in h[1:-1], 'no interior newline'
assert h.strip()==h, 'control chars are at the edges -- .strip() alone would remove them'
" "$H4/proofs/run-dirty/proof.json" 2>/dev/null; then
        ok "the dirty-headline fixture carries an INTERIOR tab and newline (the sanitizer is genuinely exercised)"
    else
        bad "the dirty-headline fixture carries an INTERIOR tab and newline (the sanitizer is genuinely exercised)" \
            "fixture is mis-escaped or .strip() alone would clean it -- the sanitizer assertions would be vacuous"
    fi

    _dirty="$(_drive_helper "$H4")"

    if [ -n "$_dirty" ]; then
        ok "the dirty-headline receipt was emitted (field/line counts are not vacuous)"
    else
        bad "the dirty-headline receipt was emitted (field/line counts are not vacuous)" \
            "the helper printed nothing -- counting fields over zero lines proves nothing"
    fi

    # Exactly ONE record. An unsanitized newline splits the emission in two and
    # the caller's second line is read as a whole extra receipt.
    _dlines="$(printf '%s\n' "$_dirty" | grep -c .)"
    if [ "$_dlines" = "1" ]; then
        ok "a headline containing a newline still emits exactly ONE line"
    else
        bad "a headline containing a newline still emits exactly ONE line" \
            "emitted $_dlines lines -- an unsanitized newline forges a second receipt record"
    fi

    # Exactly THREE fields. An unsanitized tab forges a fourth, and both callers
    # parse with \${var#*<TAB>}, so the verdict slot would hold a fragment.
    _dnf="$(printf '%s' "$_dirty" | head -1 | awk -F'\t' '{print NF}')"
    if [ "$_dnf" = "3" ]; then
        ok "a headline containing a tab still parses as exactly 3 fields"
    else
        bad "a headline containing a tab still parses as exactly 3 fields" \
            "got NF=$_dnf -- an unsanitized tab forges an extra field and the callers read the wrong substring"
    fi

    # The content must survive, merely flattened: a sanitizer that DELETED the
    # headline would also satisfy both counts above.
    _dhead="$(printf '%s' "$_dirty" | head -1 | awk -F'\t' '{print $3}')"
    if [ "$_dhead" = "VER IFIED GAPS" ]; then
        ok "the control characters were replaced with spaces, preserving the headline text"
    else
        bad "the control characters were replaced with spaces, preserving the headline text" \
            "got '$_dhead', expected 'VER IFIED GAPS' -- the sanitizer dropped or mangled the verdict instead of flattening it"
    fi
fi

# ===========================================================================
# BACKLOG 43 / D7: the headline reader runs from the agent's repo. A committed
# json.py that says VERIFIED, or a sitecustomize.py loaded through an empty
# PYTHONPATH component, must not replace the receipt's own headline.
# ===========================================================================
echo ""
echo "--- D7: a json.py/sitecustomize.py in the cwd cannot forge the headline ---"

if [ -s "$HELPER" ]; then
    H5="$TMP/shadow/.loki"
    mkdir -p "$H5/proofs/run-shadow" "$H5/state"
    printf '%s\n' '{"run_id":"run-shadow","honesty":{"headline":"NOT VERIFIED"}}' > "$H5/proofs/run-shadow/proof.json"
    printf 'run-shadow' > "$H5/state/last-proof-id.txt"
    _sh_plain="$(_drive_helper "$H5" | awk -F'\t' '{print $3}')"
    cat > "$TMP/shadow/json.py" <<'EOF'
import os
open(os.environ.get("D7_MARK", os.devnull), "a").write("json.py\n")
def load(*a, **k): return {"honesty": {"headline": "VERIFIED"}}
EOF
    printf '%s\n' 'import os' 'open(os.environ.get("D7_MARK", os.devnull), "a").write("sitecustomize.py\n")' \
        > "$TMP/shadow/sitecustomize.py"
    # Control: an unguarded interpreter in this cwd and environment does load
    # both shadows, so an empty marker below is a measurement.
    (cd "$TMP/shadow" && PYTHONPATH=":/nonexistent" D7_MARK="$TMP/shadow-ctl.mark" python3 -c 'import json') >/dev/null 2>&1
    _sh_head="$(cd "$TMP/shadow" && PYTHONPATH=":/nonexistent" D7_MARK="$TMP/shadow.mark" _drive_helper "$H5" | awk -F'\t' '{print $3}')"
    if [ "$_sh_plain" != "NOT VERIFIED" ]; then
        bad "shadow control: the plain read returns the receipt's headline" "got '$_sh_plain'"
    elif ! grep -q '^sitecustomize.py$' "$TMP/shadow-ctl.mark" 2>/dev/null || ! grep -q '^json.py$' "$TMP/shadow-ctl.mark" 2>/dev/null; then
        bad "shadow control: an unguarded python3 in the fixture loads both shadows" "the marker assertions would be vacuous"
    elif [ "$_sh_head" = "NOT VERIFIED" ] && [ ! -s "$TMP/shadow.mark" ]; then
        ok "the headline comes from proof.json, not a json.py/sitecustomize.py in the cwd"
    else
        bad "the headline comes from proof.json, not a json.py/sitecustomize.py in the cwd" \
            "got '$_sh_head'; shadow modules that ran: $(tr '\n' ' ' < "$TMP/shadow.mark" 2>/dev/null)"
    fi
fi

# Same class on the completion decision: is_completed reads currentPhase from
# the agent's repo. A json.py that says COMPLETED must not end a BUILDING run.
IC_FN="$TMP/is_completed.sh"
awk '/^is_completed\(\) \{/,/^}/' "$RUN_SH" > "$IC_FN"
_ic_rc() { # <dir> -> is_completed's return code, run from <dir> with a hostile PYTHONPATH
    (cd "$1" && PYTHONPATH=":/nonexistent" D7_MARK="$TMP/ic.mark" bash -c '. "$1"; is_completed' _ "$IC_FN") >/dev/null 2>&1
    echo "$?"
}
if grep -q '^is_completed() {' "$IC_FN"; then
    for _d in ic-done ic-building ic-shadow; do mkdir -p "$TMP/$_d/.loki/state"; done
    printf '%s\n' '{"currentPhase":"COMPLETED"}' > "$TMP/ic-done/.loki/state/orchestrator.json"
    printf '%s\n' '{"currentPhase":"BUILDING"}' > "$TMP/ic-building/.loki/state/orchestrator.json"
    printf '%s\n' '{"currentPhase":"BUILDING"}' > "$TMP/ic-shadow/.loki/state/orchestrator.json"
    printf '%s\n' 'import os' 'open(os.environ.get("D7_MARK", os.devnull), "a").write("json.py\n")' \
        'def load(*a, **k): return {"currentPhase": "COMPLETED"}' > "$TMP/ic-shadow/json.py"
    printf '%s\n' 'import os' 'open(os.environ.get("D7_MARK", os.devnull), "a").write("sitecustomize.py\n")' \
        > "$TMP/ic-shadow/sitecustomize.py"
    _ic_done="$(_ic_rc "$TMP/ic-done")"; _ic_build="$(_ic_rc "$TMP/ic-building")"
    rm -f "$TMP/ic.mark"
    _ic_shadow="$(_ic_rc "$TMP/ic-shadow")"
    if [ "$_ic_done" != 0 ] || [ "$_ic_build" != 1 ]; then
        bad "is_completed control: COMPLETED reads done and BUILDING does not" "got done=$_ic_done building=$_ic_build"
    elif [ "$_ic_shadow" = 1 ] && [ ! -s "$TMP/ic.mark" ]; then
        ok "is_completed reads the repo's orchestrator.json, not a json.py/sitecustomize.py in the cwd"
    else
        bad "is_completed reads the repo's orchestrator.json, not a json.py/sitecustomize.py in the cwd" \
            "a BUILDING run returned $_ic_shadow; shadow modules that ran: $(tr '\n' ' ' < "$TMP/ic.mark" 2>/dev/null)"
    fi
else
    bad "extracted is_completed from run.sh" "the D7 completion leg would be vacuous"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
