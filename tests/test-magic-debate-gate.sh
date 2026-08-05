#!/usr/bin/env bash
# Gate 12 (Magic Modules debate) must actually be able to block.
#
# It could not. Three independent breakages, any one of which alone was fatal:
#
#   1. The CLI called run_debate(react_path=..., wc_path=...). Those are not
#      parameters -- the function takes component_path -- so EVERY invocation
#      raised TypeError before any debate ran.
#   2. run_debate RETURNS a dict and prints nothing; the CLI discarded the
#      return value, so even a successful debate produced no stdout.
#   3. The gate grepped stdout for '"severity": "block"', a string that only
#      ever existed inside the discarded dict.
#
# The failure was invisible because the gate captured output with `|| true` and
# then looked for a blocking severity. A crash produces no match, and no match
# was read as "nothing to block on", so a totally broken gate reported PASS on
# every iteration since v6.77.0. That is the worst shape a gate can have: it
# contributes a green result to the completion decision while judging nothing.
#
# WHAT IS TESTED HERE. The debate itself invokes a provider CLI and costs money,
# so this does NOT run a real debate. It pins the three structural facts that
# were broken, plus the fail-safe direction of the new error handling:
#
#   - run_debate's real signature accepts component_path, not react_path/wc_path
#   - the CLI prints the result, or nothing downstream can ever see a verdict
#   - a gate that cannot RUN does not report PASS
#   - an ENVIRONMENT failure (missing provider CLI) degrades rather than blocks,
#     so a machine without credentials is not wedged by an advisory gate
#   - a WIRING failure (TypeError/ImportError) is loud, because that is exactly
#     the class that hid for this long
#
# A real end-to-end debate was run by hand during the fix and returned
# "severity": "block" from a persona, which the gate matched and blocked on.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: magic modules debate gate (Gate 12)"

# --- 1. the signature the CLI must call --------------------------------------
# Asserted against the REAL function object, not a grep of the source. The bug
# was a keyword mismatch, which only an actual bind can prove.
_sig_out="$(cd "$REPO_ROOT" && python3 -c '
import inspect, sys
sys.path.insert(0, ".")
try:
    from magic.core.debate import run_debate
except Exception as exc:
    print("IMPORTFAIL %s" % exc); raise SystemExit
sig = inspect.signature(run_debate)
print("PARAMS %s" % ",".join(sig.parameters))
try:
    sig.bind(name="X", spec_path="s", component_path="c", rounds=2)
    print("BIND_OK")
except TypeError as exc:
    print("BIND_FAIL %s" % exc)
' 2>&1)"

case "$_sig_out" in
    *IMPORTFAIL*) bad "magic.core.debate does not import: $_sig_out" ;;
    *BIND_OK*)    ok  "run_debate accepts the arguments the CLI passes" ;;
    *)            bad "run_debate rejects the CLI's arguments: $_sig_out" ;;
esac

# The exact regression: these two must NOT be accepted, and the CLI must not
# pass them. Pinning both halves catches a re-introduction from either side.
# Only the PARAMS line describes run_debate's signature; matching the whole
# output would also match the BIND_FAIL message, which quotes the bad keyword.
_sig_params="$(printf '%s\n' "$_sig_out" | sed -n 's/^PARAMS //p')"
case ",$_sig_params," in
    *,react_path,*|*,wc_path,*)
        bad "run_debate's signature changed; re-check what the CLI passes" ;;
    *) ok "run_debate does not take react_path/wc_path (the TypeError source)" ;;
esac

# Scoped to the run_debate CALL, not the whole file. A file-wide grep for
# react_path= is a false positive: register_component legitimately takes a
# react_path, and flagging it reported a bug that did not exist.
_debate_call="$(awk '/^_result = run_debate\(/,/^\)/' "$LOKI")"
if [ -z "$_debate_call" ]; then
    bad "could not locate the run_debate call; this test is not checking anything"
elif printf '%s' "$_debate_call" | grep -qE "react_path=|wc_path="; then
    bad "the run_debate call still passes react_path/wc_path -- every debate raises TypeError"
