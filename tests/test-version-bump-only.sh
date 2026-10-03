#!/usr/bin/env bash
# S-132: test.yml skips its heavy jobs on a version-bump-only push whose
# parent's Tests run succeeded, and runs in full otherwise.
#
# WHY THIS IS HIGH RISK. A Tests run whose jobs are all skipped concludes
# success, and release.yml required-ci accepts success at the release SHA
# without looking at the parent. So the gate must be no looser than
# release.yml required-ci STEP 1, and must itself confirm the parent's Tests
# run succeeded. This suite proves:
#
#   1. PARITY: STEP 1 is pulled out of release.yml by its content markers
#      ("# STEP 1:" .. "# STEP 2:") and run on the same fixture diffs as
#      scripts/ci/version-bump-only.sh. Both must agree AND match the expected
#      verdict (parity alone passes when both sides break the same way).
#      Loosening the script's allowlist flips the README fixture; tightening
#      it flips the pure-bump fixture.
#   2. GATE: skip=true only for an eligible diff plus a completed, successful,
#      push-event run named Tests at the parent. Pending, red, absent,
#      pull_request-only, another workflow's success, or a gh error: skip=false.
#   3. WIRING: test.yml's gate job has actions: read, runs the version-bump
#      consistency checks with no condition, and every other job needs the
#      gate and runs unless skip is exactly 'true' (and a failed gate runs
#      the suite rather than skipping it).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_YML="$REPO_ROOT/.github/workflows/release.yml"
TEST_YML="$REPO_ROOT/.github/workflows/test.yml"
GATE_SH="${VBO_SCRIPT:-$REPO_ROOT/scripts/ci/version-bump-only.sh}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vbo-test.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT

