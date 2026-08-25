#!/usr/bin/env bash
# Security scanning covers source, Python dependencies, and secrets, not just npm.
#
# THE GAP. `grep -rlE "codeql|semgrep|bandit|gitleaks|trufflehog|pip-audit|safety"
# .github/workflows/*.yml` returned NOTHING. security-audit.yml audited npm
# dependencies only, while SIX product/test Python dependency manifests went
# unscanned: five requirements files plus the independently published Python
# SDK's sdk/python/pyproject.toml. Three requirements files ship in the npm
# package and the SDK ships on PyPI. A vulnerable Python dependency there
# reaches users, and nothing in CI would have said so.
#
# WHAT THIS TEST IS. A STATIC check of the WORKFLOW DEFINITION. It reads
# .github/workflows/security-audit.yml and asserts the scanners are wired up
# over the right inputs with the right failure posture.
#
# WHAT IT THEREFORE CANNOT PROVE. It does not run the scanners, so it cannot
# show that a tool actually detects a vulnerability/secret, that the
# pinned versions still resolve, or that the scans pass on today's tree. It
# proves the gate is CONNECTED, not that the gate WORKS. Only a live CI run
# proves the latter. Findings below the reviewed critical threshold remain
# REPORTING-ONLY, so a green CI run is not evidence of a clean tree either.
#
# ASSERTIONS ARE MADE AGAINST PARSED `run:` BODIES, NEVER THE RAW FILE TEXT.
# The workflow's posture comments name every requirements path while explaining
# the shipped-vs-test split. A raw-text grep would match those comments, so
# deleting a file from the actual audit loop would leave this test green -- the
# text-guard-fires-on-its-own-docs trap this repo has already been bitten by.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# LOKI_SECURITY_WF overrides the target so mutation-verification can run against
# a COPY. Mutating the real workflow in place and reverting with `git checkout`
# discards uncommitted work on it -- which is exactly what happened the first
# time this test was mutation-verified.
WF="${LOKI_SECURITY_WF:-$REPO_ROOT/.github/workflows/security-audit.yml}"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: security-audit.yml covers source, Python deps, and secrets, fail-closed"

