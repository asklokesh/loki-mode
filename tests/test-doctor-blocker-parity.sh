#!/usr/bin/env bash
# `loki doctor` must name its blockers and offer a zero-install next step, on
# BOTH routes, on a host with nothing installed.
#
# WHY THIS EXISTS -- and it is an adoption bug, not a cosmetic one. The bash
# route ends a failed doctor with the blockers named and:
#
#     Meanwhile 'loki tour' works right now -- no provider, no key, no spend.
#
# The Bun route printed "Some required prerequisites are missing / Install
# missing dependencies and run 'loki doctor' again." That names nothing and
# offers no way forward. A first-time evaluator with no provider CLI -- exactly
# the person deciding whether to keep this tool -- hit a dead end on one route
# and a working demo on the other.
#
# It went unnoticed locally because this machine HAS a provider CLI, so doctor
# passed and the trailer never printed. Only CI, on a bare runner, ran the
# failing path. That is why this test builds a stripped PATH rather than
# trusting the developer's own machine.
#
# The bun-parity workflow compares the two routes' stdout byte for byte, so
# this also guards the gate itself: a reworded trailer on either side fails
# here first, locally, instead of after a push.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# A PATH with the core utilities but NO provider CLI, so the failing branch runs.
# Stripping PATH entirely is not viable: the shell then cannot find its own
# interpreter and exits 127 before doctor renders anything.
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
for b in bash sh python3 python sed awk grep cat tr head tail sort uniq wc \
         date mkdir rm ls printf env dirname basename cut find xargs stat \
         node jq git curl df uname bun; do
    # Resolve via command -v rather than guessing directories: hardcoding
    # /opt/homebrew/bin is one developer's layout (and is rejected by
    # tests/test-no-hardcoded-paths.sh for exactly that reason). This finds
    # each tool wherever THIS machine keeps it.
    _src="$(command -v "$b" 2>/dev/null)"
    [ -n "$_src" ] && ln -sf "$_src" "$SHIM/$b" 2>/dev/null
done

# stdout only, matching what the bun-parity gate captures. The provider install
# hint deliberately goes to stderr on both routes.
# Invoked exactly as .github/workflows/bun-parity.yml does it: bin/loki is the
# Bun route by default, LOKI_LEGACY_BASH=1 selects bash. Driving autonomy/loki
# directly with LOKI_SDK_LOOP=1 does NOT switch routes -- it runs bash both
# times and the parity assertion passes vacuously, which is exactly what
# happened on the first version of this test.
env PATH="$SHIM" LOKI_LEGACY_BASH=1 "$REPO_ROOT/bin/loki" doctor >"$SHIM/bash.txt" 2>/dev/null
bash_rc=$?
env PATH="$SHIM" "$REPO_ROOT/bin/loki" doctor >"$SHIM/bun.txt" 2>/dev/null
bun_rc=$?

if [ ! -s "$SHIM/bash.txt" ] || [ ! -s "$SHIM/bun.txt" ]; then
    # Empty output means the harness broke (shim too thin), not that the routes
    # agree. Reporting parity over two empty files would be a vacuous pass.
    bad "harness: one or both routes produced no output; assertion inconclusive"
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 1
fi
ok "both routes produced output on a provider-less host"

# The condition under test must actually have been triggered. If a provider
# leaked through the shim, doctor passes and this test proves nothing.
if [ "$bash_rc" -eq 0 ]; then
    printf 'SKIP: a provider CLI is reachable through the shim; the failing path did not run\n'
    printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
    exit 0
fi
ok "the failing path ran (doctor exited ${bash_rc})"

# Normalize MACHINE-SPECIFIC noise before comparing, mirroring what
# .github/workflows/bun-parity.yml does. Three differences are properties of a
# developer's laptop, not of the code, and a clean CI runner never produces
# them: Apple's jq reports "1.7.1apple" to one route and "1.7.1" to the other,
# and skill paths render as ~ on one side and an absolute $HOME on the other.
# Leaving them in would make this test fail on every Mac and pass in CI --
# the precise inversion of what a local pre-push gate is for.
_norm() {
    sed -E 's/Disk space: [0-9]+GB/Disk space: NGB/g' "$1" \
      | sed -E '/Runtime route:/,/^$/d' \
      | sed -E '/Phase 1 artifacts:/,/^$/d' \
      | sed -E '/Cockpit:/,/^$/d' \
      | sed -E 's/\(v([0-9.]+)apple\)/(v\1)/g' \
      | sed -E "s#${HOME}#~#g"
}
_norm "$SHIM/bash.txt" > "$SHIM/bash.norm"
_norm "$SHIM/bun.txt"  > "$SHIM/bun.norm"

# THE PARITY ASSERTION. bun-parity compares these byte for byte.
if diff -u "$SHIM/bash.norm" "$SHIM/bun.norm" >"$SHIM/d.txt" 2>&1; then
    ok "both routes print byte-identical doctor output"
else
    bad "routes diverge -- bun-parity will fail: $(head -c 200 "$SHIM/d.txt" | tr '\n' ' ')"
fi

# Both must exit nonzero: doctor stays CI-gateable on either route.
if [ "$bun_rc" -ne 0 ]; then
    ok "the Bun route also exits nonzero (still gateable)"
else
    bad "the Bun route exited 0 with a required check failing"
fi

# THE ADOPTION ASSERTION, which is the point of the whole file. A failed doctor
# must offer the zero-install path rather than only listing what is broken.
for route in bash bun; do
    if grep -q "loki tour" "$SHIM/${route}.txt"; then
        ok "the ${route} route points at 'loki tour' (works with no provider, key, or spend)"
    else
        bad "the ${route} route leaves a first-run user with no way forward"
    fi
