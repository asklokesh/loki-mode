#!/usr/bin/env bash
# scripts/real-repo-gate.sh -- D58 basic 5: the acceptance gate that must pass before `latest` moves.
#
#   real-repo-gate.sh --version X.Y.Z [--tgz PATH] [--repo spec]... [--results FILE]
#
# From a clean `npm i -g` in a throwaway HOME, runs `loki start <spec> --no-pr` on each repo in
# scripts/real-repo-gate.repos (or only the --repo specs named) and applies the pass rules:
# v10 engine used, within max_seconds, expected outcome, receipt verifies, diff limited to the
# allowed paths, project tests green when the outcome is VERIFIED. Never pushes (pushurl is
# disabled on every clone), never touches the real HOME. Exit 0 = every non-skipped repo passed
# (and at least one ran); 1 = a repo failed or nothing ran; 2 = setup error.
#
# Provider auth: the throwaway HOME has no login, so export ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN before a real run (both pass through); gh auth is carried via GH_TOKEN.
# --entry bare is diagnostic only (runs `loki <spec>`); the gate proper always uses `loki start`.
#
# Test hooks: RRG_LOKI (a loki binary, skips npm install), RRG_REPOS (expectations file),
# LOKI_E2E_ENV_FILE (opt-in, default unset): a credentials file owned by the current user with mode
# 0600, loaded with `set -a; . file; set +a` inside this process only; values are never echoed.
# RRG_CLONE_BASE (clone owner/repo from <base>/owner/repo instead of GitHub),
# RRG_CORPUS (task corpus dir), RRG_TIMEOUT (hard cap seconds, default 900).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPOS_FILE="${RRG_REPOS:-$REPO_ROOT/scripts/real-repo-gate.repos}"
CORPUS="${RRG_CORPUS:-$REPO_ROOT/eval/loki10/tasks}"
HARD_CAP="${RRG_TIMEOUT:-900}"
ORIG_HOME="$HOME"
VERSION="" TGZ="" RESULTS="" ENTRY=start SELECT=()
die() { echo "real-repo-gate: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="${2:-}"; shift ;;
        --tgz) TGZ="${2:-}"; shift ;;
        --repo) [ -n "${2:-}" ] || die "--repo needs a spec"; SELECT+=("$2"); shift ;;
        --results) RESULTS="${2:-}"; shift ;;
        --entry) ENTRY="${2:-}"; shift ;; # diagnostic only: "bare" runs `loki <spec>` instead of `loki start <spec>`
        *) die "usage: $0 --version X.Y.Z [--tgz PATH] [--repo spec]... [--results FILE]" ;;
    esac
    shift
done
[ -n "$VERSION" ] || die "--version X.Y.Z is required"
[ -f "$REPOS_FILE" ] || die "missing expectations file $REPOS_FILE"
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
[ -n "$TIMEOUT_BIN" ] || die "no timeout or gtimeout on PATH"
command -v python3 >/dev/null || die "python3 is required"
RESULTS="${RESULTS:-$ORIG_HOME/loki-ci-logs/real-repo-gate-$VERSION.results}"
mkdir -p "$(dirname "$RESULTS")" || die "cannot create $(dirname "$RESULTS")"
LOGDIR="${RESULTS%.results}.logs"; mkdir -p "$LOGDIR" || die "cannot create $LOGDIR"

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || die "cannot create the run-owned temp dir"
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
mkdir -p "$T/home" "$T/w" "$T/p"

# Opt-in credential file (LOKI_E2E_ENV_FILE). Refuse unless a regular, non-symlink file owned by this
# user with mode 0600. Loaded with tracing off so values never reach a log; never printed.
if [ -n "${LOKI_E2E_ENV_FILE:-}" ]; then
    _ef="$LOKI_E2E_ENV_FILE"
    [ -f "$_ef" ] && [ ! -L "$_ef" ] || die "LOKI_E2E_ENV_FILE is not a regular file"
    _ef_uid="$(loki_run_tmp_stat_field '%u' '%u' "$_ef")" || die "cannot stat LOKI_E2E_ENV_FILE"
    _ef_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$_ef")" || die "cannot stat LOKI_E2E_ENV_FILE"
    [ "$_ef_uid" = "$(id -u)" ] || die "LOKI_E2E_ENV_FILE must be owned by the current user"
    _ef_mode="00${_ef_mode}"
    [ "${_ef_mode#"${_ef_mode%???}"}" = "600" ] || die "LOKI_E2E_ENV_FILE must have mode 0600"
    { set +x; } 2>/dev/null
    set -a
    # shellcheck disable=SC1090
    . "$_ef" >/dev/null 2>&1 || { set +a; die "LOKI_E2E_ENV_FILE failed to load"; }
    set +a
    unset _ef _ef_uid _ef_mode
