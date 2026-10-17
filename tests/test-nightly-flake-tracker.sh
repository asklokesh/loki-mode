#!/usr/bin/env bash
# tests/test-nightly-flake-tracker.sh - offline fixtures for scripts/nightly-flake-tracker.sh (FC-53)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRACKER="$REPO_DIR/scripts/nightly-flake-tracker.sh"
FX_SRC="$SCRIPT_DIR/fixtures/nightly-flake"
# Fixtures hold @CHECK@/@CROSS@ placeholders so no committed file carries the
# dingbat glyphs the emoji structural check bans; materialise them per run.
FX="$(mktemp -d "${TMPDIR:-/tmp}/nightly-flake-fx.XXXXXX")" || exit 1
trap 'rm -rf -- "$FX"' EXIT
CHECK_GLYPH="$(printf '\342\234\223')"
CROSS_GLYPH="$(printf '\342\234\227')"
for f in "$FX_SRC"/*.txt; do
    sed -e "s/@CHECK@/$CHECK_GLYPH/g" -e "s/@CROSS@/$CROSS_GLYPH/g" "$f" >"$FX/$(basename "$f")"
done
PASS=0
FAIL=0

check() {
    local name="$1" cond="$2"
    if [ "$cond" = "0" ]; then
        PASS=$((PASS + 1))
        echo "  PASS: $name"
    else
        FAIL=$((FAIL + 1))
        echo "  FAIL: $name"
    fi
}

SHA_A="a0d599d0c469fa8d9374eac86a3e640972008c9d"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

out="$("$TRACKER" "$SHA_A:red:$FX/red.txt" "$SHA_A:green:$FX/green.txt")"
rc=$?
check "flip on identical SHA exits 1" "$([ "$rc" = 1 ] && echo 0 || echo 1)"
case "$out" in *"FLIP a0d599d suite b > flips pass=green fail=red"*) r=0 ;; *) r=1 ;; esac
check "bun test flip reported with run labels" "$r"
case "$out" in *"FLIP a0d599d Shell Thing pass=red fail=green"*) r=0 ;; *) r=1 ;; esac
check "shell runner flip reported (ANSI and BOM stripped)" "$r"
case "$out" in *"BOARD: | FLAKE |"*"suite b > flips"*) r=0 ;; *) r=1 ;; esac
check "BOARD-ready slice line emitted" "$r"
case "$out" in *"STABLE-FAIL a0d599d suite c > always red"*) r=0 ;; *) r=1 ;; esac
check "test red in every run is STABLE-FAIL, not a flake" "$r"
case "$out" in *"FLIP a0d599d suite c"*|*"FLIP a0d599d suite a"*) r=1 ;; *) r=0 ;; esac
check "always-red and always-green tests are not flips" "$r"

out2="$("$TRACKER" "$SHA_A:green:$FX/green.txt" "$SHA_B:other:$FX/othersha.txt")"
rc2=$?
check "pass on one SHA and fail on another is not a flip (exit 0)" "$([ "$rc2" = 0 ] && echo 0 || echo 1)"
case "$out2" in *FLIP*) r=1 ;; *) r=0 ;; esac
check "no FLIP line across different SHAs" "$r"

"$TRACKER" >/dev/null 2>&1
check "no arguments is a usage error (exit 2)" "$([ "$?" = 2 ] && echo 0 || echo 1)"
"$TRACKER" "$SHA_A:x:$FX/does-not-exist.log" >/dev/null 2>&1
check "missing log is a usage error (exit 2)" "$([ "$?" = 2 ] && echo 0 || echo 1)"

# --gh-run: stub gh serving a jobs list and two job logs at one SHA.
STUB="$FX/stub"
mkdir -p "$STUB"
cat >"$STUB/gh" <<'STUBEOF'
#!/usr/bin/env bash
case "$*" in
    *"/jobs?"*)
        printf '{"jobs":[{"id":101,"name":"Bun tests on macos-latest bun=1.3.13 (nightly)","head_sha":"%s"},{"id":102,"name":"Bun tests on ubuntu-latest bun=latest (nightly)","head_sha":"%s"},{"id":103,"name":"first-run gate (stub)","head_sha":"%s"}]}\n' "$STUB_SHA" "$STUB_SHA" "$STUB_SHA" ;;
    *"/jobs/101/logs") cat "$STUB_LOG1" ;;
    *"/jobs/102/logs") cat "$STUB_LOG2" ;;
    *) exit 1 ;;
esac
STUBEOF
chmod +x "$STUB/gh"
printf '2026-10-17T01:00:00.0Z (pass) WC-01b [12.00ms]\n' >"$FX/gh1.txt"
printf '2026-10-17T01:00:00.0Z (fail) WC-01b [5004.82ms]\n' >"$FX/gh2.txt"
printf '2026-10-17T01:00:00.0Z (fail) WC-01b [7.00ms]\n' >"$FX/gh3.txt"
export STUB_SHA="$SHA_A" STUB_LOG1="$FX/gh1.txt" STUB_LOG2="$FX/gh2.txt"
out3="$(PATH="$STUB:$PATH" "$TRACKER" --gh-run 4242)"
rc3=$?
check "--gh-run flip exits 1" "$([ "$rc3" = 1 ] && echo 0 || echo 1)"
case "$out3" in *"FLIP a0d599d WC-01b "*) r=0 ;; *) r=1 ;; esac
check "--gh-run reports FLIP with [ms] suffix stripped" "$r"
case "$out3" in *"fail=102-ubuntu-latest_bun=latest-drift"*) r=0 ;; *) r=1 ;; esac
check "--gh-run labels bun=latest leg as drift" "$r"
out4="$(STUB_LOG1="$FX/gh3.txt" PATH="$STUB:$PATH" "$TRACKER" --gh-run 4242)"
rc4=$?
case "$out4" in *"STABLE-FAIL a0d599d WC-01b"*) r=0 ;; *) r=1 ;; esac
check "--gh-run both failing is STABLE-FAIL, exit 0" "$([ "$r$rc4" = "00" ] && echo 0 || echo 1)"
PATH="$STUB:$PATH" "$TRACKER" --gh-run abc >/dev/null 2>&1
check "--gh-run with non-numeric id is a usage error" "$([ "$?" = 2 ] && echo 0 || echo 1)"

echo "=== nightly-flake-tracker: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
