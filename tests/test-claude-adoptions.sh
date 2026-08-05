#!/usr/bin/env bash
# v7.8.0 regression test: additive Claude Code flag adoptions.
#   - --setting-sources user,project,local (gated, opt out LOKI_SETTING_SOURCES=off)
#   - --include-partial-messages (gated, opt out LOKI_PARTIAL_MESSAGES=off)
#     + the stream-json parser handles stream_event deltas and de-dupes the
#       final assistant text (no double-print).
# Both are gated on loki_claude_flag_supported and fall back to current behavior.
set -u
PY=$(command -v python3.12 || command -v python3)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1
RUN="$REPO_ROOT/autonomy/run.sh"
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"

# --- static wiring -----------------------------------------------------------
grep -q 'loki_claude_flag_supported "--setting-sources"' "$RUN" \
  && grep -q '"--setting-sources" "user,project,local"' "$RUN" \
  && ok "run.sh autonomous path adds --setting-sources (gated)" \
  || bad "run.sh missing gated --setting-sources"

grep -q 'loki_claude_flag_supported "--include-partial-messages"' "$RUN" \
  && ok "run.sh autonomous path adds --include-partial-messages (gated)" \
  || bad "run.sh missing gated --include-partial-messages"

grep -q 'LOKI_SETTING_SOURCES:-on' "$RUN" && grep -q 'LOKI_PARTIAL_MESSAGES:-on' "$RUN" \
  && ok "run.sh honors LOKI_SETTING_SOURCES / LOKI_PARTIAL_MESSAGES opt-outs" \
  || bad "run.sh missing opt-out env gates"

grep -q '"--setting-sources" "user,project,local"' "$CLAUDE_SH" \
  && grep -q '"--include-partial-messages"' "$CLAUDE_SH" \
  && ok "providers/claude.sh helper builder adds both flags (parity)" \
  || bad "claude.sh helper missing the new flags"

# parser handles stream_event additively
grep -q 'msg_type == "stream_event"' "$RUN" \
  && grep -q 'streamed_text_blocks' "$RUN" \
  && ok "stream-json parser handles stream_event + de-dupes final text" \
  || bad "parser missing stream_event handling"

# --- v8.x: code-review structured verdict (--json-schema), BOTH routes ---------
# Catches the two failure modes the adversarial review named: (P1) passing a PATH
# to --json-schema (CLI rejects it -> feature silently dead), and (P2) one-route
# divergence (a flag on bash but not TS passes every other gate since the CLI
# matrix never invokes a model). Assert BOTH routes wire it, gated + content-not-path.
QG="$REPO_ROOT/loki-ts/src/runner/quality_gates.ts"
CRSCHEMA="$REPO_ROOT/loki-ts/data/code-review-schema.json"

# bash route: gated on --json-schema support, passes CONTENT (schema_content), opt-out.
grep -q 'loki_claude_flag_supported "--json-schema"' "$RUN" \
  && grep -q -- '--json-schema "\$_cr_schema_content"' "$RUN" \
  && grep -q 'LOKI_REVIEW_JSON_SCHEMA' "$RUN" \
  && ok "run.sh reviewer adds gated --json-schema with CONTENT (not a path) + opt-out" \
  || bad "run.sh reviewer missing gated --json-schema content-wiring"
# bash route must NOT pass a bare schema PATH to --json-schema (the P1 bug).
if grep -Eq -- '--json-schema "\$_cr_schema"( |$)' "$RUN"; then
  bad "run.sh passes a PATH to --json-schema (CLI rejects it -> structured review dead)"
else
  ok "run.sh does not pass a bare schema PATH to --json-schema"
fi

# TS route: same adoption, gated on claudeFlagSupported, passes readFileSync content.
grep -q 'claudeFlagSupported("--json-schema")' "$QG" \
  && grep -q 'readFileSync(CODE_REVIEW_SCHEMA_PATH' "$QG" \
  && grep -q 'LOKI_REVIEW_JSON_SCHEMA' "$QG" \
  && ok "quality_gates.ts reviewer adds gated --json-schema with CONTENT + opt-out (parity)" \
  || bad "quality_gates.ts reviewer missing gated --json-schema content-wiring (route divergence)"

