#!/usr/bin/env bash
# train-cycle.sh - deterministic release captain (RC-AUTO, D25/D37/D44/D46/D49).
#
# One invocation = one cycle, no model calls. Run it every 10 minutes from a
# loop or cron. Each phase is idempotent and exits fast when there is nothing
# to do:
#   A. train:   local main ahead of origin/main (and containing it) with no
#               train for that SHA -> push SHA to refs/heads/train/<N+1>.
#   B. promote: newest train green on Tests, Bun Parity, Coverage (baseline),
#               Security Audit at that exact SHA and containing origin/main ->
#               push that SHA to main with LOKI_RELEASE_MANAGER=1.
#   C. release: origin/main HEAD is a releasable, green, non-docs-only commit
#               -> bump + CHANGELOG + `release: vX.Y.Z` commit in the dedicated
#               worktree $LOKI_RELEASE_WORKTREE, push by SHA if its parent is
#               still origin/main.
# Never: force-push, promote, touch dist-tags/latest, kill processes, bypass
# hooks. Auto-drop of a red train is out of scope (logs TRAIN_RED, exit 2).
#
# Usage: scripts/train-cycle.sh [--dry-run] [--once]
#   --dry-run  read-only probes run; every mutating action is only printed.
#   --once     accepted for loop wrappers; a cycle is always exactly one pass.
# Exit: 0 ok/nothing to do/waiting, 1 error, 2 red train or red previous release.
#
# Env: LOKI_RELEASE_WORKTREE (required for phase C), LOKI_TC_REPO (main
# checkout, default: this script's repo), LOKI_TC_REMOTE (default origin).
# Test seams: LOKI_TC_BUMP_CMD, LOKI_TC_INSTALL_CMD, LOKI_TC_NET_TIMEOUT.
#
# Shell options: deliberately no `set -e` (it kills post-command handling) and
# every probe captures into a variable first (pipefail+head/grep inverts).
set -uo pipefail

DRY_RUN=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --once) ;;
        -h|--help) sed -n 2,28p "$0"; exit 0 ;;
        *) echo "train-cycle: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${LOKI_TC_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
REMOTE="${LOKI_TC_REMOTE:-origin}"
STATE_DIR="$REPO/.loki/state"
STATE_FILE="$STATE_DIR/train-cycle.json"
LOG_FILE="$STATE_DIR/train-cycle.log"
LOCK_DIR="$STATE_DIR/train-cycle.lock"
NET_TIMEOUT="${LOKI_TC_NET_TIMEOUT:-120}"
SESSION_TRAILER="Claude-Session: https://claude.ai/code/session_01GFNzL4TEfAXvX1KK5buE9w"
REQUIRED_TRAIN=("Tests" "Bun Parity" "Coverage (baseline)" "Security Audit")
REQUIRED_RELEASE=("Tests" "Bun Parity" "Coverage (baseline)")

TO_BIN=""
for _b in timeout gtimeout; do
    if command -v "$_b" >/dev/null 2>&1; then TO_BIN="$_b"; break; fi
done
net() { # timeout -k on every network call; untimed only if no binary exists
    if [ -n "$TO_BIN" ]; then "$TO_BIN" -k 10 "$NET_TIMEOUT" "$@"; else "$@"; fi
}
g() { git -C "$REPO" "$@"; }

mkdir -p "$STATE_DIR" || { echo "train-cycle: cannot create $STATE_DIR" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "train-cycle: jq is required" >&2; exit 1; }

log() { # log <phase> <sha> <result...>
    local phase="$1" sha="$2"; shift 2
    local line
    line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $phase ${sha:-none} $*"
    [ "$DRY_RUN" = 1 ] && line="$line (dry-run)"
    printf '%s\n' "$line" >>"$LOG_FILE"
    printf '%s\n' "$line"
}

state_get() { jq -r --arg k "$1" '.[$k] // empty' "$STATE_FILE" 2>/dev/null; }
state_set() { # state_set key value (skipped under --dry-run)
    [ "$DRY_RUN" = 1 ] && return 0
    local cur="{}" tmp="$STATE_FILE.tmp.$$"
    [ -s "$STATE_FILE" ] && cur="$(cat "$STATE_FILE")"
    if printf '%s' "$cur" | jq --arg k "$1" --arg v "$2" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.[$k]=$v | .updated=$t' >"$tmp" 2>/dev/null; then
        mv "$tmp" "$STATE_FILE"
    else
        rm -f "$tmp"
    fi
}

