#!/usr/bin/env bash
# eval/loki10/scorecard-run.sh: runs the 4 pinned scorecard arms
# (SCORECARD-PLAN.md section 3) back to back, N reps each, one --out per rep.
#
# Usage:
#   eval/loki10/scorecard-run.sh --tier small|medium|large --n N \
#     --arms raw-sonnet,raw-opus,loki-sonnet,loki-opus --out DIR \
#     [--parallel N] [--tasks-dir DIR] [--dry-run]
#
# E-98f defect (c): Claude Code refreshes its keychain OAuth token only close
# to expiry, so a long batch can lose a rep mid-run. Before each arm x rep
# (skipped when ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set -- arm_auth
# already prefers those), this reads only the keychain `expiresAt`, never the
# token:
#   - enough time left for this rep -> proceed.
#   - not enough -> wait (polling `expiresAt` again each round) until under
#     AUTH_MARGIN_S remains, since an early refresh call would not trigger
#     Claude Code's own near-expiry refresh; then run one operator
#     `claude -p ok --model claude-haiku-4-5` to force it, and re-read.
#   - still unusable, or no keychain at all -> stop the whole batch cleanly
#     (never burn a run on an auth failure).
# AUTH_MARGIN_S=300 is unverified (E-98f saw no refresh at ~415s remaining);
# a live check of `expiresAt` before and after the operator call confirms it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

KEYCHAIN_SERVICE="Claude Code-credentials"
SECURITY_BIN="${LOKI_EVAL_SECURITY_BIN:-/usr/bin/security}"
CLAUDE_BIN="${LOKI_EVAL_CLAUDE_BIN:-claude}"
CAP_S="${LOKI_EVAL_CAP_S:-900}"          # DEFAULT_TIMEOUT_S (harness.py)
AUTH_BUFFER_S=600
AUTH_MARGIN_S=300                        # unverified threshold, see header
POLL_S="${LOKI_EVAL_AUTH_POLL_S:-30}"
MAX_WAIT_S="${LOKI_EVAL_AUTH_MAX_WAIT_S:-4200}"

# arm label -> LOKI_EVAL_MODEL / harness --arm (SCORECARD-PLAN.md section 3)
arm_model() {
    case "$1" in
        raw-sonnet|loki-sonnet) echo claude-sonnet-5 ;;
        raw-opus|loki-opus) echo claude-opus-5-5 ;;
        *) return 1 ;;
    esac
}
arm_flag() {
    case "$1" in
        raw-sonnet|raw-opus) echo raw-claude ;;
        loki-sonnet|loki-opus) echo v10 ;;
        *) return 1 ;;
    esac
}

TIER="" N="" ARMS="" OUT="" PARALLEL=3 TASKS_DIR="" DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --tier) TIER="$2"; shift 2 ;;
        --n) N="$2"; shift 2 ;;
        --arms) ARMS="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        --parallel) PARALLEL="$2"; shift 2 ;;
        --tasks-dir) TASKS_DIR="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
    esac
done
if [ -z "$TIER" ] || [ -z "$N" ] || [ -z "$ARMS" ] || [ -z "$OUT" ]; then
    printf 'usage: scorecard-run.sh --tier T --n N --arms a,b,... --out DIR [--parallel N] [--tasks-dir DIR] [--dry-run]\n' >&2
    exit 2
fi
case "$N" in ''|*[!0-9]*|0) printf 'error: --n must be a positive integer\n' >&2; exit 2 ;; esac

TASKS_DIR_EFF="${TASKS_DIR:-$HERE/tasks}"

# Count of tier tasks feeds only the auth-guard time estimate below.
count_tier_tasks() {
    python3 - "$TASKS_DIR_EFF" "$TIER" <<'PY'
import json, os, sys
tasks_dir, tier = sys.argv[1], sys.argv[2]
n = 0
if os.path.isdir(tasks_dir):
    for d in os.listdir(tasks_dir):
        p = os.path.join(tasks_dir, d, "task.json")
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                t = (json.load(f).get("tier") or "small")
        except (OSError, ValueError):
            t = None
        if t == tier or t is None:
            n += 1
print(max(n, 1))
PY
}