[ -f "$WF" ] || { echo "  FAIL: $WF missing"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 not installed (not a pass)"; exit 0; }
python3 -c "import yaml" 2>/dev/null || { echo "  SKIPPED: pyyaml not installed (not a pass)"; exit 0; }

# Extract the concatenated `run:` bodies of one job. Comments inside a run body
# are part of the shell script and are stripped here, so an assertion can only
# be satisfied by an actual command line.
_runs() {
  _LOKI_WF="$WF" _LOKI_JOB="$1" python3 -c "
import os, re, sys, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
job = d.get('jobs', {}).get(os.environ['_LOKI_JOB'])
if not job:
    sys.exit(0)
out = []
for step in job.get('steps') or []:
    body = step.get('run')
    if not body:
        continue
    # Drop shell comments: they must not be able to satisfy an assertion.
    out.append('\n'.join(l for l in body.splitlines() if not l.strip().startswith('#')))
sys.stdout.write('\n'.join(out))
" 2>/dev/null
}

_PY_RUNS="$(_runs python-audit)"
_SECRET_RUNS="$(_runs secret-scan)"
_NPM_RUNS="$(_runs npm-audit)"

# Extract ONE step's run body, by a substring of its `name:`. Assertions about a
# specific step must be scoped to that step. Matching across the whole job lets
# an unrelated step satisfy the check -- mutation-verification caught exactly
# that here: deleting the report-parse guard stayed green because a later
# summarise step also contained `json.load`.
_step() {
  _LOKI_WF="$WF" _LOKI_JOB="$1" _LOKI_STEP="$2" python3 -c "
import os, sys, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
job = d.get('jobs', {}).get(os.environ['_LOKI_JOB']) or {}
for step in job.get('steps') or []:
    if os.environ['_LOKI_STEP'].lower() in (step.get('name') or '').lower() and step.get('run'):
        sys.stdout.write('\n'.join(
            l for l in step['run'].splitlines() if not l.strip().startswith('#')))
        break
" 2>/dev/null
}

# The step that actually invokes the scanner, as opposed to the ones that
# summarise or upload its output.
_PY_REQ_SCAN_STEP="$(_step python-audit 'pip-audit every requirements file')"
_PY_SDK_SCAN_STEP="$(_step python-audit 'pip-audit published Python SDK')"
_PY_SCAN_STEP="$_PY_REQ_SCAN_STEP
$_PY_SDK_SCAN_STEP"
_PY_ASSERT_STEP="$(_step python-audit 'Assert the audit actually produced')"
_SECRET_INSTALL_STEP="$(_step secret-scan 'Install gitleaks')"
_SECRET_SCAN_STEP="$(_step secret-scan 'gitleaks scan')"
_SECRET_ASSERT_STEP="$(_step secret-scan 'Assert the secret scan completed cleanly')"
_SAST_ASSERT_STEP="$(_step sast 'Assert CodeQL SARIF and reject unreviewed critical findings')"
_SAST_USES="$( _LOKI_WF="$WF" python3 -c "
import os, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
steps = ((d.get('jobs') or {}).get('sast') or {}).get('steps') or []
print('\\n'.join(step.get('uses', '') for step in steps if step.get('uses')))
" 2>/dev/null )"
_PY_PERMISSIONS="$( _LOKI_WF="$WF" python3 -c "
import json, os, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
job = ((d.get('jobs') or {}).get('python-audit') or {})
print(json.dumps(job.get('permissions') or {}, sort_keys=True))
" 2>/dev/null )"
_PY_JOB_NAME="$( _LOKI_WF="$WF" python3 -c "
import os, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
print((((d.get('jobs') or {}).get('python-audit') or {}).get('name') or ''))
" 2>/dev/null )"
_SECRET_CUSTODY="$( _LOKI_WF="$WF" python3 -c "
import json, os, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
job = ((d.get('jobs') or {}).get('secret-scan') or {})
checkout = next((s for s in (job.get('steps') or [])
                 if (s.get('name') or '') == 'Checkout'), {})
print(json.dumps({'permissions': job.get('permissions') or {},
                  'checkout_uses': checkout.get('uses') or '',
                  'fetch_depth': (checkout.get('with') or {}).get('fetch-depth')},
                 sort_keys=True))
" 2>/dev/null )"

# --- 1. Every Python dependency manifest is covered INDIVIDUALLY ------------
# Deliberately NOT a count. A count cannot say WHICH file was dropped, and
# tolerates losing one as long as another is added.
if [ -z "$_PY_RUNS" ]; then
  bad "no python-audit job with any run: step -- Python deps are unscanned"
else
  for _f in requirements-test.txt dashboard/requirements.txt web-app/requirements.txt \
            web-app/requirements-test.txt mcp/requirements.txt; do
    if printf '%s' "$_PY_RUNS" | grep -qF -- "$_f"; then
      ok "audited: $_f"
    else
      bad "NOT audited: $_f -- this requirements file is unscanned"
    fi
  done
fi

if printf '%s' "$_PY_SDK_SCAN_STEP" | grep -qE 'pip-audit --strict sdk/python' \
   && printf '%s' "$_PY_SDK_SCAN_STEP" | grep -q 'set -euo pipefail' \
   && ! printf '%s' "$_PY_SDK_SCAN_STEP" | grep -q '|| true' \
   && printf '%s' "$_PY_ASSERT_STEP" | grep -q 'shipped-sdk_python_pyproject.toml.json'; then
  ok "audited and new-findings-blocking: sdk/python/pyproject.toml (published Python SDK)"
else
  bad "NOT BLOCKING: sdk/python/pyproject.toml -- published Python SDK dependencies can ship unscanned"
fi

if [ "$_PY_PERMISSIONS" = '{"contents": "read"}' ]; then
  ok "pip-audit has read-only least privilege"
else
  bad "pip-audit permissions are not contents:read only ($_PY_PERMISSIONS)"
fi

if printf '%s' "$_PY_JOB_NAME" | grep -qi 'SDK new-findings-blocking'; then
  ok "pip-audit job identity names the clean SDK baseline's blocking posture"
else
  bad "pip-audit job identity does not disclose the SDK blocking threshold"
fi

# --- 2. The secret scan runs over every reachable commit --------------------
_secret_expected_custody='{"checkout_uses": "actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "fetch_depth": 0, "permissions": {"contents": "read"}}'
if printf '%s' "$_SECRET_SCAN_STEP" | grep -qE 'gitleaks git( |$)' \
   && printf '%s' "$_SECRET_SCAN_STEP" | grep -q -- '--log-opts="--all"' \
   && [ "$_SECRET_CUSTODY" = "$_secret_expected_custody" ]; then
  ok "gitleaks scans all reachable history from a full, read-only pinned checkout"
else
  bad "gitleaks history custody is incomplete -- checkout, permissions, git mode, or --all regressed"
fi

# --- 3. FAIL CLOSED: a missing tool must fail, not silently pass ------------
# The load-bearing assertion. Both scanners are continue-on-error/--exit-code 0
# so that FINDINGS report rather than block. That same setting would swallow an
# absent or crashed binary, turning "the scan never ran" into a green check that
# implies coverage. sbom.yml:7-23 records this exact failure mode in this repo:
# a workflow green for months on a dead trigger.
_py_invocations="$(printf '%s\n' "$_PY_SCAN_STEP" | grep -cE '^[[:space:]]*pip-audit ' || true)"
_py_strict_invocations="$(printf '%s\n' "$_PY_SCAN_STEP" | grep -cE '^[[:space:]]*pip-audit --strict ' || true)"
if printf '%s' "$_PY_REQ_SCAN_STEP" | grep -q 'command -v pip-audit' \
   && printf '%s' "$_PY_SDK_SCAN_STEP" | grep -q 'command -v pip-audit' \
   && printf '%s' "$_PY_SCAN_STEP" | grep -qE 'exit 1' \
   && [ "$_py_invocations" -eq 3 ] \
   && [ "$_py_strict_invocations" -eq 3 ]; then
  ok "pip-audit fails closed on tool absence and strict dependency collection across all manifests"
else
  bad "pip-audit does NOT fail closed -- tool absence or incomplete project dependency collection could report green"
fi

if printf '%s' "$_SECRET_RUNS" | grep -qE '\-x /tmp/gitleaks|command -v gitleaks' \
   && printf '%s' "$_SECRET_RUNS" | grep -qE 'exit 1'; then
  ok "gitleaks fails closed when the tool is missing"
else
  bad "gitleaks does NOT fail closed -- a missing binary would report green"
fi

# --- 4. FAIL CLOSED on a crashed scan: assert on the ARTIFACT ---------------
# An exit code alone cannot distinguish "clean" from "never ran" once findings
# are non-blocking. Each scan must produce a report that is checked for
# existence AND parseability. An empty result is an absent measurement.
# Scoped to the ASSERT step. Checking the whole job would let the summarise
# step's own json.load stand in for a deleted guard (mutation-verified).
if printf '%s' "$_PY_ASSERT_STEP" | grep -q 'json.load' \
   && printf '%s' "$_PY_ASSERT_STEP" | grep -qE '\-s "\$p"|\-f "\$p"'; then
  ok "pip-audit asserts each report exists and parses (not just an exit code)"
else
  bad "pip-audit result is not verified via its report artifact"
fi

if printf '%s' "$_SECRET_ASSERT_STEP" | grep -q 'gitleaks-report.json' \
   && printf '%s' "$_SECRET_ASSERT_STEP" | grep -q 'json.load' \
   && printf '%s' "$_SECRET_ASSERT_STEP" | grep -qE '\[ "\$n" -ne 0 \]'; then
  ok "gitleaks asserts its report exists, parses, and contains no unmatched findings"
else
  bad "gitleaks result is not verified as a parseable empty report"
fi

# --- 5. Shipped vs test-only requirements are distinguished -----------------
# Membership is from package.json files[]: dashboard/, mcp/ and
# web-app/requirements.txt ship to npm users, sdk/python/pyproject.toml ships to
# PyPI users, and the two *-test.txt do not. The split is recorded so the two
# sets can be promoted to blocking independently.
# NOTE: this asserts the DISTINCTION EXISTS, not that shipped files block --
# they do not today, by measured decision (see the workflow posture comment).
# Scoped to the SCAN step: the labels have to be applied where the reports are
# WRITTEN. Asserting across the job passed on a mutation that stripped the label
# from the audit loop, because the assert step's filename list still named it.
if printf '%s' "$_PY_SCAN_STEP" | grep -q 'shipped-' \
   && printf '%s' "$_PY_SCAN_STEP" | grep -q 'testonly-'; then
  ok "shipped and test-only requirements are tracked separately"
else
  bad "shipped and test-only requirements are indistinguishable -- cannot promote one set"
fi

# Pins the fixture the split depends on. If files[] changes, the labelling above
# becomes wrong and this says so rather than passing quietly.
_ships="$(python3 -c "
import json
f = json.load(open('$REPO_ROOT/package.json')).get('files') or []
def ships(p):
    return any(e == p or (e.endswith('/') and p.startswith(e)) for e in f)
print('ok' if ships('dashboard/requirements.txt') and ships('mcp/')
      and ships('web-app/requirements.txt')
      and not ships('requirements-test.txt')
      and not ships('web-app/requirements-test.txt') else 'drift')
" 2>/dev/null || echo error)"
_sdk_ships="$(python3 -c "
import pathlib, tomllib, yaml
root = pathlib.Path('$REPO_ROOT')
project = tomllib.loads((root / 'sdk/python/pyproject.toml').read_text()).get('project') or {}
workflow = yaml.safe_load((root / '.github/workflows/release.yml').read_text())
job = (workflow.get('jobs') or {}).get('publish-python-sdk') or {}
steps = job.get('steps') or []
print('ok' if project.get('name') == 'loki-mode-sdk'
      and any(step.get('working-directory') == 'sdk/python'
              and 'python -m build' in (step.get('run') or '') for step in steps)
      and any(step.get('working-directory') == 'sdk/python'
              and 'twine upload' in (step.get('run') or '') for step in steps)
      else 'drift')
" 2>/dev/null || echo error)"
if [ "$_ships" = "ok" ] && [ "$_sdk_ships" = "ok" ]; then
  ok "fixture intact: 3 requirements files ship via npm, Python SDK ships via PyPI, 2 test files do not"
else
  bad "FIXTURE DRIFT (npm=$_ships sdk=$_sdk_ships): shipped/test labels are now wrong"
fi

# --- 6. POSITIVE CONTROL: the existing npm audit still runs -----------------
# This change must not regress the coverage that already worked. Without this,
# a refactor that deleted the npm job would leave every other assertion green.
if printf '%s' "$_NPM_RUNS" | grep -q 'audit-check.sh'; then
  ok "the pre-existing npm audit gate still runs (not regressed)"
else
  bad "the npm audit gate is gone -- this change regressed existing coverage"
fi

# --- 7. Versions are pinned -------------------------------------------------
# An unpinned scanner changes its finding set without a commit, which silently
# moves the baseline the promotion path is measured against.
printf '%s' "$_PY_RUNS" | grep -qE "pip-audit==[0-9]" \
  && ok "pip-audit version is pinned" \
  || bad "pip-audit is unpinned -- the baseline can move without a commit"
printf '%s' "$_SECRET_RUNS" | grep -qE "gitleaks/releases/download/v[0-9]" \
  && ok "gitleaks version is pinned" \
  || bad "gitleaks is unpinned -- the baseline can move without a commit"

# Pinning the URL is not enough: a replaced or corrupted release asset would
# otherwise be extracted and executed with no byte-level provenance check. The
# digest is the official v8.30.0 linux_x64 release checksum, and verification
# must happen before extraction so no unauthenticated binary reaches /tmp.
_gitleaks_linux_x64_sha="79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e"
_gitleaks_checksum_order="$( _LOKI_BODY="$_SECRET_INSTALL_STEP" \
  _LOKI_SHA="$_gitleaks_linux_x64_sha" python3 -c "
import os
body = os.environ['_LOKI_BODY']
sha = os.environ['_LOKI_SHA']
verify = body.find(sha)
extract = body.find('tar -xzf /tmp/gitleaks.tar.gz')
print('ok' if verify >= 0 and 'sha256sum -c' in body[verify:extract]
      and extract > verify else 'missing')
" 2>/dev/null )"
if [ "$_gitleaks_checksum_order" = "ok" ]; then
  ok "gitleaks archive matches the pinned official SHA-256 before extraction"
else
  bad "gitleaks archive is executed without the pinned official pre-extraction checksum"
fi

# --- 8. Secret findings block outside an exact reviewed baseline ------------
_secret_name="$( _LOKI_WF="$WF" python3 -c "
import os, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
print(((d.get('jobs') or {}).get('secret-scan') or {}).get('name', ''))
" 2>/dev/null )"
if printf '%s' "$_secret_name" | grep -qi 'new-findings-blocking'; then
  ok "gitleaks job identity names its new-finding blocking posture"
else
  bad "gitleaks blocking posture is not explicit in the job identity"
fi

if printf '%s' "$_SECRET_SCAN_STEP" | grep -q -- '--gitleaks-ignore-path .gitleaksignore' \
   && ! printf '%s' "$_SECRET_SCAN_STEP" | grep -q -- '--exit-code 0' \
   && printf '%s' "$_SECRET_SCAN_STEP" | grep -q 'set -euo pipefail'; then
  ok "gitleaks uses the exact baseline and default blocking exit code"
else
  bad "gitleaks findings are non-blocking or the exact baseline is not selected"
fi

# Override only a disposable copy when mutation-verifying the baseline shape.
_ignore="${LOKI_GITLEAKS_IGNORE:-$REPO_ROOT/.gitleaksignore}"
_ignore_shape="$(python3 - "$_ignore" <<'PY'
import re, sys
entries = [line.strip() for line in open(sys.argv[1])
           if line.strip() and not line.lstrip().startswith('#')]
current = re.compile(r'^[^:]+:[a-z0-9-]+:[1-9][0-9]*$')
historical = re.compile(r'^[0-9a-f]{40}:[^:]+:[a-z0-9-]+:[1-9][0-9]*$')
print(len(entries), len(set(entries)),
      sum(bool(current.fullmatch(e)) for e in entries),
      sum(bool(historical.fullmatch(e)) for e in entries),
      sum(not current.fullmatch(e) and not historical.fullmatch(e) for e in entries))
PY
)"
if [ "$_ignore_shape" = "44 44 35 9 0" ]; then
  ok "gitleaks baseline contains 35 current and 9 commit-qualified historical fingerprints"
