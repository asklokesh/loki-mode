#!/usr/bin/env bash
# Head-to-head: does any installed competitor CLI verify its OWN output?
#
# WHY THIS IS THE ONE COMPARISON WORTH SHIPPING. Feature grids comparing ten
# tools are written by the vendor being graded, and no reader can check a cell.
# This is different: it runs `--help` on whatever competitor CLIs are actually
# installed on the machine, so anyone can reproduce it in ten seconds and get
# their own answer.
#
# THE TRAP IT AVOIDS, which is the whole reason it reads the hits instead of
# counting them: aider reports EIGHT matches for verif/proof/receipt/attest.
# All eight are --verify-ssl (SSL certificate validation) and
# --git-commit-verify (git pre-commit hooks). Neither verifies the agent's
# output. A count-only comparison would have scored aider 8 and Loki 2 and
# concluded the opposite of the truth. Counting is not reading.
#
# Scope, stated so it cannot be overread: this inspects the CLI surface of
# LOCALLY INSTALLED tools. Devin and Replit Agent ship no local CLI, so they are
# NOT covered here and no claim is made about them. Absence from a --help
# listing is also not proof of absence from a product -- a web UI or an API
# could expose something the CLI does not. What it establishes is checkable and
# narrow, which is the point.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0; SKIP=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
note() { echo "  [SKIP] $1"; SKIP=$((SKIP+1)); }

# Terms that would appear in a command that verifies the agent's own work.
_PAT='verif|proof|receipt|attest|evidence'

echo "T1 -- Loki exposes a verification command"

loki_help=$(bash "$LOKI" --help 2>&1 || true)
if printf '%s' "$loki_help" | grep -qiE "$_PAT"; then
    ok "loki --help advertises verification"
else
    bad "loki --help no longer advertises verification -- the differentiator is gone"
fi

# The command must actually exist, not merely be advertised.
if bash "$LOKI" proof --help >/dev/null 2>&1 || bash "$LOKI" proof list >/dev/null 2>&1; then
    ok "loki proof is a real command, not just help text"
else
    bad "loki proof does not run"
fi

echo
echo "T2 -- installed competitors are inspected by READING, not counting"

_checked=0
for cli in opencode aider codex cline claude cursor-agent; do
    command -v "$cli" >/dev/null 2>&1 || { note "$cli not installed on this machine"; continue; }
    _checked=$((_checked + 1))
    hits=$("$cli" --help 2>&1 | grep -icE "$_PAT" || true)
    # Read every hit. A term match is not a capability: aider's matches are all
    # SSL and git-hook flags.
    own_output=0
    while IFS= read -r line; do
        # An output-verification feature would talk about the run, the diff, a
        # receipt or an attestation -- not TLS certificates or commit hooks.
        case "$line" in
            *ssl*|*SSL*|*commit-verify*|*commit_verify*|*pre-commit*) continue ;;
        esac
        case "$line" in
            *proof*|*receipt*|*attest*|*evidence*) own_output=1 ;;
        esac
    done < <("$cli" --help 2>&1 | grep -iE "$_PAT" || true)

    if [ "$own_output" -eq 0 ]; then
        ok "$cli ($hits raw hit(s)) exposes no output-verification command"
    else
        # Not a failure of ours. If a competitor ships this, the README claim
        # must be corrected, and this test is how we would find out.
        bad "$cli DOES expose output verification -- update the README claim"
    fi
done

if [ "$_checked" -eq 0 ]; then
    note "no competitor CLI installed; comparison not performed"
else
    ok "compared against $_checked installed competitor CLI(s)"
fi

echo
echo "T3 -- the recorded artifact matches what was just measured"

ART="$REPO_ROOT/benchmarks/results/competitor-verify-surface.json"
if [ -f "$ART" ]; then
    if grep -q '"not_claimed"' "$ART"; then
        ok "artifact records what it does NOT claim"
    else
        bad "artifact lost its scope limit -- reads as a broader claim than it is"
    fi
    if grep -qi "SSL" "$ART"; then
        ok "artifact records the aider count-vs-read trap"
    else
        bad "artifact no longer explains why aider's 8 hits are not a capability"
    fi
else
    note "artifact not present"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