else
    ok "the run_debate call no longer passes the arguments that raised TypeError"
fi

if grep -qE "component_path=" "$LOKI"; then
    ok "the CLI passes component_path, the real parameter"
else
    bad "the CLI does not pass component_path; the debate sees no code"
fi

# --- 2. the result must reach stdout -----------------------------------------
# run_debate returns a dict. A returned-but-never-printed dict is invisible to
# the gate, which reads stdout. This is the second of the three breakages.
if grep -qE "print\(json\.dumps\(_result" "$LOKI"; then
    ok "the CLI prints the debate result, so the gate can read a verdict"
else
    bad "the debate result is never printed; the gate greps stdout and sees nothing"
fi

# --- 3. a gate that cannot run must not report PASS --------------------------
# The original pipeline ended in '|| true', so a crash was indistinguishable
# from a clean debate with no blocking findings.
_gate_src="$(sed -n '/^run_magic_debate_gate()/,/^}/p' "$RUN_SH")"

# Asserted as a PROPERTY, not as one spelling. An earlier version of this test
# matched the literal '--rounds 2 2>&1 || true)' and a mutation that restored
# the swallow in a DIFFERENT form (`|| true; debate_rc=0`) sailed straight past
# it -- the test asserted on a string rather than on the behaviour, which is the
# exact failure mode the trust-core detector exists to catch.
#
# The real property: whatever form it takes, the debate's exit code must be
# captured from the debate itself AND consulted. A hardcoded success assignment
# satisfies "mentions debate_rc" while meaning the opposite, so that is excluded
# explicitly.
# Scoped to the DEBATE invocation. A blanket '|| true' grep over the whole
# function is a false positive: the preceding `magic update` call is advisory by
# design and legitimately ends in '|| true'. Only the debate's own exit status
# decides the gate verdict.
_debate_invocation="$(printf '%s\n' "$_gate_src" | sed -n '/magic debate/,/debate_rc/p')"
if [ -z "$_debate_invocation" ]; then
    bad "could not locate the debate invocation; this check is inert"
elif printf '%s\n' "$_debate_invocation" | grep -qE '\|\|[[:space:]]*true'; then
    bad "the debate invocation still swallows its exit status with '|| true'"
else
    ok "the debate call no longer swallows its exit code"
fi

if printf '%s\n' "$_gate_src" | grep -qE 'debate_rc=\$\?'; then
    ok "the gate captures the debate's real exit code"
else
    bad "the gate never reads \$? from the debate; failure is invisible"
fi

if printf '%s\n' "$_gate_src" | grep -qE 'debate_rc=0[^"]*$' \
    && ! printf '%s\n' "$_gate_src" | grep -qE '&&[[:space:]]*debate_rc=0'; then
    bad "debate_rc is hardcoded to success; the capture is decorative"
else
    ok "success is recorded only when the debate actually succeeded"
fi

if printf '%s\n' "$_gate_src" | grep -qE '\[ "\$debate_rc" -ne 0 \]'; then
    ok "the gate branches on the captured exit code"
else
    bad "the exit code is captured but never consulted"
fi

# --- 4. fail-safe DIRECTION --------------------------------------------------
# The two failure classes need opposite handling, and getting this backwards is
# a real defect in both directions:
#   environment (no provider CLI) -> degrade, or every credential-less machine
#                                    is wedged by an advisory gate
#   wiring (TypeError/Import)     -> block loudly, since nothing is being judged
case "$_gate_src" in
    *TypeError*|*ImportError*)
        ok "a wiring failure is classified separately from an environment one" ;;
    *) bad "wiring failures are not distinguished; the silent class stays silent" ;;
esac

# The environment branch must return 0 (degrade). Checked by finding the
# not-judged warning and confirming a `return 0` follows it, rather than
# asserting on the whole function shape.
_env_tail="$(printf '%s\n' "$_gate_src" | sed -n '/treating as not-judged/,/return/p')"
case "$_env_tail" in
    *"return 0"*)
        ok "an environment failure degrades (return 0), not wedges every build" ;;
    *) bad "an environment failure blocks; a machine without a provider CLI cannot build" ;;
