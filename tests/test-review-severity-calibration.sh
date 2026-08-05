#!/usr/bin/env bash

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$ROOT/autonomy/run.sh"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }

if grep -q 'Missing an exact-copy, styling, placeholder, or implementation-detail assertion is not Critical or High by itself' "$RUN_SH" \
   && grep -q 'Prefer behavior and requirement tests over brittle content snapshots' "$RUN_SH"; then
    ok "reviewers cannot block normal UI refinement for missing copy snapshots"
else
    bad "behavior-first test severity calibration is missing"
fi

if grep -q 'unsupported factual or commercial claims in user-facing output' "$RUN_SH" \
   && grep -q 'Unsupported factual, customer, pricing, performance, availability, legal, or integration claims' "$RUN_SH"; then
    ok "unsupported commercial claims remain blocking"
else
    bad "truthfulness review contract is missing"
fi

if grep -q 'A partial diff cannot prove unchanged code is absent' "$RUN_SH" \
   && grep -q 'do not claim they will fail unless you cite a reproduced failing command and output' "$RUN_SH"; then
    ok "reviewers must ground absence and predicted-failure claims in current evidence"
else
    bad "review evidence-grounding contract is missing"
fi

if grep -q 'Unrequested behavior such as resetting a form, disabling a button, or preserving a message is not a requirement' "$RUN_SH" \
   && grep -q 'An ordinary missing test is Medium or Low unless it is tied to a cited changed high-impact trust boundary or explicit acceptance criterion' "$RUN_SH"; then
    ok "optional coverage gaps cannot become unsupported blockers"
else
    bad "missing-test blocker calibration is incomplete"
fi

if grep -q 'Do not invent customer identities, testimonials, quantitative benefits, prices, availability, response times, legal claims, or integrations' "$RUN_SH" \
   && grep -q 'A no-backend form must never imply that it transmits or stores data' "$RUN_SH"; then
    ok "supervised generation is constrained to approved product facts"
else
    bad "supervised truthfulness policy is missing"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