else
  bad "gitleaks baseline shape drifted ($_ignore_shape; expected 44 44 35 9 0)"
fi

# Optional live mutation proof. Exact-SHA acceptance supplies the same pinned
# v8.30.0 binary as the workflow. Ordinary repository tests retain their static
# coverage when that binary is unavailable. Both live rungs call this helper so
# the acceptance test exercises the production git-history mode, not dir mode.
_run_live_gitleaks_history() {
  local scan_root="$1" report="$2" ignore="$3"
  (cd "$scan_root" && "$LOKI_GITLEAKS_BIN" git . \
    --log-opts="--all" \
    --gitleaks-ignore-path "$ignore" --report-format json \
    --report-path "$report" --redact --no-banner >/dev/null 2>&1)
}

_live_history_helper="$(declare -f _run_live_gitleaks_history)"
if printf '%s' "$_live_history_helper" | grep -qE 'GITLEAKS_BIN.* git \.' \
   && printf '%s' "$_live_history_helper" | grep -q -- '--log-opts="--all"'; then
  ok "live gitleaks oracle is bound to git mode over all reachable history"
else
  bad "live gitleaks oracle regressed from git mode or omitted --all"
fi

if [ -n "${LOKI_GITLEAKS_BIN:-}" ]; then
  if [ ! -x "$LOKI_GITLEAKS_BIN" ]; then
    bad "LOKI_GITLEAKS_BIN is set but is not executable"
  else
    _live_clean_root=''
    _live_mutation_root=''
    _cleanup_live_gitleaks() {
      local path
      for path in "$_live_clean_root" "$_live_mutation_root"; do
        [ -n "$path" ] || continue
        case "$path" in
          "${TMPDIR:-/tmp}"/loki-gitleaks-*) rm -rf -- "$path" ;;
          *) return 64 ;;
        esac
      done
    }
    trap _cleanup_live_gitleaks EXIT

    _live_clean_root="$(mktemp -d "${TMPDIR:-/tmp}/loki-gitleaks-clean.XXXXXX")"
    _clean_report="$_live_clean_root/report.json"
    if _run_live_gitleaks_history "$REPO_ROOT" "$_clean_report" ".gitleaksignore" \
       && python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) == []' \
            "$_clean_report"; then
      ok "live gitleaks accepts the exact reviewed baseline across repository history"
    else
      bad "live gitleaks rejects the reviewed history baseline or emits findings"
    fi

    _live_mutation_root="$(mktemp -d "${TMPDIR:-/tmp}/loki-gitleaks-mutation.XXXXXX")"
    _mutation_repo="$_live_mutation_root/repo"
    _mutation_report="$_live_mutation_root/report.json"
    git init -q "$_mutation_repo"
    git -C "$_mutation_repo" config user.email "gitleaks-test@loki.local"
    git -C "$_mutation_repo" config user.name "gitleaks test"
    git -C "$_mutation_repo" config commit.gpgsign false
    git -C "$_mutation_repo" config core.hooksPath /dev/null
    cp "$_ignore" "$_mutation_repo/.gitleaksignore"
    git -C "$_mutation_repo" add .gitleaksignore
    git -C "$_mutation_repo" commit -qm "baseline" --no-gpg-sign --no-verify
    # Keep the detector literal split in this source file; only the disposable
    # committed history receives the contiguous, intentionally synthetic token.
    printf '%s%s\n' 'const key = "AKIA' 'ABCDEFGHIJKLMNOP";' \
      > "$_mutation_repo/novel-secret.js"
    git -C "$_mutation_repo" add novel-secret.js
    git -C "$_mutation_repo" commit -qm "novel secret mutation" --no-gpg-sign --no-verify
    if _run_live_gitleaks_history "$_mutation_repo" "$_mutation_report" ".gitleaksignore"; then
      bad "live git-history scan accepted a committed unmatched synthetic secret"
    elif python3 -c 'import json,sys; assert len(json.load(open(sys.argv[1]))) == 1' \
           "$_mutation_report"; then
      ok "live git-history scan blocks one committed unmatched synthetic secret"
    else
      bad "live git-history scan failed without one parseable novel-finding report"
    fi

    _cleanup_live_gitleaks
    trap - EXIT
    if [ ! -e "$_live_clean_root" ] && [ ! -e "$_live_mutation_root" ]; then
      ok "live gitleaks fixtures are fully cleaned"
    else
      bad "live gitleaks fixtures were not fully cleaned"
    fi
  fi
