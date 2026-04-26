#!/usr/bin/env bash
#
# license-audit.sh
#
# Print the license of every direct (non-dev) dependency listed in the root
# package.json and loki-ts/package.json. Verifies each is in the permissive
# allowlist (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC). Prints a
# verdict line (LICENSE-AUDIT: PASS or LICENSE-AUDIT: REVIEW) and exits 0 on
# PASS, 1 on REVIEW.
#
# No source files are modified. Stock macOS / Ubuntu CI tooling only.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_FILES=(
  "${REPO_ROOT}/package.json"
  "${REPO_ROOT}/loki-ts/package.json"
)

# Permissive license allowlist (case-insensitive substring match against
# the SPDX identifier returned by npm view).
ALLOWED_PATTERN='^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC)$'

# Require jq to parse package.json (available on stock macOS via brew and
# on Ubuntu CI runners by default).
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not found on PATH" >&2
  exit 2
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required but not found on PATH" >&2
  exit 2
fi

# Collect direct deps from each package.json.
# Sections considered "direct production deps" for this audit:
#   dependencies, optionalDependencies, peerDependencies
# devDependencies are skipped (per --omit=dev semantics).
collect_direct_deps() {
  local pkg_json="$1"
  if [[ ! -f "$pkg_json" ]]; then
    return 0
  fi
  jq -r '
    [
      (.dependencies // {}),
      (.optionalDependencies // {}),
      (.peerDependencies // {})
    ]
    | map(to_entries) | add // []
    | .[]
    | "\(.key)\t\(.value)"
  ' "$pkg_json"
}

# Lookup the license for a package@version via `npm view`.
# Falls back to "UNKNOWN" on any error (network, rate limit, missing field).
lookup_license() {
  local name="$1"
  local version_range="$2"

  local raw license
  # Try the bare package name first (returns the latest dist-tag's license
  # as a single bare line, which is the easiest to parse). If that fails,
  # fall back to the version-pinned form and parse the multi-line output.
  raw="$(npm view "${name}" license 2>/dev/null | tr -d '\r')" || true

  # Take the LAST non-empty line (npm prints `pkg@ver 'License'` per version
  # when the range matches several versions; the last is the newest).
  license="$(printf '%s\n' "$raw" | awk 'NF{last=$0} END{print last}')"

  if [[ -z "$license" ]]; then
    raw="$(npm view "${name}@${version_range}" license 2>/dev/null | tr -d '\r')" || true
    license="$(printf '%s\n' "$raw" | awk 'NF{last=$0} END{print last}')"
  fi

  if [[ -z "$license" ]]; then
    echo "UNKNOWN"
    return 0
  fi

  # If the line looks like `pkg@version 'SPDX'` (multi-version output),
  # extract the quoted SPDX expression.
  if [[ "$license" =~ \'([^\']+)\' ]]; then
    license="${BASH_REMATCH[1]}"
  fi

  # Strip surrounding braces (handles object form like {"type":"MIT"})
  # and stray quotes.
  license="${license#\{}"
  license="${license%\}}"
  license="${license//\"/}"
  license="${license//\'/}"
  # Trim whitespace.
  license="$(printf '%s' "$license" | sed 's/^ *//;s/ *$//')"

  if [[ -z "$license" ]]; then
    echo "UNKNOWN"
  else
    echo "$license"
  fi
}

is_permissive() {
  local license="$1"
  # Strip parens commonly used in SPDX expressions like "(MIT OR Apache-2.0)".
  local stripped="${license#\(}"
  stripped="${stripped%\)}"

  # If it's an OR expression, accept if ANY clause is permissive.
  IFS=' ' read -r -a parts <<<"${stripped// OR / }"
  if [[ ${#parts[@]} -gt 1 ]]; then
    local p
    for p in "${parts[@]}"; do
      if [[ "$p" =~ $ALLOWED_PATTERN ]]; then
        return 0
      fi
    done
    return 1
  fi

  if [[ "$license" =~ $ALLOWED_PATTERN ]]; then
    return 0
  fi
  return 1
}

# Header
printf '%-50s %-20s %s\n' "PACKAGE" "VERSION" "LICENSE"
printf '%-50s %-20s %s\n' "-------" "-------" "-------"

declare -a OFFENDERS=()
TOTAL=0

for pkg_json in "${PACKAGE_FILES[@]}"; do
  if [[ ! -f "$pkg_json" ]]; then
    continue
  fi
  while IFS=$'\t' read -r name version; do
    [[ -z "$name" ]] && continue
    TOTAL=$((TOTAL + 1))
    license="$(lookup_license "$name" "$version")"
    printf '%-50s %-20s %s\n' "$name" "$version" "$license"
    if ! is_permissive "$license"; then
      OFFENDERS+=("${name}@${version} :: ${license}")
    fi
  done < <(collect_direct_deps "$pkg_json")
done

echo ""
echo "Total direct dependencies audited: ${TOTAL}"
echo ""

echo ""
echo "==============================================================="
echo "Transitive (production) dependency license audit"
echo "==============================================================="
# v7.4.10: extend audit to transitive deps via license-checker.
# Pre-v7.4.10 only the 4 direct deps were audited; AGPL/GPL transitive
# would have shipped undetected. Now we install --omit=dev into a temp
# dir, run license-checker over the resolved tree, and add any
# non-permissive transitive to OFFENDERS.
#
# Skipped if npm is in offline mode or the install step fails.
TMPROOT="$(mktemp -d -t loki-license-audit-XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT
cp "${REPO_ROOT}/package.json" "${TMPROOT}/" 2>/dev/null || true
TRANSITIVE_OK=true
if (
  cd "$TMPROOT"
  npm install --omit=dev --no-package-lock --no-audit --no-fund \
    --silent >/dev/null 2>&1
); then
  TRANSITIVE_RAW="$(cd "$TMPROOT" && npx --yes license-checker \
    --production --csv --excludePrivatePackages 2>/dev/null || true)"
  if [[ -n "$TRANSITIVE_RAW" ]]; then
    TRANSITIVE_COUNT=0
    while IFS=, read -r module licenses _rest; do
      module="${module//\"/}"
      licenses="${licenses//\"/}"
      [[ "$module" == "module name" ]] && continue
      [[ -z "$module" ]] && continue
      # v7.4.12 R2 fix: skip the host package itself. license-checker
      # includes loki-mode@<version> in the tree (it's the package being
      # audited) and would falsely flag our own BUSL-1.1 as a transitive
      # offender. Match the bare name -- we are loki-mode regardless of
      # version suffix.
      case "$module" in
        loki-mode|loki-mode@*) continue ;;
      esac
      TRANSITIVE_COUNT=$((TRANSITIVE_COUNT + 1))
      if ! is_permissive "$licenses"; then
        OFFENDERS+=("${module} :: ${licenses} (transitive)")
      fi
    done <<<"$TRANSITIVE_RAW"
    echo "Transitive packages audited: ${TRANSITIVE_COUNT}"
  else
    echo "Transitive scan: license-checker produced no output (skipping)"
    TRANSITIVE_OK=false
  fi
else
  echo "Transitive scan: npm install in temp dir failed (offline?); skipping"
  TRANSITIVE_OK=false
fi

echo ""
if [[ ${#OFFENDERS[@]} -eq 0 ]]; then
  if [[ "$TRANSITIVE_OK" == "true" ]]; then
    echo "LICENSE-AUDIT: PASS (direct + transitive)"
  else
    echo "LICENSE-AUDIT: PASS (direct only -- transitive scan unavailable)"
  fi
  exit 0
fi

echo "LICENSE-AUDIT: REVIEW"
echo "Non-permissive or unknown licenses (${#OFFENDERS[@]}):"
for o in "${OFFENDERS[@]}"; do
  echo "  - $o"
done
exit 1
