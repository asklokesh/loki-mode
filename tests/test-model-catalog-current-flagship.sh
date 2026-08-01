#!/usr/bin/env bash
# The planning tier must not point at a superseded flagship.
#
# WHY AGE IS NOT ENOUGH. `loki doctor` already reports catalog age and warns
# past 90 days. That check did NOT catch this: the catalog was 3 days old and
# still resolved the planning tier -- the most expensive tier, used for
# architecture decisions -- to claude-opus-4-8 while claude-opus-5 was shipping.
# A provider releasing mid-window makes age a poor proxy for correctness.
#
# WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT.
# It does NOT hit the network, and it does NOT try to know what the newest model
# is -- that would make the test rot exactly like the catalog. Instead it pins a
# structural property that is cheap and stays true: within a provider's own
# model family, the tier must not resolve to a version that the catalog itself
# lists as superseded, and every tier target must be internally consistent.
#
# The live check is tools/probe-model-catalog.py, which reads provider docs.
# This is its offline complement: the probe tells a maintainer what is new; this
# fails the suite when the catalog contradicts itself.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG="$REPO_ROOT/providers/model_catalog.json"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: model catalog flagship currency"

[ -f "$CATALOG" ] || { echo "FAIL: catalog missing at $CATALOG"; exit 1; }

# --- 1. no tier resolves to a model absent from models[] ---------------------
# models[] is authoritative per the catalog's own _source_of_truth note. A tier
# pointing at an id that is not in models[] means the mirrors drifted.
_orphans="$(python3 - "$CATALOG" <<'PY'
import json, sys
cat = json.load(open(sys.argv[1]))["providers"]
bad = []
for prov, v in cat.items():
    ids = {m.get("id") for m in v.get("models", [])}
    for tier in ("latest_fast", "latest_development", "latest_planning"):
        target = v.get(tier)
        if target and target not in ids:
            bad.append(f"{prov}.{tier}={target}")
print(" ".join(bad))
PY
)"
if [ -z "$_orphans" ]; then
    ok "every tier target exists in its provider's models[]"
else
    bad "tier targets missing from models[]: $_orphans"
fi

# --- 2. within a family, no tier points at a superseded major ----------------
# The regression this exists for. If models[] contains claude-opus-5, then a
# tier resolving to claude-opus-4-8 is provably stale by the catalog's OWN
# contents -- no network needed to know that.
_superseded="$(python3 - "$CATALOG" <<'PY'
import json, re, sys

def parse(mid):
    """(family, version-tuple) for a model id, or None when unparseable."""
    m = re.match(r"^(claude-[a-z]+|gpt)-(\d+(?:[.-]\d+)*)", mid or "")
    if not m:
        return None
    fam = m.group(1)
    nums = tuple(int(p) for p in re.split(r"[.-]", m.group(2)) if p.isdigit())
    return fam, nums

cat = json.load(open(sys.argv[1]))["providers"]
findings = []
for prov, v in cat.items():
    parsed = [(m.get("id"), parse(m.get("id"))) for m in v.get("models", [])]
    parsed = [(i, p) for i, p in parsed if p]
    for tier in ("latest_fast", "latest_development", "latest_planning"):
        target = v.get(tier)
        tp = parse(target)
        if not tp:
            continue
        # Any model of the SAME family with a strictly greater version.
        newer = [i for i, p in parsed if p[0] == tp[0] and p[1] > tp[1]]
        if newer:
            findings.append(f"{prov}.{tier}={target} superseded by {','.join(sorted(newer))}")
print("\n".join(findings))
PY
)"
if [ -z "$_superseded" ]; then
    ok "no tier points at a superseded model in the same family"
else
    bad "stale tier targets: $_superseded"
fi

# --- 3. the alias and the tier must agree ------------------------------------
# providers/claude.sh dispatches by ALIAS. If cli_aliases.opus and
# latest_planning disagree, the tier a user selects and the model actually run
# are different -- a silent cost and capability mismatch.
_alias_drift="$(python3 - "$CATALOG" <<'PY'
import json, sys
cat = json.load(open(sys.argv[1]))["providers"]
out = []
for prov, v in cat.items():
    aliases = v.get("cli_aliases") or {}
    by_tier = {}
    for m in v.get("models", []):
        if m.get("tier") and m.get("alias"):
            by_tier[m["tier"]] = (m["alias"], m["id"])
    for tier, key in (("planning", "latest_planning"),
                      ("development", "latest_development"),
                      ("fast", "latest_fast")):
        if tier not in by_tier:
            continue
        alias, mid = by_tier[tier]
        if alias in aliases and aliases[alias] != mid:
            out.append(f"{prov}: alias {alias}->{aliases[alias]} but tier {tier}->{mid}")
print("\n".join(out))
PY
)"
if [ -z "$_alias_drift" ]; then
    ok "every cli alias resolves to the same id as its tier"
else
    bad "alias/tier disagreement: $_alias_drift"
fi

# --- 4. the updated date must be a real ISO date -----------------------------
# doctor's age check silently degrades to "unreadable" on a malformed date,
# which reads as a warning about the file rather than about the date.
if python3 -c "
import json,datetime,sys
d=json.load(open('$CATALOG'))['updated']
datetime.date.fromisoformat(d)
" 2>/dev/null; then
    ok "the catalog 'updated' field is a valid ISO date"
else
    bad "the catalog 'updated' field is missing or not an ISO date"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