gitc() { git -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@"; }

echo "== release.yml STEP 1 extraction =="
BLOCK="$WORK/step1.sh"
awk '/^ *# STEP 1:/{f=1} /^ *# STEP 2:/{f=0} f' "$RELEASE_YML" | sed 's/^          //' > "$BLOCK"
# shellcheck disable=SC2016  # literal: expands when the block runs
printf '%s\n' 'echo "VERDICT=$ELIGIBLE"' >> "$BLOCK"
if [ -s "$BLOCK" ] && grep -q 'ALLOWLIST = {' "$BLOCK" \
   && [ "$(grep -c '^PYEOF$' "$BLOCK")" = "1" ] && grep -q "<<'PYEOF'" "$BLOCK"; then
  ok "STEP 1 extracted by content markers (non-empty, has ALLOWLIST and a closed PYEOF heredoc)"
else
  bad "STEP 1 extraction is empty or malformed; parity below would be vacuous"
fi

# Verdict parity below cannot reach every branch (loki.js.map, the NUL guard),
# so also require the normalizer bodies to be byte-identical.
awk '/<<.PYEOF.$/{f=1;next} /^          PYEOF$/{f=0} f' "$RELEASE_YML" | sed 's/^          //' > "$WORK/py-release"
awk '/<<.PYEOF.$/{f=1;next} /^PYEOF$/{f=0} f' "$GATE_SH" > "$WORK/py-script"
if [ -s "$WORK/py-release" ] && [ -s "$WORK/py-script" ] && cmp -s "$WORK/py-release" "$WORK/py-script"; then
  ok "script's python normalizer is byte-identical to release.yml STEP 1's ($(wc -l < "$WORK/py-script" | tr -d ' ') lines)"
else
  bad "script's python normalizer differs from release.yml STEP 1's (or one side is empty)"
fi

# ---------------------------------------------------------------- fixtures
BASE="$WORK/base"
mkdir -p "$BASE/loki-ts/dist" "$BASE/autonomy" "$BASE/wiki" "$BASE/web-app/src/components"
(
  cd "$BASE" || exit 1
  git init -q .
  printf '1.2.3\n' > VERSION
  printf '{"name":"x","version":"1.2.3","devDependencies":{"jest":"^29.0.0"}}\n' > package.json
  printf '# Skill v1.2.3\n\nbody\n\nv1.2.3\n' > SKILL.md
  printf '# Changelog\n\nblurb\n\n## v1.2.3\n- old\n' > CHANGELOG.md
  printf 'guide 1.2.3, pins lib ^21.2.3\n' > CLAUDE.md
  printf 'var V="1.2.3";\nconsole.log(V);\n//# debugId=aaaa-1111\n' > loki-ts/dist/loki.js
  printf 'Loki 1.2.3\n' > README.md
  printf 'echo hi\n' > autonomy/run.sh
  printf '<span>\n  v1.2.3\n</span>\n' > web-app/src/components/Footer.tsx
  git add -A && gitc commit -q -m base
) || { echo "fixture base setup failed"; exit 1; }

bump_core() {  # $1 = new version; the files a real bump touches
  printf '%s\n' "$1" > VERSION
  printf '{"name":"x","version":"%s","devDependencies":{"jest":"^29.0.0"}}\n' "$1" > package.json
  printf '# Skill v%s\n\nbody\n\nv%s\n' "$1" "$1" > SKILL.md
}

make_fixture() {  # $1 = name; $2 = shell to apply in the clone; prints nothing
  local d="$WORK/fx-$1"
  git clone -q "$BASE" "$d" || return 1
  ( cd "$d" && eval "$2" && git add -A && gitc commit -q -m "$1" ) >/dev/null 2>&1
}

release_verdict() {  # $1 = repo dir, $2 = event -> prints 1 or 0
  ( cd "$1" && EVENT_NAME="$2" SHA="$(git rev-parse HEAD)" bash "$BLOCK" 2>/dev/null ) \
    | sed -n 's/^VERDICT=//p' | tail -n 1
}

script_verdict() {  # $1 = repo dir, $2 = event -> prints 1 or 0
  if ( cd "$1" && EVENT_NAME="$2" SHA="$(git rev-parse HEAD)" "$GATE_SH" check 2>/dev/null ); then
    echo 1
  else
    echo 0
  fi
}

# name | expected | event | change
FIXTURES="$WORK/fixtures.txt"
cat > "$FIXTURES" <<'EOF'
pure-bump|1|push|bump_core 1.2.4; printf '# Changelog\n\nblurb\n\n## v1.2.4\n- new\n\n## v1.2.3\n- old\n' > CHANGELOG.md; printf 'var V="1.2.4";\nconsole.log(V);\n//# debugId=bbbb-2222\n' > loki-ts/dist/loki.js
skill-only-bump|1|push|printf '1.2.4\n' > VERSION; printf '# Skill v1.2.4\n\nbody\n\nv1.2.4\n' > SKILL.md
bump-plus-source|0|push|bump_core 1.2.4; printf 'echo bye\n' > autonomy/run.sh
dist-beyond-version|0|push|bump_core 1.2.4; printf 'var V="1.2.4";\nconsole.log(V, 1);\n//# debugId=bbbb-2222\n' > loki-ts/dist/loki.js
changelog-rewrites-old|0|push|bump_core 1.2.4; printf '# Changelog\n\nblurb\n\n## v1.2.4\n- new\n\n## v1.2.3\n- EDITED\n' > CHANGELOG.md
chmod-allowlisted|0|push|bump_core 1.2.4; chmod +x SKILL.md
rename-into-allowlist|0|push|bump_core 1.2.4; mkdir -p wiki; git mv CLAUDE.md wiki/Home.md
malformed-version|0|push|printf '1.2.4-rc1\n' > VERSION
readme-version-only|0|push|printf '1.2.4\n' > VERSION; printf 'Loki 1.2.4\n' > README.md
not-a-push|0|pull_request|bump_core 1.2.4
footer-version-only|1|push|bump_core 1.2.4; printf '<span>\n  v1.2.4\n</span>\n' > web-app/src/components/Footer.tsx
footer-beyond-version|0|push|bump_core 1.2.4; printf '<span>\n  v1.2.4 beta\n</span>\n' > web-app/src/components/Footer.tsx
dep-spec-collateral|1|push|printf '1.2.4\n' > VERSION; printf 'guide 1.2.4, pins lib ^21.2.4\n' > CLAUDE.md
EOF

echo "== parity: release.yml STEP 1 vs scripts/ci/version-bump-only.sh =="
n=0
while IFS='|' read -r name expect event change; do
  [ -n "$name" ] || continue
  if ! make_fixture "$name" "$change"; then
    bad "$name: fixture could not be built"
    continue
  fi
  n=$((n+1))
  r="$(release_verdict "$WORK/fx-$name" "$event")"
  s="$(script_verdict "$WORK/fx-$name" "$event")"
  if [ "$r" = "$expect" ] && [ "$s" = "$expect" ]; then
    ok "$name: release=$r script=$s expected=$expect"
  else
    bad "$name: release='$r' script='$s' expected=$expect"
    ( cd "$WORK/fx-$name" && EVENT_NAME="$event" SHA="$(git rev-parse HEAD)" "$GATE_SH" check 2>&1 | sed 's/^/      /' )
  fi
done < "$FIXTURES"
if [ "$n" -ge 6 ]; then
  ok "parity ran on $n fixture diffs (floor 6)"
else
  bad "parity ran on only $n fixture diffs (floor 6)"
fi
# dep-spec-collateral is eligible by the normalizer on purpose: "^21.2.3" ->
# "^21.2.4" is byte-identical modulo the version (CLAUDE.md here, package.json
# in the real incident). That is the v9.8.0 jest
# incident, and why the WIRING section requires the consistency checks to run
# on every push, skipped or not.

echo "== gate: parent Tests verdict =="
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/gh" <<'EOF'
#!/usr/bin/env bash
# Fake gh: records its args, applies the real --jq filter to a fixture.
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
[ "${FAKE_GH_FAIL:-0}" = "1" ] && exit 1
filter=""
while [ $# -gt 0 ]; do
  case "$1" in --jq) filter="$2"; shift 2 ;; *) shift ;; esac