# ---- lock: mkdir + stale-PID probe (kill -0 only; never kills) -------------
acquire_lock() {
    local pid
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo "$$" >"$LOCK_DIR/pid"; return 0
    fi
    pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        return 1
    fi
    # stale: owner dead (or pid file missing/unreadable). Reclaim once.
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || return 1
    echo "$$" >"$LOCK_DIR/pid"
}
if ! acquire_lock; then
    log LOCK "" "LOCK_HELD pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo ?) exiting"
    exit 0
fi
# shellcheck disable=SC2329 # invoked via trap
cleanup() {
    if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK_DIR"; fi
}
trap cleanup EXIT

# ---- helpers -----------------------------------------------------------------
# remote_train_max: "N SHA" of the newest train/<N> on the remote, or "0 ".
# Sets LS_FAIL=1 when the network call itself failed.
LS_FAIL=0
remote_trains() { # prints "<sha> <N>" lines
    local out
    out="$(net git -C "$REPO" ls-remote --heads "$REMOTE" 'refs/heads/train/*' 2>/dev/null)" || { LS_FAIL=1; return; }
    printf '%s\n' "$out" | while IFS=$'\t' read -r sha ref; do
        [ -n "$sha" ] || continue
        n="${ref#refs/heads/train/}"
        case "$n" in ''|*[!0-9]*) continue ;; esac
        printf '%s %s\n' "$sha" "$n"
    done
}
remote_main() {
    local out
    out="$(net git -C "$REPO" ls-remote "$REMOTE" refs/heads/main 2>/dev/null)" || return 1
    printf '%s\n' "${out%%[[:space:]]*}"
}
is_ancestor() { g merge-base --is-ancestor "$1" "$2" 2>/dev/null; }

