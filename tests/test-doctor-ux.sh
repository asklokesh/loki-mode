#!/usr/bin/env bash
# test-doctor-ux.sh -- C1 + C3 doctor UX regression tests.
#
# C1: when a provider CLI is missing, `loki doctor` must print the EXACT
#     install command for that provider (not just "not found").
# C3: no misleading "(instant)" timing label may remain in the doctor/CLI
#     surface, and slow network probes must be bounded (have curl timeouts).
#
# Non-vacuity: each assertion greps REAL captured `loki doctor` output (run via
# bash autonomy/loki against this repo). If the doctor output were empty or the
# feature regressed, the install-command and timeout assertions below would FAIL
# rather than silently pass. The negative "(instant)" check is paired with a
# positive check that the corrected "(a few seconds)" label is present, so a
# truncated/empty doctor run cannot make the negative check vacuously pass.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

pass=0
fail=0

ok()   { echo "  PASS  $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail + 1)); }

echo "test-doctor-ux: C1 + C3 doctor UX"
echo ""

# --- Setup: a PATH with NO provider CLIs, so doctor sees them all missing. ----
# We build a sandbox bin dir containing only the basic tools doctor needs
# (so the AI Providers section reports every provider as missing) and run
# doctor against it. This deterministically exercises the C1 missing-provider
# path regardless of what is installed on the host.
_BUN_SRC="$(command -v bun 2>/dev/null || true)"
if [ -z "$_BUN_SRC" ]; then
    for _c in "$REPO_ROOT"/node_modules/@oven/bun-*/bin/bun "$REPO_ROOT"/node_modules/bun/bin/bun.exe; do
        [ -x "$_c" ] && { _BUN_SRC="$_c"; break; }
    done
fi
if [ -z "$_BUN_SRC" ]; then
    echo "SKIP: bun is not available on this host (PATH or node_modules); doctor is bun-only, so this suite cannot run"
    exit 0
fi
SANDBOX_BIN="$(mktemp -d)/bin"
mkdir -p "$SANDBOX_BIN"
ln -sf "$_BUN_SRC" "$SANDBOX_BIN/bun"
for t in bash sh env node python3 jq git curl df awk sed tr head tail cut grep \
         readlink dirname uname cat printf docker npm pip; do
    src="$(command -v "$t" 2>/dev/null || true)"
    [ -n "$src" ] && ln -sf "$src" "$SANDBOX_BIN/$t"
done

# Capture stdout and stderr SEPARATELY. The per-provider "Install:" hints must
# go to STDERR (fd 2) so the parity-captured STDOUT stays byte-identical to the
# Bun route (which emits no per-provider Install line). Merging the two streams
# would make the fd-routing assertions below vacuous, so we keep them split.
DOCTOR_STDOUT_F="$(mktemp)"
DOCTOR_STDERR_F="$(mktemp)"
PATH="$SANDBOX_BIN" bash "$LOKI" doctor >"$DOCTOR_STDOUT_F" 2>"$DOCTOR_STDERR_F" || true
DOCTOR_STDOUT="$(cat "$DOCTOR_STDOUT_F")"
DOCTOR_STDERR="$(cat "$DOCTOR_STDERR_F")"
DOCTOR_OUT="$DOCTOR_STDOUT
$DOCTOR_STDERR"

# Non-vacuity guard: the combined capture must be substantial doctor output.
if [ "$(printf '%s' "$DOCTOR_OUT" | wc -l)" -lt 10 ]; then
    bad "doctor produced <10 lines of output (capture failed; assertions would be vacuous)"
    echo "$DOCTOR_OUT"
    echo ""
    echo "Summary: $pass passed, $fail failed"
    exit 1
fi
ok "doctor produced substantial output ($(printf '%s' "$DOCTOR_OUT" | wc -l | tr -d ' ') lines)"

# --- C1: missing provider prints the EXACT install command on STDERR. ---------
# The hint must appear on stderr (so the user sees it) AND must NOT leak to
# stdout (so bash/Bun parity holds -- the Bun route emits no per-provider line).
for entry in \
    "Claude|Install: npm install -g @anthropic-ai/claude-code" \
    "Codex|Install: npm install -g @openai/codex" \
    "Cline|Install: npm install -g cline" \
    "Aider|Install: pip install aider-chat"; do
    _name="${entry%%|*}"
    _hint="${entry#*|}"
    if grep -q "$_hint" <<<"$DOCTOR_STDERR"; then
        ok "C1: missing $_name CLI prints exact install command on stderr"
    else
        bad "C1: missing $_name CLI did NOT print '$_hint' on stderr"
    fi
done

# --- C1-parity: per-provider Install hints must NOT be on stdout. -------------
# stdout may carry AT MOST one "Install:" line: the shared "No AI provider CLI
# installed" claude-code line, which the Bun route also prints (parity by
# construction). Any more means a per-provider hint leaked back to stdout and
# the parity matrix would break on a host missing a provider.
_stdout_install_count="$(printf '%s' "$DOCTOR_STDOUT" | grep -c "Install:")"
if [ "$_stdout_install_count" -le 1 ]; then
    ok "C1-parity: stdout has <=1 Install line (count=$_stdout_install_count; matches Bun route)"
else
    bad "C1-parity: stdout has $_stdout_install_count Install lines (expected <=1; per-provider hints must be on stderr)"
    printf '%s\n' "$DOCTOR_STDOUT" | grep "Install:"
fi

# Per-provider parity guard: the codex/cline/aider hints (which the shared
# stdout line never contains) must be entirely absent from stdout.
for _ph in "Install: npm install -g @openai/codex" \
           "Install: npm install -g cline" \
           "Install: pip install aider-chat"; do
    if grep -q "$_ph" <<<"$DOCTOR_STDOUT"; then
        bad "C1-parity: per-provider hint leaked to stdout: $_ph"
    else
        ok "C1-parity: per-provider hint absent from stdout: $_ph"
    fi
done

rm -f "$DOCTOR_STDOUT_F" "$DOCTOR_STDERR_F" 2>/dev/null || true

# --- C3: no "(instant)" mislabel remains in either doctor source. -------------
TS_DOCTOR="$REPO_ROOT/loki-ts/src/commands/doctor.ts"
if grep -q "(instant)" "$LOKI" "$TS_DOCTOR"; then
    bad "C3: '(instant)' mislabel still present"
else
    ok "C3: no '(instant)' mislabel in autonomy/loki or doctor.ts"
fi

# Positive pairing so the negative check above cannot be vacuous.
if grep -q "a few seconds" "$LOKI"; then
    ok "C3: corrected '(a few seconds)' timing label present"
else
    bad "C3: corrected '(a few seconds)' timing label missing (negative check may be vacuous)"
fi

# --- C3: slow network probes are bounded (single doctor lives in doctor.ts). --
if grep -q "api/v2/heartbeat" "$TS_DOCTOR" && grep -q "AbortSignal.timeout(timeoutMs)" "$TS_DOCTOR" && \
   grep -Eq "timeoutMs = [0-9]+" "$TS_DOCTOR"; then
    ok "C3: ChromaDB probe is bounded by httpReachable's abort timeout"
else
    bad "C3: ChromaDB network probe is NOT bounded with a timeout"
fi

if grep -q 'httpReachable(`${mfUrl}/health`)' "$TS_DOCTOR"; then
    ok "C3: MiroFish probe goes through the bounded httpReachable"
else
    bad "C3: MiroFish network probe is NOT bounded with a timeout"
fi

# --- FV-readiness-env-3: loki chat reaches repo readiness -----------------------
CHAT_SH="$REPO_ROOT/autonomy/lib/chat.sh"
if grep -q '^  /doctor \[--json\]' "$CHAT_SH" && grep -Eq '/doctor\|/ready\)' "$CHAT_SH" && grep -q '_chat_do "\$loki" doctor --repo' "$CHAT_SH"; then
    ok "FV-readiness-env-3: chat /doctor (alias /ready) is listed in /help and delegates to doctor --repo"
else
    bad "FV-readiness-env-3: chat.sh missing /doctor help line or doctor --repo delegation"
fi

# --- P12-16: loki chat command completeness -------------------------------------
export LOKI_NO_BROWSER=1
chat_ok() { if grep -Eq "$1" "$CHAT_SH"; then ok "P12-16: $2"; else bad "P12-16: $2"; fi; }
chat_ok '^  /answer <text>' "/answer listed in /help"
chat_ok '/answer\)' "/answer dispatch"
chat_ok 'answer --text' "/answer delegates to loki answer --text"
chat_ok '^  /pause' "/pause listed in /help"
chat_ok '/pause\) _chat_do "\$loki" pause' "/pause delegates to loki pause"
chat_ok '^  /resume' "/resume listed in /help"
chat_ok '/resume\) _chat_do "\$loki" resume' "/resume delegates to loki resume"
chat_ok '/run\|/start\)' "/start is an alias of /run"
chat_ok '^  /start' "/start listed in /help"
chat_ok '_chat_run_start "\$loki" "\$input" < /dev/null .* &$' "/run backgrounds the run"
chat_ok '/status /steer.*/stop' "help lists /status /steer /stop"
chat_ok '/steer sends a mid-run directive via loki steer' "system prompt explains /steer"
CHAT_STUB="$(mktemp -d)"
printf '#!/bin/sh\necho "Steer rev 7 received: applies at next plan/implement stage."\n' > "$CHAT_STUB/loki"
chmod +x "$CHAT_STUB/loki"
printf '#!/bin/sh\necho quiet\n' > "$CHAT_STUB/loki-quiet"
chmod +x "$CHAT_STUB/loki-quiet"
if out="$(bash -c 'source "$1"; _chat_steer "$2" go' _ "$CHAT_SH" "$CHAT_STUB/loki" 2>&1)" && grep -q 'Steer rev 7 received' <<<"$out"; then
    ok "P12-16: /steer shows loki steer's rev ack"
else
    bad "P12-16: /steer ack missing: $out"
fi
if out="$(bash -c 'source "$1"; _chat_steer "$2" go' _ "$CHAT_SH" "$CHAT_STUB/loki-quiet" 2>&1)" && grep -q '^Steer not confirmed: quiet$' <<<"$out" && ! echo "$out" | grep -q received; then
    ok "P12-16: /steer without a rev line says 'not confirmed', never 'received'"
else
    bad "P12-16: /steer fallback missing: $out"
fi
if out="$(bash -c 'source "$1"; _chat_steer "$2" help' _ "$CHAT_SH" "$CHAT_STUB/loki" 2>&1)" && grep -q '^usage: /steer' <<<"$out" && ! echo "$out" | grep -q received; then
    ok "P12-16: /steer refuses bare help without calling loki steer"
else
    bad "P12-16: /steer help guard missing: $out"
fi
rm -rf "$CHAT_STUB"

# --- P12-16b: /run proves the start; /steer accepts text beginning with "-" ----
B_DIR="$(mktemp -d)"; B_LOG="$B_DIR/args"
printf '#!/bin/sh\nprintf "%%s|" "$@" > "%s"\necho "Steer rev 1 received"\n' "$B_LOG" > "$B_DIR/loki-rec"
printf '#!/bin/sh\necho "boom: no provider" >&2\nexit 3\n' > "$B_DIR/loki-fail"
printf '#!/bin/sh\nmkdir -p "$LOKI_DIR/runs/e10-1"; echo $$ > "$LOKI_DIR/runs/e10-1/run.pid"; sleep 4\n' > "$B_DIR/loki-ok"
chmod +x "$B_DIR"/loki-*
bash -c 'source "$1"; _chat_steer "$2" "-fix auth"' _ "$CHAT_SH" "$B_DIR/loki-rec" >/dev/null 2>&1
if [ "$(cat "$B_LOG")" = "steer|--|-fix auth|" ]; then ok "P12-16b: /steer passes dash-leading text after --"; else bad "P12-16b: steer args: $(cat "$B_LOG")"; fi
S_DIR="$B_DIR/s/.loki"; mkdir -p "$S_DIR"
LOKI_DIR="$S_DIR" bash -c 'source "$1"; _CHAT_PROVIDER=claude; _chat_steer "$2" "-h"' _ "$CHAT_SH" "$LOKI" >/dev/null 2>&1
if grep -q '^-h$' "$S_DIR/HUMAN_INPUT.md" 2>/dev/null; then ok "P12-16b: loki steer -- treats -h as data"; else bad "P12-16b: loki steer -- -h not recorded"; fi
out="$(LOKI_DIR="$B_DIR/f/.loki" LOKI_CHAT_START_WAIT=3 bash -c 'source "$1"; _CHAT_PROVIDER=claude; _CHAT_MODEL=; _chat_run_launch "$2" brief; echo "rc=$?"' _ "$CHAT_SH" "$B_DIR/loki-fail" 2>&1)"
if grep -q 'rc=3' <<<"$out" && grep -q 'boom: no provider' <<<"$out" && grep -q 'chat-run.log' <<<"$out" && ! grep -q 'Run started' <<<"$out"; then ok "P12-16b: failed /run prints real error and log, never Run started"; else bad "P12-16b: failed run output: $out"; fi
out="$(LOKI_DIR="$B_DIR/o/.loki" LOKI_CHAT_START_WAIT=3 bash -c 'source "$1"; _CHAT_PROVIDER=claude; _CHAT_MODEL=; _chat_run_launch "$2" brief; echo "rc=$?"' _ "$CHAT_SH" "$B_DIR/loki-ok" 2>&1)"
if grep -q 'rc=0' <<<"$out" && grep -q 'Run started' <<<"$out"; then ok "P12-16b: /run prints Run started once a live run exists"; else bad "P12-16b: ok run output: $out"; fi
rm -rf "$B_DIR"

# --- P12-16c: wait validation, new-dir proof, real exit code -------------------
C_DIR="$(mktemp -d)"
printf '#!/bin/sh\nmkdir -p "$LOKI_DIR/runs/e10-2"\nsleep 6\n' > "$C_DIR/loki-nopid"
printf '#!/bin/sh\nexit 7\n' > "$C_DIR/loki-exit7"
chmod +x "$C_DIR"/loki-*
out="$(LOKI_DIR="$C_DIR/w/.loki" LOKI_CHAT_START_WAIT=1.5 bash -c 'source "$1"; _CHAT_PROVIDER=claude; _CHAT_MODEL=; _chat_run_launch "$2" brief; echo "rc=$?"' _ "$CHAT_SH" "$C_DIR/loki-exit7" 2>&1)"
if grep -q 'rc=7' <<<"$out" && ! grep -qi 'syntax error' <<<"$out"; then ok "P12-16c: non-integer wait is tolerated and real exit code propagates"; else bad "P12-16c: wait/exit output: $out"; fi
out="$(LOKI_DIR="$C_DIR/z/.loki" LOKI_CHAT_START_WAIT=0 bash -c 'source "$1"; _CHAT_PROVIDER=claude; _CHAT_MODEL=; _chat_run_launch "$2" brief; echo "rc=$?"' _ "$CHAT_SH" "$C_DIR/loki-exit7" 2>&1)"
if grep -q 'rc=7' <<<"$out"; then ok "P12-16c: wait 0 clamps to 1"; else bad "P12-16c: wait 0 output: $out"; fi
mkdir -p "$C_DIR/n/.loki/runs/e10-1"; sleep 30 & OTHER=$!
echo "$OTHER" > "$C_DIR/n/.loki/loki.pid"
out="$(LOKI_DIR="$C_DIR/n/.loki" LOKI_CHAT_START_WAIT=2 bash -c 'source "$1"; _CHAT_PROVIDER=claude; _CHAT_MODEL=; _chat_run_launch "$2" brief; echo "rc=$?"' _ "$CHAT_SH" "$C_DIR/loki-nopid" 2>&1)"
kill "$OTHER" 2>/dev/null; wait "$OTHER" 2>/dev/null
if grep -q 'rc=1' <<<"$out" && ! grep -q 'Run started' <<<"$out" && grep -q 'not confirmed' <<<"$out"; then ok "P12-16c: new run dir without its own live run.pid is not 'Run started'"; else bad "P12-16c: new-dir output: $out"; fi
# P12-16c: the wait is deadline-based. A fake clock (file) advances 700ms per poll and per sleep;
# the launcher stays alive and no run ever appears, so the total fake wait must stay within the budget.
printf '#!/bin/sh\necho $$ >> "%s"\nexec sleep 6\n' "$C_DIR/sleep.pid" > "$C_DIR/loki-sleep"
chmod +x "$C_DIR/loki-sleep"
# shellcheck disable=SC2016
DL_SCRIPT='source "$1"; _CHAT_PROVIDER=claude; _CHAT_MODEL=
CLK="$3"; echo 0 > "$CLK"
_chat_now_ms() { cat "$CLK"; }
_chat_sleep_ms() { echo $(( $(cat "$CLK") + $1 )) > "$CLK"; }
_chat_run_dir() { echo $(( $(cat "$CLK") + ${POLL_COST:-700} )) > "$CLK"; if [ -n "$APPEAR_AT" ] && [ "$(cat "$CLK")" -ge "$APPEAR_AT" ]; then echo "$LOKI_DIR/runs/e10-9"; fi; }
_chat_run_state() { if [ -n "$1" ]; then echo running; else echo finished; fi; }
_chat_pidfile_live() { return 0; }
_chat_run_launch "$2" brief; echo "rc=$?"; echo "elapsed=$(cat "$CLK")"'
out="$(LOKI_DIR="$C_DIR/d1/.loki" LOKI_CHAT_START_WAIT=3 bash -c "$DL_SCRIPT" _ "$CHAT_SH" "$C_DIR/loki-sleep" "$C_DIR/clk1" 2>&1)"
el="$(sed -n 's/^elapsed=//p' <<<"$out")"
if grep -q 'rc=1' <<<"$out" && [ -n "$el" ] && [ "$el" -le 3700 ]; then ok "P12-16c: wait loop stays within its deadline (fake clock ${el}ms of 3000ms + one poll)"; else bad "P12-16c: deadline overrun, elapsed=${el:-none}: $out"; fi
out="$(POLL_COST=0 APPEAR_AT=3000 LOKI_DIR="$C_DIR/d2/.loki" LOKI_CHAT_START_WAIT=3 bash -c "$DL_SCRIPT" _ "$CHAT_SH" "$C_DIR/loki-sleep" "$C_DIR/clk2" 2>&1)"
if grep -q 'rc=0' <<<"$out" && grep -q 'Run started' <<<"$out"; then ok "P12-16c: a run appearing at the deadline is caught by the final check"; else bad "P12-16c: final-check output: $out"; fi
# P12-16d: perl picked as the clock, then fails mid-wait (fork EAGAIN): deadline reached, no arithmetic abort.
mkdir -p "$C_DIR/pstub"
printf '#!/bin/sh\nn=$(cat "%s/pcount" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "%s/pcount"\n[ "$n" -le 1 ] && exit 0\n[ "$n" -eq 2 ] && { echo 1000; exit 0; }\nexit 1\n' "$C_DIR" "$C_DIR" > "$C_DIR/pstub/perl"
chmod +x "$C_DIR/pstub/perl"
t0=$SECONDS
out="$(PATH="$C_DIR/pstub:$PATH" LOKI_DIR="$C_DIR/d3/.loki" LOKI_CHAT_START_WAIT=10 bash -c 'source "$1"; _CHAT_PROVIDER=claude; _CHAT_MODEL=; _chat_run_launch "$2" brief; echo "rc=$?"' _ "$CHAT_SH" "$C_DIR/loki-sleep" 2>&1)"
el=$(( SECONDS - t0 ))
if grep -q 'rc=1' <<<"$out" && grep -q 'clock' <<<"$out" && ! grep -q 'not confirmed\|syntax error\|unbound' <<<"$out" && [ "$el" -le 4 ]; then ok "P12-16d/f: a mid-loop clock failure ends the wait at once (${el}s of a 10s wait) with a clean clock-failure message, no arithmetic abort"; else bad "P12-16d/f: mid-loop clock failure waited ${el}s: $out"; fi
# P12-16e: the initial start read fails (perl probe ok, first read exits 1): clock failure reported, not a false timeout.
mkdir -p "$C_DIR/pstub2"
printf '#!/bin/sh\nn=$(cat "%s/pcount2" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "%s/pcount2"\n[ "$n" -le 1 ] && exit 0\nexit 1\n' "$C_DIR" "$C_DIR" > "$C_DIR/pstub2/perl"
chmod +x "$C_DIR/pstub2/perl"
out="$(PATH="$C_DIR/pstub2:$PATH" LOKI_DIR="$C_DIR/d4/.loki" LOKI_CHAT_START_WAIT=10 bash -c 'source "$1"; _CHAT_PROVIDER=claude; _CHAT_MODEL=; _chat_run_launch "$2" brief; echo "rc=$?"' _ "$CHAT_SH" "$C_DIR/loki-sleep" 2>&1)"
if grep -q 'rc=1' <<<"$out" && grep -q 'clock' <<<"$out" && ! grep -q 'not confirmed' <<<"$out"; then ok "P12-16e: a failed start clock read reports the clock failure, not a false timeout"; else bad "P12-16e: start clock failure output: $out"; fi
while read -r sp; do kill "$sp" 2>/dev/null || true; done < "$C_DIR/sleep.pid"
rm -rf "$C_DIR"

# --- Cleanup ------------------------------------------------------------------
rm -rf "$(dirname "$SANDBOX_BIN")" 2>/dev/null || true

echo ""
echo "Summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
