#!/usr/bin/env bash
# The Slack card carries the verdict, and never guesses one.
#
# Roadmap item 9: "put the receipt where review already happens ... verification
# nobody sees does not build trust." Slack notifications carried the event name
# and the project name and nothing else -- grepping this file for
# receipt/verdict/proof returned 0. A team watching a channel saw "build
# finished" and had to go elsewhere to learn whether it was verified.
#
# TEST 3 IS THE LOAD-BEARING ONE, and it is about a MALFORMED PAYLOAD. The
# fields are spliced into an existing JSON array. An empty value that still
# emitted its separator produces `[{...},]`, Slack rejects the whole card, and
# the notification silently stops arriving -- so a change meant to add trust
# signal would instead delete every notification, and nothing would report it.
# The failure mode of "no receipt" must be a card WITHOUT verdict fields, never
# a card that does not send.
#
# TEST 4 is the second refusal: an unanchored receipt must say so. base_sha=""
# means the receipt cannot be anchored, so it cannot be verified. Showing a
# files-changed count there reads as a verified result. It reports
# "no (unanchored receipt)" instead.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NOTIFY="$REPO_ROOT/autonomy/notify.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the Slack card carries the verdict and never guesses one"

[ -f "$NOTIFY" ] || { echo "  FAIL: $NOTIFY missing"; exit 1; }

_fields() { bash -c "source '$NOTIFY' 2>/dev/null; LOKI_DIR='$1' _slack_verdict_fields" 2>/dev/null; }

# Splices using the REAL expansion taken from notify.sh, not a copy.
#
# The first version hand-wrote `${vf:+,$vf}` in the test. That made the
# separator assertion VACUOUS: breaking the expansion in notify.sh left this
# test green, because the test was exercising its own correct copy. Extracting
# the line means a separator bug in the source fails here.
_SPLICE="$(grep -o '\${verdict_fields:+[^}]*}' "$NOTIFY" | head -1)"
[ -n "$_SPLICE" ] && _SPLICE="${_SPLICE//verdict_fields/vf}" || _SPLICE=',$vf'
_payload() {
    bash -c "
        source '$NOTIFY' 2>/dev/null
        vf=\"\$(LOKI_DIR='$1' _slack_verdict_fields 2>/dev/null || true)\"
        printf '{\"attachments\":[{\"fields\":[{\"title\":\"Event\",\"value\":\"e\"}%s]}]}' \"$_SPLICE\"
    " 2>/dev/null
}

_mkreceipt() {  # <dir> <base_sha> <gates-json>
    local d="$1"; mkdir -p "$d/proofs/r1"
    python3 -c "
import json,sys
json.dump({'run_id':'r1','facts':{'git':{'base_sha':sys.argv[2],'head_sha':'abc',
 'diff':{'count':7}}},'quality_gates':{'gates':json.loads(sys.argv[3])}},
 open(sys.argv[1]+'/proofs/r1/proof.json','w'))" "$d" "$2" "$3"
}

# --- 1. THE GAP: the card actually carries verdict signal -------------------
T="$(mktemp -d)"
_mkreceipt "$T" "deadbeef" '[{"name":"a","status":"passed"},{"name":"b","status":"failed"}]'
_out="$(_fields "$T")"
if printf '%s' "$_out" | grep -q '"Gates"'; then
    ok "the card reports gate results"
else
    bad "no gate field -- the channel still shows only 'build finished'"
fi
if printf '%s' "$_out" | grep -q '1/2 passed'; then
    ok "gate counts are real (1/2 passed), not a status word"
else
    bad "the gate field does not carry the actual counts"
fi
if printf '%s' "$_out" | grep -q '"Receipt"'; then
    ok "the card names the receipt, so a reader can go look it up"
else
    bad "the card omits the receipt id"
fi
rm -rf "$T"

# --- 2. Valid JSON with a receipt ------------------------------------------
T="$(mktemp -d)"
_mkreceipt "$T" "deadbeef" '[{"name":"a","status":"passed"}]'
if _payload "$T" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    ok "the payload is valid JSON when a receipt exists"
else
    bad "the payload is malformed with a receipt -- Slack would drop the card"
fi
rm -rf "$T"

# --- 3. THE GUARD: valid JSON with NO receipt -------------------------------
# The separator bug. `[{...},]` makes Slack reject the card, so notifications
# stop arriving entirely and nothing reports it.
T="$(mktemp -d)"   # no proofs/ at all
if [ -z "$(_fields "$T")" ]; then
    ok "no receipt yields no verdict fields (not a guessed default)"
else
    bad "fields were emitted with no receipt to derive them from"
fi
if _payload "$T" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if len(d["attachments"][0]["fields"])==1 else 1)' 2>/dev/null; then
    ok "with no receipt the card still sends, with just its base field"
else
    bad "an empty verdict breaks the payload -- notifications would stop silently"
fi
rm -rf "$T"

# --- 4. THE SECOND REFUSAL: an unanchored receipt says so -------------------
# base_sha="" means the receipt cannot be anchored, so it cannot be verified.
# A files-changed count there would read as a verified result.
T="$(mktemp -d)"
_mkreceipt "$T" "" '[{"name":"a","status":"passed"}]'
_out="$(_fields "$T")"
if printf '%s' "$_out" | grep -q 'unanchored receipt'; then
    ok "an unanchored receipt is reported as NOT verified"
else
    bad "an unanchored receipt does not say it cannot be verified"
fi
if printf '%s' "$_out" | grep -q '"Files changed"'; then
    bad "an unanchored receipt shows a diff count, which reads as a verified result"
else
    ok "no diff count is shown for a receipt that cannot be anchored"
fi
rm -rf "$T"

# --- 5. Malformed receipt degrades to silence, never to a claim -------------
T="$(mktemp -d)"; mkdir -p "$T/proofs/r1"; printf '{not json' > "$T/proofs/r1/proof.json"
if [ -z "$(_fields "$T")" ]; then
    ok "a corrupt receipt yields no fields (silent, not a fabricated verdict)"
else
    bad "a corrupt receipt still produced verdict fields"
fi
if _payload "$T" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    ok "a corrupt receipt still leaves a sendable card"
else
    bad "a corrupt receipt breaks the payload"
fi
rm -rf "$T"

# --- 6. It cannot fail a build ----------------------------------------------
# A notification is a side channel. Assert the function returns 0 even with a
# nonexistent directory.
if bash -c "source '$NOTIFY' 2>/dev/null; LOKI_DIR=/nonexistent/xyz _slack_verdict_fields" >/dev/null 2>&1; then
    ok "a missing .loki returns success (a notification never fails a build)"
else
    bad "the verdict helper exits non-zero -- it could fail a build"
fi

# --- 7. Syntax --------------------------------------------------------------
bash -n "$NOTIFY" 2>/dev/null && ok "notify.sh parses" || bad "notify.sh has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
