#!/usr/bin/env bash
# Test: provider_invoke_argv -- the timeout seam.
#
# THE PROBLEM IT SOLVES
#   Eight auxiliary judge sites bypass the provider abstraction and shell out to
#   `claude --dangerously-skip-permissions -p` directly. The reason is written
#   into the source (done-recognition.sh:49, prd-enrich.sh:40):
#
#       "Calls `claude -p` directly (not provider_invoke) because `timeout`
#        needs a real command, not a shell function."
#
#   That is TRUE, and it is why the obvious fix is wrong. `timeout
#   provider_invoke ...` cannot work: timeout(1) execs a binary, and a shell
#   function is not one. Routing the judges through provider_invoke would mean
#   DROPPING their timeout -- reintroducing exactly the hang class that left 59
#   orphaned emit.sh processes alive for 21 hours (fixed in v8.1.0). Never trade
#   a hang guard for an abstraction.
#
#   MEASURED, on a stub CLI that sleeps 300s:
#       timeout 1 "${_LOKI_INVOKE_ARGV[@]}"  -> rc=124 after 1s   (BOUNDED)
#       timeout 1 provider_invoke "x"        -> rc=127 immediately (cannot exec)
#
#   So the seam is a BUILDER that prints argv into an array, which the caller
#   hands to timeout. Provider-agnostic dispatch AND a preserved timeout.
#
# Proven directions:
#   BUILDS     : each provider populates _LOKI_INVOKE_ARGV with a real argv.
#   EXECUTABLE : argv[0] is a command, not a shell function.
#   BOUNDED    : `timeout` genuinely bounds the argv form (rc=124).
#   UNBOUNDED  : `timeout` genuinely CANNOT bound the function form (rc!=124) --
#                the non-vacuity proof that this seam is necessary at all.
#   PROMPT     : the prompt survives into argv intact, including spaces.
#   TIERED     : different tiers can yield different models.
#   PARITY     : every non-degraded provider implements the seam.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS="$SCRIPT_DIR/../providers"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-argv-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== provider_invoke_argv: the timeout seam ==="

# providers/*.sh use bash indirect expansion; run everything under bash -c or
# every check fails identically under zsh and reads as a provider bug.
runb() { bash -c "$1" 2>/dev/null; }

# ---- PARITY + BUILDS -----------------------------------------------------
for p in claude codex opencode; do
    if ! grep -q 'provider_invoke_argv()' "$PROVIDERS/$p.sh" 2>/dev/null; then
        bad "$p does not implement provider_invoke_argv"
        continue
    fi
    n="$(runb ". $PROVIDERS/$p.sh >/dev/null 2>&1; provider_invoke_argv development 'hi'; printf '%s' \"\${#_LOKI_INVOKE_ARGV[@]}\"")"
    if [ "${n:-0}" -ge 3 ] 2>/dev/null; then
        ok "$p builds argv (${n} elements)"
    else
        bad "$p built '${n}' argv elements"
    fi
done

# ---- EXECUTABLE ----------------------------------------------------------
for p in claude codex opencode; do
    a0="$(runb ". $PROVIDERS/$p.sh >/dev/null 2>&1; provider_invoke_argv development 'hi'; printf '%s' \"\${_LOKI_INVOKE_ARGV[0]}\"")"
    case "$a0" in
        claude|codex|opencode) ok "$p argv[0] is a real command ($a0)" ;;
        *) bad "$p argv[0]='$a0' is not an executable name" ;;
    esac
done

# ---- PROMPT --------------------------------------------------------------
# A multi-word prompt must survive as ONE argv element, not be word-split.
got="$(runb ". $PROVIDERS/opencode.sh >/dev/null 2>&1; provider_invoke_argv development 'two words here'; printf '%s' \"\${_LOKI_INVOKE_ARGV[\${#_LOKI_INVOKE_ARGV[@]}-1]}\"")"
if [ "$got" = "two words here" ]; then
    ok "a multi-word prompt survives as a single argv element"
