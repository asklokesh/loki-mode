#!/usr/bin/env bash
# tests/test-code-review-json-rematerialize.sh -- v8.x structured code-review.
#
# Proves the JSON->legacy-text adapter (autonomy/lib/cr-rematerialize.py) drives
# the UNCHANGED downstream verdict parsers to the correct decision, and is
# fail-closed on every malformed envelope. ZERO billable agent calls: it feeds
# hand-crafted envelopes plus one RECORDED-real envelope. It also awk-extracts
# the REAL _classify_verdict / _severity_is_blocking / _count_nonblocking_findings
# bodies from run.sh and runs the re-materialized text through them, so any drift
# in those functions breaks this test (extraction-harness discipline).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMAT="$REPO_ROOT/autonomy/lib/cr-rematerialize.py"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# ---------- extract the real downstream parsers from run.sh ----------
# Same awk-extraction pattern as test-code-review-verdict-parse-wave8.sh so a
# drift in the real bodies breaks this test too. set +u inside the eval subshell
# (extracted fns reference orchestrator vars we do not set).
_extract() { awk "/^${1}\(\) \{/,/^\}/" "$RUN_SH"; }
FN_SRC="$(_extract _classify_verdict)
$(_extract _severity_is_blocking)
$(_extract _count_nonblocking_findings)"
# sanity: extraction captured the functions
case "$FN_SRC" in
    *"_classify_verdict()"*"_severity_is_blocking()"*"_count_nonblocking_findings()"*)
        ok "extracted the 3 downstream parsers from run.sh" ;;
    *)  bad "extraction missed a parser body (run.sh drift?)"; ;;
esac

# classify <json-envelope> -> echoes "VERDICT_TOKEN|blocking_rc|med low" or "PYFAIL:<rc>"
classify() {
    local envelope="$1" tmp txt vtok brc counts pyrc
    tmp="$(mktemp)"
    if _LOKI_CR_JSON="$envelope" _LOKI_CR_OUT="$tmp" python3 "$REMAT"; then
        pyrc=0
    else
        pyrc=$?
    fi
    if [ "$pyrc" -ne 0 ]; then
        rm -f "$tmp"
        printf 'PYFAIL:%s' "$pyrc"
        return 0
    fi
    txt="$(cat "$tmp")"
    # run the extracted parsers against the re-materialized file
    ( set +u
      eval "$FN_SRC"
      vtok="$(_classify_verdict "$tmp")"
      if _severity_is_blocking "$tmp"; then brc=0; else brc=1; fi
      counts="$(_count_nonblocking_findings "$tmp")"
      printf '%s|%s|%s' "$vtok" "$brc" "$counts"
    )
    rm -f "$tmp"
}

# ---------- VALID cases (correct decision by construction) ----------
r=$(classify '{"stop_reason":"tool_use","structured_output":{"verdict":"FAIL","findings":[{"severity":"Critical","description":"SQLi (a.py:10)"}]}}')
[ "$r" = "FAIL|0|0 0" ] && ok "FAIL+Critical -> FAIL, blocking, 0 0" || bad "FAIL+Critical got [$r]"

r=$(classify '{"stop_reason":"tool_use","structured_output":{"verdict":"PASS","findings":[]}}')
[ "$r" = "PASS|1|0 0" ] && ok "PASS+empty -> PASS, non-blocking, 0 0 (- None)" || bad "PASS+empty got [$r]"

r=$(classify '{"stop_reason":"tool_use","structured_output":{"verdict":"FAIL","findings":[{"severity":"Medium","description":"m"},{"severity":"Low","description":"l"}]}}')
[ "$r" = "FAIL|1|1 1" ] && ok "FAIL+Medium+Low -> FAIL, non-blocking, 1 1" || bad "FAIL+Med+Low got [$r]"

# result-string fallback (no structured_output key)
r=$(classify '{"stop_reason":"tool_use","result":"{\"verdict\":\"PASS\",\"findings\":[]}"}')
[ "$r" = "PASS|1|0 0" ] && ok "result-string fallback -> PASS+None" || bad "result-string got [$r]"

