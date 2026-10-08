#!/usr/bin/env bash
# scripts/ci/fast-gate.sh -- the blocking push/release gate (D90, CI-FAST).
#
#   fast-gate.sh plan BASE [HEAD] OUTDIR   compute plan.tsv + matrix.json
#   fast-gate.sh run PLAN SHARD            run one shard of a plan
#   fast-gate.sh p9                        the moat P9 (Rule of Two) case only
#
# plan: the diff BASE...HEAD goes through scripts/select-tests.sh (the one
# shared file-to-suite mapping). Files that make the selector answer R0 (a
# broad-blast-radius or unknown-shape path) are NOT expanded to the full suite
# here; they are mapped to the structural guards that name that path
# (workflows, docker/Dockerfiles, package manifests, tests/lib, dist). The rest of
# the diff still gets its normal R1-R6 selection. The ONLY full-set fallback
# is a diff that cannot be computed (unparseable), which writes FULL.
#
# plan.tsv columns: kind, target, estimated seconds, shard. Estimated seconds
# come from tests/shard-durations.tsv (measured), default 8s for an unknown
# suite. The shard count is chosen so each shard targets <= 60s of estimate.
# Anything the fast gate skips is covered by the nightly full run (D90).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 2
export LOKI_NO_BROWSER=1

SHARD_TARGET_S="${FAST_GATE_SHARD_TARGET_S:-60}"
MAX_SHARDS="${FAST_GATE_MAX_SHARDS:-12}"
# PLAN-BOUND: above this many changed files, diff-to-suite selection picks
# nearly everything anyway and its per-file greps are the slow part; go FULL
# (the fail-safe direction) without calling the selector.
MAX_PLAN_FILES="${FAST_GATE_MAX_PLAN_FILES:-150}"
SUITE_LIMIT="${FAST_GATE_SUITE_LIMIT:-100}"

# Mirrors the R0 case patterns in scripts/select-tests.sh. tests/test-fast-gate.sh
# fails if this list and the selector's answer ever disagree.
is_r0_path() {
    case "$1" in
        tests/lib/* | tests/run-all-tests.sh | package.json | */package.json \
            | requirements*.txt | requirements*.in | */requirements*.txt | */requirements*.in \
            | loki-ts/dist/* | VERSION | .github/workflows/*) return 0 ;;
    esac
    case "$1" in
        tests/* | loki-ts/* | dashboard/* | web-app/* | skills/* | autonomy/* \
            | providers/* | memory/* | mcp/* | events/* | docs/* | scripts/* \
            | references/* | templates/* | benchmarks/* | wiki/* | plugins/* \
            | vscode-extension/* | SKILL.md | CLAUDE.md | README.md | CHANGELOG.md) return 1 ;;
        *.sh | *.py | *.md | *.ts | *.tsx | *.js | *.mjs | *.json | *.yml | *.yaml) return 1 ;;
    esac
    return 0
}

# has_baseline: stdin test paths -> those the full suite also runs (so they have a green
# baseline). pytest files are collected by the python runners and always pass through.
has_baseline() {
    local t b
    while IFS= read -r t; do
        case "$t" in
            *.py) printf '%s\n' "$t"; continue ;;
        esac
        b="${t##*/}"
        if grep -qF -- "$b" tests/run-all-tests.sh scripts/local-ci.sh tests/shard-durations.tsv 2>/dev/null \
            || grep -qF -- "$b" .github/workflows/full-suite.yml .github/workflows/nightly.yml 2>/dev/null; then
            printf '%s\n' "$t"
        fi
    done
}