esac

# The wiring branch must return 1.
_wire_tail="$(printf '%s\n' "$_gate_src" | sed -n '/is BROKEN/,/return/p')"
case "$_wire_tail" in
    *"return 1"*) ok "a wiring failure blocks (return 1) instead of passing silently" ;;
    *) bad "a broken debate does not block; the original defect is back" ;;
esac

# --- 4b. the blocking verdict is OPT-IN --------------------------------------
# Measured, not assumed. The gate was fail-open from v6.77.0 until the TypeError
# was fixed, so its blocking path had never run against a real project. Two real
# debates were run during the fix: on a deliberately thorough spec (explicit KB
# budgets, named device class, zero-JS server component, stated contrast ratio)
# THREE of four personas returned "block". Any single persona blocking is enough
# to fail the gate, so it approves only when four strict reviewers are
# simultaneously satisfied -- a threshold almost nothing clears.
#
# Enabling that would replace a gate that never blocked with one that blocks
# nearly every build. The finding is surfaced; enforcement waits on tuning.
case "$_gate_src" in
    *LOKI_GATE_MAGIC_DEBATE_BLOCKING*)
        ok "the blocking verdict is opt-in, not on by default" ;;
    *) bad "a never-exercised gate blocks by default; 3-of-4 personas block a good spec" ;;
esac

# Default MUST be advisory. A default of 'true' here would ship the regression.
if printf '%s\n' "$_gate_src" | grep -qE 'LOKI_GATE_MAGIC_DEBATE_BLOCKING:-false'; then
    ok "the enforcement default is false (advisory)"
else
    bad "enforcement does not default to false; this blocks real builds"
fi

# Advisory must still SURFACE the finding. A gate that silently passes is the
# defect being fixed, just with a different mechanism.
case "$_gate_src" in
    *"advisory; set LOKI_GATE_MAGIC_DEBATE_BLOCKING=true"*)
        ok "the advisory path still reports the blocking finding" ;;
    *) bad "the advisory path hides the finding, recreating the silent-pass bug" ;;
esac

# --- 5. the blocking verdict still parses ------------------------------------
# The severity regex is the thing that turns a debate into a gate decision.
case "$_gate_src" in
    *'"severity"'*'"block"'*)
        ok "the gate still parses a blocking severity" ;;
    *) bad "the gate no longer looks for a blocking severity" ;;
esac

# Proven against REAL debate output captured during the fix: a persona emitted
# this shape and the gate matched it. Keeping the fixture pins the contract
# between what the debate emits and what the gate greps -- they drifted apart
# once already and nothing noticed.
_real_fixture='{"severity": "block", "issues": ["..."], "approves": false}'
if printf '%s' "$_real_fixture" | grep -qi '"severity"[[:space:]]*:[[:space:]]*"block"'; then
    ok "the gate regex matches real debate output"
else
    bad "the gate regex does NOT match real debate output; it can never block"
fi

# A non-blocking severity must not trip it.
if printf '%s' '{"severity": "suggestion", "approves": true}' \
    | grep -qi '"severity"[[:space:]]*:[[:space:]]*"block"'; then
    bad "the gate blocks on a non-blocking severity"
else
    ok "an advisory severity does not block"
fi

# --- 6. WIRING ---------------------------------------------------------------
# Everything above proves the gate function behaves. None of it proves the
# runner still CALLS it -- the gap found in eight subsystems here.
if grep -qE 'if run_magic_debate_gate; then' "$RUN_SH"; then
    ok "WIRING: the iteration loop still consults the gate"
else
    bad "WIRING: nothing calls run_magic_debate_gate; Gate 12 is dead"
fi

if grep -qE 'gate_failures="\$\{gate_failures\}magic_debate,"' "$RUN_SH"; then
    ok "WIRING: a blocking debate feeds gate_failures"
else
    bad "WIRING: the gate's verdict never reaches gate_failures, so nothing acts on it"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
