#!/usr/bin/env bash
# CI cache steps must never land in a job that holds a write token or a
# publish secret (moat P9). Caching a job that can push would let a cache
# entry poisoned by an untrusted PR feed a job with write access.
#
# This parses .github/workflows/test.yml with a real YAML loader and asserts,
# for every job that contains a cache step (`cache: pip` on a setup-* action,
# or an actions/cache@ step): its EFFECTIVE permissions (its own job-level
# `permissions:` block, or the workflow-level default when the job has none)
# must NOT include `contents: write`, and its step text must NOT reference
# secrets.NPM_TOKEN / DOCKERHUB / HOMEBREW.
#
# THE DEFECT THIS REPLACED: the previous version used `grep -A5 permissions:`
# on an awk-split text block. A permissions mapping is not bounded to 5 lines
# -- GitHub grants ~10 scopes (actions, checks, contents, deployments,
# issues, packages, pull-requests, statuses, ...) and `contents: write` can
# sit anywhere in that list. A -A5 window misses it whenever it is not among
# the first five keys, which silently turns the guard into a no-op for any
# job whose permissions block lists contents last. T3 below is a regression
# fixture that reproduces exactly that shape.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/test.yml"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

if [ ! -f "$WORKFLOW" ]; then
    bad "workflow file not found: $WORKFLOW"
    echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
    exit 1
fi

if ! python3 -c 'import yaml' 2>/dev/null; then
    bad "python3 yaml module not available -- cannot parse the workflow"
    echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
    exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Emits one TSV line per job in the given workflow file:
#   name<TAB>has_cache(0/1)<TAB>effective_contents_write(0/1)<TAB>has_publish_secret(0/1)
# "Effective" permissions = the job's own `permissions:` mapping, falling
# back to the workflow-level default when the job declares none -- this is
# what GitHub actually enforces, and what the old text-window grep could not
# see past its first 5 lines.
extract_jobs() {
    python3 - "$1" <<'PY'
import sys, yaml, json

with open(sys.argv[1]) as f:
    wf = yaml.safe_load(f)

top_perms = wf.get('permissions', {}) or {}
jobs = wf.get('jobs', {}) or {}

def job_has_cache(job):
    for step in job.get('steps', None) or []:
        if not isinstance(step, dict):
            continue
        uses = step.get('uses') or ''
        if isinstance(uses, str) and uses.startswith('actions/cache@'):
            return True
        with_block = step.get('with') or {}
        if isinstance(with_block, dict) and with_block.get('cache') == 'pip':
            return True
    return False

def contents_write(perms):
    if isinstance(perms, str):
        return perms == 'write-all'
    if isinstance(perms, dict):
        return perms.get('contents') == 'write'
    return False

def has_publish_secret(job):
    text = json.dumps(job)
    return any(s in text for s in ('NPM_TOKEN', 'DOCKERHUB', 'HOMEBREW'))

for name, job in jobs.items():
    if not isinstance(job, dict):
        continue
    effective_perms = job.get('permissions', top_perms)
    print('\t'.join([
        name,
        '1' if job_has_cache(job) else '0',
        '1' if contents_write(effective_perms) else '0',
        '1' if has_publish_secret(job) else '0',
    ]))
PY
}

echo "T1 -- parser finds jobs"

if ! extract_jobs "$WORKFLOW" > "$WORK/real.tsv" 2>"$WORK/real.err"; then
    bad "YAML parser failed on $WORKFLOW: $(cat "$WORK/real.err")"
    echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
    exit 1
fi

job_count="$(wc -l < "$WORK/real.tsv" | tr -d ' ')"
if [ "$job_count" -gt 0 ]; then
    ok "parser found $job_count job(s)"
else
    bad "parser found zero jobs in $WORKFLOW -- the parser is broken, not the workflow"
fi

echo
echo "T2 -- every job with a cache step holds no write permission and no publish secret"

