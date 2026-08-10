#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOKI="$ROOT/autonomy/loki"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-start-repo.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
TARGET="$TMP/repo with spaces ; touch INJECTED"
mkdir -p "$TARGET"
printf '{"name":"fixture"}\n' > "$TARGET/package.json"

fail=0
if [ -e "$TMP/INJECTED" ] || [ -e "$TARGET/INJECTED" ]; then
  echo "FAIL: directory metacharacters were evaluated"
  fail=1
fi

# Exercise the real classifier boundary independently of provider availability.
start=$(grep -n '^detect_arg_type()' "$LOKI" | head -1 | cut -d: -f1)
end=$(awk -v s="$start" 'NR>s && /^}/{print NR; exit}' "$LOKI")
sed -n "${start},${end}p" "$LOKI" > "$TMP/detect.sh"
actual=$(bash -c 'source "$1"; detect_arg_type "$2"' _ "$TMP/detect.sh" "$TARGET")
if [ "$actual" != "repo" ]; then
  echo "FAIL: expected repo classification, got $actual"
  fail=1
fi

# Exercise cmd_start end to end, stubbing only its final exec boundary. This
# proves cwd and generated argv without launching a provider or autonomous run.
sed '$d' "$LOKI" > "$TMP/loki-source.sh"
cat > "$TMP/harness.sh" <<'HARNESS'
source "$1"
cmd_welcome_maybe_firstrun() { :; }
maybe_print_update_hint() { :; }
provider_offer_gate() { return 0; }
show_prd_plan() { :; }
_loki_new_session_exec() {
  printf 'cwd=%s\n' "$PWD" > "$LOKI_CAPTURE"
  printf 'arg=%s\n' "$@" >> "$LOKI_CAPTURE"
  return 0
}
cmd_start "$2" --provider claude --yes --no-plan
HARNESS
LOKI_CAPTURE="$TMP/capture" bash "$TMP/harness.sh" "$TMP/loki-source.sh" "$TARGET" >/dev/null 2>&1
if ! grep -Fq "cwd=$TARGET" "$TMP/capture" \
   || ! grep -Fq "arg=$TARGET/.loki/repo-prd-" "$TMP/capture" \
   || ! ls "$TARGET"/.loki/repo-prd-*.md >/dev/null 2>&1; then
  echo "FAIL: stubbed dispatch did not enter target and generate repo input"
  fail=1
fi

# Frozen-fixture fast-path measurement and mode contract. The final provider
# boundary remains stubbed, so this measures honest command-to-first-artifact
# latency without spend or background work.
cat > "$TMP/harness-fast.sh" <<'HARNESS'
source "$1"
cmd_welcome_maybe_firstrun() { :; }
maybe_print_update_hint() { :; }
provider_offer_gate() { return 0; }
show_prd_plan() { :; }
_loki_new_session_exec() {
  printf 'cwd=%s\n' "$PWD" > "$LOKI_CAPTURE"
  printf 'mode=%s\n' "${LOKI_TTFV:-}" >> "$LOKI_CAPTURE"
  printf 'iterations=%s\n' "${LOKI_MAX_ITERATIONS:-}" >> "$LOKI_CAPTURE"
  printf 'council=%s\n' "${LOKI_COUNCIL_ENABLED:-}" >> "$LOKI_CAPTURE"
  return 0
}
cmd_start "$2" --provider claude --yes --repo-fast
HARNESS
started=$(python3 -c 'import time; print(time.monotonic_ns())')
LOKI_CAPTURE="$TMP/fast-capture" bash "$TMP/harness-fast.sh" "$TMP/loki-source.sh" "$TARGET" >/dev/null 2>&1
ended=$(python3 -c 'import time; print(time.monotonic_ns())')
elapsed_ms=$(( (ended - started) / 1000000 ))
echo "METRIC: frozen repo command-to-generated-PRD/provider-boundary ${elapsed_ms}ms"
if [ "$elapsed_ms" -ge 600000 ] \
   || ! grep -q '^mode=repo-fast$' "$TMP/fast-capture" \
   || ! grep -q '^iterations=3$' "$TMP/fast-capture" \
   || ! grep -q '^council=false$' "$TMP/fast-capture" \
   || ! grep -q 'fast pass, reduced gates' "$TARGET"/.loki/repo-prd-*.md; then
  echo "FAIL: repo-fast profile or under-10-minute artifact contract failed"
  fail=1
fi

# Explicit full is byte-equivalent in profile to the default: no lightweight
# environment is introduced.
sed 's/--repo-fast/--repo-full/' "$TMP/harness-fast.sh" > "$TMP/harness-full.sh"
LOKI_CAPTURE="$TMP/full-capture" bash "$TMP/harness-full.sh" "$TMP/loki-source.sh" "$TARGET" >/dev/null 2>&1
if ! grep -q '^mode=repo$' "$TMP/full-capture" \
   || grep -q '^council=false$' "$TMP/full-capture"; then
  echo "FAIL: explicit repo-full weakened the default verification profile"
  fail=1
fi

# Explicit full wins deterministically regardless of ordering or repetition.
for flags in '--full --fast' '--fast --full' '--full --fast --fast' \
             '--repo-full --repo-fast --repo-fast'; do
  sed "s/--repo-fast/$flags/" "$TMP/harness-fast.sh" > "$TMP/harness-permutation.sh"
  LOKI_CAPTURE="$TMP/permutation-capture" bash "$TMP/harness-permutation.sh" \
    "$TMP/loki-source.sh" "$TARGET" >/dev/null 2>&1
  if ! grep -q '^mode=repo$' "$TMP/permutation-capture" \
     || grep -q '^council=false$' "$TMP/permutation-capture"; then
    echo "FAIL: explicit full did not win for flags: $flags"
    fail=1
  fi
done

# User-facing completion copy must not upgrade lightweight evidence into a
# council verdict. Extract the real renderer to keep this assertion direct.
RUN_SH="$ROOT/autonomy/run.sh"
line=$(grep -n '^print_ttfv_next_steps()' "$RUN_SH" | head -1 | cut -d: -f1)
end=$(awk -v s="$line" 'NR>s && /^}/{print NR; exit}' "$RUN_SH")
sed -n "${line},${end}p" "$RUN_SH" > "$TMP/next-steps.sh"
copy=$(TARGET_DIR="$TARGET" bash -c 'source "$1"; print_ttfv_next_steps repo-fast 0' _ "$TMP/next-steps.sh")
if ! printf '%s' "$copy" | grep -q 'council off' \
   || printf '%s' "$copy" | grep -q 'council verdicts'; then
  echo "FAIL: repo-fast completion copy overclaims verification"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "PASS: existing directory routes as a safe repository target"
exit "$fail"