# Reads only expiresAt (as whole seconds), never the accessToken itself.
read_expires_at_s() {
    local raw
    raw="$("$SECURITY_BIN" find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" || return 1
    printf '%s' "$raw" | python3 -c '
import json, sys
try:
    exp = json.load(sys.stdin).get("claudeAiOauth", {}).get("expiresAt")
except Exception:
    exp = None
print(int(exp) // 1000 if isinstance(exp, (int, float)) and not isinstance(exp, bool) else "")
'
}

# auth_guard TASKS: ensure the keychain token outlives one arm+rep, or stop
# the batch cleanly. Never echoes the token.
auth_guard() {
    local tasks="$1" needed now exp remaining waited=0
    if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
        return 0
    fi
    needed=$(( (tasks + PARALLEL - 1) / PARALLEL ))
    needed=$(( needed * CAP_S + AUTH_BUFFER_S ))
    now="$(date +%s)"
    exp="$(read_expires_at_s)" || { printf 'error: keychain entry %s unreadable; no model auth (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)\n' "$KEYCHAIN_SERVICE" >&2; return 1; }
    [ -n "$exp" ] || { printf 'error: keychain OAuth token has no usable expiry\n' >&2; return 1; }
    remaining=$(( exp - now ))
    [ "$remaining" -ge "$needed" ] && return 0

    printf 'auth guard: %ds remain, %ds needed for this rep; waiting for expiry to near before a refresh can trigger\n' "$remaining" "$needed" >&2
    while [ "$remaining" -ge "$AUTH_MARGIN_S" ]; do
        if [ "$waited" -ge "$MAX_WAIT_S" ]; then
            printf 'error: %ds still remain after waiting %ds; refusing to wait longer, stopping the batch\n' "$remaining" "$waited" >&2
            return 1
        fi
        sleep "$POLL_S"
        waited=$(( waited + POLL_S ))
        now="$(date +%s)"
        exp="$(read_expires_at_s)" || { printf 'error: keychain entry unreadable while waiting\n' >&2; return 1; }
        [ -n "$exp" ] || { printf 'error: keychain OAuth token lost its expiry while waiting\n' >&2; return 1; }
        remaining=$(( exp - now ))
    done

    printf 'auth guard: refreshing (operator claude -p ok --model claude-haiku-4-5)\n' >&2
    if ! "$CLAUDE_BIN" -p ok --model claude-haiku-4-5 >/dev/null 2>&1; then
        printf 'error: refresh command failed; stopping the batch before burning a run\n' >&2
        return 1
    fi
    now="$(date +%s)"
    exp="$(read_expires_at_s)" || { printf 'error: keychain entry unreadable after refresh\n' >&2; return 1; }
    [ -n "$exp" ] || { printf 'error: refresh left no usable expiry; stopping the batch\n' >&2; return 1; }
    remaining=$(( exp - now ))
    if [ "$remaining" -lt "$needed" ]; then
        printf 'error: refresh did not extend the token enough (%ds remain, %ds needed); stopping the batch\n' "$remaining" "$needed" >&2
        return 1
    fi
    printf 'auth guard: refreshed, %ds now remain\n' "$remaining" >&2
    return 0
}

IFS=',' read -r -a ARM_LIST <<<"$ARMS"
for a in "${ARM_LIST[@]}"; do
    arm_model "$a" >/dev/null || { printf 'error: unknown arm %s (want raw-sonnet, raw-opus, loki-sonnet or loki-opus)\n' "$a" >&2; exit 2; }
done

tasks_n="$(count_tier_tasks)"
rc=0
for rep in $(seq 1 "$N"); do
    for a in "${ARM_LIST[@]}"; do
        model="$(arm_model "$a")"
        flag="$(arm_flag "$a")"
        rep_out="$OUT/rep$rep/$a"
        cmd=(env "LOKI_EVAL_MODEL=$model" "$HERE/run.sh" --arm "$flag" --all --tier "$TIER" --parallel "$PARALLEL" --out "$rep_out")
        [ -n "$TASKS_DIR" ] && cmd+=(--tasks-dir "$TASKS_DIR")
        if [ "$DRY_RUN" -eq 1 ]; then
            printf '%q ' "${cmd[@]}"; printf '\n'
            continue
        fi
        auth_guard "$tasks_n" || { rc=1; break 2; }
        "${cmd[@]}"
        s=$?
        [ "$s" -eq 0 ] || rc="$s"
    done
done
exit "$rc"
