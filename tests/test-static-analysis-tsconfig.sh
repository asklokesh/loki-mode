#!/usr/bin/env bash
#===============================================================================
# Regression tests for autonomy/run.sh v7.5.12 static-analysis fixes:
#
#   A) Triage #2: when tsconfig.json exists, the TS gate must invoke
#      `tsc --noEmit -p .` ONCE so paths/baseUrl resolve. Path-aliased
#      imports like `@/x` must not false-block iterations.
#
#   B) Triage #3: shellcheck gate must use `-S error` so style/info/warning
#      findings on WIP shell scripts do not block iteration.
#
# Strategy:
#   - Build a tmpdir fixture that mirrors a Next.js-style project (tsconfig
#     with paths, src/main.ts that imports `@/x`).
#   - Source enforce_static_analysis() in a controlled manner is hard
#     (run.sh has heavy top-level setup), so we instead exercise the same
#     CLI surface the gate uses: `tsc --noEmit -p .` should succeed where
#     `tsc --noEmit "$f"` fails. That proves the fix's contract.
#   - For Triage #3 we grep autonomy/run.sh for the `-S error` flag on the
#     shellcheck invocation in enforce_static_analysis() and confirm the
#     blocking call no longer fires on style/info severity.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    if [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ]; then
        rm -rf "$TMPROOT"
    fi
}
trap cleanup EXIT

#-------------------------------------------------------------------------------
# Sanity: run.sh syntax must parse (touched in v7.5.12).
#-------------------------------------------------------------------------------
if bash -n "$RUN_SH" 2>/dev/null; then
    ok "autonomy/run.sh parses with bash -n"
else
    bad "autonomy/run.sh failed bash -n parse"
fi

#-------------------------------------------------------------------------------
# Triage #2 fixture: Next.js-style tsconfig with `@/*` path alias
#-------------------------------------------------------------------------------
TMPROOT=$(mktemp -d -t loki-static-analysis-tsconfig.XXXXXX)
PROJECT="$TMPROOT/proj"
mkdir -p "$PROJECT/src"

cat > "$PROJECT/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Node",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "strict": false,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
JSON

cat > "$PROJECT/src/x.ts" <<'TS'
export const greet = (name: string) => `hi ${name}`;
TS

cat > "$PROJECT/src/main.ts" <<'TS'
import { greet } from "@/x";
console.log(greet("world"));
TS

#-------------------------------------------------------------------------------
# Test A1: per-file `tsc --noEmit "$f"` (the OLD pre-7.5.12 gate behavior)
#          must FAIL on path-aliased imports -- this proves the bug exists
#          and our fix is meaningful. Skip if tsc not available.
#-------------------------------------------------------------------------------
if command -v tsc >/dev/null 2>&1; then
    if (cd "$PROJECT" && tsc --noEmit --jsx preserve --target esnext src/main.ts) >/dev/null 2>&1; then
        bad "old per-file tsc unexpectedly succeeded on @/x import (cannot demonstrate bug)"
    else
        ok "old per-file tsc fails on @/x import (bug pre-condition confirmed)"
    fi

    #---------------------------------------------------------------------------
    # Test A2: NEW v7.5.12 gate behavior -- `tsc --noEmit -p .` must SUCCEED
    # on the same project because tsconfig paths resolve.
    #---------------------------------------------------------------------------
    if (cd "$PROJECT" && tsc --noEmit -p .) >/dev/null 2>&1; then
        ok "tsc --noEmit -p . resolves @/x via tsconfig paths (no false block)"
    else
        bad "tsc --noEmit -p . unexpectedly failed on path-aliased import"
    fi
else
    ok "SKIP: tsc not on PATH; cannot exercise TS gate (test infra ok)"
fi

#-------------------------------------------------------------------------------
# Test A3: run.sh must contain the new project-mode invocation (`tsc --noEmit -p .`)
# inside enforce_static_analysis(). Greps the source to verify the fix is wired.
#-------------------------------------------------------------------------------
if grep -q 'tsc --noEmit -p \.' "$RUN_SH"; then
    ok "run.sh wires tsc --noEmit -p . in enforce_static_analysis"
else
    bad "run.sh does NOT contain tsc --noEmit -p . (Triage #2 fix missing)"
fi

#-------------------------------------------------------------------------------
# Test B1: shellcheck gate must use `-S error` (Triage #3).
#-------------------------------------------------------------------------------
if grep -qE 'shellcheck -S error "\$\{TARGET_DIR' "$RUN_SH"; then
    ok "run.sh shellcheck gate uses -S error severity (Triage #3 fix wired)"
else
    bad "run.sh shellcheck gate missing -S error flag"
fi

#-------------------------------------------------------------------------------
# Test B2: behavioral check -- a script with only style/info findings must NOT
# fail under `shellcheck -S error`. Skip if shellcheck not on PATH.
#-------------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
    STYLE_SH="$TMPROOT/style.sh"
    cat > "$STYLE_SH" <<'BASH'
#!/usr/bin/env bash
# Triggers SC2086 (info/warning) but no error severity.
files="a b c"
echo $files
BASH
    if shellcheck -S error "$STYLE_SH" >/dev/null 2>&1; then
        ok "shellcheck -S error does not block on style/info findings (SC2086 only)"
    else
        bad "shellcheck -S error unexpectedly blocked on style-only script"
    fi

    # Also confirm a HARD error (e.g. unmatched quote) DOES still block.
    ERR_SH="$TMPROOT/error.sh"
    cat > "$ERR_SH" <<'BASH'
#!/usr/bin/env bash
echo "unterminated
BASH
    if shellcheck -S error "$ERR_SH" >/dev/null 2>&1; then
        bad "shellcheck -S error failed to block on unterminated quote (error severity)"
    else
        ok "shellcheck -S error still blocks on real error severity (parse error)"
    fi
else
    ok "SKIP: shellcheck not on PATH; behavioral check skipped"
fi

#-------------------------------------------------------------------------------
echo
echo "=========================================="
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
echo "=========================================="
[ "$FAIL" -eq 0 ]