# runs_json <sha>: JSON array of runs for the SHA, or empty on failure.
runs_json() {
    (cd "$REPO" && net gh run list --commit "$1" --limit 100 \
        --json workflowName,status,conclusion,databaseId 2>/dev/null)
}
# check_state <json> <workflow>: prints success|pending|cancelled|red:<concl>|missing
# Newest run of that workflow decides (gh lists newest first).
check_state() {
    local r
    r="$(printf '%s' "$1" | jq -r --arg w "$2" '
        [.[] | select(.workflowName == $w)] | first // empty
        | if .status != "completed" then "pending"
          elif .conclusion == "success" then "success"
          elif .conclusion == "cancelled" then "cancelled"
          else "red:" + (.conclusion // "unknown") end' 2>/dev/null)"
    printf '%s\n' "${r:-missing}"
}
run_id() { printf '%s' "$1" | jq -r --arg w "$2" '[.[] | select(.workflowName == $w)] | first | .databaseId // empty' 2>/dev/null; }

DOCS_RE='^(docs/|\.loki/)|\.md$'
only_docs() { # stdin: paths. 0 when non-empty and all docs
    local f any=0
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        any=1
        printf '%s\n' "$f" | grep -Eq "$DOCS_RE" || return 1
    done
    [ "$any" = 1 ]
}

# ---- Phase A: train ----------------------------------------------------------
phase_a() {
    local local_main trains n_max=0 n_max_sha="" have=0 sha n runs name st
    net git -C "$REPO" fetch --quiet "$REMOTE" main 2>/dev/null || { log A "" "FETCH_FAIL skip"; return 0; }
    local_main="$(g rev-parse refs/heads/main 2>/dev/null)" || { log A "" "NO_LOCAL_MAIN skip"; return 0; }
    if [ "$local_main" = "$(g rev-parse "$REMOTE/main" 2>/dev/null)" ]; then return 0; fi
    if ! is_ancestor "$REMOTE/main" "$local_main"; then
        log A "$local_main" "SKIP local main does not contain $REMOTE/main"; return 0
    fi
    if is_ancestor "$local_main" "$REMOTE/main"; then return 0; fi
    LS_FAIL=0
    trains="$(remote_trains)"
    [ "$LS_FAIL" = 1 ] && { log A "$local_main" "LSREMOTE_FAIL skip"; return 0; }
    while read -r sha n; do
        [ -n "$n" ] || continue
        if [ "$n" -gt "$n_max" ]; then n_max="$n"; n_max_sha="$sha"; fi
        [ "$sha" = "$local_main" ] && have=1
    done <<EOF
$trains
EOF
    if [ "$have" = 1 ]; then return 0; fi
    # Never supersede a train whose required checks are still running: a new
    # train cancels the old one's CI, so pushing every cycle means no train
    # ever finishes. LOKI_TC_NO_HOLD=1 overrides.
    if [ -n "$n_max_sha" ] && [ "${LOKI_TC_NO_HOLD:-0}" != 1 ] && is_ancestor "$REMOTE/main" "$n_max_sha"; then
        runs="$(runs_json "$n_max_sha")"
        local all_green=1
        for name in "${REQUIRED_TRAIN[@]}"; do
            st="$(check_state "$runs" "$name")"
            # ponytail: only pending holds; a check that never starts (missing) must not wedge phase A forever.
            if [ "$st" = pending ]; then
                log A "$local_main" "HOLD train/$n_max still running ($name:$st)"; return 0
            fi
            [ "$st" = success ] || all_green=0
        done
        # A green, unpromoted train must be promoted (phase B) before a newer
        # train supersedes it; phase B only evaluates the newest train.
        if [ "$all_green" = 1 ] && ! is_ancestor "$n_max_sha" "$REMOTE/main"; then
            log A "$local_main" "HOLD train/$n_max green, awaiting promote"; return 0
        fi
    fi
    n=$((n_max + 1))
    if [ "$DRY_RUN" = 1 ]; then
        log A "$local_main" "WOULD_PUSH $local_main:refs/heads/train/$n"; return 0
    fi
    if net git -C "$REPO" push --quiet "$REMOTE" "$local_main:refs/heads/train/$n" 2>/dev/null; then
        state_set last_train "$n"; state_set last_train_sha "$local_main"
        log A "$local_main" "TRAIN_PUSHED train/$n"
    else
        log A "$local_main" "TRAIN_PUSH_FAIL train/$n"
    fi
    return 0
}

# ---- Phase B: promote --------------------------------------------------------
# returns 2 on a red train (caller exits 2)
phase_b() {
    local trains sha n best_n=0 best_sha="" main_sha runs c name id rerun_key
    LS_FAIL=0
    trains="$(remote_trains)"
    [ "$LS_FAIL" = 1 ] && { log B "" "LSREMOTE_FAIL skip"; return 0; }
    while read -r sha n; do
        [ -n "$n" ] || continue
        if [ "$n" -gt "$best_n" ]; then best_n="$n"; best_sha="$sha"; fi
    done <<EOF
$trains
EOF
    [ -n "$best_sha" ] || return 0
    main_sha="$(remote_main)" || { log B "$best_sha" "LSREMOTE_FAIL skip"; return 0; }
    [ "$best_sha" = "$main_sha" ] && return 0
    net git -C "$REPO" fetch --quiet "$REMOTE" "refs/heads/train/$best_n" 2>/dev/null \
        || { log B "$best_sha" "FETCH_FAIL train/$best_n skip"; return 0; }
    net git -C "$REPO" fetch --quiet "$REMOTE" main 2>/dev/null || true
    if is_ancestor "$best_sha" "$main_sha"; then return 0; fi   # already promoted
    if ! is_ancestor "$main_sha" "$best_sha"; then
        log B "$best_sha" "TRAIN_STALE $best_n does not contain origin/main $main_sha"; return 0
    fi
    runs="$(runs_json "$best_sha")" || runs=""
    if [ -z "$runs" ]; then log B "$best_sha" "GH_FAIL train/$best_n wait"; return 0; fi

    local pending=""
    for name in "${REQUIRED_TRAIN[@]}"; do
        c="$(check_state "$runs" "$name")"
        case "$c" in
            success) ;;
            pending|missing) pending="$pending [$name:$c]" ;;
            cancelled)
                if [ "$name" = "Security Audit" ]; then
                    rerun_key="security_rerun_$best_sha"
                    if [ -n "$(state_get "$rerun_key")" ]; then
                        pending="$pending [$name:cancelled-after-rerun]"
                    else
                        id="$(run_id "$runs" "$name")"
                        if [ "$DRY_RUN" = 1 ]; then
                            log B "$best_sha" "WOULD_RERUN $name run=$id"
                        elif (cd "$REPO" && net gh run rerun "$id" >/dev/null 2>&1); then
                            state_set "$rerun_key" "$id"
                            log B "$best_sha" "RERUN $name run=$id train/$best_n wait"
                        else
                            log B "$best_sha" "RERUN_FAIL $name run=$id"
                        fi
                        pending="$pending [$name:rerun]"
                    fi
                else
                    log B "$best_sha" "TRAIN_RED $best_n $name cancelled"
                    return 2
                fi ;;
            red:*)
                log B "$best_sha" "TRAIN_RED $best_n $name ${c#red:}"
                return 2 ;;
        esac
    done
    if [ -n "$pending" ]; then log B "$best_sha" "WAIT train/$best_n$pending"; return 0; fi

    if [ "$DRY_RUN" = 1 ]; then
        log B "$best_sha" "WOULD_PROMOTE train/$best_n -> main (LOKI_RELEASE_MANAGER=1 push by SHA)"; return 0
    fi
    if (cd "$REPO" && LOKI_RELEASE_MANAGER=1 net git push --quiet "$REMOTE" "$best_sha:refs/heads/main" 2>/dev/null); then
        state_set last_promoted_sha "$best_sha"
        log B "$best_sha" "PROMOTED train/$best_n -> main"
    else
        log B "$best_sha" "PROMOTE_PUSH_FAIL train/$best_n"
    fi
    return 0
}