else
  echo "  SKIP: live gitleaks mutation proof (set LOKI_GITLEAKS_BIN to pinned v8.30.0)"
fi

# --- 9. The workflow is valid YAML -----------------------------------------
python3 -c "import yaml;yaml.safe_load(open('$WF'))" 2>/dev/null \
  && ok "security-audit.yml parses as YAML" \
  || bad "security-audit.yml is not valid YAML"

# --- 10. SAST covers supported shipped languages ---------------------------
# CodeQL has no Bash extractor. The matrix must cover BOTH supported product
# surfaces without implying the shell CLI is analyzed.
_sast_matrix="$( _LOKI_WF="$WF" python3 -c "
import os, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
langs = (((d.get('jobs') or {}).get('sast') or {}).get('strategy') or {}).get('matrix', {}).get('language', [])
print(' '.join(langs))
" 2>/dev/null )"
for _lang in javascript-typescript python; do
  if printf '%s\n' "$_sast_matrix" | grep -qw -- "$_lang"; then
    ok "CodeQL SAST matrix covers $_lang"
  else
    bad "CodeQL SAST matrix does not cover $_lang"
  fi
done

# --- 11. SAST tooling and results are immutable/auditable ------------------
if printf '%s' "$_SAST_USES" | grep -qE 'github/codeql-action/init@[0-9a-f]{40}' \
   && printf '%s' "$_SAST_USES" | grep -qE 'github/codeql-action/analyze@[0-9a-f]{40}'; then
  ok "CodeQL actions are pinned to immutable commits"
