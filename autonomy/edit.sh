#!/usr/bin/env bash
# loki edit: the lightest path. One provider pass on the current repo.
# No PRD, no plan stage, no council, no PR, no receipt (unless asked), no branch switching.
# Functions-only file, sourced by autonomy/loki. Claude Code is the default provider.
# Exit codes: 0 done, 1 provider or --verify failure, 2 usage or setup error.

_loki_edit_usage() {
    echo "Usage: loki edit [options] [path ...] \"<change>\""
    echo ""
    echo "One provider pass on the current repo. No PRD, plan, council, PR or branch switch."
    echo "Prints git diff --stat, the diff (paged on a TTY), then cost and elapsed time."
    echo ""
    echo "Examples:"
    echo "  loki edit \"rename fooBar to foo_bar in the config loader\""
    echo "  loki edit src/foo.ts \"rename X to Y\""
    echo "  loki edit --verify --commit src/a.ts src/b.ts \"add null checks\""
    echo ""
    echo "Options:"
    echo "  --verify     Run the fast verify (loki verify --fast) after the edit"
    echo "  --receipt    Write an unsigned edit receipt to .loki/edit-receipts/"
    echo "  --commit     Commit the result with a generated message (stages only touched files)"
    echo "  --dry-run    Plan only: read-only pass, no files are changed"
    echo "  --quiet, -q  Print only the run summary block"
    echo "  --json       Print only the run summary as one JSON object"
    echo "  --help, -h   Show this help"
    echo ""
    echo "Leading arguments that are existing files or directories scope the edit to them."
    echo "Environment: LOKI_EDIT_MODEL overrides the model."
    echo "Exit codes: 0 done, 1 provider or verify failure, 2 usage or setup error."
    echo ""
    echo "edit = one pass, no loop. quick = small task with the verify loop (loki quick)."
}

# Run the edit, then print the unified run summary (autonomy/lib/run-summary.sh).
# --quiet hides the diff and per-step lines; --json prints only the JSON summary.
cmd_edit() {
    local _q=false _j=false _a _t0 _sha _rc _lib _out _cost
    for _a in "$@"; do
        case "$_a" in --quiet|-q) _q=true ;; --json) _j=true ;; --) break ;; esac
    done
    case " $* " in *" --help "*|*" -h "*) _cmd_edit_run "$@"; return $? ;; esac
    _t0="$(date +%s)"
    _sha="$(git rev-parse HEAD 2>/dev/null || true)"
    _LOKI_EDIT_COST_FILE="$(mktemp 2>/dev/null || true)"
    export _LOKI_EDIT_COST_FILE
    if [ "$_q" = true ] || [ "$_j" = true ]; then
        _out="$(_cmd_edit_run "$@" 2>&1)"; _rc=$?
        # Failures and usage errors stay visible even when quiet.
        if [ "$_rc" -ne 0 ]; then printf '%s\n' "$_out" >&2; fi
    else
        _cmd_edit_run "$@"; _rc=$?
    fi
    _cost=""
    if [ -n "${_LOKI_EDIT_COST_FILE:-}" ]; then
        [ -s "$_LOKI_EDIT_COST_FILE" ] && _cost="$(head -n1 "$_LOKI_EDIT_COST_FILE")"
        rm -f "$_LOKI_EDIT_COST_FILE"
    fi
    unset _LOKI_EDIT_COST_FILE
    # Usage and setup errors (exit 2) never ran a pass: no summary.
    if [ "$_rc" -ne 2 ]; then
        _lib="${_LOKI_SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/run-summary.sh"
        if [ -f "$_lib" ]; then
            # shellcheck source=lib/run-summary.sh
            source "$_lib" 2>/dev/null || true
            if command -v loki_run_summary >/dev/null 2>&1; then
                _LOKI_SUMMARY_PRINTED=0
                LOKI_SUMMARY_WORKTREE=1 LOKI_SUMMARY_COST="$_cost" SESSION_START_EPOCH="$_t0" \
                LOKI_SUMMARY_JSON="$([ "$_j" = true ] && echo 1 || echo 0)" \
                TARGET_DIR="." loki_run_summary "$_rc" "$_sha" || true
            fi
        fi
    fi
    return "$_rc"
}

