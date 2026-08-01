#!/usr/bin/env bash
# The receipt a human reads must show which gates were switched off.
#
# v8.17.0 taught the proof to RECORD disabled_phases. Nothing rendered it, so
# the Evidence Receipt -- the artifact that goes on a pull request and is the
# whole point of the proof pipeline -- still could not distinguish a fully
# verified run from one with code review and security disabled.
#
# That is the same half-shipped shape this project has now hit five times: the
# data lands on one surface and the surface a person actually reads keeps the
# old behaviour. A recorded fact nobody can see does not make a receipt honest.
#
# THE PROPERTY: an ordinary run renders NO such row. A permanent "all gates ran"
# line on every receipt is noise, and noise in a trust artifact trains readers to
# skim past exactly the line that matters on the one run where it appears.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROOF_PR="$REPO_ROOT/autonomy/lib/proof-pr.sh"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: the receipt shows disabled gates"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-rcpt-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# $1 = output path, remaining args = disabled phase names (may be none)
mk_proof() {
    local out="$1"; shift
    python3 - "$out" "$@" <<'PY'
import json, sys
out, disabled = sys.argv[1], sys.argv[2:]
proof = {
    "run_id": "r1",
    "meta": {"run_id": "r1"},
    "facts": {"files_changed": 2},
    "honesty": {"headline": "VERIFIED", "degraded": []},
    "quality_gates": {"passed": 3, "total": 3},
}
if disabled:
    proof["quality_gates"]["disabled_phases"] = disabled
with open(out, "w", encoding="utf-8") as handle:
    json.dump(proof, handle)
PY
}

render() {
    bash -c "source '$PROOF_PR' 2>/dev/null; render_evidence_receipt_md '$1'" 2>/dev/null
}

# --- 1. a run with gates off says so -----------------------------------------
mk_proof "$SCRATCH/off.json" code_review security
out="$(render "$SCRATCH/off.json")"
if [[ "$out" == *"Gates disabled"* ]]; then
    ok "a run with gates disabled renders the row"
else
    ko "a run with gates disabled renders the row" \
       "the receipt cannot distinguish this from a fully verified run"
fi
[[ "$out" == *"code_review"* && "$out" == *"security"* ]] \
    && ok "every disabled gate is named, not just counted" \
    || ko "every disabled gate is named, not just counted" "got: $(grep -i 'gates disabled' <<<"$out")"

# --- 2. THE PROPERTY. An ordinary run renders nothing. -----------------------
mk_proof "$SCRATCH/clean.json"
clean="$(render "$SCRATCH/clean.json")"
if [[ "$clean" == *"Gates disabled"* ]]; then
    ko "an ordinary run renders NO gates-disabled row" \
       "a permanent row is noise, and noise gets skimmed past on the run that matters"
else
    ok "an ordinary run renders NO gates-disabled row"
fi

# The receipt must still render normally -- the addition must not break it.
[[ "$clean" == *"Evidence Receipt"* ]] \
    && ok "an ordinary receipt still renders in full" \
    || ko "an ordinary receipt still renders in full"

# --- 3. a proof predating the field must not break -----------------------
# Older proofs have no quality_gates.disabled_phases at all.
python3 -c "
import json
json.dump({'run_id':'r0','meta':{'run_id':'r0'},'facts':{},
           'honesty':{'headline':'VERIFIED','degraded':[]}},
          open('$SCRATCH/old.json','w'))"
old="$(render "$SCRATCH/old.json")"
[[ "$old" == *"Evidence Receipt"* && "$old" != *"Gates disabled"* ]] \
    && ok "a proof predating the field renders without the row and without error" \
    || ko "a proof predating the field renders cleanly" "got: $(head -3 <<<"$old")"

# --- 4. a malformed value must not break the receipt ------------------------
# quality_gates.disabled_phases arriving as a string or null must degrade, not
# crash: a receipt that fails to render is worse than one missing a row.
python3 -c "
import json
json.dump({'run_id':'r2','meta':{'run_id':'r2'},'facts':{},
           'honesty':{'headline':'VERIFIED','degraded':[]},
           'quality_gates':{'disabled_phases':'not-a-list'}},
          open('$SCRATCH/bad.json','w'))"
bad="$(render "$SCRATCH/bad.json")"
[[ "$bad" == *"Evidence Receipt"* ]] \
    && ok "a malformed disabled_phases value does not break the receipt" \
    || ko "a malformed disabled_phases value does not break the receipt"

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
