#!/usr/bin/env bash
# CPE24-L7: keep the legacy dashboard deleted.
#
# Fails when, under the repo root:
#   C1  the legacy UI directories exist
#   C2  package.json "files" lists them
#   C3  `npm pack --dry-run --json` would ship any path under them
#   C4  a tracked file outside CHANGELOG.md, docs/ and the allowlist mentions them
#   C5  an allowlist entry is stale (the file no longer mentions them or is gone):
#       the allowlist may only shrink, so a stale line must be deleted.
#
# Usage:
#   bash tests/test-legacy-dashboard-removed.sh              check the real repo
#   bash tests/test-legacy-dashboard-removed.sh --self-test  prove each check goes red on a fixture
# Env:
#   LEGACY_DASH_ROOT       repo root to check (default: this repo)
#   LEGACY_DASH_ALLOWLIST  allowlist file (default: tests/legacy-dashboard-removed.allowlist under the root)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Built by concatenation so this file never matches its own reference scan.
LEG_UI="dashboard""-ui"
LEG_STATIC="dashboard/""static"
PATTERN_ARGS=(-e "$LEG_UI" -e "$LEG_STATIC")

# check_root ROOT ALLOWLIST: prints [FAIL] C<n> lines, returns the failure count (capped at 255).
check_root() {
    local root="$1" allow="$2" fails=0 d f line
    [ -d "$root" ] || { echo "  [FAIL] C0 root $root is not a directory"; return 1; }

    for d in "$LEG_UI" "$LEG_STATIC"; do
        if [ -e "$root/$d" ]; then
            echo "  [FAIL] C1 $d/ still exists"; fails=$((fails + 1))
        fi
    done

    if [ -f "$root/package.json" ]; then
        local listed
        listed="$(node -e '
            const p = JSON.parse(require("fs").readFileSync(process.argv[1] + "/package.json", "utf8"));
            for (const f of (p.files || [])) console.log(f);' "$root" 2>&1)" || {
            echo "  [FAIL] C2 cannot parse package.json: $listed"; fails=$((fails + 1)); listed=""; }
        while IFS= read -r line; do
            [ -n "$line" ] || continue
            case "$line" in
                *"$LEG_UI"*|*"$LEG_STATIC"*)
                    echo "  [FAIL] C2 package.json files lists $line"; fails=$((fails + 1)) ;;
            esac
        done <<EOF