done
jq -r "$filter" "$FAKE_GH_JSON"
EOF
chmod +x "$FAKEBIN/gh"

run_json() {  # $1 = event $2 = name $3 = status $4 = conclusion
  printf '{"workflow_runs":[{"event":"%s","name":"%s","status":"%s","conclusion":"%s"}]}\n' "$1" "$2" "$3" "$4"
}

gate_out() {  # $1 = fixture dir, $2 = json, $3 = gh fail flag
  printf '%s' "$2" > "$WORK/runs.json"
  : > "$WORK/gh.log"
  ( cd "$1" && PATH="$FAKEBIN:$PATH" FAKE_GH_JSON="$WORK/runs.json" FAKE_GH_LOG="$WORK/gh.log" \
      FAKE_GH_FAIL="$3" EVENT_NAME=push SHA="$(git rev-parse HEAD)" REPO=o/r GH_TOKEN=x \
      "$GATE_SH" gate 2>/dev/null )
}

if ! command -v jq >/dev/null 2>&1; then
  bad "jq not on PATH; the gate cases cannot apply the real --jq filter"
else
  ELIG="$WORK/fx-pure-bump"
  NOTELIG="$WORK/fx-bump-plus-source"
  PARENT_SHA="$(cd "$ELIG" && git rev-parse HEAD^)"
  check_gate() {  # $1 label, $2 dir, $3 json, $4 fail flag, $5 expected
    local out; out="$(gate_out "$2" "$3" "$4")"
    if [ "$out" = "skip=$5" ]; then ok "$1 -> skip=$5"; else bad "$1 -> got '$out', want skip=$5"; fi
  }
  check_gate "eligible + parent Tests success" "$ELIG" "$(run_json push Tests completed success)" 0 true
  if grep -q "head_sha=$PARENT_SHA" "$WORK/gh.log"; then
    ok "gate queried the parent SHA, not the pushed one"
  else
    bad "gate did not query head_sha=$PARENT_SHA (log: $(cat "$WORK/gh.log"))"
  fi
  check_gate "eligible + parent Tests in progress (never waits)" "$ELIG" "$(run_json push Tests in_progress null)" 0 false
  check_gate "eligible + parent Tests failure" "$ELIG" "$(run_json push Tests completed failure)" 0 false
  check_gate "eligible + parent Tests cancelled" "$ELIG" "$(run_json push Tests completed cancelled)" 0 false
  check_gate "eligible + no parent runs" "$ELIG" '{"workflow_runs":[]}' 0 false
  check_gate "eligible + pull_request-only success" "$ELIG" "$(run_json pull_request Tests completed success)" 0 false
  check_gate "eligible + another workflow's success" "$ELIG" "$(run_json push 'Security Audit' completed success)" 0 false
  check_gate "eligible + gh error" "$ELIG" "$(run_json push Tests completed success)" 1 false
  check_gate "not eligible + parent Tests success" "$NOTELIG" "$(run_json push Tests completed success)" 0 false
  # S-153: release.sh --bump-only now rewrites Footer.tsx; a version-only edit reuses, anything more runs in full.
  check_gate "Footer version-only bump + parent Tests success" "$WORK/fx-footer-version-only" "$(run_json push Tests completed success)" 0 true
  check_gate "Footer beyond-version bump + parent Tests success" "$WORK/fx-footer-beyond-version" "$(run_json push Tests completed success)" 0 false
