#!/usr/bin/env bash
#===============================================================================
# Event Bus exact-id match (TypeScript) test
#
# Regression for an event-loss bug in events/bus.ts:
#   EventBus.markProcessed() located the pending file with a SUBSTRING match
#   (files.filter(f => f.includes(event.id))). When one event id is a substring
#   of another id, marking the shorter event processed also archived the
#   longer-id (superstring) event's file -- silently losing that event. The fix
#   matches the exact id at the filename boundary (f.endsWith(`_${id}.json`)),
#   mirroring the Python impl's `*_${id}.json` glob.
#
# NON-VACUITY: against the OLD .includes() matcher this assertion FAILS, because
#   marking id "abc" processed would also archive the "_abcdef.json" file, so the
#   superstring event would NOT survive (proven live during development).
#
# The TypeScript bus.ts is exercised via tsx. If tsx is unavailable the test is
# reported as skipped (a clear message), not silently passed.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUS_TS="$PROJECT_ROOT/events/bus.ts"

PASS=0
FAIL=0

echo "Event Bus exact-id match (bus.ts) test"
echo "======================================"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-busid.XXXXXX")"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# How to exercise bus.ts, in order of preference:
#   1) tsc (typescript is a declared devDep, so `npm install` makes `npx tsc`
#      available in CI): compile bus.ts + the test to JS, run with node. This is
#      the CI-real path -- it actually exercises bus.ts under GitHub Actions.
#   2) tsx (developer machines): run the .ts directly.
#   3) bun: run the .ts directly.
# If none are available the test is reported as skipped (honest), never a silent
# green.
RUN_MODE=""
if npx --no-install tsc --version >/dev/null 2>&1; then
    RUN_MODE="tsc"
elif npx --no-install tsx --version >/dev/null 2>&1; then
    RUN_MODE="tsx"
elif command -v bun >/dev/null 2>&1; then
    RUN_MODE="bun"
fi

if [[ -z "$RUN_MODE" ]]; then
    echo "  [SKIP] no TypeScript toolchain (tsc/tsx/bun) available; cannot exercise bus.ts"
    echo "Results: skipped (no TS toolchain)"
    exit 0
fi

# For the tsc path we compile a local copy of bus.ts so the test can import it
# by a relative specifier; for tsx/bun we import bus.ts by absolute path.
if [[ "$RUN_MODE" == "tsc" ]]; then
    cp "$BUS_TS" "$WORK/bus.ts"
    BUS_IMPORT="./bus"
else
    BUS_IMPORT="$BUS_TS"
fi

TEST_TS="$WORK/exact_id.ts"
cat > "$TEST_TS" <<EOF
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventBus } from "${BUS_IMPORT}";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loki-busid-run-"));
const loki = path.join(root, ".loki");
const bus = new EventBus(loki);
const pending = path.join(loki, "events", "pending");

// Two events whose ids are in a substring relationship.
const shortId = "abc";
const longId = "abcdef"; // contains "abc"
bus.emit({ type: "task", source: "cli", id: shortId, payload: { n: 1 } });
bus.emit({ type: "task", source: "cli", id: longId, payload: { n: 2 } });

let files = fs.readdirSync(pending).filter((f) => f.endsWith(".json"));
if (files.length !== 2) {
  console.error("setup FAIL: expected 2 pending, got", files);
  process.exit(1);
}

// Mark ONLY the short-id event processed.
const shortEvent: any = {
  id: shortId, type: "task", source: "cli",
  timestamp: "x", payload: {}, version: "1.0",
};
bus.markProcessed(shortEvent, true);

files = fs.readdirSync(pending).filter((f) => f.endsWith(".json"));
const longSurvives = files.some((f) => f.endsWith("_" + longId + ".json"));
const shortGone = !files.some((f) => f.endsWith("_" + shortId + ".json"));

fs.rmSync(root, { recursive: true, force: true });

if (longSurvives && shortGone) {
  console.log("OK");
  process.exit(0);
}
console.error("FAIL longSurvives=", longSurvives, "shortGone=", shortGone, "remaining=", files);
process.exit(1);
EOF

run_test_program() {
    case "$RUN_MODE" in
        tsc)
            # Compile bus.ts + the test to CommonJS JS, then run with node.
            # --noEmitOnError false: still emit JS even if type-resolution
            # produces diagnostics (e.g. a missing @types/node in a minimal
            # env). We judge the test by the RUNTIME behavior of the emitted JS,
            # not tsc's exit code, so a type-only warning never false-fails the
            # behavioral assertion. If no JS is emitted at all, that is a real
            # failure surfaced below.
            npx --no-install tsc "$WORK/bus.ts" "$TEST_TS" \
                --outDir "$WORK/out" --module commonjs --target ES2020 \
                --moduleResolution node --skipLibCheck --strict false \
                --noEmitOnError false >"$WORK/tsc.log" 2>&1 || true
            if [[ ! -f "$WORK/out/exact_id.js" ]]; then
                echo "TSC_FAIL: no JS emitted"
                cat "$WORK/tsc.log"
                return 1
            fi
            node "$WORK/out/exact_id.js" 2>&1
            ;;
        tsx)
            npx --no-install tsx "$TEST_TS" 2>&1
            ;;
        bun)
            bun "$TEST_TS" 2>&1
            ;;
    esac
}

echo "  (TS run mode: $RUN_MODE)"
if out=$(run_test_program) && echo "$out" | grep -q "^OK$"; then
    echo "  [PASS] markProcessed exact-id match: superstring-id event survives, target archived"
    PASS=$((PASS + 1))
else
    echo "  [FAIL] markProcessed lost a superstring-id event (substring false-hit)"
    echo "         $out"
    FAIL=$((FAIL + 1))
fi

echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