# ---- Phase C: release --------------------------------------------------------
phase_c() {
    local head subj tag files runs name c rel concl wt
    head="$(remote_main)" || { log C "" "LSREMOTE_FAIL skip"; return 0; }
    [ -n "$head" ] || return 0
    net git -C "$REPO" fetch --quiet --tags "$REMOTE" main 2>/dev/null || { log C "$head" "FETCH_FAIL skip"; return 0; }
    subj="$(g log -1 --format=%s "$head" 2>/dev/null)" || { log C "$head" "NO_OBJECT skip"; return 0; }
    case "$subj" in "release: v"*) return 0 ;; esac
    tag="$(g describe --tags --abbrev=0 "$head" 2>/dev/null)" || tag=""
    if [ -n "$tag" ]; then
        files="$(g diff --name-only "$tag" "$head" 2>/dev/null)"
        if [ -z "$files" ]; then return 0; fi
        if printf '%s\n' "$files" | only_docs; then
            log C "$head" "SKIP docs-only since $tag"; return 0
        fi
    fi
    runs="$(runs_json "$head")" || runs=""
    if [ -z "$runs" ]; then log C "$head" "GH_FAIL wait"; return 0; fi
    for name in "${REQUIRED_RELEASE[@]}"; do
        c="$(check_state "$runs" "$name")"
        if [ "$c" != "success" ]; then log C "$head" "WAIT $name=$c"; return 0; fi
    done

    rel="$(cd "$REPO" && net gh run list --workflow Release --limit 5 --json status,conclusion 2>/dev/null)" \
        || { log C "$head" "GH_FAIL release-runs wait"; return 0; }
    if [ "$(printf '%s' "$rel" | jq '[.[] | select(.status != "completed")] | length' 2>/dev/null)" != "0" ]; then
        log C "$head" "WAIT release in progress"; return 0
    fi
    concl="$(printf '%s' "$rel" | jq -r '.[0].conclusion // "none"' 2>/dev/null)"
    if [ "$concl" != "success" ] && [ "$concl" != "none" ]; then
        log C "$head" "RELEASE_PREV_RED previous Release run concluded $concl"; return 2
    fi

    wt="${LOKI_RELEASE_WORKTREE:-}"
    if [ -z "$wt" ] || [ ! -e "$wt/.git" ]; then log C "$head" "NO_WORKTREE set LOKI_RELEASE_WORKTREE to a dedicated git worktree"; return 1; fi
    if [ "$DRY_RUN" = 1 ]; then
        log C "$head" "WOULD_RELEASE in $wt: install, release.sh patch --bump-only, stage, CHANGELOG, commit, check-clean, push"
        return 0
    fi
    release_in_worktree "$head" "$wt" "$tag"
}