# guards_for FILE: print test files that guard that R0-class path.
guards_for() {
    local f="$1" base
    base="${f##*/}"
    # FC-54: options BEFORE `--`; after it --include is a file operand and the filter is silently dropped.
    # tests that name the exact path or the basename (docker/Dockerfile.control-plane
    # selects tests/test-control-plane.sh this way)
    # FC-67: the grep result is only a candidate set. VERSION and the manifest names are mentioned by hundreds of
    # tests (fixtures, prose) that do not guard the file (their guards are the explicit lists below), and a
    # candidate with no green baseline (not run by the full suite) fails here for reasons
    # unrelated to the change. Keep only baseline-registered .sh candidates.
    case "$f" in
        VERSION | package.json | */package.json | requirements*.txt | requirements*.in | */requirements*.txt | */requirements*.in) ;;
        *)
        { grep -rlF --include='test-*.sh' --include='test_*.py' -- "$f" tests 2>/dev/null
          grep -rlF --include='test-*.sh' --include='test_*.py' -- "$base" tests 2>/dev/null
        } | has_baseline
        ;;
    esac
    case "$f" in
        .github/workflows/*)
            grep -rlF --include='test-*.sh' --include='test_*.py' -- ".github/workflows" tests 2>/dev/null
            printf '%s\n' tests/test-shard-coverage.sh tests/test-registration-coverage.sh
            ;;
        docker/Dockerfile*)
            printf '%s\n' tests/test-structural-checks.sh
            ;;
        package.json | */package.json | requirements*.txt | requirements*.in | */requirements*.txt | */requirements*.in)
            ls tests/test-*package* tests/test-*lockfile* tests/test-*manifest* tests/test-release-dist-guard.sh \
                tests/test-release-bump-dist.sh tests/test_version_bump_safety.py 2>/dev/null
            ;;
        tests/lib/* | tests/run-all-tests.sh)
            printf '%s\n' tests/test-shard-coverage.sh tests/test-registration-coverage.sh tests/test-structural-checks.sh
            ;;
        loki-ts/dist/* | VERSION)
            printf '%s\n' tests/test-release-dist-guard.sh tests/test-engine10-dist.sh tests/test-release-bump-dist.sh \
                tests/test_version_bump_safety.py tests/test-server-json-current.sh tests/test-plugin-json-current.sh
            ;;
    esac
}

cmd_plan() {
    local base="${1:-}" head="${2:-HEAD}" out="${3:-}"
    if [ -z "$out" ]; then out="${2:-}"; head=HEAD; fi
    [ -n "$out" ] || { echo "usage: fast-gate.sh plan BASE [HEAD] OUTDIR" >&2; return 2; }
    mkdir -p "$out" || return 2
    : >"$out/plan.tsv"
    if [ -z "$base" ]; then
        # "${head}^": when HEAD is itself the release tag commit, describing HEAD
        # returns that tag and the diff is empty; start from its parent.
        base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "${head}^" 2>/dev/null || true)"
    fi
    local files
    if [ -n "${FAST_GATE_FILES_FILE:-}" ] && [ "${FAST_GATE_TEST_MODE:-}" = "1" ]; then
        # Test-only hook (tests/test-fast-gate.sh): a fixed changed-file list.
        files="$(cat "$FAST_GATE_FILES_FILE")"; base="${base:-test}"
    elif [ -z "$base" ] || ! files="$(git diff --name-only "${base}...${head}" -- . 2>/dev/null)"; then
        echo "fast-gate: cannot compute a diff (base='${base}'): failing safe to the FULL set" >&2
        printf 'FULL\tunparseable-diff\t0\t0\n' >"$out/plan.tsv"
        write_matrix "$out"
        return 0
    fi
    if [ -z "$(printf '%s' "$files" | tr -d '[:space:]')" ]; then
        echo "fast-gate: the diff file list is empty (base='${base}'): failing safe to the FULL set" >&2
        printf 'FULL\tempty-diff\t0\t0\n' >"$out/plan.tsv"
        write_matrix "$out"
        return 0
    fi
    printf '%s\n' "$files" >"$out/changed.txt"
    local nfiles
    nfiles="$(printf '%s\n' "$files" | grep -c .)"
    if [ "$nfiles" -gt "$MAX_PLAN_FILES" ]; then
        echo "fast-gate: ${nfiles} changed files exceed ${MAX_PLAN_FILES}: failing safe to the FULL set" >&2
        printf 'FULL\ttoo-many-files\t0\t0\n' >"$out/plan.tsv"
        write_matrix "$out"
        return 0
    fi

    : >"$out/r0.txt"
    : >"$out/rest.txt"
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        if is_r0_path "$f"; then printf '%s\n' "$f" >>"$out/r0.txt"; else printf '%s\n' "$f" >>"$out/rest.txt"; fi
    done <"$out/changed.txt"

    : >"$out/raw.tsv"
    if [ -s "$out/rest.txt" ]; then
        # --files mode has no git history for the run.sh/loki hunk refinement and
        # falls back to a path/basename grep (a superset, never a miss).
        bash scripts/select-tests.sh --files-from "$out/rest.txt" >"$out/raw.tsv" || {
            printf 'FULL\tselector-failed\t0\t0\n' >"$out/plan.tsv"; write_matrix "$out"; return 0; }
    fi
    if grep -q '^R0' "$out/raw.tsv"; then
        # Defence in depth: the pre-filter above must have removed every R0 path.
        printf 'FULL\tselector-answered-R0-on-prefiltered-diff\t0\t0\n' >"$out/plan.tsv"
        write_matrix "$out"
        return 0
    fi
    # R8: the global guard set (scripts/global-guards.tsv) runs on every plan, even when every changed
    # path was R0-class and rest.txt is empty. The python step below dedups against the selector's own R8 rows.
    bash scripts/select-tests.sh --guards-only >>"$out/raw.tsv" || {
        printf 'FULL\tglobal-guards-unreadable\t0\t0\n' >"$out/plan.tsv"; write_matrix "$out"; return 0; }
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        guards_for "$f" | sort -u | while IFS= read -r t; do
            [ -f "$t" ] || continue
            case "$t" in
                *.py) printf 'G\tpy_test\t%s\n' "$t" ;;
                *.js) printf 'G\tnode_test\t%s\n' "$t" ;;
                *) printf 'G\tshell_test\t%s\n' "$t" ;;
            esac
        done >>"$out/raw.tsv"
    done <"$out/r0.txt"

    python3 - "$out" "$SHARD_TARGET_S" "$MAX_SHARDS" <<'PYEOF'
import math, os, re, sys
out, target, maxs = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
dur = {}
names = {}
for line in open("tests/run-all-tests.sh", errors="replace"):
    m = re.match(r'\s*run_test\s+"([^"]+)"\s+"?\$SCRIPT_DIR/([^"\s]+)', line)
    if m:
        names[os.path.basename(m.group(2))] = m.group(1)
for line in open("tests/shard-durations.tsv"):
    if line.startswith("#") or "\t" not in line:
        continue
    n, s = line.rstrip("\n").split("\t")[:2]
    try:
        dur[n] = float(s)
    except ValueError:
        pass
seen, rows, deferred = set(), [], []
for line in open(os.path.join(out, "raw.tsv")):
    p = line.rstrip("\n").split("\t")
    if len(p) < 3:
        continue
    kind, target_ = p[1], p[2]
    # Same filter as scripts/impacted-gate.sh: the selector's own fixture suite
    # is selected by R3 for nearly any diff and takes minutes; run it only
    # when it or the selector changed (R2).
    if p[0] == "R3" and target_ == "tests/test-select-tests.sh":
        continue
    # Moat P9 has its own job; the other properties run as plain scripts.
    if kind == "moat" and target_.endswith("p9-rule-of-two.sh"):
        continue
    if kind == "bun_typecheck":
        continue  # the typecheck job always runs tsc
    key = (kind, target_)
    if key in seen:
        continue
    seen.add(key)
    base = os.path.basename(target_)
    if kind in ("bash_n", "shellcheck", "py_syntax"):
        cost = 2.0
    elif kind == "bun_test":
        cost = 10.0
    else:
        cost = dur.get(names.get(base, ""), 8.0)
    # A suite estimated over 80s cannot fit a 90s job. It is deferred to the
    # nightly full run (D90) unless its own file changed (R2) or a path guard
    # selected it (G); the deferral is listed, never silent.
    if cost > 80 and p[0] not in ("R2", "G", "R8"):
        deferred.append("%s\t%s\t%g\n" % (kind, target_, cost))
        continue
    rows.append([kind, target_, cost])
rows.sort(key=lambda r: -r[2])
total = sum(r[2] for r in rows)
n = 0 if not rows else min(maxs, max(1, math.ceil(total / target)))
loads = [0.0] * n
for r in rows:
    i = loads.index(min(loads))
    loads[i] += r[2]
    r.append(i)
open(os.path.join(out, "deferred.tsv"), "w").writelines(deferred)
with open(os.path.join(out, "plan.tsv"), "w") as f:
    for r in rows:
        f.write("%s\t%s\t%g\t%d\n" % tuple(r))
PYEOF
    write_matrix "$out"
    echo "fast-gate: base=$base head=$head files=$(wc -l <"$out/changed.txt" | tr -d ' ') planned=$(wc -l <"$out/plan.tsv" | tr -d ' ')"
}

write_matrix() {
    local out="$1" n
    if grep -q '^FULL' "$out/plan.tsv"; then
        printf 'full=true\nshards=[]\nhas_shards=false\n' >"$out/outputs.txt"
        return 0
    fi
    n="$(awk -F'\t' 'NF>=4 && $4+0>m {m=$4+0} NF>=4 {c=1} END{print (c? m+1 : 0)}' "$out/plan.tsv")"
    if [ "$n" -eq 0 ]; then
        printf 'full=false\nshards=[]\nhas_shards=false\n' >"$out/outputs.txt"
        return 0
    fi
    printf 'full=false\nshards=[%s]\nhas_shards=true\n' "$(awk -v n="$n" 'BEGIN{for(i=0;i<n;i++) printf "%s%d",(i?",":""),i}')" >"$out/outputs.txt"
}

cmd_run() {
    local plan="${1:-}" shard="${2:-}" fail=0 kind target est sh rc
    [ -f "$plan" ] && [ -n "$shard" ] || { echo "usage: fast-gate.sh run PLAN SHARD" >&2; return 2; }
    local ran=0
    while IFS=$'\t' read -r kind target est sh; do
        [ -n "$kind" ] && [ "$sh" = "$shard" ] || continue
        ran=$((ran + 1))
        echo "--- $kind $target (est ${est}s) ---"
        case "$kind" in
            bash_n) bash -n "$target"; rc=$? ;;
            shellcheck)
                if command -v shellcheck >/dev/null 2>&1; then
                    ex="SC1090,SC1091"
                    case "$target" in providers/*.sh | tests/*.sh) ex="$ex,SC2034" ;; esac
                    shellcheck -S warning -e "$ex" "$target"; rc=$?
                else rc=0; fi ;;
            py_syntax) python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$target"; rc=$? ;;
            shell_test | moat) timeout -k 10 "$SUITE_LIMIT" bash "$target"; rc=$? ;;
            py_test | pytest) timeout -k 10 "$SUITE_LIMIT" python3 -m pytest -q "$target"; rc=$? ;;
            bun_test) (cd loki-ts && timeout -k 10 "$SUITE_LIMIT" bun test "${target#loki-ts/}"); rc=$? ;;
            node_test) timeout -k 10 "$SUITE_LIMIT" node --test "$target"; rc=$? ;;
            node_lint)
                # The shard installs only the root and loki-ts deps; install the target's own
                # locked deps so the linter binary exists (FC-67), instead of failing rc=127.
                if [ ! -x "$target/node_modules/.bin/eslint" ]; then
                    (cd "$target" && timeout -k 10 "${FAST_GATE_INSTALL_LIMIT:-300}" npm ci --ignore-scripts --no-audit --no-fund) || echo "fast-gate: npm ci failed in $target"
                fi
                (cd "$target" && timeout -k 10 "$SUITE_LIMIT" npm run lint); rc=$? ;;
            *) echo "unknown kind: $kind" >&2; rc=2 ;;
        esac
        if [ "$rc" -ne 0 ]; then echo "FAIL rc=$rc: $kind $target"; fail=1; else echo "ok: $kind $target"; fi
    done <"$plan"
    echo "fast-gate: shard $shard ran $ran item(s), $([ "$fail" -eq 0 ] && echo PASS || echo FAIL)"
    return "$fail"
}

# P9 only. The three prerequisites are PyYAML, bun (the hermetic injection case
# drives the real issue path) and git/perl. All four CASE lines must be PASS and
# be the ones registered in tests/moat/cases.txt, so a deleted case cannot turn
# this green; the full registry ratchet stays in the nightly moat run.
cmd_p9() {
    local out rc=0 id="" n=0
    out="$(mktemp "${TMPDIR:-/tmp}/p9.XXXXXX")" || return 2
    bash tests/moat/p9-rule-of-two.sh >"$out" 2>&1 || rc=$?
    grep '^CASE ' "$out" | cut -c1-140
    if [ "$rc" -ne 0 ]; then echo "P9 FAIL: script rc=$rc"; tail -n 30 "$out"; rm -f "$out"; return 1; fi
    if grep -E '^CASE P9\.[^ ]+ FAIL' "$out" >/dev/null; then echo "P9 FAIL: a case failed"; rm -f "$out"; return 1; fi
    for id in $(awk '/^[ \t]*#/ || NF==0 {next} $1 ~ /^P9[.]/ {print $1}' tests/moat/cases.txt); do
        n=$((n + 1))
        grep -q "^CASE $id PASS" "$out" || { echo "P9 FAIL: registered case $id did not report PASS"; rm -f "$out"; return 1; }
    done
    [ "$n" -gt 0 ] || { echo "P9 FAIL: no P9 case registered in tests/moat/cases.txt"; rm -f "$out"; return 1; }
    rm -f "$out"
    echo "P9 PASS"
}

case "${1:-}" in
    plan) shift; cmd_plan "$@" ;;
    run) shift; cmd_run "$@" ;;
    p9) cmd_p9 ;;
    *) echo "usage: fast-gate.sh plan|run|p9" >&2; exit 2 ;;
esac