fi

# gh auth lives under the real HOME; capture a token before HOME is swapped, never write it anywhere.
if [ -z "${GH_TOKEN:-}" ] && command -v gh >/dev/null; then GH_TOKEN="$(gh auth token 2>/dev/null || true)"; fi
export GH_TOKEN
export HOME="$T/home" LOKI_NO_BROWSER=1 LOKI_DASHBOARD=false npm_config_cache="$T/npm-cache" npm_config_userconfig="$T/home/.npmrc"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0

if [ -n "${RRG_LOKI:-}" ]; then LOKI="$RRG_LOKI"
else
    PKG="loki-mode@$VERSION"; [ -z "$TGZ" ] || PKG="$TGZ"
    npm i -g --prefix "$T/p" "$PKG" >"$T/npm-install.log" 2>&1 || { tail -5 "$T/npm-install.log" >&2; die "npm install of $PKG failed"; }
    LOKI="$T/p/bin/loki"
fi
[ -x "$LOKI" ] || die "no executable loki at $LOKI"

START_LINE_RE='^Loki 10 engine \('   # the v10 start banner legitimately names LOKI_ENGINE=legacy
TABLE="" LINES_OUT="" NPASS=0 NFAIL=0 NSKIP=0

# run_repo <spec> <expected> <allowed> <max_seconds>; sets VERDICT=PASS|FAIL|SKIP, DETAIL
run_repo() {
    local spec="$1" expected="$2" allowed="$3" maxs="$4" name d arg out base slug
    local pre source="" ref="" setup="" gtest="" rc=0 t0 t1 wall outcome cost runid receipt vrc
    local -a why=()
    VERDICT=FAIL; WALL="-"; OUTCOME="-"; COST="-"; STAT="-"; RC="-"
    name="$(printf '%s' "$spec" | tr -c 'A-Za-z0-9\n' '_')"; d="$T/w/$name"; out="$LOGDIR/$name.log"
    if [ "${spec#corpus:}" != "$spec" ]; then
        local tj="$CORPUS/${spec#corpus:}/task.json"
        [ -f "$tj" ] || { DETAIL="corpus task missing: $tj"; return; }
        { IFS= read -r source; IFS= read -r ref; IFS= read -r setup; IFS= read -r gtest; } < <(python3 -c '
import json,sys
t=json.load(open(sys.argv[1]))
print(t["repo"]["source"]); print(t["repo"]["ref"]); print(t.get("setup","")); print(t.get("gate_test",""))' "$tj")
        python3 -c 'import json,sys;sys.stdout.write(json.load(open(sys.argv[1]))["prompt"]+"\n")' "$tj" > "$T/issue-$name.md"
        arg="$T/issue-$name.md"
        if ! git clone -q "$source" "$d" 2>/dev/null || ! git -C "$d" checkout -q "$ref" 2>/dev/null; then DETAIL="clone of $source at $ref failed"; return; fi
    else
        slug="${spec%%#*}"; arg="$spec"
        if [ -n "${RRG_CLONE_BASE:-}" ]; then git clone -q --depth 1 "file://$RRG_CLONE_BASE/$slug" "$d" 2>/dev/null
        else gh repo clone "$slug" "$d" -- --depth 1 -q 2>/dev/null; fi
        if [ ! -d "$d/.git" ]; then
            if [ -n "${RRG_CLONE_BASE:-}" ] || ! gh repo view "$slug" >/dev/null 2>&1; then VERDICT=SKIP; DETAIL="no access to $slug (needs a gh token with read access)"
            else DETAIL="clone of $slug failed"; fi
            return
        fi
    fi
    git -C "$d" config remote.origin.pushurl "invalid://push-disabled-by-real-repo-gate"
    git -C "$d" config user.name "real-repo-gate"; git -C "$d" config user.email "gate@example.invalid"
    base="$(git -C "$d" rev-parse HEAD)"

    t0=$(date +%s)
    local -a cmd=("$LOKI" start "$arg" --no-pr); [ "$ENTRY" != bare ] || cmd=("$LOKI" "$arg" --no-pr)
    pre="$(git -C "$d" for-each-ref --format='%(refname) %(objectname)' refs/heads)"
    ( cd "$d" || exit 1; "$TIMEOUT_BIN" -k 30 "$HARD_CAP" "${cmd[@]}" ) >"$out" 2>&1; rc=$?
    t1=$(date +%s); wall=$((t1 - t0)); WALL="${wall}s"; RC="$rc"

    outcome="$(sed -n -E 's/^Outcome:?[[:space:]]+([A-Z_]+).*/\1/p' "$out" | head -1)"; OUTCOME="${outcome:-none}"
    cost="$(sed -n -E 's/^Cost:?[[:space:]]+(.*)/\1/p' "$out" | head -1)"; COST="${cost:-not reported}"

    # diff against the clone's base: working tree, every local branch, untracked; .loki is the engine's own state
    local files b newb
    # branches the run created or moved (the default branch is not the engine's work)
    newb="$(git -C "$d" for-each-ref --format='%(refname) %(objectname)' refs/heads | grep -v -x -F -f <(printf '%s\n' "$pre") | cut -d' ' -f1)"
    files="$( { git -C "$d" diff --name-only "$base"; git -C "$d" ls-files --others --exclude-standard
        for b in $newb; do git -C "$d" diff --name-only "$base" "$b"; done
        } 2>/dev/null | grep -v -E '^\.loki(/|$)' | sort -u)"
    STAT="$(git -C "$d" diff --shortstat "$base" 2>/dev/null | sed 's/^ *//')"
    if [ -z "$STAT" ]; then
        for b in $newb; do
            STAT="$(git -C "$d" diff --shortstat "$base" "$b" 2>/dev/null | sed 's/^ *//')"; [ -z "$STAT" ] || break
        done
    fi
    if [ -z "$STAT" ]; then
        if [ -n "$files" ]; then STAT="$(printf '%s\n' "$files" | wc -l | tr -d ' ') file(s), untracked only"; else STAT="no diff"; fi
    fi

    # rule: timeout and wall budget
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then why+=("timeout: killed at the ${HARD_CAP}s cap"); fi
    [ "$wall" -le "$maxs" ] || why+=("wall ${wall}s over the ${maxs}s budget")
    # rule: v10 engine
    runid="$(cd "$d/.loki/runs" 2>/dev/null && ls -t | head -1)"
    [ -n "$runid" ] && [ -s "$d/.loki/runs/$runid/events.jsonl" ] || why+=("no .loki/runs/*/events.jsonl (v10 engine did not run)")
    if grep -v -E "$START_LINE_RE" "$out" | grep -q -i -E 'legacy|run\.sh'; then why+=("output mentions the legacy engine or run.sh"); fi
    # rule: outcome and exit code
    [ "$OUTCOME" = "$expected" ] || why+=("outcome $OUTCOME, expected $expected")
    [ "$rc" -eq 0 ] || [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ] || why+=("exit code $rc")
    # rule: receipt exists and verifies
    receipt="$d/.loki/runs/$runid/receipt.json"
    if [ -z "$runid" ] || [ ! -s "$receipt" ]; then why+=("no receipt.json")
    else
        ( cd "$d" && "$LOKI" verify "$runid" ) >"$LOGDIR/$name.verify.log" 2>&1; vrc=$?
        [ "$vrc" -eq 0 ] || why+=("loki verify exit $vrc")
    fi
    # rule: diff only relevant files
    local f pat ok
    if [ "$allowed" = "(none)" ]; then
        [ -z "$files" ] || why+=("diff must be empty, found: $(printf '%s' "$files" | tr '\n' ' ')")
    else
        while IFS= read -r f; do
            [ -n "$f" ] || continue; ok=0
            while IFS= read -r pat; do
                # shellcheck disable=SC2254
                case "$f" in $pat) ok=1 ;; esac
            done < <(printf '%s\n' "$allowed" | tr ',' '\n')
            [ "$ok" -eq 1 ] || why+=("unrelated file in diff: $f")
        done <<< "$files"
        [ "$expected" != VERIFIED ] || [ -n "$files" ] || why+=("empty diff on a VERIFIED run")
    fi
    # rule: project tests green when VERIFIED (run after the diff was captured; setup adds untracked files)
    if [ "$OUTCOME" = VERIFIED ]; then
        local tcmd="$gtest"
        if [ -z "$tcmd" ] && [ -n "$setup" ]; then tcmd=".venv/bin/python -m pytest -q -p no:cacheprovider"; fi
        if [ -z "$tcmd" ] && [ -f "$d/package.json" ]; then setup="npm install --silent"; tcmd="npm test --silent"; fi
        if [ -z "$tcmd" ]; then why+=("no test command known for $spec")
        else
            ( cd "$d" && { [ -z "$setup" ] || bash -c "$setup"; } && "$TIMEOUT_BIN" -k 30 600 bash -c "$tcmd" ) >"$LOGDIR/$name.tests.log" 2>&1 \
                || why+=("project tests not green (see $name.tests.log)")
        fi
    fi
    if [ "${#why[@]}" -eq 0 ]; then VERDICT=PASS; DETAIL="ok"; else VERDICT=FAIL; DETAIL="$(IFS=';'; echo "${why[*]}")"; fi
}

