#!/usr/bin/env bash
# `loki gates` shows what blocks, what advises, and what promoting one costs.
#
# WHY. Ona's Veto Exec ships an audit-first ladder: "Start with audit rules,
# review matches, then promote confirmed rules to block." The MIDDLE step is the
# load-bearing one -- a policy you cannot safely turn on is a policy nobody turns
# on, so before flipping a gate to blocking you get to see what it WOULD have
# blocked.
#
# We had both ends and nothing between them: gates were advisory or blocking,
# three promotion knobs already existed, and .loki/quality/gate-failure-count.json
# had counted per-gate hits the whole time. Nothing joined them, so an operator
# deciding whether to promote a gate had to guess.
#
# TEST 3 IS THE LOAD-BEARING ONE, and it is about an ABSENT measurement. A gate
# with no ledger entry must read "not measured", never "0 hits". Zero is a claim
# -- it says the gate ran and never fired -- and an operator would reasonably
# promote a gate they believe has never blocked anything. Reporting an unmeasured
# gate as 0 manufactures exactly the false green this codebase exists to prevent,
# in the surface built to help people trust gates.
#
# TEST 5 pins the other half: this command REPORTS. It must never promote a gate
# itself. A tool that silently starts blocking is the thing operators most
# reasonably fear, and it would poison the ladder it is meant to make usable.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GP="$REPO_ROOT/autonomy/lib/gate_policy.py"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the gate ladder reports mode, hits, and the promotion knob"

[ -f "$GP" ] || { echo "  FAIL: $GP missing"; exit 1; }

_mkledger() {
    local d; d="$(mktemp -d)"; mkdir -p "$d/quality"
    printf '%s\n' "$1" > "$d/quality/gate-failure-count.json"
    printf '%s' "$d"
}

# --- 1. An advisory gate names the exact variable that promotes it -----------
# "This is advisory" without the knob is a dead end; the operator still has to
# grep run.sh.
T="$(_mkledger '{"magic_debate": 4}')"
_out="$(python3 "$GP" "$T" 2>&1)"
if printf '%s' "$_out" | grep -q "LOKI_GATE_MAGIC_DEBATE_BLOCKING=true"; then
    ok "an advisory gate prints the variable that promotes it"
else
    bad "advisory gates do not say how to promote them"
fi

# --- 2. THE LADDER: hits are shown so promotion is an informed choice --------
# 4 recorded hits means promoting this gate would have blocked 4 times.
if printf '%s' "$_out" | grep -qE "magic_debate +4 hits"; then
    ok "the audit count is shown next to the gate (4 hits)"
else
    bad "the hit count is missing -- promotion is still a guess"
fi
if printf '%s' "$_out" | grep -q "would have blocked"; then
    ok "a gate with hits says promoting it WOULD HAVE BLOCKED"
else
    bad "a gate with recorded hits does not say what promotion would cost"
fi
rm -rf "$T"

# --- 3. THE GUARD: an unmeasured gate is never reported as 0 ----------------
# Zero is a claim. An operator who reads "0 hits" reasonably concludes the gate
# ran and never fired, and promotes it. With no ledger, nothing ran.
T="$(mktemp -d)"   # no quality/ dir at all
_out="$(python3 "$GP" "$T" 2>&1)"
if printf '%s' "$_out" | grep -q "not measured"; then
    ok "with no ledger, gates read 'not measured'"
else
    bad "an absent ledger is reported as a measurement"
fi
if printf '%s' "$_out" | grep -qE "[a-z_]+ +0 hits"; then
    bad "an unmeasured gate reads '0 hits' -- that is a claim the gate never fired"
else
    ok "no gate claims 0 hits when nothing was measured"
fi
# Matched on a fragment that fits ONE line: the sentence wraps in the rendered
# report, so a grep for the whole phrase fails against correct output.
if printf '%s' "$_out" | grep -q "rather than 0"; then
    ok "the report explains why counts read 'not measured'"
else
    bad "the unmeasured state is shown without explaining it"
fi
rm -rf "$T"

