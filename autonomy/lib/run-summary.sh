#!/usr/bin/env bash
# OC-OUTPUT: unified end-of-run summary for the legacy engine. Same format as
# loki-ts/src/engine10/run_summary.ts (Result, Files, Cost, Elapsed, Receipt, next).
# Sourced by autonomy/run.sh; defines functions only.
#
#   loki_run_summary RESULT_CODE [START_SHA]
# Honors NO_COLOR, LOKI_QUIET=1 (summary only is the caller's choice), LOKI_SUMMARY_JSON=1.

loki_run_summary() {
    local code="${1:-0}" start_sha="${2:-${_LOKI_RUN_START_SHA:-}}"
    local loki_dir="${LOKI_DIR:-${TARGET_DIR:-.}/.loki}"
    local result="done-unverified" files="" ins="" del="" shortstat="" cost="" receipt="" next=""
    local elapsed=$(( $(date +%s) - ${SESSION_START_EPOCH:-$(date +%s)} ))

    # Result: verified only when a proof exists and the run exited 0.
    local rid="" proof=""
    if [ -s "$loki_dir/state/last-proof-id.txt" ]; then rid="$(head -n1 "$loki_dir/state/last-proof-id.txt" 2>/dev/null | tr -d '[:space:]')"; fi
    case "$rid" in *[!A-Za-z0-9._-]*) rid="" ;; esac
    [ -n "$rid" ] && [ -f "$loki_dir/proofs/$rid/proof.json" ] && proof="$loki_dir/proofs/$rid/proof.json"
    case "$code" in
        0) if [ -n "$proof" ]; then result="verified"; else result="done-unverified"; fi ;;
        130|143) result="stopped" ;;
        *) result="failed" ;;
    esac
    [ -f "$loki_dir/STOPPED" ] && result="stopped"
    [ -n "$proof" ] && receipt="$proof"

    # Files changed vs run-start SHA (excluding .loki and .git).
    if [ -n "$start_sha" ]; then
        shortstat="$( (cd "${TARGET_DIR:-.}" && git diff --shortstat "${start_sha}..HEAD" -- . ':(exclude).loki/' ':(exclude).git/') 2>/dev/null || true )"
        files="$(printf '%s\n' "$shortstat" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' | head -1)"
        ins="$(printf '%s\n' "$shortstat" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' | head -1)"
        del="$(printf '%s\n' "$shortstat" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' | head -1)"
        [ -z "$files" ] && files=0
        [ -z "$ins" ] && ins=0
        [ -z "$del" ] && del=0
    fi

    # Cost: legacy cost comes from the context tracker (token estimate), so it is always marked estimated.
    if [ -f "$loki_dir/context/tracking.json" ]; then
        cost="$(LOKI_TRK="$loki_dir/context/tracking.json" python3 -E -c "
import json, os
try:
    c = json.load(open(os.environ['LOKI_TRK'])).get('totals', {}).get('total_cost_usd')
    print('' if c is None else '%.2f' % float(c))
except Exception:
    print('')
" 2>/dev/null || true)"
    fi

    case "$result" in
        verified) if [ "${files:-0}" != "0" ] && [ -n "$files" ]; then next="loki diff"; else next="loki status"; fi ;;
        done-unverified) next="loki verify" ;;
        stopped) next="loki status" ;;
        *) if [ -n "$files" ] && [ "$files" != "0" ]; then next="loki undo"; else next="loki doctor"; fi ;;
    esac

    local mm=$((elapsed / 60)) ss=$((elapsed % 60)) elapsed_h
    if [ "$elapsed" -lt 60 ]; then elapsed_h="${elapsed}s"; else elapsed_h="${mm}m$(printf '%02d' "$ss")s"; fi

    if [ "${LOKI_SUMMARY_JSON:-0}" = "1" ]; then
        printf '{"result":"%s","files_changed":%s,"insertions":%s,"deletions":%s,"cost_usd":%s,"cost_estimated":true,"elapsed_s":%s,"receipt":%s,"next":"%s"}\n' \
            "$result" "${files:-null}" "${ins:-null}" "${del:-null}" "${cost:-null}" "$elapsed" \
            "$([ -n "$receipt" ] && printf '"%s"' "$receipt" || printf 'null')" "$next"
        return 0
    fi

    local c0="" c1=""
    if [ -t 1 ] && [ -z "${NO_COLOR+x}" ]; then
        c1=$'\033[0m'
        case "$result" in verified) c0=$'\033[32m' ;; done-unverified) c0=$'\033[33m' ;; *) c0=$'\033[31m' ;; esac
    fi
    local files_h="unknown" cost_h="not measured"
    [ -n "$files" ] && files_h="${files} changed (+${ins} -${del})"
    [ -n "$cost" ] && cost_h="\$${cost} (estimated)"
    printf '\n'
    printf 'Result:   %s%s%s\n' "$c0" "$result" "$c1"
    printf 'Files:    %s\n' "$files_h"
    printf 'Cost:     %s\n' "$cost_h"
    printf 'Elapsed:  %s\n' "$elapsed_h"
    [ -n "$receipt" ] && printf 'Receipt:  %s\n' "$receipt"
    printf 'next:     %s\n' "$next"
}