else
    bad "prompt was mangled to '$got'"
fi

# ---- TIERED --------------------------------------------------------------
plan="$(runb ". $PROVIDERS/opencode.sh >/dev/null 2>&1; provider_invoke_argv planning 'x'; printf '%s' \"\${_LOKI_INVOKE_ARGV[*]}\"")"
fast="$(runb ". $PROVIDERS/opencode.sh >/dev/null 2>&1; provider_invoke_argv fast 'x'; printf '%s' \"\${_LOKI_INVOKE_ARGV[*]}\"")"
if [ -n "$plan" ] && [ -n "$fast" ]; then
    ok "tier is honored in argv (planning and fast both build)"
else
    bad "tiered argv build failed (plan='$plan' fast='$fast')"
fi

# ---- BOUNDED vs UNBOUNDED: the whole point -------------------------------
# A stub CLI that hangs. The argv form must be killable by timeout; the shell
# function form must NOT be -- that asymmetry is why this seam exists.
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nsleep 300\n' > "$TMP/bin/hangcli"
chmod +x "$TMP/bin/hangcli"
cat > "$TMP/probe.sh" <<'EOF'
export PATH="$1/bin:$PATH"
provider_invoke_argv(){ _LOKI_INVOKE_ARGV=(hangcli -p "$2"); }
provider_invoke(){ hangcli -p "$1"; }
provider_invoke_argv development "x"
timeout 1 "${_LOKI_INVOKE_ARGV[@]}" >/dev/null 2>&1; echo "argv=$?"
timeout 1 provider_invoke "x" >/dev/null 2>&1; echo "func=$?"
EOF
# This probe asserts on RETURN CODES only (124 vs not-124), never on elapsed
# time, so the bound can be as short as the kill is reliable. 1s against a stub
# that sleeps 300s proves exactly what 3s proved. The outer cap stays well above
# the inner bound so a genuinely-lost bound surfaces as rc!=124, not a cap kill.
out="$(timeout 10 bash "$TMP/probe.sh" "$TMP" 2>/dev/null)"
argv_rc="$(printf '%s\n' "$out" | grep '^argv=' | cut -d= -f2)"
func_rc="$(printf '%s\n' "$out" | grep '^func=' | cut -d= -f2)"
if [ "$argv_rc" = "124" ]; then
    ok "timeout BOUNDS the argv form (rc=124, killed on schedule)"
else
    bad "argv form returned rc=$argv_rc, expected 124 -- timeout did not bound it"
fi
if [ "$func_rc" != "124" ]; then
    ok "timeout CANNOT bound a shell function (rc=$func_rc) -- seam is necessary"
else
    bad "a shell function was bounded by timeout; this seam would be unnecessary"
fi

# ---- REACHABILITY: the new arms must not be dead code ---------------------
# The judges dispatch on ${PROVIDER_NAME:-claude}. If a real alt-provider never
# sets PROVIDER_NAME it defaults to "claude", the claude arm fires, and every
# seam arm below is unreachable in the field. The bounded-ness probes force an
# unknown provider, so they CANNOT catch that. Assert it separately against the
# real loader.
reach="$(runb "cd '$SCRIPT_DIR/..' && export LOKI_PROVIDER=opencode
. providers/loader.sh >/dev/null 2>&1 || true
type load_provider >/dev/null 2>&1 && load_provider opencode >/dev/null 2>&1
type provider_invoke_argv >/dev/null 2>&1 || { echo 'noseam'; exit 0; }
case \"\${PROVIDER_NAME:-claude}\" in
  claude|codex|gemini|cline|aider) echo \"named:\${PROVIDER_NAME:-claude}\" ;;
  *) echo 'seam-default' ;;
esac")"
if [ "$reach" = "seam-default" ]; then
    ok "a real alt-provider (opencode) reaches the seam arm with the seam loaded"
else
    bad "opencode routes to '$reach' -- the seam arms would be DEAD CODE in the field"
fi