# ---------- T1: fake-green guard (PASS + Critical MUST become FAIL/blocking) ----------
r=$(classify '{"stop_reason":"tool_use","structured_output":{"verdict":"PASS","findings":[{"severity":"Critical","description":"SQLi"}]}}')
[ "$r" = "FAIL|0|0 0" ] && ok "T1: PASS+Critical FORCED to FAIL+blocking (no fake-green)" || bad "T1 FAILED, got [$r] (fake-green risk!)"

r=$(classify '{"stop_reason":"tool_use","structured_output":{"verdict":"PASS","findings":[{"severity":"High","description":"authz bypass"}]}}')
[ "$r" = "FAIL|0|0 0" ] && ok "T1: PASS+High FORCED to FAIL+blocking" || bad "T1 High got [$r]"

# ---------- FAIL-CLOSED cases (py exits non-zero, never PASS) ----------
for envelope in \
    'not json at all' \
    '{"stop_reason":"tool_use","structured_output":{"findings":[]}}' \
    '{"stop_reason":"refusal","structured_output":{"verdict":"PASS","findings":[]}}' \
    '{"stop_reason":"tool_use","structured_output":{"verdict":"MAYBE","findings":[]}}' ; do
    r=$(classify "$envelope")
    case "$r" in
        PYFAIL:*) ok "fail-closed (py non-zero) for: ${envelope:0:40}" ;;
        *) bad "NOT fail-closed for [${envelope:0:40}] -> got [$r]" ;;
    esac
done

# ---------- RECORDED-REAL envelope (locks the field contract to reality) ----------
# Captured from a live claude 2.1.207 --json-schema --output-format json run.
REAL='{"stop_reason":"tool_use","structured_output":{"verdict":"FAIL","findings":[{"severity":"Critical","description":"SQL injection vulnerability (db.py:10)"}]},"result":"{\"verdict\":\"FAIL\",\"findings\":[{\"severity\":\"Critical\",\"description\":\"SQL injection vulnerability (db.py:10)\"}]}"}'
r=$(classify "$REAL")
[ "$r" = "FAIL|0|0 0" ] && ok "recorded-real envelope -> FAIL, blocking" || bad "recorded-real got [$r]"

# ---------- v8 RAW-SDK BARE OBJECT (no CLI envelope) ----------
# `loki internal sdk-judge` emits the bare payload, not the CLI envelope. The
# re-materializer must accept it and reach the SAME decision, with T1 + fail-
# closed intact. Byte-for-byte parity with the TS bare-object test.
r=$(classify '{"verdict":"PASS","findings":[]}')
[ "$r" = "PASS|1|0 0" ] && ok "SDK bare PASS+empty -> PASS, non-blocking (parity)" || bad "SDK bare PASS got [$r]"

r=$(classify '{"verdict":"FAIL","findings":[{"severity":"Critical","description":"SQLi (a.py:10)"}]}')
[ "$r" = "FAIL|0|0 0" ] && ok "SDK bare FAIL+Critical -> FAIL, blocking (parity)" || bad "SDK bare FAIL+Crit got [$r]"

r=$(classify '{"verdict":"PASS","findings":[{"severity":"High","description":"authz bypass"}]}')
[ "$r" = "FAIL|0|0 0" ] && ok "T1: SDK bare PASS+High FORCED to FAIL (no fake-green)" || bad "T1 SDK bare got [$r]"

# fail-closed on a bare object that isn't a payload / bad token
for envelope in \
    '{"foo":"bar","findings":[]}' \
    '{"verdict":"MAYBE","findings":[]}' ; do
    r=$(classify "$envelope")
    case "$r" in
        PYFAIL:*) ok "fail-closed (bare) for: ${envelope:0:40}" ;;
        *) bad "NOT fail-closed (bare) for [${envelope:0:40}] -> got [$r]" ;;
    esac
done

echo ""
echo "Total: $((PASS+FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