checked_cache_job=0
while IFS=$'\t' read -r job has_cache write secret; do
    [ "$has_cache" -eq 1 ] || continue
    checked_cache_job=$((checked_cache_job + 1))

    if [ "$write" -eq 1 ]; then
        bad "$job: has a cache step AND an effective contents:write permission"
    else
        ok "$job: no effective write permission alongside its cache step"
    fi

    if [ "$secret" -eq 1 ]; then
        bad "$job: has a cache step AND references a publish secret"
    else
        ok "$job: no publish-secret reference alongside its cache step"
    fi
done < "$WORK/real.tsv"

if [ "$checked_cache_job" -eq 0 ]; then
    bad "no job in $WORKFLOW has a cache step -- nothing to guard (add pip/bun caches first)"
else
    ok "$checked_cache_job job(s) with cache steps checked"
fi

echo
echo "T3 -- regression fixture: contents:write listed last in a long permissions block"
echo "      (the shape a fixed -A5 window would miss)"

cat > "$WORK/fixture.yml" <<'FIXTURE'
name: fixture
on: push
jobs:
  cache-job-long-perms:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      checks: read
      deployments: read
      issues: read
      packages: read
      pull-requests: read
      statuses: read
      contents: write
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: pip
      - run: echo hi
FIXTURE

if extract_jobs "$WORK/fixture.yml" > "$WORK/fixture.tsv" 2>"$WORK/fixture.err"; then
    fixture_line="$(grep '^cache-job-long-perms' "$WORK/fixture.tsv")"
    fixture_write="$(printf '%s' "$fixture_line" | cut -f3)"
    if [ "$fixture_write" = "1" ]; then
        ok "fixture: contents:write detected despite being the 8th line of an 8-scope block"
    else
        bad "fixture: contents:write NOT detected -- the detector regressed to a bounded window"
    fi
else
    bad "YAML parser failed on fixture: $(cat "$WORK/fixture.err")"
fi

# D90: test.yml is the fast gate (it absorbed Tier A, which no longer exists).
# slice-*, train/** and main all run it; only train/** refs cancel superseded
# runs, never main. The 8-shard shell matrix lives in full-suite.yml, which
# nightly.yml calls.
if python3 - "$REPO_ROOT/.github/workflows" <<'PY'
import sys, yaml
d = sys.argv[1]
t = yaml.safe_load(open(d + '/test.yml'))
f = yaml.safe_load(open(d + '/full-suite.yml'))
n = yaml.safe_load(open(d + '/nightly.yml'))
trig = lambda w: w.get(True) or w.get('on')
tb = trig(t)['push']['branches']
errs = []
for need in ('main', 'train/**', 'slice-*'):
    if need not in tb: errs.append('test.yml lost ' + need)
if f['jobs']['shell-tests']['strategy']['matrix']['shard'] != list(range(8)): errs.append('full-suite shell-tests no longer 8 shards')
if 'full' not in n['jobs'] or 'full-suite.yml' not in str(n['jobs']['full'].get('uses', '')): errs.append('nightly.yml does not call full-suite.yml')
if 'schedule' not in trig(n): errs.append('nightly.yml lost its schedule')
steps = ' '.join(str(s.get('run', '')) for j in t['jobs'].values() for s in j.get('steps', []))
for need in ('fast-gate.sh plan', 'fast-gate.sh run', 'fast-gate.sh p9', 'structural-checks.sh', 'test-shard-coverage.sh', 'bun run typecheck'):
    if need not in steps: errs.append('test.yml missing ' + need)
c = t['concurrency']
cip = str(c['cancel-in-progress'])
if 'refs/heads/train/' not in cip: errs.append('train refs do not cancel in progress')
if 'refs/heads/main' in cip or 'slice-' in cip: errs.append('cancel-in-progress mentions main or slice')
if 'github.sha' not in str(c['group']) or 'refs/heads/train/' not in str(c['group']): errs.append('group is not per-ref for train and per-sha otherwise')
print('\n'.join(errs)); sys.exit(1 if errs else 0)
PY
then ok "D90: Tests is the fast gate on slice/train/main; full 8-shard matrix is nightly via full-suite.yml; only train cancels"
else bad "D90 workflow shape (see above)"; fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
