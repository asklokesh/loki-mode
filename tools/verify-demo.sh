#!/usr/bin/env bash
#
# Zero-cost demonstration of the verification chain, on receipts it builds
# itself. The point a prospective user cannot otherwise see without paying for
# a full build: this system re-checks its own output, and says so honestly when
# a receipt does not hold up.
#
#   tools/verify-demo.sh [--keep]
#
# WHAT MAKES THIS HONEST, AND WHY IT IS BUILT THIS WAY.
#
# Every verdict below is printed by the REAL tool, verbatim. Nothing here
# echoes a "VERIFIED" of its own. A demo that printed its own verdicts would
# keep printing them after the verifier broke -- it would be a claim about the
# product rather than an exercise of it, which is the same defect the tools it
# demonstrates exist to prevent. So each step runs the actual script, shows the
# actual output, and asserts the actual exit code. If the chain regresses, this
# fails; that is deliberate, and makes it a smoke test as well as a demo.
#
# The receipts are SYNTHETIC. A scratch git repo with one commit and one
# uncommitted edit is created in a tempdir, and the real proof generator is run
# over it. Synthetic means no build ran, no provider was contacted and no money
# was spent -- it does NOT mean the receipt is fake. It is a genuine receipt
# about a trivially small piece of real work, which is exactly what lets the
# real verifier reach a real VERIFIED instead of a hedge.
#
# The scratch repo is a fresh mktemp -d. Nothing is written inside the user's
# own .loki, and the demo never touches global git config.

set -uo pipefail

KEEP=0
for arg in "$@"; do
    case "$arg" in
        --keep) KEEP=1 ;;
        -h|--help) sed -n '2,28p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
        *) echo "verify-demo: unknown argument: $arg" >&2; exit 64 ;;
    esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

GENERATOR="$ROOT/autonomy/lib/proof-generator.py"
ATTEST="$HERE/receipt-attest.py"
GATE="$HERE/ci-gate.py"

# Requirement: name the missing tool and stop. A demo that skipped a step and
# still reported success would be asserting a capability it never exercised.
missing=0
for tool in "$GENERATOR" "$ATTEST" "$GATE"; do
    if [ ! -f "$tool" ]; then
        echo "verify-demo: required tool missing: $tool" >&2
        missing=1
    fi
done
if ! command -v git >/dev/null 2>&1; then
    echo "verify-demo: required tool missing: git" >&2
    missing=1
fi
if [ "$missing" -ne 0 ]; then
    echo "verify-demo: cannot demonstrate the verification chain with a tool absent" >&2
    exit 1
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-verify-demo-XXXXXX")"

cleanup() {
    if [ "$KEEP" -eq 1 ]; then
        echo ""
        echo "scratch kept at: $SCRATCH"
    else
        rm -rf "$SCRATCH"
    fi
}
trap cleanup EXIT

rule() { printf '%s\n' "------------------------------------------------------------"; }

step_failed() {
    echo ""
    echo "verify-demo: FAILED -- $1" >&2
    echo "verify-demo: the verification chain did not behave as this demo claims." >&2
    exit 1
}

cat <<BANNER
============================================================
 Loki Mode -- verification chain demo
============================================================

 THESE RECEIPTS ARE SYNTHETIC.

 No build was run. No provider was contacted. No money was
 spent. This creates a scratch git repository, generates a
 real receipt over it with the real generator, and then runs
 the real verification tools against that receipt.

 Every verdict below is printed by the tool named above it.
 Nothing in this script prints a verdict of its own.

 scratch workspace: $SCRATCH
BANNER

# ---------------------------------------------------------------------------
# Build the synthetic workspace: a real repo, a real commit, a real edit.
# Small, but genuinely present on disk, which is what the verifier re-derives
# the receipt's git facts from.
# ---------------------------------------------------------------------------
cd "$SCRATCH" || step_failed "could not enter the scratch workspace"

git init -q . 2>/dev/null || step_failed "could not create the scratch git repository"
# Repo-local only. The user's global git identity is never touched.
git config user.name "loki-verify-demo" || step_failed "could not set scratch git identity"
git config user.email "verify-demo@loki.invalid" || step_failed "could not set scratch git identity"

printf 'print("hello")\n' > app.py
git add app.py || step_failed "could not stage the scratch file"
git commit -qm "synthetic baseline" || step_failed "could not commit the scratch baseline"
printf 'print("goodbye")\n' >> app.py

mkdir -p .loki/proofs

