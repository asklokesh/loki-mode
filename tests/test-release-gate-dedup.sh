#!/usr/bin/env bash
# WF-GATE-DEDUP (FC-88): release.yml's `gate` job must not repeat work the Tests
# workflow already did, and must keep the two checks only it can make.
#
#   1. gate has no `bun test`, `bun run test`, `pytest` or `bun run typecheck`
#      (Tests runs tsc at test.yml "Typecheck loki-ts (tsc)" and the bun suites).
#   2. gate rebuilds the dist and compares it to the committed one, and compares
#      the npm tarball's dist (scripts/ci/verify-release-dist.sh build|tarball).
#   3. The Tests verdict is still enforced: `release` needs required-ci, and
#      required-ci's REQUIRED list still names Tests.
#   4. verify-release-dist.sh behaves: a debugId-only difference passes, a real
#      byte difference in the tarball or the build fails.
#
# Every assertion is checked against a mutated copy of release.yml, which must
# turn red, so the guard cannot pass vacuously.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_YML="${RELEASE_YML:-$REPO_ROOT/.github/workflows/release.yml}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

temp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || exit 2
chmod 700 "$RUN_TMP"
printf '%s\n' "$RUN_TMP" >"$RUN_TMP/.loki-run-owned"
cleanup() {
    if [ "$(cat "$RUN_TMP/.loki-run-owned" 2>/dev/null)" = "$RUN_TMP" ]; then
        rm -rf -- "$RUN_TMP"
    fi
}
trap cleanup EXIT

# gate_block <yml>: the text of the top-level `gate:` job.
gate_block() {
    awk '/^  gate:$/ {on=1; next} on && /^  [A-Za-z0-9_-]+:$/ {exit} on {print}' "$1"
}
# job_block <yml> <job>
job_block() {
    awk -v j="  $2:" '$0==j {on=1; next} on && /^  [A-Za-z0-9_-]+:$/ {exit} on {print}' "$1"
}
# code_only: drop comment lines so prose cannot satisfy or trip a check.
code_only() { grep -vE '^[[:space:]]*#'; }

# check_yml <yml>: prints one failure reason per line; empty output = all good.
check_yml() {
    local yml="$1" g rel req
    g="$(gate_block "$yml" | code_only)"
    [ -n "$g" ] || { echo "gate job not found"; return; }
    printf '%s\n' "$g" | grep -qE 'bun[[:space:]]+(run[[:space:]]+)?test' && echo "gate runs bun test"
    printf '%s\n' "$g" | grep -qE 'pytest' && echo "gate runs pytest"
    printf '%s\n' "$g" | grep -qE 'bun[[:space:]]+run[[:space:]]+typecheck' && echo "gate reruns typecheck"
    printf '%s\n' "$g" | grep -qE 'verify-release-dist\.sh[[:space:]]+build' || echo "gate lost the dist byte-identity build check"
    printf '%s\n' "$g" | grep -qE 'verify-release-dist\.sh[[:space:]]+tarball' || echo "gate lost the packed tarball dist check"
    printf '%s\n' "$g" | grep -qE 'fast-gate\.sh[[:space:]]+p9' || echo "gate lost the P9 step"
    # Order: P9 needs bun, bun deps and PyYAML, so it must come after all three.
    printf '%s\n' "$g" | grep -nE 'setup-bun|bun install --cwd loki-ts --frozen-lockfile|pip install pyyaml|fast-gate\.sh[[:space:]]+p9' \
        | awk -F: '{ if ($0 ~ /setup-bun/) b=$1; else if ($0 ~ /bun install/) i=$1; else if ($0 ~ /pyyaml/) y=$1; else p=$1 }
                   END { if (!(b && i && y && p && b < i && i < p && y < p)) print "gate runs P9 before bun, bun install or PyYAML are ready" }'
    printf '%s\n' "$g" | grep -qE 'npm pack' || echo "gate does not pack the tarball"
    rel="$(job_block "$yml" release | code_only)"
    printf '%s\n' "$rel" | grep -qE '^[[:space:]]+needs:.*required-ci' || echo "release no longer needs required-ci (Tests verdict)"
    printf '%s\n' "$rel" | grep -qE '^[[:space:]]+needs:.*\bgate\b' || echo "release no longer needs gate"
    req="$(job_block "$yml" required-ci | code_only)"
    printf '%s\n' "$req" | grep -qE "REQUIRED=.*\"Tests\"" || echo "required-ci REQUIRED list no longer names Tests"
}

# expect_clean / expect_red wrap check_yml
expect_clean() {
    local out; out="$(check_yml "$2")"
    if [ -z "$out" ]; then ok "$1"; else bad "$1"; printf '    %s\n' "$out"; fi
}
expect_red() { # name yml needle
    local out; out="$(check_yml "$2")"
    if printf '%s\n' "$out" | grep -qF "$3"; then ok "$1 turns red"; else bad "$1 stayed green (got: ${out:-nothing})"; fi
}