$listed
EOF

        local packed packrc
        packed="$(cd "$root" && timeout -k 5 120 npm pack --dry-run --json --ignore-scripts 2>/dev/null | node -e '
            let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
                let j; try { j = JSON.parse(s); } catch (e) { console.log("__PARSE_ERROR__"); return; }
                for (const f of j[0].files) console.log(f.path); });')"
        packrc=$?
        if [ "$packrc" -ne 0 ] || [ "$packed" = "__PARSE_ERROR__" ]; then
            echo "  [FAIL] C3 npm pack --dry-run --json did not produce a file list"; fails=$((fails + 1))
        else
            while IFS= read -r line; do
                case "$line" in
                    "$LEG_UI"/*|"$LEG_STATIC"/*)
                        echo "  [FAIL] C3 npm pack would ship $line"; fails=$((fails + 1)) ;;
                esac
            done <<EOF
$packed
EOF
        fi
    else
        echo "  [FAIL] C2 no package.json under $root"; fails=$((fails + 1))
    fi

    local allowed="" files
    if [ -f "$allow" ]; then
        allowed="$(grep -v '^[[:space:]]*#' "$allow" | grep -v '^[[:space:]]*$')"
    fi
    if git -C "$root" rev-parse --show-toplevel >/dev/null 2>&1 && [ "$(cd "$root" && pwd -P)" = "$(git -C "$root" rev-parse --show-toplevel)" ]; then
        files="$(git -C "$root" ls-files)"
    else
        files="$(cd "$root" && find . -type f -not -path './.git/*' -not -path '*/node_modules/*' | sed 's|^\./||')"
    fi
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        case "$f" in
            CHANGELOG.md|docs/*|"$LEG_UI"/*|"$LEG_STATIC"/*) continue ;;
            tests/test-legacy-dashboard-removed.sh|tests/legacy-dashboard-removed.allowlist) continue ;;
        esac
        [ -f "$root/$f" ] || continue
        if grep -qI "${PATTERN_ARGS[@]}" "$root/$f" 2>/dev/null; then
            if ! printf '%s\n' "$allowed" | grep -qxF -- "$f"; then
                echo "  [FAIL] C4 $f references the legacy dashboard and is not allowlisted"; fails=$((fails + 1))
            fi
        fi
    done <<EOF
$files
EOF
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        if [ ! -f "$root/$f" ] || ! grep -qI "${PATTERN_ARGS[@]}" "$root/$f" 2>/dev/null; then
            echo "  [FAIL] C5 stale allowlist entry (delete it): $f"; fails=$((fails + 1))
        fi
    done <<EOF
$allowed
EOF
    [ "$fails" -gt 255 ] && fails=255
    return "$fails"
}

if [ "${1:-}" = "--self-test" ]; then
    PASS=0; FAIL=0
    ok()  { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
    bad() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

    temp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
    RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || exit 2
    RUN_TMP_RECORDED="$RUN_TMP"
    trap 'rm -rf -- "$RUN_TMP_RECORDED"' EXIT

    # mkfix NAME: a clean fixture tree at $RUN_TMP/NAME
    mkfix() {
        local r="$RUN_TMP/$1"
        mkdir -p "$r/bin" "$r/docs"
        printf '#!/bin/sh\necho hi\n' > "$r/bin/x"
        printf '{"name":"fixture","version":"1.0.0","files":["bin/"]}\n' > "$r/package.json"
        printf 'history: removed %s and %s\n' "$LEG_UI" "$LEG_STATIC" > "$r/CHANGELOG.md"
        printf 'history: %s\n' "$LEG_UI" > "$r/docs/h.md"
        printf '%s\n' "$r"
    }
    # expect NAME CODE ROOT: run check_root, assert a [FAIL] CODE line (or none for CODE=none)
    expect() {
        local name="$1" code="$2" root="$3" out rc
        out="$(check_root "$root" "$root/tests/legacy-dashboard-removed.allowlist")"; rc=$?
        if [ "$code" = none ]; then
            if [ "$rc" -eq 0 ] && [ -z "$out" ]; then ok "$name goes green"; else bad "$name should be green (rc=$rc): $out"; fi
        else
            if [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q "\[FAIL\] $code "; then ok "$name goes red on $code"; else bad "$name should be red on $code (rc=$rc): $out"; fi
        fi
    }

    echo "T1 -- clean fixture is green"
    r="$(mkfix clean)"; expect "clean fixture" none "$r"

    echo "T2 -- planted legacy directory is red"
    r="$(mkfix planted-ui)"; mkdir -p "$r/$LEG_UI/src"; echo x > "$r/$LEG_UI/src/a.js"; expect "planted $LEG_UI/" C1 "$r"
    r="$(mkfix planted-static)"; mkdir -p "$r/$LEG_STATIC"; echo x > "$r/$LEG_STATIC/index.html"; expect "planted $LEG_STATIC/" C1 "$r"

    echo "T3 -- planted package.json files entry is red (and the pack check sees the shipped path)"
    r="$(mkfix planted-files)"
    printf '{"name":"fixture","version":"1.0.0","files":["bin/","%s/"]}\n' "$LEG_UI" > "$r/package.json"
    expect "planted files entry" C2 "$r"
    mkdir -p "$r/$LEG_UI"; echo x > "$r/$LEG_UI/a.js"
    expect "planted files entry with dir" C3 "$r"

    echo "T4 -- planted reference in a tracked file is red unless allowlisted"
    r="$(mkfix planted-ref)"; mkdir -p "$r/scripts"; printf 'cd %s\n' "$LEG_UI" > "$r/scripts/build.sh"
    expect "planted reference" C4 "$r"
    mkdir -p "$r/tests"; printf 'scripts/build.sh\n' > "$r/tests/legacy-dashboard-removed.allowlist"
    expect "allowlisted reference" none "$r"

    echo "T5 -- stale allowlist entry is red"
    r="$(mkfix stale)"; mkdir -p "$r/tests"; printf 'scripts/gone.sh\n' > "$r/tests/legacy-dashboard-removed.allowlist"
    expect "stale allowlist entry" C5 "$r"

    echo ""
    echo "Self-test: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
    exit $?
fi

ROOT="${LEGACY_DASH_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ALLOW="${LEGACY_DASH_ALLOWLIST:-$ROOT/tests/legacy-dashboard-removed.allowlist}"
echo "Legacy dashboard removal guard: root=$ROOT"
check_root "$ROOT" "$ALLOW"
rc=$?
if [ "$rc" -eq 0 ]; then
    echo "PASS: legacy dashboard is fully removed"
    exit 0
fi
echo "FAIL: $rc legacy dashboard violation(s)"
exit 1