done

# Machine-readable doctor output is routinely archived by CI and MCP clients.
# Skill locations must remain actionable without exposing an absolute HOME.
mkdir -p "$SHIM/home"
mkdir -p "$SHIM/home/.claude/skills"
ln -s "$SHIM/home/private/PACKET744_SECRET_VALUE" \
    "$SHIM/home/.claude/skills/loki-mode"
env HOME="$SHIM/home" PATH="$SHIM" LOKI_LEGACY_BASH=1 \
    "$REPO_ROOT/bin/loki" doctor --json >"$SHIM/bash.json" 2>/dev/null
bash_json_rc=$?
env HOME="$SHIM/home" PATH="$SHIM" BUN_FROM_SOURCE=1 \
    "$REPO_ROOT/bin/loki" doctor --json >"$SHIM/bun.json" 2>/dev/null
bun_json_rc=$?
if [ "$bash_json_rc" -ne 0 ] && [ "$bun_json_rc" -ne 0 ] \
   && jq -e --arg root "$SHIM" '
        (.skills | length == 4)
        and ([.skills[].path] == [
          "~/.claude/skills/loki-mode",
          "~/.codex/skills/loki-mode",
          "~/.cline/skills/loki-mode",
          "~/.aider/skills/loki-mode"
        ])
        and ((.skills | tostring | contains($root)) | not)
        and ((.skills | tostring | contains("PACKET744_SECRET_VALUE")) | not)
        and (.skills[0].detail == "broken symlink. Fix: loki setup-skill")
      ' "$SHIM/bash.json" >/dev/null \
   && jq -e --arg root "$SHIM" '
        (.skills | length == 4)
        and ([.skills[].path] == [
          "~/.claude/skills/loki-mode",
          "~/.codex/skills/loki-mode",
          "~/.cline/skills/loki-mode",
          "~/.aider/skills/loki-mode"
        ])
        and ((.skills | tostring | contains($root)) | not)
        and ((.skills | tostring | contains("PACKET744_SECRET_VALUE")) | not)
        and (.skills[0].detail == "broken symlink. Fix: loki setup-skill")
      ' "$SHIM/bun.json" >/dev/null; then
    ok "doctor JSON keeps skill paths user-relative on both routes"
else
    bad "doctor JSON leaked an absolute HOME path or changed the skill-path contract"
fi

# Blockers must be NAMED. "Some prerequisites are missing" is the failure mode
# this replaced: it tells the user something is wrong but not what.
for route in bash bun; do
    if grep -q "Blocking (" "$SHIM/${route}.txt" && grep -q "  - " "$SHIM/${route}.txt"; then
        ok "the ${route} route names each blocker"
    else
        bad "the ${route} route reports a failure without naming what blocks the user"
    fi
done


#------------------------------------------------------------------------------
# A-123: one Ready line; only the selected provider blocks. Throwaway HOME under
# a loki-run temp dir; the real ~/.loki is never touched (doctor never creates a
# key, asserted below).
#------------------------------------------------------------------------------
A123_T="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")"
A123_H="$A123_T/home"
mkdir -p "$A123_H/.claude/skills/loki-mode" "$A123_H/.cline/skills" "$A123_T/with-claude" "$A123_T/no-claude"
printf '# SKILL\n' > "$A123_H/.claude/skills/loki-mode/SKILL.md"
ln -s "$A123_T/gone" "$A123_H/.cline/skills/loki-mode"
for _b in with-claude/claude no-claude/codex; do
    printf '#!/bin/sh\nexit 0\n' > "$A123_T/$_b"; chmod +x "$A123_T/$_b"
done
# $1 route (bash|bun), $2 stub dir, $3 provider, $4 out file; prints the exit code.
a123_run() {
    local route="$1" stub="$2" prov="$3" out="$4" rc=0
    if [ "$route" = bash ]; then
        env HOME="$A123_H" PATH="$stub:/opt/homebrew/bin:/usr/bin:/bin" LOKI_LEGACY_BASH=1 \
            ANTHROPIC_API_KEY=doctor-fixture-not-a-key LOKI_PROVIDER="$prov" LOKI_NO_BROWSER=1 \
            bash "$REPO_ROOT/autonomy/loki" doctor >"$out" 2>/dev/null || rc=$?
    else
        env HOME="$A123_H" PATH="$stub:$(dirname "$(command -v bun)"):/opt/homebrew/bin:/usr/bin:/bin" \
            ANTHROPIC_API_KEY=doctor-fixture-not-a-key LOKI_PROVIDER="$prov" LOKI_NO_BROWSER=1 \
            bun "$REPO_ROOT/loki-ts/src/cli.ts" doctor >"$out" 2>/dev/null || rc=$?
    fi
    echo "$rc"
}

if command -v bun >/dev/null 2>&1; then
    for scen in "with-claude claude" "no-claude claude" "no-claude codex"; do
        set -- $scen
        rc_a="$(a123_run bash "$A123_T/$1" "$2" "$A123_T/pb.txt")"
        rc_b="$(a123_run bun "$A123_T/$1" "$2" "$A123_T/pt.txt")"
        if [ "$rc_a" = "$rc_b" ] && [ "$(tail -1 "$A123_T/pb.txt")" = "$(tail -1 "$A123_T/pt.txt")" ] && [ -n "$(tail -1 "$A123_T/pb.txt")" ]; then
            ok "A-123 parity ($1 $2): same exit code and identical last line"
        else
            bad "A-123 parity ($1 $2): bash rc=$rc_a '$(tail -1 "$A123_T/pb.txt")' vs bun rc=$rc_b '$(tail -1 "$A123_T/pt.txt")'"
        fi
    done
fi

rm -rf "$A123_T"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