release_in_worktree() {
    local head="$1" wt="$2" tag="$3" ver out line f date_s sec subj fl c tmp nl parent rmain
    w() { git -C "$wt" "$@"; }
    if [ -n "$(w status --porcelain --untracked-files=no)" ]; then log C "$head" "WORKTREE_DIRTY refuse"; return 1; fi
    w checkout --quiet --detach "$head" 2>/dev/null || { log C "$head" "CHECKOUT_FAIL"; return 1; }

    if [ -n "${LOKI_TC_INSTALL_CMD:-}" ]; then
        (cd "$wt" && eval "$LOKI_TC_INSTALL_CMD") >/dev/null 2>&1; c=$?
    else
        (cd "$wt/loki-ts" && bun install --frozen-lockfile) >/dev/null 2>&1; c=$?
    fi
    [ "$c" = 0 ] || { log C "$head" "INSTALL_FAIL rc=$c"; return 1; }

    out="$(cd "$wt" && eval "${LOKI_TC_BUMP_CMD:-bash scripts/release.sh patch --bump-only}" 2>&1)"; c=$?
    if [ "$c" != 0 ]; then
        log C "$head" "BUMP_FAIL rc=$c $(printf '%s' "$out" | tail -1)"
        w checkout --quiet -- . 2>/dev/null
        return 1
    fi
    ver="$(tr -d '[:space:]' <"$wt/VERSION")"
    case "$ver" in [0-9]*.[0-9]*.[0-9]*) ;; *) log C "$head" "BAD_VERSION '$ver'"; w checkout --quiet -- . 2>/dev/null; return 1 ;; esac

    # stage exactly the printed files
    printf '%s\n' "$out" | grep -E '^ *git add ' | while IFS= read -r line; do
        line="${line#"${line%%[![:space:]]*}"}"
        case "$line" in
            "git add -f "*) w add -f -- "${line#git add -f }" ;;
            "git add "*)    w add -- "${line#git add }" ;;
        esac
    done

    # dist guards: no absolute / repo-escaping map sources; version embedded
    for f in "$wt"/loki-ts/dist/*.map; do
        [ -e "$f" ] || continue
        if ! jq -e '[(.sources // [])[] | select(startswith("/") or contains("../../../"))] | length == 0' "$f" >/dev/null 2>&1; then
            log C "$head" "MAP_BAD $(basename "$f") refuse"; w reset --quiet 2>/dev/null; w checkout --quiet -- . 2>/dev/null; return 1
        fi
    done
    if ! grep -qF "$ver" "$wt/loki-ts/dist/loki.js" 2>/dev/null; then
        log C "$head" "DIST_VERSION_MISSING $ver refuse"; w reset --quiet 2>/dev/null; w checkout --quiet -- . 2>/dev/null; return 1
    fi

    # CHANGELOG: section above the first "## v" heading
    date_s="$(date -u +%Y-%m-%d)"
    sec="$(mktemp "${TMPDIR:-/tmp}/train-cycle-changelog.XXXXXXXX")" || return 1
    {
        # shellcheck disable=SC2016 # literal backticks
        # LOKI_TC_LEAD: one sentence naming the user-visible change (D60); default unchanged
        printf '## v%s (%s)\n\n%s\n\n### Changes\n' "$ver" "$date_s" "${LOKI_TC_LEAD:-A \`next\` release.}"
        w log --no-merges --reverse --format='%H' "${tag:+$tag..}$head" | while IFS= read -r c; do
            subj="$(w log -1 --format=%s "$c")"
            case "$subj" in "release: v"*) continue ;; esac
            fl="$(w diff-tree --no-commit-id --name-only -r "$c")"
            if [ -n "$fl" ] && printf '%s\n' "$fl" | only_docs; then continue; fi
            printf -- '- %s\n' "$subj"
        done
        printf '\n'
    } >"$sec"
    nl="$(grep -n -m1 '^## v' "$wt/CHANGELOG.md" | cut -d: -f1)"
    tmp="$wt/CHANGELOG.md.tc.$$"
    if [ -n "$nl" ]; then
        { head -n $((nl - 1)) "$wt/CHANGELOG.md"; cat "$sec"; tail -n +"$nl" "$wt/CHANGELOG.md"; } >"$tmp"
    else
        { cat "$wt/CHANGELOG.md"; printf '\n'; cat "$sec"; } >"$tmp"
    fi
    mv "$tmp" "$wt/CHANGELOG.md"; rm -f "$sec"
    w add -- CHANGELOG.md

    w -c user.name=asklokesh -c user.email=lokeshmure@live.com commit --quiet \
        -m "release: v$ver" -m "$SESSION_TRAILER" >/dev/null 2>&1 \
        || { log C "$head" "COMMIT_FAIL v$ver"; return 1; }
    if ! (cd "$wt" && bash scripts/release.sh --check-clean >/dev/null 2>&1); then
        log C "$(w rev-parse HEAD)" "CHECK_CLEAN_FAIL v$ver not pushed"; return 1
    fi
    parent="$(w rev-parse 'HEAD^')"
    rmain="$(remote_main)" || { log C "$head" "LSREMOTE_FAIL not pushed"; return 1; }
    if [ "$parent" != "$rmain" ]; then
        log C "$(w rev-parse HEAD)" "PARENT_MISMATCH parent=$parent origin/main=$rmain not pushed"; return 1
    fi
    if (cd "$wt" && LOKI_RELEASE_MANAGER=1 net git push --quiet "$REMOTE" "HEAD:refs/heads/main" 2>/dev/null); then
        state_set last_release_sha "$(w rev-parse HEAD)"
        log C "$(w rev-parse HEAD)" "RELEASED v$ver"
    else
        log C "$(w rev-parse HEAD)" "RELEASE_PUSH_FAIL v$ver"
        return 1
    fi
    return 0
}

rc=0
phase_a
phase_b; b=$?
if [ "$b" = 2 ]; then exit 2; fi
phase_c; c=$?
[ "$c" -gt "$rc" ] && rc="$c"
exit "$rc"
