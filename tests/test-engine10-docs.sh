#!/usr/bin/env bash
# E-34 (docs/v10/ENGINE.md): v10 user docs must not drift from the code they
# describe. README.md and docs/v10/GUIDE.md document a CLI surface that is
# still landing piece by piece -- this pins every command and flag they name
# to the engine10 USAGE text (loki-ts/src/engine10/cli.ts) so a doc claim can
# never outrun what the router actually supports, and pins the opt-in marker
# line to bin/loki's real default so the two docs and the flip switch cannot
# silently disagree about which engine runs by default.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUIDE="$REPO_ROOT/docs/v10/GUIDE.md"
README="$REPO_ROOT/README.md"
CLI="$REPO_ROOT/loki-ts/src/engine10/cli.ts"
BIN_LOKI="$REPO_ROOT/bin/loki"

PASS=0
FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

echo "T1 -- required files exist"
if [ -f "$GUIDE" ]; then
    ok "docs/v10/GUIDE.md exists"
else
    bad "docs/v10/GUIDE.md is missing"
    echo "  Passed: $PASS  Failed: $FAIL"
    exit 1
fi
if [ -f "$CLI" ]; then
    ok "engine10/cli.ts exists"
else
    bad "engine10/cli.ts is missing; nothing to check the docs against"
    echo "  Passed: $PASS  Failed: $FAIL"
    exit 1
fi

# The ground truth: the literal USAGE template string, not a re-typed copy.
USAGE_TXT="$(sed -n '/^const USAGE = `/,/^`;/p' "$CLI")"
if [ -n "$USAGE_TXT" ]; then
    ok "read USAGE text from cli.ts"
else
    bad "could not extract USAGE text from cli.ts; test is inert"
fi

echo
echo "T2 -- every documented subcommand appears in engine10 USAGE"
for cmd in status verify dashboard; do
    if printf '%s\n' "$USAGE_TXT" | grep -qE "loki $cmd\b"; then
        ok "USAGE lists 'loki $cmd'"
    else
        bad "USAGE never mentions 'loki $cmd', but the guide documents it"
    fi
done

echo
echo "T3 -- every flag the guide documents is a real engine10 flag"
for flag in --deep --provider --no-pr; do
    if grep -qF -- "\`$flag" "$GUIDE"; then
        ok "GUIDE documents $flag"
    else
        bad "GUIDE does not document $flag"
    fi
    if printf '%s\n' "$USAGE_TXT" | grep -qF -- "$flag"; then
        ok "$flag appears in engine10 USAGE"
    else
        bad "$flag is documented but absent from engine10 USAGE (doc drift)"
    fi
done

echo
echo "T4 -- every 'loki ...' example line uses a real v10 command shape"
# Scoped to GUIDE.md in full (a v10-only file) and README's own v10 section
# only: README has other, unrelated "loki ..." examples for the legacy CLI
# elsewhere in the file, which are not this slice's concern to validate.
extract_examples() {
    awk '
        /^## Loki 10 engine/ { insection = 1; next }
        insection && /^## / { insection = 0 }
        FILENAME ~ /GUIDE\.md$/ { insection = 1 }
        /^```/ { infence = !infence; next }
        insection && infence && ($0 ~ /^loki / || $0 ~ /^LOKI_ENGINE=v10 loki /) { print }
    ' "$1"
}
example_count=0
while IFS= read -r line; do
    [ -z "$line" ] && continue
    example_count=$((example_count + 1))
    cmdline="${line#LOKI_ENGINE=v10 }"
    second="$(printf '%s\n' "$cmdline" | awk '{print $2}')"
    case "$second" in
        quick)
            ok "example '$line' is the quick entry (routed by bin/loki to the v10 supervisor)"
            ;;
        status | verify | dashboard)
            if printf '%s\n' "$USAGE_TXT" | grep -qE "loki $second\b"; then
                ok "example '$line' uses a USAGE-listed command"
            else
                bad "example '$line' uses '$second', which is not in USAGE"
            fi
            ;;
        \"* | *\#* | http* | */*)
            # A quoted task, an owner/repo#N ref, or an issue URL: both forms
            # USAGE documents ("run the engine on a free-text task" / "run on
            # an issue"). No literal token to match, so accept the shape.
            ok "example '$line' is a task or issue-ref form"
            ;;
        *)
            bad "example '$line' uses an unrecognized command shape '$second'"
            ;;
    esac
done < <(extract_examples "$GUIDE"; extract_examples "$README")
if [ "$example_count" -gt 0 ]; then
    ok "checked $example_count fenced command example(s)"
else
    bad "no fenced 'loki ...' example found in the docs; test is inert"
fi

echo
echo "T5 -- the opt-in marker line matches bin/loki's current default"
if grep -q '_loki_engine_default="v10"' "$BIN_LOKI" 2>/dev/null; then
    flipped=1
else
    flipped=0
fi
for f in "$README" "$GUIDE"; do
    n="$(grep -c '<!-- loki10-default -->' "$f")"
    if [ "$n" -eq 1 ]; then
        ok "$(basename "$f") has exactly one loki10-default marker"
    else
        bad "$(basename "$f") has $n loki10-default markers, want exactly 1"
        continue
    fi
    marked_line="$(grep -- '<!-- loki10-default -->' "$f" | sed -e 's/<!-- loki10-default -->//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ "$flipped" -eq 1 ]; then
        if [ "$marked_line" != "Opt-in: set LOKI_ENGINE=v10" ]; then
            ok "$(basename "$f")'s marked line was updated for the flip"
        else
            bad "$(basename "$f") still reads the pre-flip opt-in line, but bin/loki now defaults to v10"
        fi
    else
        if [ "$marked_line" = "Opt-in: set LOKI_ENGINE=v10" ]; then
            ok "$(basename "$f")'s marked line reads the pre-flip opt-in wording"
        else
            bad "$(basename "$f")'s marked line reads '$marked_line', want 'Opt-in: set LOKI_ENGINE=v10'"
        fi
    fi
done

echo
echo "T6 -- README links docs/v10/GUIDE.md"
if grep -qF "docs/v10/GUIDE.md" "$README"; then
    ok "README links GUIDE.md"
else
    bad "README never links docs/v10/GUIDE.md"
fi

echo
echo "T7 -- no em or en dashes in the v10 docs"
EMDASH=$'\xe2\x80\x94'
ENDASH=$'\xe2\x80\x93'
for f in "$README" "$GUIDE"; do
    if grep -qF -- "$EMDASH" "$f" || grep -qF -- "$ENDASH" "$f"; then
        bad "$(basename "$f") contains an em or en dash"
    else
        ok "$(basename "$f") has no em or en dashes"
    fi
done

echo
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