# ---- CONVERTED JUDGE SITES: the new arms must still be bounded -----------
# v8.2.0 routed the seam into the `*)` provider arm of three judges. Those arms
# only exist for providers with no named case, so an UNKNOWN provider name is
# what selects them.
#
# This does NOT grep for the word `timeout` -- a token proves nothing about
# whether the call is actually bounded. Each arm is EXECUTED against a stub CLI
# that sleeps 300s, with the site's own timeout knob set to 1s, and the WALL
# CLOCK is measured. A site that lost its timeout would take 300s (the harness
# cap kills it at 10 and the elapsed assertion fails).
#
# TIMING PRECISION IS LOAD-BEARING. The knobs are 1s, so the vacuity floor is
# sub-second and `date +%s` (whole seconds) cannot resolve it -- a correct 1s
# bound would floor-divide to elapsed=1 or even 0 and trip the vacuity branch,
# turning a passing test red. Timing is therefore in MILLISECONDS. `date +%s%3N`
# is GNU-only and yields a literal "3N" on BSD/macOS date, so this uses python3.
JUDGES="$SCRIPT_DIR/.."

now_ms() { python3 -c "import time;print(int(time.time()*1000))"; }

# All three knobs are read straight into `timeout "$secs"` at every judge site
# (grill.sh:264/278/303, council-v2.sh:459, completion-council.sh:3116+), so a
# whole-second value of 1 is honored exactly as 3 was.
JUDGE_KNOB_S=1

judge_probe_run() {
    # $1 = slot, $2 = shell snippet. Writes "<elapsed_ms>" to $TMP/elapsed.<slot>.
    # Runs in the background, so the script path MUST be per-slot: a shared
    # $TMP/judge.sh would be overwritten by whichever slot wrote last and every
    # probe would silently exercise the same arm.
    local slot="$1" body="$2" start end
    cat > "$TMP/judge.$slot.sh" <<PROBE_EOF
set -uo pipefail
export PATH="$TMP/bin:\$PATH"
export LOKI_PROVIDER=notaprovider
export PROVIDER_NAME=notaprovider
# The seam a real provider would supply, pointed at the hanging stub.
provider_invoke_argv(){ _LOKI_INVOKE_ARGV=(hangcli -p "\$2"); }
# Bound every judge knob to ${JUDGE_KNOB_S}s so a WORKING timeout returns fast.
export LOKI_GRILL_TIMEOUT=$JUDGE_KNOB_S
export LOKI_SDK_REVIEW_TIMEOUT=$JUDGE_KNOB_S
export LOKI_COUNCIL_REVIEW_TIMEOUT=$JUDGE_KNOB_S
$body
PROBE_EOF
    start=$(now_ms)
    timeout 10 bash "$TMP/judge.$slot.sh" >/dev/null 2>&1
    end=$(now_ms)
    printf '%s' "$((end - start))" > "$TMP/elapsed.$slot"
}

judge_probe_assert() {
    # $1 = slot, $2 = label. Reads the elapsed_ms recorded by judge_probe_run.
    local slot="$1" label="$2" elapsed
    if [ -n "${JUDGE_PROBE_SKIP:-}" ]; then
        printf '  SKIP: %s (no timeout/gtimeout binary on this host)\n' "$label"
        return 0
    fi
    elapsed="$(cat "$TMP/elapsed.$slot" 2>/dev/null || echo 0)"
    # Two-sided assertion, and BOTH sides matter (unchanged in kind, rescaled to
    # ms against a 1s knob):
    #   upper bound -> the timeout still fires (a lost bound would hit the 10s cap)
    #   lower bound -> the arm was actually ENTERED. Returning instantly means the
    #                  function bailed early and the stub was never launched, so an
    #                  upper-bound-only check would go green while proving nothing.
    # The ceiling is a deliberately generous 5x the 1s knob: these probes run in
    # parallel and CI machines run loaded, so a tight ceiling would be a false red.
    if [ "$elapsed" -lt 300 ]; then
        bad "$label returned in ${elapsed}ms -- the hanging stub was never reached (vacuous)"
    elif [ "$elapsed" -le 5000 ]; then
        ok "$label is bounded by its timeout (returned in ${elapsed}ms, stub sleeps 300s)"
    else
        bad "$label ran ${elapsed}ms against a ${JUDGE_KNOB_S}s timeout -- the bound was LOST"
    fi
}