# --- 4. Setting the knob flips the reported mode ----------------------------
# The report must reflect the CURRENT environment, or it describes a config the
# operator is not running.
T="$(_mkledger '{"test_coverage": 2}')"
_off="$(python3 "$GP" "$T" 2>&1 | grep -E "test_coverage" | head -1)"
_on="$(LOKI_COV_ENFORCE=1 python3 "$GP" "$T" 2>&1 | grep -E "test_coverage" | head -1)"
if printf '%s' "$_off" | grep -q "ADVISORY" && printf '%s' "$_on" | grep -q "BLOCKING"; then
    ok "setting the knob flips the reported mode advisory -> blocking"
else
    bad "the report ignores the environment (off='$_off' on='$_on')"
fi
# A promoted gate must stop advertising the knob it already has set.
if printf '%s' "$_on" | grep -q "promote with"; then
    bad "an already-blocking gate still tells you to promote it"
else
    ok "a promoted gate no longer advertises its knob"
fi

# --- 5. IT NEVER PROMOTES ANYTHING ------------------------------------------
# Reporting only. A tool that silently starts blocking poisons the ladder.
_before="$(find "$T" -type f | wc -l | tr -d ' ')"
python3 "$GP" "$T" >/dev/null 2>&1
_after="$(find "$T" -type f | wc -l | tr -d ' ')"
if [ "$_before" = "$_after" ]; then
    ok "the report writes nothing (it cannot promote a gate)"
else
    bad "gate_policy wrote to the repo ($_before -> $_after files)"
fi
_src="$(cat "$GP")"
if printf '%s' "$_src" | grep -qE "os\.environ\[[^]]+\] *=|setenv|putenv"; then
    bad "gate_policy mutates the environment -- it could promote a gate"
else
    ok "gate_policy never assigns to the environment"
fi
rm -rf "$T"

# --- 6. Blocking gates are listed too, so the picture is complete -----------
# An operator asking "what blocks here" should not have to read run.sh.
T="$(_mkledger '{"code_review": 6}')"
if python3 "$GP" "$T" 2>&1 | grep -q "BLOCKING  code_review"; then
    ok "unconditionally-blocking gates appear in the same report"
else
    bad "the report only lists promotable gates -- an incomplete picture"
fi
rm -rf "$T"

# --- 7. Deterministic: no model, no network ---------------------------------
if printf '%s' "$_src" | grep -qiE "requests|urllib|http|anthropic|openai|subprocess"; then
    bad "the reporter reaches for the network or a model"
else
    ok "pure python: reads files and the environment, nothing else"
fi

# --- 8. Registered everywhere a command must be ------------------------------
# A new command needs its dispatch AND both completions AND the help list, or it
# is unreachable by tab-completion and invisible in help.
grep -q "^        gates)" "$LOKI" && ok "dispatch entry exists" || bad "no dispatch entry for 'gates'"
# Asserted in each file's REAL format, not as a bare line. My first attempt
# inserted `gates` on its own line into both, which landed INSIDE the `case`
# statements and broke them -- and the presence-only parity test still passed,
# because it greps for the token anywhere in the file. zsh wants a
# 'cmd:description' entry in _loki_commands; bash wants a word in the
# space-separated main_commands string.
grep -q "'gates:" "$REPO_ROOT/completions/_loki" \
    && ok "zsh completion lists it as cmd:description" \
    || bad "missing from the zsh _loki_commands list"
grep -q "main_commands=.* gates " "$REPO_ROOT/completions/loki.bash" \
    && ok "bash completion lists it in main_commands" \
    || bad "missing from the bash main_commands string"
# And neither file may carry a stray bare `gates` line, which is what a
# careless insertion produces and what silently broke the case statements.
if grep -q "^gates$" "$REPO_ROOT/completions/_loki" "$REPO_ROOT/completions/loki.bash"; then
    bad "a bare 'gates' line is loose in a completion file (breaks its case statement)"
else
    ok "no stray bare 'gates' line in either completion file"
fi
grep -q "failover gates github" "$LOKI" && ok "help command list includes it" || bad "missing from the help command list"

# --- 9. Syntax --------------------------------------------------------------
python3 -c "import ast;ast.parse(open('$GP').read())" 2>/dev/null \
    && ok "gate_policy.py parses" || bad "gate_policy.py has a syntax error"
bash -n "$LOKI" 2>/dev/null && ok "autonomy/loki parses" || bad "autonomy/loki has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
