#!/usr/bin/env bash
#===============================================================================
# Behavioral tests for autonomy/run.sh enforce_build_check() -- honest build
# applicability in the Evidence Receipt (#47).
#
# THE anti-fake-green contract (council-caught, this is the load-bearing test):
# the writer must NEVER launder "I don't recognize your build system" into an
# explicit applicable:false (N/A). N/A is ONLY for a POSITIVE "no build phase"
# determination. A real-but-unrecognized build system (Make, Maven, Gradle, a
# non-"build" npm script) must stay an HONEST not_run gap, mirroring
# verify.sh:291's "skipped". Otherwise a real, un-run build reads VERIFIED.
#
# Three-way classification:
#   runnable  (npm "build" / go / cargo)     -> RUN it   -> verified | failed
#   present   (build system exists, not run) -> not_run  (HONEST GAP)
#   none      (positively no build phase)    -> not_applicable (N/A)
#
# Strategy (mirrors test-static-analysis-languages.sh): extract the function via
# awk, source it into a harness with stub log_* helpers, run against fixture
# repos, assert build-results.json.status. The engine is NEVER run.
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

cleanup() { [ -n "$TMPROOT" ] && rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT

TMPROOT="$(mktemp -d -t loki-buildcheck.XXXXXX)"

# Extract the supervised result predicate and enforce_build_check(), then source
# them with a stub logger and the real exact-profile predicate.
FN="$TMPROOT/fn.sh"
awk '/^_loki_supervised_build_result_passes\(\) \{/,/^\}/' "$RUN_SH" > "$FN"
awk '/^enforce_build_check\(\) \{/,/^\}/' "$RUN_SH" >> "$FN"
if ! grep -q 'enforce_build_check' "$FN"; then
    bad "could not extract enforce_build_check from run.sh"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; exit 1
fi
# shellcheck disable=SC1090
log_info() { :; }
loki_is_supervised_simple_web() {
    [ "${LOKI_SUPERVISED_BUILD:-0}" = "1" ] \
        && [ "${LOKI_BUILD_PROFILE:-}" = "simple-web" ]
}
source "$FN"

# status_of <dir> -> prints build-results.json .status (or ERR)
status_of() {
    python3 -c "import json,sys;print(json.load(open('$1/.loki/quality/build-results.json'))['status'])" 2>/dev/null || echo ERR
}

# assert_status <label> <dir> <expected>
assert_status() {
    local label="$1" dir="$2" expect="$3" got
    got="$(status_of "$dir")"
    if [ "$got" = "$expect" ]; then ok "$label ($got)"; else bad "$label: expected $expect, got $got"; fi
}

mk() { local d="$TMPROOT/$1"; mkdir -p "$d"; echo "$d"; }

# --- ANTI-FAKE-GREEN: unrecognized build systems stay a GAP (not N/A) --------
d="$(mk ts)"; printf '{"scripts":{"compile":"tsc"}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
assert_status "npm compile script (unrecognized build script)" "$d" "not_run"

d="$(mk make)"; printf 'all:\n\techo hi\n' > "$d/Makefile"
TARGET_DIR="$d" enforce_build_check
assert_status "Makefile present" "$d" "not_run"

d="$(mk mvn)"; printf '<project/>\n' > "$d/pom.xml"
TARGET_DIR="$d" enforce_build_check
assert_status "Maven pom.xml present" "$d" "not_run"

d="$(mk gradle)"; : > "$d/build.gradle"
TARGET_DIR="$d" enforce_build_check
assert_status "Gradle build.gradle present" "$d" "not_run"

# .NET -- the nullglob footgun (council-caught): a single .csproj or .sln (no
# nullglob set in run.sh) must still be detected, not laundered to N/A.
d="$(mk csproj)"; : > "$d/App.csproj"
TARGET_DIR="$d" enforce_build_check
assert_status ".NET .csproj ONLY (nullglob-safe detect)" "$d" "not_run"

d="$(mk sln)"; : > "$d/App.sln"
TARGET_DIR="$d" enforce_build_check
assert_status ".NET .sln ONLY (nullglob-safe detect)" "$d" "not_run"

# Legacy setuptools: setup.py with no pyproject [build-system] is a real build.
d="$(mk setuppy)"; printf 'from setuptools import setup\nsetup()\n' > "$d/setup.py"
TARGET_DIR="$d" enforce_build_check
assert_status "Python setup.py-only (legacy setuptools)" "$d" "not_run"

# --- Council round-3 stacks: every one must be an honest gap, never fake N/A --
# The INVERSION makes not_run the catch-all, so these hold structurally (an
# unknown/forgotten stack falls to not_run), not by enumerating each. We assert
# the exact ones the council flagged plus a few more, as a corpus.
d="$(mk gradlew)"; : > "$d/settings.gradle"; : > "$d/gradlew"
TARGET_DIR="$d" enforce_build_check
assert_status "Gradle wrapper (settings.gradle+gradlew, no root build.gradle)" "$d" "not_run"

d="$(mk autotools)"; : > "$d/configure"; : > "$d/configure.ac"; : > "$d/Makefile.in"
TARGET_DIR="$d" enforce_build_check
assert_status "Autotools (configure+configure.ac, no Makefile yet)" "$d" "not_run"

d="$(mk meson)"; : > "$d/meson.build"
TARGET_DIR="$d" enforce_build_check
assert_status "Meson meson.build" "$d" "not_run"

d="$(mk ant)"; : > "$d/build.xml"
TARGET_DIR="$d" enforce_build_check
assert_status "Ant build.xml" "$d" "not_run"

d="$(mk bazel)"; : > "$d/WORKSPACE"; : > "$d/BUILD"
TARGET_DIR="$d" enforce_build_check
assert_status "Bazel WORKSPACE+BUILD" "$d" "not_run"

d="$(mk cmake)"; : > "$d/CMakeLists.txt"
TARGET_DIR="$d" enforce_build_check
assert_status "CMake CMakeLists.txt" "$d" "not_run"

# INVERSION catch-all: a totally unknown/forgotten build manifest falls to
# not_run (honest), NEVER fake N/A. This is the whole point -- no enumeration.
d="$(mk unknownstack)"; : > "$d/BUILD.zig"; printf 'const std=@import("std");\n' > "$d/main.zig"
TARGET_DIR="$d" enforce_build_check
assert_status "unknown stack (zig, not enumerated) -> honest not_run, not fake N/A" "$d" "not_run"

# --- TRUE N/A: positively no build phase stays not_applicable ----------------
d="$(mk cli)"; printf '{"scripts":{"test":"node --test"}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
assert_status "CLI, no build script" "$d" "not_applicable"

# A bare script dir with NO package.json is IGNORANCE ("I don't recognize a build
# here"), not proof-of-no-build -> honest not_run, NEVER N/A. This is the
# inversion's convergence line: N/A requires a package.json to positively assert.
d="$(mk plain)"; printf 'print(1)\n' > "$d/app.py"
TARGET_DIR="$d" enforce_build_check
assert_status "plain script, NO package.json -> honest not_run (ignorance != N/A)" "$d" "not_run"

# --- INVERSION guard: the positive-no-build signal must NOT over-fire ---------
# The new fake-green surface is "N/A fires on a real build". A package.json with
# a build-ish script under a NON-"build" name (compile) must NOT read N/A -- the
# build-ish regex is an exclusion, so it stays not_run (an honest gap).
d="$(mk noverfire)"; printf '{"scripts":{"test":"jest","compile":"tsc"}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
assert_status "package.json with compile script -> not_run, N/A does NOT over-fire" "$d" "not_run"

# A CLI whose ONLY scripts are test/start/lint (no build-ish) -> genuine N/A.
d="$(mk clilint)"; printf '{"scripts":{"test":"jest","start":"node .","lint":"eslint ."}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
assert_status "CLI with test/start/lint only (no build-ish) -> N/A" "$d" "not_applicable"

# devDep over-fire guard: a build TOOL in devDependencies means a build exists
# even when the script is named non-"build" -> stay not_run, do not claim N/A.
d="$(mk vitedep)"; printf '{"scripts":{"test":"vitest"},"devDependencies":{"vite":"^5"}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
assert_status "package.json w/ vite devDep but no build script -> not_run (no fake N/A)" "$d" "not_run"

# --- RUNNABLE: a build we run -> verified/failed (the mirror guard) ----------
d="$(mk ok)"; printf '{"scripts":{"build":"true"}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
assert_status "npm build succeeds" "$d" "verified"

d="$(mk bad)"; printf '{"scripts":{"build":"false"}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
assert_status "npm build fails -> failed (never N/A, never green)" "$d" "failed"

# Exact hosted profile is fail-closed. The same records stay advisory elsewhere.
d="$(mk supervised-bad)"; printf '{"scripts":{"build":"false"}}' > "$d/package.json"
if LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web TARGET_DIR="$d" enforce_build_check; then
    bad "supervised failed build returned success"
else
    ok "supervised failed build returns nonzero"
fi

d="$(mk supervised-gap)"; printf '{"scripts":{"compile":"tsc"}}' > "$d/package.json"
if LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web TARGET_DIR="$d" enforce_build_check; then
    bad "supervised applicable not_run build returned success"
else
    ok "supervised applicable not_run build returns nonzero"
fi

d="$(mk supervised-ok)"; printf '{"scripts":{"build":"true"}}' > "$d/package.json"
if LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web TARGET_DIR="$d" enforce_build_check; then
    ok "supervised verified build returns success"
else
    bad "supervised verified build returned nonzero"
fi

d="$(mk advisory-bad)"; printf '{"scripts":{"build":"false"}}' > "$d/package.json"
if TARGET_DIR="$d" enforce_build_check; then
    ok "failed build remains advisory outside exact profile"
else
    bad "failed build blocked outside exact profile"
fi
if LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web TARGET_DIR="$d" enforce_build_check; then
    bad "supervised cached failed build returned success"
else
    ok "supervised cached failed build returns nonzero"
fi

# --- once-per-run: a second call reuses, does NOT rebuild --------------------
d="$(mk once)"; printf '{"scripts":{"build":"true"}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
# flip to failing; a re-run must REUSE the verified result, not rebuild
printf '{"scripts":{"build":"false"}}' > "$d/package.json"
TARGET_DIR="$d" enforce_build_check
assert_status "second call reuses (once-per-run, not rebuilt)" "$d" "verified"

# --- opt-out: applicable build, execution disabled -> honest not_run gap -----
d="$(mk optout)"; printf '{"scripts":{"build":"true"}}' > "$d/package.json"
LOKI_BUILD_CHECK=0 TARGET_DIR="$d" enforce_build_check
assert_status "LOKI_BUILD_CHECK=0 -> honest not_run gap (not fake N/A)" "$d" "not_run"

# --- WIRING ------------------------------------------------------------------
# Everything above extracts enforce_build_check and exercises it in isolation.
# That proves the FUNCTION is correct and says nothing about whether the runner
# still calls it. Verified by mutation: replacing the call site with `if true;`
# left every assertion above green -- a production build that fails would stop
# blocking completion and no test would notice.
#
# This is the caller-vs-callee gap that has now been found in nine subsystems
# here. An isolation test without a wiring assertion is only half a test.
_WIRE_RUN_SH="${RUN_SH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/run.sh}"

if grep -qE '^\s*if enforce_build_check; then' "$_WIRE_RUN_SH"; then
    ok "WIRING: the iteration loop still calls enforce_build_check"
else
    bad "WIRING: nothing calls enforce_build_check; a failed build never blocks"
fi

# The blocking half is the elif: only the supervised simple-web route turns a
# failed build into a gate failure. Losing that branch makes the gate advisory
# everywhere, which is a silent downgrade rather than a visible break.
if grep -qE '^\s*elif loki_is_supervised_simple_web; then' "$_WIRE_RUN_SH"; then
    ok "WIRING: a failed build still routes to the supervised blocking branch"
else
    bad "WIRING: the supervised branch is gone; a failed build blocks nothing"
fi

if grep -qE 'gate_failures="\$\{gate_failures\}production_build,"' "$_WIRE_RUN_SH"; then
    ok "WIRING: a failed build feeds gate_failures"
else
    bad "WIRING: the build verdict never reaches gate_failures, so nothing acts on it"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