# One "<content-hash> <path>" line per untracked, non-ignored file.
_loki_edit_untracked_hashes() {
    local f
    git ls-files --others --exclude-standard | while IFS= read -r f; do
        [ -f "$f" ] && printf '%s %s\n' "$(git hash-object -- "$f" 2>/dev/null)" "$f"
    done
}

_cmd_edit_run() {
    local do_verify=false do_receipt=false do_commit=false dry=false
    local paths=() change=""
    local a
    while [ $# -gt 0 ]; do
        a="$1"
        case "$a" in
            --help|-h|help) _loki_edit_usage; return 0 ;;
            --verify) do_verify=true ;;
            --receipt) do_receipt=true ;;
            --commit) do_commit=true ;;
            --dry-run) dry=true ;;
            --quiet|-q|--json) ;;
            --) shift; change="$*"; break ;;
            -*) echo "loki edit: unknown option: $a" >&2; _loki_edit_usage >&2; return 2 ;;
            *)
                if [ $# -gt 1 ] && [ -e "$a" ]; then
                    paths+=("$a")
                else
                    change="$*"
                    break
                fi
                ;;
        esac
        shift
    done
    if [ -z "$change" ]; then
        echo "loki edit: no change description given" >&2
        _loki_edit_usage >&2
        return 2
    fi
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "loki edit: not inside a git repository" >&2
        return 2
    fi
    local prov="${LOKI_PROVIDER:-claude}"
    if [ "$prov" != "claude" ]; then
        echo "loki edit: provider '$prov' is not supported by the one-pass path; use loki quick, or unset LOKI_PROVIDER" >&2
        return 2
    fi
    if ! command -v claude >/dev/null 2>&1; then
        echo "loki edit: claude CLI not found (run loki doctor)" >&2
        return 2
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        echo "loki edit: python3 is required" >&2
        return 2
    fi

    local before_head before_status
    before_head="$(git rev-parse HEAD 2>/dev/null || echo none)"
    before_status="$(git status --porcelain)"
    local before_untracked
    before_untracked="$(_loki_edit_untracked_hashes)"

    local prompt scope=""
    if [ "${#paths[@]}" -gt 0 ]; then
        scope=" Limit changes to these paths: ${paths[*]}."
    fi
    if [ "$dry" = true ]; then
        prompt="Plan only, do not modify any file. Describe the exact edits (file, location, change) needed for: ${change}.${scope}"
    else
        prompt="Make this change in the current repository with the smallest correct edit: ${change}.${scope} Do not create branches, commits, plans or documents. Reply with one short sentence."
    fi

    local args=(-p "$prompt" --output-format json)
    if [ "$dry" = true ]; then
        args+=(--permission-mode plan)
    else
        args+=(--permission-mode acceptEdits --allowedTools "Read Edit Write Glob Grep")
    fi
    [ -n "${LOKI_EDIT_MODEL:-}" ] && args+=(--model "$LOKI_EDIT_MODEL")

    local start_s out rc
    start_s="$(date +%s)"
    out="$(LOKI_NO_BROWSER=1 claude "${args[@]}" 2>&1)"
    rc=$?
    local elapsed=$(( $(date +%s) - start_s ))

    local parsed
    parsed="$(printf '%s' "$out" | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw)
except Exception:
    print("0|1|"+raw.strip()[:400].replace("\n"," ")); sys.exit(0)
c=d.get("total_cost_usd",d.get("cost_usd",0)) or 0
err=1 if d.get("is_error") else 0
print("%s|%s|%s" % (c,err,(d.get("result") or "").strip().replace("\n"," ")[:400]))
' 2>/dev/null)"
    local cost="0" iserr="1" msg="" rest=""
    case "$parsed" in
        *'|'*'|'*) cost="${parsed%%|*}"; rest="${parsed#*|}"; iserr="${rest%%|*}"; msg="${rest#*|}" ;;
        *) msg="$parsed" ;;
    esac

    [ -n "${_LOKI_EDIT_COST_FILE:-}" ] && printf '%s\n' "$cost" > "$_LOKI_EDIT_COST_FILE" 2>/dev/null
    if [ "$rc" -ne 0 ] || [ "$iserr" = "1" ]; then
        echo "loki edit: provider pass failed (exit $rc)" >&2
        [ -n "$msg" ] && echo "$msg" >&2
        return 1
    fi

    if [ "$dry" = true ]; then
        [ -n "$msg" ] && echo "$msg"
        printf 'dry-run: no files changed | cost $%s | %ss\n' "$cost" "$elapsed"
        return 0
    fi

    # Files touched by this pass: status delta against the pre-run snapshot.
    local touched
    touched="$(git status --porcelain | grep -vxF -f <(printf '%s\n' "$before_status") 2>/dev/null | sed 's/^...//' || true)"
    # A file untracked before the run keeps the same porcelain line when edited,
    # so also pick up untracked files whose content hash changed.
    local changed_untracked
    changed_untracked="$(_loki_edit_untracked_hashes | grep -vxF -f <(printf '%s\n' "$before_untracked") 2>/dev/null | sed 's/^[^ ]* //' || true)"
    if [ -n "$changed_untracked" ]; then
        touched="$(printf '%s\n%s\n' "$touched" "$changed_untracked" | sed '/^$/d' | sort -u)"
    fi
    [ -n "$touched" ] || touched="$(git diff --name-only)"

    if [ -z "$touched" ]; then
        echo "No changes made. ${msg}"
        printf 'cost $%s | %ss\n' "$cost" "$elapsed"
        return 0
    fi

    git --no-pager diff --stat
    if [ -t 1 ]; then git diff; else git --no-pager diff; fi
    [ -n "$msg" ] && echo "$msg"

    local vrc=0
    if [ "$do_verify" = true ]; then
        local fv="${_LOKI_SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/fast_verify.py"
        if [ -f "$fv" ]; then
            python3 "$fv" || vrc=$?
        else
            echo "loki edit: fast_verify not found at $fv" >&2
            vrc=2
        fi
        if [ "$vrc" -eq 0 ]; then echo "verify: pass"; else echo "verify: FAILED (exit $vrc)" >&2; fi
    fi

    if [ "$do_receipt" = true ]; then
        local rdir=".loki/edit-receipts" ts rf
        ts="$(date -u +%Y%m%dT%H%M%SZ)"
        mkdir -p "$rdir"
        rf="$rdir/edit-$ts.json"
        git diff | python3 -c '
