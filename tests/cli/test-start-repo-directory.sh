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

[ "$fail" -eq 0 ] && echo "PASS: existing directory routes as a safe repository target"
exit "$fail"