# Stock macOS ships NEITHER timeout nor gtimeout. _grill_with_timeout then
# degrades to bare exec by design, so the stub would run its full 300s and
# this probe would report a false red. Skip rather than lie.
JUDGE_PROBE_SKIP=""
if ! command -v timeout >/dev/null 2>&1 && ! command -v gtimeout >/dev/null 2>&1; then
    JUDGE_PROBE_SKIP=1
fi

# The four probes are INDEPENDENT (separate processes, separate stub scripts,
# separate output dirs), so they run concurrently. Each one is dominated by
# waiting out its own ${JUDGE_KNOB_S}s timeout, which is exactly the kind of wait
# that overlaps for free. Serial cost was 4 x knob; parallel cost is ~1 x knob.
# Every assertion still executes the real arm against the real hanging stub.
if [ -z "${JUDGE_PROBE_SKIP:-}" ]; then
    # grill.sh: the *) arm of grill_invoke_provider.
    judge_probe_run grill "
. '$JUDGES/autonomy/grill.sh' >/dev/null 2>&1 || true
grill_invoke_provider 'probe prompt'
" &

    # completion-council.sh: the *) arms of council_member_review and
    # council_devils_advocate. Signatures are load-bearing here -- the LAST arg is a
    # vote_dir the function writes into, NOT an iteration number. Passing the wrong
    # shape makes the function bail before it ever reaches the provider case, and
    # the probe then "passes" in 0s without exercising anything. That is exactly the
    # vacuous-green this suite exists to prevent, so the elapsed floor below asserts
    # the stub was genuinely entered.
    # Vote dirs are per-slot: these two ran serially before and could share one
    # directory, but concurrently they would race on the files they write.
    judge_probe_run member "
mkdir -p '$TMP/votes-member'
. '$JUDGES/autonomy/completion-council.sh' >/dev/null 2>&1 || true
council_member_review 1 reviewer /dev/null '$TMP/votes-member'
" &

    judge_probe_run contrarian "
mkdir -p '$TMP/votes-contrarian'
. '$JUDGES/autonomy/completion-council.sh' >/dev/null 2>&1 || true
council_devils_advocate /dev/null '$TMP/votes-contrarian'
" &

    # council-v2.sh: the *) arm of council_v2_run_reviewer.
    judge_probe_run councilv2 "
mkdir -p '$TMP/rv'
. '$JUDGES/autonomy/council-v2.sh' >/dev/null 2>&1 || true
council_v2_run_reviewer requirements_verifier '$TMP/rv' '$TMP/rv/out.json'
" &

    wait
fi

judge_probe_assert grill     "grill.sh seam arm"
judge_probe_assert member    "completion-council.sh member-vote seam arm"
judge_probe_assert contrarian "completion-council.sh contrarian seam arm"
judge_probe_assert councilv2 "council-v2.sh reviewer seam arm"

# council-v2 additionally must never turn a seam failure into a REJECT (v8.1.0
# TRUST-3). After the timeout kill above, the verdict must be INCONCLUSIVE.
v2_verdict="$(grep -o '\"verdict\":\"[A-Z]*\"' "$TMP/rv/out.json" 2>/dev/null | head -1)"
case "$v2_verdict" in
    *INCONCLUSIVE*) ok "council-v2 seam timeout yields INCONCLUSIVE, never a fabricated REJECT" ;;
    *REJECT*)       bad "council-v2 seam timeout fabricated a REJECT ($v2_verdict)" ;;
    *)              bad "council-v2 seam produced no parseable verdict ('$v2_verdict')" ;;
esac

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
