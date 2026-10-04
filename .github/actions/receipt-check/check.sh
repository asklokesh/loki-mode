#!/usr/bin/env bash
# "Loki Receipt" check: run `loki verify --pubkey <key> <receipt>` and post a check run through
# `gh api` with fixed argv. No merge step lives here; autopilot merge stays opt-in elsewhere.
# Env: LOKI_RECEIPT_CHECK_RECEIPT (path; default: newest .loki/runs/*/receipt.json),
#      LOKI_RECEIPT_CHECK_PUBKEY (required Ed25519 JWK/PEM file), LOKI_RECEIPT_CHECK_LOKI (default: loki),
#      LOKI_RECEIPT_CHECK_SHA (default: GITHUB_SHA), GITHUB_REPOSITORY.
set -uo pipefail

LOKI_BIN="${LOKI_RECEIPT_CHECK_LOKI:-loki}"
PUBKEY="${LOKI_RECEIPT_CHECK_PUBKEY:-}"
RECEIPT="${LOKI_RECEIPT_CHECK_RECEIPT:-}"
SHA="${LOKI_RECEIPT_CHECK_SHA:-${GITHUB_SHA:-}}"
REPO_SLUG="${GITHUB_REPOSITORY:-}"

if [ -z "$RECEIPT" ]; then
    for candidate in .loki/runs/*/receipt.json; do
        [ -f "$candidate" ] && RECEIPT="$candidate" # run ids sort chronologically; the glob is sorted, last wins
    done
fi

output=""
rc=0
if [ -z "$PUBKEY" ]; then
    output="loki receipt check: no public key supplied (set the pubkey input)"
    rc=2
elif [ -z "$RECEIPT" ] || [ ! -f "$RECEIPT" ]; then
    output="loki receipt check: receipt not found: ${RECEIPT:-.loki/runs/*/receipt.json}"
    rc=66
else
    output="$(timeout -k 5 300 "$LOKI_BIN" verify --pubkey "$PUBKEY" "$RECEIPT" 2>&1)"
    rc=$?
fi

# Strip ANSI escape sequences from the summary.
summary="$(printf '%s\n' "$output" | sed $'s/\x1b\\[[0-9;?]*[A-Za-z]//g')"
printf '%s\n' "$summary"

if [ "$rc" -eq 0 ]; then
    conclusion="success"
    title="Receipt verified"
else
    conclusion="failure"
    title="Receipt not verified"
fi

if [ -z "$SHA" ] || [ -z "$REPO_SLUG" ]; then
    echo "loki receipt check: GITHUB_REPOSITORY and a head sha are required to post the check" >&2
    exit 2
fi

gh api -X POST "repos/${REPO_SLUG}/check-runs" \
    -f "name=Loki Receipt" \
    -f "head_sha=${SHA}" \
    -f "status=completed" \
    -f "conclusion=${conclusion}" \
    -f "output[title]=${title}" \
    -f "output[summary]=${summary}" || exit 1

exit "$rc"
