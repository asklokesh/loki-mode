#!/usr/bin/env bash
# FC-71: promote.yml's smoke gate must accept a legacy-titled Release-triggered
# smoke run by head_sha, let the newest run decide, and fail closed.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 not installed (not a pass)"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "  SKIPPED: jq not installed (not a pass)"; exit 0; }
python3 -I -c 'import yaml' 2>/dev/null || { echo "  SKIPPED: pyyaml not installed (not a pass)"; exit 0; }
W="$(mktemp -d "${TMPDIR:-/tmp}/promote-smoke.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$W"' EXIT
_ROOT="$REPO_ROOT" _OUT="$W/step.sh" python3 -I - <<'PY' || { echo "FAIL: cannot extract step"; exit 1; }
import os, yaml
d = yaml.safe_load(open(os.path.join(os.environ['_ROOT'], '.github/workflows/promote.yml')))
for job in d['jobs'].values():
    for st in job['steps']:
        if st.get('name') == 'Require a green Post-Release Smoke for this version':
            open(os.environ['_OUT'], 'w').write(st['run'])
            raise SystemExit(0)
raise SystemExit(1)
PY
# gh stub: apply the --jq expression to the fixture file; GHFAIL=1 simulates an API error
cat > "$W/gh" <<'STUB'
#!/usr/bin/env bash
[ "${GHFAIL:-0}" = 1 ] && exit 1
while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && { expr="$2"; break; }; shift; done
jq -r "$expr" "$FIXTURE"
STUB
chmod +x "$W/gh"
HEAD=75bbbb9465e6b2b80dc8b05a012a6d0eec576005
fails=0
run_case() { # name want_rc fixture_json [ghfail]
  printf '%s' "$3" > "$W/fx.json"
  PATH="$W:$PATH" FIXTURE="$W/fx.json" GHFAIL="${4:-0}" GITHEAD="$HEAD" VERSION=11.3.2 \
    GITHUB_REPOSITORY=o/r bash "$W/step.sh" > "$W/out" 2>&1
  rc=$?
  if [ "$rc" = "$2" ]; then echo "  ok: $1"; else echo "  FAIL: $1 (rc=$rc want $2)"; sed 's/^/    /' "$W/out"; fails=$((fails+1)); fi
}
run_case "legacy-titled green by head_sha passes" 0 \
 '{"workflow_runs":[{"display_title":"Post-Release Smoke","event":"workflow_run","head_sha":"'$HEAD'","conclusion":"success","html_url":"u"}]}'
run_case "newer red legacy run blocks" 1 \
 '{"workflow_runs":[{"display_title":"Post-Release Smoke","event":"workflow_run","head_sha":"'$HEAD'","conclusion":"failure","html_url":"u2"},{"display_title":"Post-Release Smoke","event":"workflow_run","head_sha":"'$HEAD'","conclusion":"success","html_url":"u"}]}'
run_case "no matching run blocks" 1 \
 '{"workflow_runs":[{"display_title":"Post-Release Smoke","event":"workflow_run","head_sha":"deadbeef","conclusion":"success","html_url":"u"},{"display_title":"Post-Release Smoke","event":"workflow_dispatch","head_sha":"'$HEAD'","conclusion":"success","html_url":"u"}]}'
run_case "title match still passes" 0 \
 '{"workflow_runs":[{"display_title":"Post-Release Smoke '$HEAD'","event":"workflow_run","head_sha":"x","conclusion":"success","html_url":"u"}]}'
run_case "API error fails closed" 1 '{"workflow_runs":[]}' 1
if [ "$fails" = 0 ]; then echo "PASS: promote smoke sha (5 cases)"; else echo "FAIL: $fails case(s)"; exit 1; fi