fi

echo "== wiring: test.yml =="
if python3 - "$TEST_YML" <<'PYEOF'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
jobs = wf["jobs"]
fails = []
G = "version-bump-gate"
names = list(jobs)
if not names or names[0] != G:
    fails.append(f"first job is {names[:1]}, want {G}")
g = jobs.get(G, {})
perms = g.get("permissions") or {}
if perms.get("actions") != "read" or perms.get("contents") != "read":
    fails.append(f"gate permissions {perms}, want actions: read and contents: read")
if "skip" not in (g.get("outputs") or {}):
    fails.append("gate declares no skip output")
steps = g.get("steps") or []
runs = [(s.get("run") or "", s.get("if")) for s in steps]
if not any("test_version_bump_safety.py" in r and c is None for r, c in runs):
    fails.append("gate does not run tests/test_version_bump_safety.py unconditionally")
for t in ("test-server-json-current.sh", "test-plugin-json-current.sh"):
    if not any(t in r and c is None for r, c in runs):
        fails.append(f"gate does not run tests/{t} unconditionally")
if not any("scripts/ci/version-bump-only.sh gate" in r for r, _ in runs):
    fails.append("gate does not run scripts/ci/version-bump-only.sh gate")
for name in names[1:]:
    j = jobs[name]
    needs = j.get("needs") or []
    needs = [needs] if isinstance(needs, str) else needs
    if G not in needs:
        fails.append(f"{name}: does not need {G}")
    cond = str(j.get("if", "")).replace(" ", "")
    if "needs.version-bump-gate.outputs.skip!='true'" not in cond:
        fails.append(f"{name}: if does not require skip != 'true' ({j.get('if')!r})")
    if "!cancelled()" not in cond:
        fails.append(f"{name}: if lacks !cancelled(), so a failed gate would skip the suite")
if len(names) < 9:
    fails.append(f"only {len(names)} jobs parsed; expected the gate plus the 8+ heavy jobs")
for f in fails:
    print("    " + f)
sys.exit(1 if fails else 0)
PYEOF
then
  ok "gate job wired first, with actions: read, unconditional consistency checks, and every heavy job gated"
else
  bad "test.yml wiring (see lines above)"
fi

echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]