else
  bad "CodeQL actions are not pinned to immutable commits"
fi

if printf '%s' "$_SAST_ASSERT_STEP" | grep -q 'glob.glob' \
   && printf '%s' "$_SAST_ASSERT_STEP" | grep -q 'json.load' \
   && printf '%s' "$_SAST_ASSERT_STEP" | grep -q '2.1.0' \
   && printf '%s' "$_SAST_ASSERT_STEP" | grep -q 'security-severity' \
   && printf '%s' "$_SAST_ASSERT_STEP" | grep -q 'severity < 9.0' \
   && printf '%s' "$_SAST_ASSERT_STEP" | grep -q 'primaryLocationLineHash' \
   && printf '%s' "$_SAST_ASSERT_STEP" | grep -q 'identity in reviewed_critical' \
   && printf '%s' "$_SAST_ASSERT_STEP" | grep -q 'identity in seen_critical'; then
  ok "CodeQL fails closed on missing SARIF and unreviewed/duplicate critical identities"
else
  bad "CodeQL result lacks exact-fingerprint critical enforcement"
fi

_reviewed_identity_count="$(printf '%s' "$_SAST_ASSERT_STEP" \
  | grep -cE '^ *\("py/command-line-injection", "[^\"]+", "[0-9a-f]{15,16}:1"\),$' || true)"
if [ "$_reviewed_identity_count" -eq 7 ]; then
  ok "CodeQL gate contains exactly seven path-bound reviewed critical fingerprints"
else
  bad "CodeQL reviewed critical set is not exactly seven path-bound fingerprints"
fi

_sast_name="$( _LOKI_WF="$WF" python3 -c "
import os, yaml
d = yaml.safe_load(open(os.environ['_LOKI_WF']))
print(((d.get('jobs') or {}).get('sast') or {}).get('name', ''))
" 2>/dev/null )"
if printf '%s' "$_sast_name" | grep -qi 'critical-blocking'; then
  ok "CodeQL job identity names its critical-blocking posture"
else
  bad "CodeQL critical-blocking posture is not explicit in the job identity"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
