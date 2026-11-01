#!/usr/bin/env bash
# The first-touch path a new user takes: `loki tour` replays the bundled demo
# receipt offline, prints the verifier's VERIFIED line, then TAMPERED on a
# one-byte copy. Guards the runtime read of skills/fixtures/demo-receipt (the
# receipt, its events.jsonl and its pubkey), and that the tour leaves the bundled
# files untouched.
#
# Planted defect used to prove this test can fail: replace the contents of
# skills/fixtures/demo-receipt/pubkey.jwk with {}; the tour must then fail to
# print VERIFIED. Reverted afterwards.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
cd "$ROOT" || exit 2

echo "TEST: newcomer path (loki tour)"

export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
FX="$ROOT/skills/fixtures/demo-receipt"
for f in receipt.json events.jsonl pubkey.jwk proof.json; do
    [ -s "$FX/$f" ] && ok "fixture present: $f" || bad "fixture missing or empty: $f"
done
before="$(cat "$FX/receipt.json" "$FX/events.jsonl" "$FX/pubkey.jwk" | shasum -a 256 | cut -d' ' -f1)"

out="$(bash bin/loki tour 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "loki tour exits 0" || bad "loki tour exited $rc"
v_line="$(printf '%s\n' "$out" | grep -n 'Result: VERIFIED' | head -1 | cut -d: -f1)"
t_line="$(printf '%s\n' "$out" | grep -n 'Result: TAMPERED' | head -1 | cut -d: -f1)"
[ -n "$v_line" ] && ok "tour prints Result: VERIFIED" || bad "tour never prints Result: VERIFIED"
[ -n "$t_line" ] && ok "tour prints Result: TAMPERED for the one-byte copy" || bad "tour never prints Result: TAMPERED"
[ -n "$v_line" ] && [ -n "$t_line" ] && [ "$v_line" -lt "$t_line" ] && ok "VERIFIED comes before TAMPERED" || bad "tour verdict order is wrong"
has "tour says it is a sample" "$out" "This is a SAMPLE"

after="$(cat "$FX/receipt.json" "$FX/events.jsonl" "$FX/pubkey.jwk" | shasum -a 256 | cut -d' ' -f1)"
[ "$before" = "$after" ] && ok "bundled fixture untouched by the tour" || bad "the tour modified the bundled fixture"

finish