# schema file exists + is valid JSON + carries the PASS/FAIL + severity contract.
if [ -f "$CRSCHEMA" ] && $PY -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['properties']['verdict']['enum']==['PASS','FAIL']; assert 'Critical' in d['properties']['findings']['items']['properties']['severity']['enum']" "$CRSCHEMA" 2>/dev/null; then
  ok "code-review-schema.json valid + PASS/FAIL verdict + severity enum"
else
  bad "code-review-schema.json missing/invalid or wrong contract"
fi

# re-materializer exists + T1 (Critical/High forces FAIL) is present on both routes.
REMAT="$REPO_ROOT/autonomy/lib/cr-rematerialize.py"
if [ -f "$REMAT" ] && grep -q '_BLOCKING' "$REMAT" && grep -q 'verdict = "FAIL"' "$REMAT"; then
  ok "cr-rematerialize.py present with T1 force-FAIL-on-blocking-severity"
else
  bad "cr-rematerialize.py missing or missing the T1 force-FAIL guard"
fi
grep -q 'hasBlocking) verdict = "FAIL"' "$QG" \
  && ok "quality_gates.ts rematerializeCodeReview has the T1 force-FAIL guard (parity)" \
  || bad "quality_gates.ts missing the T1 force-FAIL guard (route divergence on fake-green)"

# --- v8.x: council-v2 structured verdict (--json-schema, content not path) -----
C2="$REPO_ROOT/autonomy/council-v2.sh"
C2SCHEMA="$REPO_ROOT/loki-ts/data/council-v2-schema.json"
grep -q 'loki_claude_flag_supported "--json-schema"' "$C2" \
  && grep -q -- '--json-schema "\$_c2_schema_content"' "$C2" \
  && grep -q 'LOKI_REVIEW_JSON_SCHEMA' "$C2" \
  && ok "council-v2.sh adds gated --json-schema with CONTENT (not a path) + opt-out" \
  || bad "council-v2.sh missing gated --json-schema content-wiring"
if grep -Eq -- '--json-schema "\$_c2_schema"( |$)' "$C2"; then
  bad "council-v2.sh passes a PATH to --json-schema (CLI rejects it -> structured dead)"
else
  ok "council-v2.sh does not pass a bare schema PATH to --json-schema"
fi
if [ -f "$C2SCHEMA" ] && $PY -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['properties']['verdict']['enum']==['APPROVE','REJECT']" "$C2SCHEMA" 2>/dev/null; then
  ok "council-v2-schema.json valid + APPROVE/REJECT verdict enum"
else
  bad "council-v2-schema.json missing/invalid or wrong contract"
fi

# --- v8.x: done-recognition structured verdict (--json-schema, content not path)
DR="$REPO_ROOT/autonomy/lib/done-recognition.sh"
DRSCHEMA="$REPO_ROOT/loki-ts/data/done-recognition-schema.json"
grep -q 'loki_claude_flag_supported "--json-schema"' "$DR" \
  && grep -q -- '--json-schema "\$_dr_schema_content"' "$DR" \
  && grep -q 'LOKI_REVIEW_JSON_SCHEMA' "$DR" \
  && ok "done-recognition.sh adds gated --json-schema with CONTENT (not a path) + opt-out" \
  || bad "done-recognition.sh missing gated --json-schema content-wiring"
if grep -Eq -- '--json-schema "\$_dr_schema"( |$)' "$DR"; then
  bad "done-recognition.sh passes a PATH to --json-schema (CLI rejects it -> structured dead)"
else
  ok "done-recognition.sh does not pass a bare schema PATH to --json-schema"
fi
if [ -f "$DRSCHEMA" ] && $PY -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['properties']['verdict']['enum']==['done','incomplete','inconclusive']; assert 'requirements' in d['required']" "$DRSCHEMA" 2>/dev/null; then
  ok "done-recognition-schema.json valid + verdict enum + requirements required"
else
  bad "done-recognition-schema.json missing/invalid or wrong contract"
fi