expect_clean "release.yml gate keeps its dedup contract" "$RELEASE_YML"

# mutate <name> <needle expected in the failure> <python replace expr on s>
mutate() {
    local name="$1" needle="$2" expr="$3" m="$RUN_TMP/mut.yml"
    if ! python3 -I - "$RELEASE_YML" "$m" "$expr" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
before = s
exec(sys.argv[3])
assert s != before, "mutation did not change the file"
open(sys.argv[2], "w").write(s)
PYEOF
    then
        bad "$name: mutation could not be applied"; return
    fi
    expect_red "$name" "$m" "$needle"
}

mutate "M1 reintroduce bun test in gate" "gate runs bun test" \
  's = s.replace("bash scripts/ci/verify-release-dist.sh build", "bash scripts/ci/verify-release-dist.sh build\n          bun test", 1)'
mutate "M2 reintroduce typecheck in gate" "gate reruns typecheck" \
  's = s.replace("bash scripts/ci/verify-release-dist.sh build", "bash scripts/ci/verify-release-dist.sh build\n          bun run typecheck", 1)'
mutate "M3 remove dist byte-identity check" "gate lost the dist byte-identity build check" \
  's = s.replace("bash scripts/ci/verify-release-dist.sh build", "true", 1)'
mutate "M4 remove tarball dist check" "gate lost the packed tarball dist check" \
  's = s.replace("verify-release-dist.sh tarball", "true", 1)'
mutate "M5 release stops needing required-ci" "release no longer needs required-ci" \
  's = s.replace("    needs: [gate, required-ci]\n    permissions:\n      contents: write", "    needs: [gate]\n    permissions:\n      contents: write", 1)'
# shellcheck disable=SC2016
mutate "M6 required-ci stops requiring Tests" "required-ci REQUIRED list no longer names Tests" \
  's = s.replace("REQUIRED=$(printf \x27%s\\n\x27 \"Tests\" \"Security Audit\")", "REQUIRED=$(printf \x27%s\\n\x27 \"Security Audit\")", 1)'

mutate "M7 remove the P9 step" "gate lost the P9 step" \
  's = s.replace("bash scripts/ci/fast-gate.sh p9", "true", 1)'
mutate "M8 move P9 above Setup Bun" "gate runs P9 before bun" \
  'a = s.index("      - name: P9 Rule of Two"); b = s.index("      - name: Verify the committed loki-ts dist"); blk = s[a:b]; s = s[:a] + s[b:]; c = s.index("      - name: Setup Bun\n"); s = s[:c] + blk + s[c:]'
mutate "M9 drop the PyYAML install" "gate runs P9 before bun" \
  's = s.replace("python3 -m pip install pyyaml", "true", 1)'

# Behavior of the verifier: copy it into a fixture repo with a committed dist.
FX="$RUN_TMP/fx"
mkdir -p "$FX/scripts/ci" "$FX/loki-ts/dist" "$RUN_TMP/pkgsrc/package/loki-ts/dist"
cp "$REPO_ROOT/scripts/ci/verify-release-dist.sh" "$FX/scripts/ci/"
for f in loki.js cockpit.js; do
    printf 'var a=1;\n\n//# debugId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n' >"$FX/loki-ts/dist/$f"
done
for f in loki.js.map cockpit.js.map; do
    printf '{"version":3,"debugId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","sources":[]}\n' >"$FX/loki-ts/dist/$f"
done
git -C "$FX" init -q
git -C "$FX" add -A
git -C "$FX" -c user.name=t -c user.email=t@example.com commit -q -m fx

pack() { # name content-of-js
    local d="$RUN_TMP/pkg-$1"
    mkdir -p "$d/package/loki-ts/dist"
    printf '%s' "$2" >"$d/package/loki-ts/dist/loki.js"
    printf '%s' "$2" >"$d/package/loki-ts/dist/cockpit.js"
    tar -czf "$RUN_TMP/$1.tgz" -C "$d" package
}
SAME=$'var a=1;\n\n//# debugId=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n'
DIFF=$'var a=2;\n\n//# debugId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'
pack same "$SAME"; pack diff "$DIFF"
if timeout -k 5 60 bash "$FX/scripts/ci/verify-release-dist.sh" tarball "$RUN_TMP/same.tgz" >/dev/null 2>&1; then
    ok "tarball with only a debugId difference passes"
else
    bad "debugId-only tarball refused"
fi
if timeout -k 5 60 bash "$FX/scripts/ci/verify-release-dist.sh" tarball "$RUN_TMP/diff.tgz" >/dev/null 2>&1; then
    bad "tarball with different bytes passed"
else
    ok "tarball with different bytes fails"
fi

echo "release-gate-dedup: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
