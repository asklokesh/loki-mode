#!/usr/bin/env bash
# SIGS-DOC: the draft predicate doc's example JSON parses, is a draft (no standardization claim), and every
# receipt field its field table maps to is documented in docs/AGENT-CHANGE-RECEIPT.md.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC="$ROOT/docs/v11/INTOTO-AGENT-CHANGE-PREDICATE.md"
RECEIPT_DOC="$ROOT/docs/AGENT-CHANGE-RECEIPT.md"
fail=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }
[ -f "$DOC" ] && [ -f "$RECEIPT_DOC" ] || { echo "FAIL: doc missing"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }

example="$(awk '/^```json$/{f=1;next} /^```$/{if(f)exit} f' "$DOC")"
if printf '%s' "$example" | jq -e . >/dev/null 2>&1; then ok "example JSON parses"; else bad "example JSON parses"; fi

# Example predicate keys must each be a documented predicate field (first column of the field table).
table_fields="$(awk -F'|' '/^\| `/{gsub(/[` ]/,"",$2); print $2}' "$DOC")"
for k in $(printf '%s' "$example" | jq -r '.predicate | keys[]' 2>/dev/null); do
    if printf '%s\n' "$table_fields" | grep -qx -- "$k" || printf '%s\n' "$table_fields" | grep -q -- "^$k\."; then ok "example key $k is in the field table"; else bad "example key $k is in the field table"; fi
done

# Every mapped receipt field (third column, not "new") must appear as a backticked name in the receipt doc.
while IFS= read -r f; do
    [ -n "$f" ] || continue
    if grep -qF -- "\`$f\`" "$RECEIPT_DOC"; then ok "receipt field $f documented"; else bad "receipt field $f documented"; fi
done < <(awk -F'|' '/^\| `/{c=$4; gsub(/[` ]/,"",c); if (c!="new" && c!="") print c}' "$DOC" | sort -u)

if grep -qi "DRAFT" "$DOC" && grep -qi "not accepted" "$DOC"; then ok "states it is a draft and not accepted"; else bad "states it is a draft and not accepted"; fi
if grep -niE 'is (an )?(accepted|official|standard)|standardized by' "$DOC" | grep -viE 'not|nothing|never' >/dev/null; then bad "no standardization claim"; else ok "no standardization claim"; fi
if grep -qF -e "$(printf '\342\200\223')" -e "$(printf '\342\200\224')" "$DOC"; then bad "no en or em dashes"; else ok "no en or em dashes"; fi
exit "$fail"