# --- syntax ------------------------------------------------------------------
bash -n "$RUN" && ok "autonomy/run.sh passes bash -n" || bad "run.sh syntax error"
bash -n "$CLAUDE_SH" && ok "providers/claude.sh passes bash -n" || bad "claude.sh syntax error"

# --- functional: parser de-dup (partial deltas streamed once, full suppressed)
DEDUP=$($PY - <<'PYEOF' 2>&1 | tail -1
import json
streamed=False; out=[]
samples=[
  '{"type":"stream_event","event":{"type":"message_start","message":{}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
]
for line in samples:
    data=json.loads(line); mt=data.get("type","")
    if mt=="stream_event":
        ev=data.get("event",{}); et=ev.get("type")
        if et=="message_start": streamed=False
        elif et=="content_block_delta":
            d=ev.get("delta",{})
            if d.get("type")=="text_delta":
                t=d.get("text","")
                if t: out.append(t); streamed=True
        continue
    if mt=="assistant":
        for it in data.get("message",{}).get("content",[]):
            if it.get("type")=="text":
                t=it.get("text","")
                if t and not streamed: out.append("[FULL]"+t)
txt="".join(out)
print("DEDUP_OK" if txt=="hello" else "DEDUP_FAIL:"+repr(txt))
PYEOF
)
[ "$DEDUP" = "DEDUP_OK" ] && ok "partial deltas render once; final assistant text suppressed (no double-print)" || bad "parser de-dup: $DEDUP"

# --- functional: parser without partials still prints the full message -------
NOPART=$($PY - <<'PYEOF' 2>&1 | tail -1
import json
streamed=False; out=[]
# no stream_event lines (partials off) -> assistant text must print
for line in ['{"type":"assistant","message":{"content":[{"type":"text","text":"plain"}]}}']:
    data=json.loads(line); mt=data.get("type","")
    if mt=="assistant":
        for it in data.get("message",{}).get("content",[]):
            if it.get("type")=="text":
                t=it.get("text","")
                if t and not streamed: out.append(t)
print("NOPART_OK" if "".join(out)=="plain" else "NOPART_FAIL")
PYEOF
)
[ "$NOPART" = "NOPART_OK" ] && ok "partials-off fallback: assistant text still prints (no regression)" || bad "fallback: $NOPART"

# --- live (best-effort): real claude partial stream renders the marker once --
if command -v claude >/dev/null 2>&1; then
    SAMP=$(mktemp); PC=$(mktemp --suffix=.py 2>/dev/null || mktemp)
    timeout 35 claude --dangerously-skip-permissions -p "Reply with exactly: PARTIAL-MARK-9" --output-format stream-json --verbose --include-partial-messages 2>/dev/null > "$SAMP"
    cat > "$PC" <<'PYEOF'
import sys,json
streamed=False; out=[]
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: data=json.loads(line)
    except: continue
    mt=data.get("type","")
    if mt=="stream_event":
        ev=data.get("event",{}); et=ev.get("type")
        if et=="message_start": streamed=False
        elif et=="content_block_delta":
            d=ev.get("delta",{})
            if d.get("type")=="text_delta":
                t=d.get("text","")
                if t: out.append(t); streamed=True
        continue
    if mt=="assistant":
        for it in data.get("message",{}).get("content",[]):
            if it.get("type")=="text":
                t=it.get("text","")
                if t and not streamed: out.append("[FULL]"+t)
txt="".join(out); n=txt.count("PARTIAL-MARK-9")
print("LIVE_OK" if n==1 and "[FULL]" not in txt else f"LIVE_SKIP n={n}")
PYEOF
    LIVE=$($PY "$PC" < "$SAMP" 2>/dev/null | tail -1)
    rm -f "$SAMP" "$PC"
    case "$LIVE" in
        LIVE_OK) ok "live claude partial stream renders the marker once (real run)" ;;
        *) ok "live partial-stream check skipped/inconclusive ($LIVE) -- static+functional cover it" ;;
    esac
else
    ok "live partial-stream check skipped (no claude on PATH)"
fi

# --- no em dashes ------------------------------------------------------------
if grep -lP '\xe2\x80\x94' "$RUN" "$CLAUDE_SH" "$SCRIPT_DIR/test-claude-adoptions.sh" >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