echo ""
rule
echo "STEP 1 of 3 -- generate a receipt over the synthetic workspace"
echo "  \$ autonomy/lib/proof-generator.py --out-dir .loki/proofs/good"
rule
if ! python3 "$GENERATOR" --loki-dir .loki --out-dir .loki/proofs/good \
        --provider claude --quiet; then
    step_failed "the real proof generator did not produce a receipt"
fi
GOOD="$SCRATCH/.loki/proofs/good/proof.json"
[ -f "$GOOD" ] || step_failed "the generator reported success but wrote no proof.json"
echo "wrote $(basename "$GOOD") ($(wc -c < "$GOOD" | tr -d ' ') bytes)"

# ---------------------------------------------------------------------------
# 2. The honest receipt verifies.
# ---------------------------------------------------------------------------
echo ""
rule
echo "STEP 2 of 3 -- verify the untouched receipt"
echo "  \$ tools/receipt-attest.py .loki/proofs/good/proof.json"
rule
python3 "$ATTEST" "$GOOD"
good_exit=$?
if [ "$good_exit" -ne 0 ]; then
    step_failed "an untouched receipt did not attest cleanly (exit $good_exit, expected 0)"
fi
echo ""
echo "  -> exit 0. Every scored axis was checked here, and passed."

# ---------------------------------------------------------------------------
# 3. Tamper with a recorded FACT, not the formatting. The integrity hash is
#    taken over canonicalized bytes, so re-indenting alone proves nothing;
#    changing a claim the receipt makes is the case worth showing.
# ---------------------------------------------------------------------------
mkdir -p "$SCRATCH/.loki/proofs/tampered"
python3 - "$GOOD" "$SCRATCH/.loki/proofs/tampered/proof.json" <<'PY' || step_failed "could not write the tampered receipt"
import json, sys
src, dst = sys.argv[1], sys.argv[2]
proof = json.loads(open(src).read())
# Inflate the recorded file count: the receipt now claims more work than the
# repository contains. This is the realistic forgery, and it is a value inside
# the hashed body rather than a formatting change.
proof["facts"]["git"]["diff"]["count"] = 999
open(dst, "w").write(json.dumps(proof, indent=2))
PY

echo ""
rule
echo "STEP 3 of 3 -- tamper with the receipt, then re-verify"
echo "  edited facts.git.diff.count: 1 -> 999 (claims work that is not there)"
echo "  \$ tools/receipt-attest.py .loki/proofs/tampered/proof.json"
rule
python3 "$ATTEST" "$SCRATCH/.loki/proofs/tampered/proof.json"
bad_exit=$?
if [ "$bad_exit" -eq 0 ]; then
    step_failed "a tampered receipt attested as clean (exit 0) -- the verifier did not catch it"
fi
echo ""
echo "  -> exit $bad_exit. Caught, with the reason printed above."

# ---------------------------------------------------------------------------
# 4. The gate refuses. A verdict a human reads is not a gate; an exit code CI
#    branches on is. Only the tampered receipt is left in place.
# ---------------------------------------------------------------------------
# Moved aside rather than deleted: the gate must see ONLY the tampered receipt
# (it attests the newest one under .loki/proofs/*), while --keep still leaves
# the good receipt on disk for anyone -- or any test -- wanting to re-hash it
# and confirm the digest printed above came from these exact bytes.
mkdir -p "$SCRATCH/generated"
mv "$SCRATCH/.loki/proofs/good/proof.json" "$SCRATCH/generated/proof.json" \
    || step_failed "could not set aside the good receipt"
rm -rf "$SCRATCH/.loki/proofs/good"

echo ""
rule
echo "AND THE GATE REFUSES TO PASS"
echo "  with only the tampered receipt present:"
echo "  \$ tools/ci-gate.py . --require-receipt"
rule
python3 "$GATE" "$SCRATCH" --require-receipt
gate_exit=$?
if [ "$gate_exit" -eq 0 ]; then
    step_failed "the CI gate passed (exit 0) on a tampered receipt"
fi
echo ""
echo "  -> exit $gate_exit. A CI job branching on this exit code stops here."

cat <<'SUMMARY'

============================================================
 Every verdict above was printed by the real tool, over
 receipts generated on this machine seconds ago.

 Reminder: SYNTHETIC receipts. No build ran, no provider was
 contacted, no money was spent. This demonstrates the
 verification chain; it does not certify any real work.
============================================================
SUMMARY

exit 0