while IFS='|' read -r s e a m; do
    s="$(echo "$s" | xargs)"; case "$s" in ''|'#'*) continue ;; esac
    e="$(echo "$e" | xargs)"; a="$(echo "$a" | xargs)"; m="$(echo "$m" | xargs)"
    if [ "${#SELECT[@]}" -gt 0 ]; then
        hit=0; for x in "${SELECT[@]}"; do [ "$x" != "$s" ] || hit=1; done; [ "$hit" -eq 1 ] || continue
    fi
    DETAIL=""
    run_repo "$s" "$e" "$a" "$m"
    case "$VERDICT" in PASS) NPASS=$((NPASS + 1)) ;; SKIP) NSKIP=$((NSKIP + 1)) ;; *) NFAIL=$((NFAIL + 1)) ;; esac
    [ "$VERDICT" != SKIP ] || echo "SKIP $s: $DETAIL"
    TABLE+="$(printf '%-6s %-28s %-18s %-8s %-30s %s' "$VERDICT" "$s" "$OUTCOME" "$WALL" "$COST" "$DETAIL")"$'\n'
    LINES_OUT+="| $(date -u +%Y-%m-%dT%H:%MZ) | real-repo-gate $VERSION | $s | $VERDICT | outcome $OUTCOME | wall $WALL | cost $COST | diff: $STAT | exit $RC |"$'\n'
done < "$REPOS_FILE"
if [ "${#SELECT[@]}" -gt 0 ]; then
    for x in "${SELECT[@]}"; do grep -q -F "$x" "$REPOS_FILE" || die "--repo $x is not in $REPOS_FILE"; done
fi

echo
echo "real-repo-gate $VERSION"
printf '%-6s %-28s %-18s %-8s %-30s %s\n' RESULT REPO OUTCOME WALL COST DETAIL
printf '%s' "$TABLE"
echo
echo "METRICS lines (also appended to $RESULTS):"
printf '%s' "$LINES_OUT" | tee -a "$RESULTS"
echo "passed=$NPASS failed=$NFAIL skipped=$NSKIP"
if [ "$NFAIL" -gt 0 ]; then echo "GATE FAIL: latest must not move"; exit 1; fi
if [ "$NPASS" -eq 0 ]; then echo "GATE FAIL: no repo ran, nothing is proven"; exit 1; fi
echo "GATE PASS"
exit 0
