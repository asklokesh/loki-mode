#!/usr/bin/env bash
# test-doctor-ux.sh -- C1 + C3 doctor UX regression tests.
#
# C1: when a provider CLI is missing, `loki doctor` must print the EXACT
#     install command for that provider (not just "not found").
# C3: no misleading "(instant)" timing label may remain in the doctor/CLI
#     surface, and slow network probes must be bounded (have curl timeouts).
#
# Non-vacuity: each assertion greps REAL captured `loki doctor` output (run via
# bash autonomy/loki against this repo). If the doctor output were empty or the
# feature regressed, the install-command and timeout assertions below would FAIL
# rather than silently pass. The negative "(instant)" check is paired with a
# positive check that the corrected "(a few seconds)" label is present, so a
# truncated/empty doctor run cannot make the negative check vacuously pass.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

pass=0
fail=0

ok()   { echo "  PASS  $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail + 1)); }

echo "test-doctor-ux: C1 + C3 doctor UX"
echo ""

# --- Setup: a PATH with NO provider CLIs, so doctor sees them all missing. ----
# We build a sandbox bin dir containing only the basic tools doctor needs
# (so the AI Providers section reports every provider as missing) and run
# doctor against it. This deterministically exercises the C1 missing-provider
# path regardless of what is installed on the host.
SANDBOX_BIN="$(mktemp -d)/bin"
mkdir -p "$SANDBOX_BIN"
for t in bash sh env node python3 jq git curl df awk sed tr head tail cut grep \
         readlink dirname uname cat printf docker npm pip; do
    src="$(command -v "$t" 2>/dev/null || true)"
    [ -n "$src" ] && ln -sf "$src" "$SANDBOX_BIN/$t"
done

# Capture stdout and stderr SEPARATELY. The per-provider "Install:" hints must
# go to STDERR (fd 2) so the parity-captured STDOUT stays byte-identical to the
# Bun route (which emits no per-provider Install line). Merging the two streams
# would make the fd-routing assertions below vacuous, so we keep them split.
DOCTOR_STDOUT_F="$(mktemp)"
DOCTOR_STDERR_F="$(mktemp)"
PATH="$SANDBOX_BIN" bash "$LOKI" doctor >"$DOCTOR_STDOUT_F" 2>"$DOCTOR_STDERR_F" || true
DOCTOR_STDOUT="$(cat "$DOCTOR_STDOUT_F")"
DOCTOR_STDERR="$(cat "$DOCTOR_STDERR_F")"
DOCTOR_OUT="$DOCTOR_STDOUT
$DOCTOR_STDERR"

# Non-vacuity guard: the combined capture must be substantial doctor output.
if [ "$(printf '%s' "$DOCTOR_OUT" | wc -l)" -lt 10 ]; then
    bad "doctor produced <10 lines of output (capture failed; assertions would be vacuous)"
    echo "$DOCTOR_OUT"
    echo ""
    echo "Summary: $pass passed, $fail failed"
    exit 1
fi
ok "doctor produced substantial output ($(printf '%s' "$DOCTOR_OUT" | wc -l | tr -d ' ') lines)"

# --- C1: missing provider prints the EXACT install command on STDERR. ---------
# The hint must appear on stderr (so the user sees it) AND must NOT leak to
# stdout (so bash/Bun parity holds -- the Bun route emits no per-provider line).
for entry in \
    "Claude|Install: npm install -g @anthropic-ai/claude-code" \
    "Codex|Install: npm install -g @openai/codex" \
    "Cline|Install: npm install -g cline" \
    "Aider|Install: pip install aider-chat"; do
    _name="${entry%%|*}"
    _hint="${entry#*|}"
    if printf '%s' "$DOCTOR_STDERR" | grep -q "$_hint"; then
        ok "C1: missing $_name CLI prints exact install command on stderr"
    else
        bad "C1: missing $_name CLI did NOT print '$_hint' on stderr"
    fi
done

# --- C1-parity: per-provider Install hints must NOT be on stdout. -------------
# stdout may carry AT MOST one "Install:" line: the shared "No AI provider CLI
# installed" claude-code line, which the Bun route also prints (parity by
# construction). Any more means a per-provider hint leaked back to stdout and
# the parity matrix would break on a host missing a provider.
_stdout_install_count="$(printf '%s' "$DOCTOR_STDOUT" | grep -c "Install:")"
if [ "$_stdout_install_count" -le 1 ]; then
    ok "C1-parity: stdout has <=1 Install line (count=$_stdout_install_count; matches Bun route)"
else
    bad "C1-parity: stdout has $_stdout_install_count Install lines (expected <=1; per-provider hints must be on stderr)"
    printf '%s\n' "$DOCTOR_STDOUT" | grep "Install:"
fi

# Per-provider parity guard: the codex/cline/aider hints (which the shared
# stdout line never contains) must be entirely absent from stdout.
for _ph in "Install: npm install -g @openai/codex" \
           "Install: npm install -g cline" \
           "Install: pip install aider-chat"; do
    if printf '%s' "$DOCTOR_STDOUT" | grep -q "$_ph"; then
        bad "C1-parity: per-provider hint leaked to stdout: $_ph"
    else
        ok "C1-parity: per-provider hint absent from stdout: $_ph"
    fi
done

rm -f "$DOCTOR_STDOUT_F" "$DOCTOR_STDERR_F" 2>/dev/null || true

# --- C3: no "(instant)" mislabel remains anywhere in autonomy/loki. -----------
if grep -q "(instant)" "$LOKI"; then
    bad "C3: '(instant)' mislabel still present in autonomy/loki"
    grep -n "(instant)" "$LOKI"
else
    ok "C3: no '(instant)' mislabel in autonomy/loki"
fi

# Positive pairing so the negative check above cannot be vacuous: the corrected
# timing label must be present.
if grep -q "a few seconds" "$LOKI"; then
    ok "C3: corrected '(a few seconds)' timing label present"
else
    bad "C3: corrected '(a few seconds)' timing label missing (negative check may be vacuous)"
fi

# --- C3: slow network probes are bounded (have curl timeouts). ----------------
# The ChromaDB and MiroFish heartbeat probes must carry --connect-timeout and
# --max-time so a dead host fails fast instead of hanging on curl defaults.
if grep -q "api/v2/heartbeat" "$LOKI" && \
   grep -E "curl -sf --connect-timeout [0-9]+ --max-time [0-9]+ http://localhost:8100/api/v2/heartbeat" "$LOKI" >/dev/null; then
    ok "C3: ChromaDB probe is bounded with connect/max timeouts"
else
    bad "C3: ChromaDB network probe is NOT bounded with curl timeouts"
fi

if grep -E 'curl -sf --connect-timeout [0-9]+ --max-time [0-9]+ "\$_mf_url/health"' "$LOKI" >/dev/null; then
    ok "C3: MiroFish probe is bounded with connect/max timeouts"
else
    bad "C3: MiroFish network probe is NOT bounded with curl timeouts"
fi

# --- Cleanup ------------------------------------------------------------------
rm -rf "$(dirname "$SANDBOX_BIN")" 2>/dev/null || true

echo ""
echo "Summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
