#!/usr/bin/env bash
#
# test-license-audit-pinned-version.sh
#
# Regression test for the silent-false-pass in scripts/license-audit.sh.
#
# BUG: lookup_license() queried the BARE package name first (`npm view <name>
# license`), which returns the LATEST published version's license, and only
# fell back to the version-pinned query as a backup. The audit therefore
# reported the license of @latest, NOT the version that actually ships per
# package.json's range. A pinned non-permissive version could silently PASS
# because @latest happened to be permissive (and vice versa).
#
# FIX: query the resolved/pinned range FIRST; fall back to bare only when the
# pinned query is empty.
#
# This test extracts the real lookup_license() + is_permissive() functions
# from the script and drives them against a stubbed `npm` so that the LATEST
# license differs from the PINNED license. It asserts the audit now reports
# the PINNED (shipping) license, and that the verdict flips accordingly.
#
# Deterministic and offline: no network, no real npm registry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
AUDIT_SCRIPT="${REPO_ROOT}/scripts/license-audit.sh"

if [[ ! -f "$AUDIT_SCRIPT" ]]; then
  echo "FAIL: $AUDIT_SCRIPT not found"
  exit 1
fi

WORK="$(mktemp -d -t loki-license-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# --- Stub npm so LATEST (bare) != PINNED (range) -------------------------
# fakepkg:       latest dist-tag license = MIT        (permissive  -> PASS)
# fakepkg@<rng>: pinned versions license = GPL-3.0    (non-permissive -> REVIEW)
#
# emptypkg:      latest dist-tag license = MIT        (permissive  -> PASS)
# emptypkg@<rng>: pinned query returns NOTHING (no version matches the range)
#                -> exercises the fallback to the bare lookup.
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/npm" <<'STUB'
#!/usr/bin/env bash
# Minimal `npm view <spec> license` stub.
spec="$2"
case "$spec" in
  fakepkg)   echo "MIT" ;;                                   # LATEST
  fakepkg@*) printf "%s\n%s\n" \
               "fakepkg@1.0.0 'GPL-3.0'" \
               "fakepkg@1.2.0 'GPL-3.0'" ;;                  # PINNED (multi-version)
  emptypkg)   echo "MIT" ;;                                  # LATEST (fallback target)
  emptypkg@*) echo "" ;;                                     # PINNED: no match -> empty
  *)          echo "" ;;
esac
STUB
chmod +x "${WORK}/bin/npm"

# --- Build a harness from the REAL script functions ---------------------
HARNESS="${WORK}/harness.sh"
{
  echo "ALLOWED_PATTERN='^(MIT|Apache-2\\.0|BSD-2-Clause|BSD-3-Clause|ISC)\$'"
  sed -n '/^lookup_license()/,/^}/p' "$AUDIT_SCRIPT"
  sed -n '/^is_permissive()/,/^}/p' "$AUDIT_SCRIPT"
  cat <<'EOF'
mode="$1"; name="$2"; range="$3"
lic="$(lookup_license "$name" "$range")"
if is_permissive "$lic"; then verdict="PASS"; else verdict="REVIEW"; fi
echo "${mode}|${lic}|${verdict}"
EOF
} > "$HARNESS"

run_harness() {
  PATH="${WORK}/bin:${PATH}" bash "$HARNESS" "$@"
}

FAILS=0
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS: ${desc}"
  else
    echo "FAIL: ${desc}"
    echo "      expected: ${expected}"
    echo "      actual:   ${actual}"
    FAILS=$((FAILS + 1))
  fi
}

echo "== license-audit pinned-version regression =="

# 1. Pinned-first: must report the PINNED license (GPL-3.0), not LATEST (MIT),
#    and the verdict must be REVIEW (the bug would have reported MIT -> PASS).
out="$(run_harness pinned fakepkg '^1.0.0')"
assert_eq "pinned query reports shipping license (GPL-3.0), not @latest (MIT)" \
  "pinned|GPL-3.0|REVIEW" "$out"

# 2. Highest-in-range: the multi-version pinned output keeps the last line,
#    which is the highest version matching the range (what npm installs).
#    Both stubbed versions are GPL-3.0; assert the value parses cleanly.
out_lic="$(run_harness pinned fakepkg '^1.0.0' | cut -d'|' -f2)"
assert_eq "multi-version pinned output parses to a single SPDX id" \
  "GPL-3.0" "$out_lic"

# 3. Fallback: when the pinned query is empty, fall back to the bare lookup.
out="$(run_harness fallback emptypkg '^9.9.9')"
assert_eq "empty pinned query falls back to bare (latest) lookup" \
  "fallback|MIT|PASS" "$out"

echo ""
if [[ "$FAILS" -eq 0 ]]; then
  echo "LICENSE-AUDIT-PINNED-TEST: PASS"
  exit 0
fi
echo "LICENSE-AUDIT-PINNED-TEST: FAIL (${FAILS})"
exit 1
