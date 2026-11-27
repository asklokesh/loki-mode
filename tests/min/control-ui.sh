#!/usr/bin/env bash
# The dashboard UI (packages/control-plane/ui): its view logic, the Start route its New work dialog posts to (with a spawn stub, never a real
# run), and that it type-checks and builds from source into a scratch directory (the committed tree's ui/dist is never touched).
# New file: no existing tests/min file owns the dashboard UI; the CP server itself has no test here either.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. ui/src/lib/model.ts bucket(): drop the `blocked.has` line, the "holding a question" leg must fail.
#   2. ui/src/lib/model.ts money(): return "$0.00" for a null cost, the unpriced leg must fail.
#   3. ui/src/components/Spend.tsx: add the text "Sample data", the no-sample-data leg must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
CP="$ROOT/packages/control-plane"
[ -d "$CP/node_modules" ] || { echo "control-ui: run 'bun install --cwd loki-ts --frozen-lockfile' first (it installs packages/control-plane)" >&2; exit 2; }
[ -d "$CP/ui/node_modules" ] || (cd "$CP/ui" && bun install --frozen-lockfile >/dev/null 2>&1) || { echo "control-ui: bun install failed in packages/control-plane/ui" >&2; exit 2; }

echo "TEST: dashboard UI logic, Start route, build"

res="$(bun "$ROOT/tests/min/fixtures/control-ui.ts" "$ROOT" 2>&1)"
while IFS= read -r l; do
    case "$l" in PASS\ *) ok "${l#PASS }" ;; FAIL\ *) bad "${l#FAIL }" ;; esac
done <<< "$res"
case "$res" in *PASS*) ;; *) bad "driver printed no legs: $(head -3 <<< "$res" | tr '\n' ' ')" ;; esac

out="$(cd "$CP/ui" && bunx tsc --noEmit 2>&1)" && ok "the UI type-checks" || bad "UI tsc errors: $(head -3 <<< "$out" | tr '\n' ' ')"
out="$(cd "$CP/ui" && bunx vite build --outDir "$T/dist" --emptyOutDir 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [ -s "$T/dist/index.html" ] && ok "the UI builds into a scratch directory" || bad "vite build failed: $(tail -3 <<< "$out" | tr '\n' ' ')"
if grep -rqiE "sample data|loki-factory-v7" "$CP/ui/src" "$T/dist" 2>/dev/null; then bad "sample data text found in the UI source or build"; else ok "no sample data text in the UI"; fi
if grep -rqE "fonts.googleapis|cdn\." "$T/dist" 2>/dev/null; then bad "the build loads a remote font or script"; else ok "the build loads nothing remote"; fi

finish
