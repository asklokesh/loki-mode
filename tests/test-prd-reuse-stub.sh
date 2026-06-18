#!/usr/bin/env bash
# v7.8.1+ end-to-end stub proof for staleness-aware generated-PRD reuse.
#
# Honest interpretation of "reuse consumes zero provider calls": a real reuse
# run still calls the provider to do build work, but it must make ZERO codebase
# RE-ANALYSIS / regeneration calls. The discriminating fact is the prompt: only
# the generate path injects CODEBASE_ANALYSIS_MODE. This harness puts a stub
# provider on PATH that counts how many invocations receive a CODEBASE_ANALYSIS_
# MODE prompt, runs the real CLI loop twice (MAX_ITERATIONS=1 each, hermetic, no
# network, no spend), and asserts:
#   Run 1 (no PRD, no generated PRD): analysis counter >= 1, generated-prd.md
#     written, prd-signature.json recorded.
#   Run 2 (reuse): analysis counter == 0 AND generated-prd.md byte-identical.
#
# Uses the claude provider route, because that is the route whose prompt is
# assembled by build_prompt and therefore carries the CODEBASE_ANALYSIS_MODE
# instruction (the codex degraded route uses a minimal hand-built prompt without
# it). The stub claude reads the -p prompt, counts CODEBASE_ANALYSIS_MODE
# invocations, and emits the completion-promise text so the loop stops after one
# real provider call. Never touches port 57374, never spends, trap-rm cleanup.
set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/loki-prdstub-XXXXXX")
BIN=$(mktemp -d "${TMPDIR:-/tmp}/loki-prdstub-bin-XXXXXX")
# Harness scratch (run stdout/stderr capture + the analysis counter) lives
# OUTSIDE $WORK so it never pollutes the git tree Loki operates on. With
# feature-branch-by-default (v7.73.0) Loki commits the work tree at session end;
# if the harness wrote its own .run.out/.run.err/count files INTO $WORK they
# would be committed and their content would differ run-to-run, making the
# codebase signature change between runs and spuriously flipping reuse->update.
# Keeping them out of $WORK keeps the tree honest (only real codebase content).
OUT=$(mktemp -d "${TMPDIR:-/tmp}/loki-prdstub-out-XXXXXX")
cleanup() { rm -rf "$WORK" "$BIN" "$OUT"; }
trap cleanup EXIT INT TERM

# --- a tiny real git project (so signature uses git mode) --------------------
(
  cd "$WORK" && git init -q && git config user.email t@t && git config user.name t \
    && printf 'print("hi")\n' > app.py \
    && printf '{"name":"stub","scripts":{"start":"python app.py"}}\n' > package.json \
    && git add app.py package.json && git commit -qm init
) 2>/dev/null

# --- the stub provider -------------------------------------------------------
# Invoked as: claude <argv...> -p "<prompt>" --output-format stream-json --verbose
# Extract the value following -p, count a re-analysis call only when that prompt
# contains CODEBASE_ANALYSIS_MODE, and in that case write a deterministic
# generated PRD (mimicking the agent). Always exits 0 and emits the completion-
# promise text (raw line; the runner greps the tee'd output for it) so the loop
# stops after one real provider call.
cat > "$BIN/claude" <<STUB
#!/usr/bin/env bash
prompt=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "-p" ]; then prompt="\$a"; fi
  prev="\$a"
done
cnt_file="\${LOKI_STUB_COUNT_FILE:-/dev/null}"
case "\$prompt" in
  *CODEBASE_ANALYSIS_MODE*)
    n=0; [ -f "\$cnt_file" ] && n=\$(cat "\$cnt_file")
    echo \$((n+1)) > "\$cnt_file"
    mkdir -p .loki
    printf '# Generated PRD\n\nOverview: stub.\n' > .loki/generated-prd.md
    ;;
esac
echo "stub provider done. STUB_COMPLETE"
exit 0
STUB
chmod +x "$BIN/claude"

COUNT_FILE="$OUT/.stub-analysis-count"
echo 0 > "$COUNT_FILE"

run_once() {
  # One hermetic single-iteration run against the stub claude provider. Wrapped
  # in a generous per-run timeout so a hang cannot stall local-ci indefinitely
  # (slowness alone is fine: the assertions check the recorded effect, not wall
  # time). A timeout expiry surfaces as a missing PRD/count -> a clear FAIL.
  local _to="${LOKI_PRDSTUB_TIMEOUT:-240}"
  ( cd "$WORK" \
    && PATH="$BIN:$PATH" \
       LOKI_TARGET_DIR="$WORK" \
       LOKI_PROVIDER=claude \
       LOKI_STUB_COUNT_FILE="$COUNT_FILE" \
       LOKI_MAX_ITERATIONS=2 \
       LOKI_COMPLETION_PROMISE="STUB_COMPLETE" \
       LOKI_AUTO_CONFIRM=true \
       LOKI_SKIP_PREREQS=true \
       LOKI_DASHBOARD=false \
       LOKI_PHASE_CODE_REVIEW=false \
       LOKI_COUNCIL_ENABLED=false \
       LOKI_APP_RUNNER=false \
       LOKI_TELEMETRY_DISABLED=1 \
       LOKI_NO_NEW_SESSION=1 \
       CI=true \
       timeout "$_to" bash "$RUN_SH" 2>"$OUT/.run.err" >"$OUT/.run.out"
  )
}

# --- RUN 1: first no-PRD run must analyze + generate -------------------------
echo 0 > "$COUNT_FILE"
run_once
N1=$(cat "$COUNT_FILE")
if [ "$N1" -ge 1 ]; then ok "run 1 (no PRD): provider received CODEBASE_ANALYSIS_MODE (${N1} calls)"; else bad "run 1: expected >=1 analysis call, got $N1 (see $OUT/.run.err)"; fi
[ -f "$WORK/.loki/generated-prd.md" ] && ok "run 1: generated-prd.md written" || bad "run 1: no generated-prd.md"
[ -f "$WORK/.loki/state/prd-signature.json" ] && ok "run 1: prd-signature.json recorded (provenance)" || bad "run 1: no prd-signature.json"
PRD_HASH1=$(shasum -a 256 "$WORK/.loki/generated-prd.md" 2>/dev/null | cut -d' ' -f1)

# --- RUN 2: reuse must make ZERO re-analysis calls --------------------------
echo 0 > "$COUNT_FILE"
run_once
N2=$(cat "$COUNT_FILE")
[ "$N2" -eq 0 ] && ok "run 2 (reuse): ZERO CODEBASE_ANALYSIS_MODE provider calls" || bad "run 2: expected 0 re-analysis calls, got $N2 (reuse not honored)"
PRD_HASH2=$(shasum -a 256 "$WORK/.loki/generated-prd.md" 2>/dev/null | cut -d' ' -f1)
[ -n "$PRD_HASH1" ] && [ "$PRD_HASH1" = "$PRD_HASH2" ] && ok "run 2: generated-prd.md byte-identical (not regenerated)" || bad "run 2: generated PRD changed on reuse"
grep -q 'Reusing the PRD last generated or updated on\|Reusing the generated PRD' "$OUT/.run.out" \
  && ok "run 2: reuse disclosure printed to the user" || bad "run 2: no reuse disclosure in output"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