import hashlib,json,sys
d=sys.stdin.buffer.read()
json.dump({"kind":"edit-receipt","signed":False,"task":sys.argv[1],"base":sys.argv[2],"diff_sha256":hashlib.sha256(d).hexdigest(),"cost_usd":float(sys.argv[3] or 0),"elapsed_s":int(sys.argv[4]),"verify_exit":int(sys.argv[5])},open(sys.argv[6],"w"),indent=2)
' "$change" "$before_head" "$cost" "$elapsed" "$vrc" "$rf"
        echo "receipt: $rf (unsigned)"
    fi

    if [ "$do_commit" = true ]; then
        if [ "$vrc" -ne 0 ]; then
            echo "loki edit: not committing because verify failed" >&2
        else
            local subj f
            subj="$(printf '%s' "$change" | tr '\n' ' ' | cut -c1-68)"
            while IFS= read -r f; do
                [ -n "$f" ] && git add -- "$f"
            done <<< "$touched"
            if git commit -q -m "edit: $subj" -m "Generated by loki edit."; then
                echo "committed: $(git rev-parse --short HEAD)"
            fi
        fi
    fi

    printf 'cost $%s | %ss\n' "$cost" "$elapsed"
    [ "$vrc" -eq 0 ] || return 1
    return 0
}
