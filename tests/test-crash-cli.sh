#!/usr/bin/env bash
# tests/test-crash-cli.sh -- Crash Reporting Phase 0 (local-only, zero egress)
# bash-route tests. Modeled on tests/test-anthropic-base-url.sh (ok/bad helpers).
#
# Covers autonomy/crash.sh helpers and the bash cmd_crash / cmd_telemetry
# routes:
#   - loki_collection_enabled: default on; off for every documented opt-out.
#   - loki_show_disclosure_once: prints once (to stderr), persists sentinel,
#     silent on the second call.
#   - End-to-end capture via crash_capture.py: written .loki/crash/*.json
#     contains NONE of the planted secrets and error_class == "TypeError".
#   - loki crash (empty), loki crash show <bad-id> nonzero, telemetry off/on
#     idempotency (exactly one TELEMETRY_DISABLED line after two offs).
#
# A temp HOME and temp target dir are used so the real ~/.loki/config is never
# touched. The bash route is forced with LOKI_LEGACY_BASH=1.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# Isolated sandbox so the real ~/.loki is untouched.
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-crash-test.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT" 2>/dev/null || true; }
trap cleanup EXIT
FAKE_HOME="$TMP_ROOT/home"
TARGET_DIR="$TMP_ROOT/proj"
mkdir -p "$FAKE_HOME" "$TARGET_DIR"

# ---------------------------------------------------------------------------
# loki_collection_enabled: run in a clean subshell with controlled env so the
# function sees exactly the switches we set (and our FAKE_HOME for the config
# probe). Returns 0 (enabled) or 1 (disabled).
# ---------------------------------------------------------------------------
_collection_enabled() {
    # args become KEY=VALUE env assignments.
    env -i PATH="$PATH" HOME="$FAKE_HOME" "$@" \
        bash -c ". '$REPO_ROOT/autonomy/crash.sh'; loki_collection_enabled"
}

# DEFAULT MODEL (v7.89.0): collection is ON by default for an ordinary individual
# interactive install, but AUTO-OFF in non-interactive / enterprise / CI / air-
# gapped contexts. The test harness runs under `env -i ... bash -c` with NO TTY,
# which is exactly a non-interactive context, so the bare default here resolves
# OFF (auto-off). That is the air-gapped / CI / GDPR safety guarantee: an
# untouched install in a non-interactive environment collects + egresses nothing.
rm -f "$FAKE_HOME/.loki/config" 2>/dev/null || true
if _collection_enabled; then bad "non-interactive default should auto-off"; else ok "collection auto-off in non-interactive context (CI/air-gapped safe)"; fi
# An explicit opt-in forces ON even in this non-interactive context (force-on).
if _collection_enabled LOKI_TELEMETRY=on; then ok "explicit opt-in forces ON even non-interactive"; else bad "LOKI_TELEMETRY=on must force ON"; fi
# An enterprise/CI marker keeps it OFF even if a TTY were present.
if _collection_enabled CI=true; then bad "CI=true must auto-off"; else ok "CI=true auto-off"; fi
if _collection_enabled LOKI_ENTERPRISE=true; then bad "LOKI_ENTERPRISE=true must auto-off"; else ok "LOKI_ENTERPRISE=true auto-off"; fi

# Opt-in via env enables collection.
if _collection_enabled LOKI_TELEMETRY=on; then ok "LOKI_TELEMETRY=on enables"; else bad "LOKI_TELEMETRY=on should enable"; fi
if _collection_enabled LOKI_TELEMETRY=ON; then ok "LOKI_TELEMETRY=ON enables (case-insensitive)"; else bad "LOKI_TELEMETRY=ON should enable"; fi
# A non-opt-in truthy-looking value is NOT consent (precise: only "on" counts).
if _collection_enabled LOKI_TELEMETRY=1; then bad "LOKI_TELEMETRY=1 should NOT count as opt-in"; else ok "LOKI_TELEMETRY=1 is not opt-in (only 'on')"; fi
if _collection_enabled LOKI_TELEMETRY=true; then bad "LOKI_TELEMETRY=true should NOT count as opt-in"; else ok "LOKI_TELEMETRY=true is not opt-in (only 'on')"; fi

# Opt-in via config enables collection.
mkdir -p "$FAKE_HOME/.loki"
printf 'TELEMETRY_ENABLED=true\n' > "$FAKE_HOME/.loki/config"
if _collection_enabled; then ok "config TELEMETRY_ENABLED=true enables"; else bad "config TELEMETRY_ENABLED=true should enable"; fi
rm -f "$FAKE_HOME/.loki/config"

# Opt-out always wins over opt-in (belt and suspenders), even when opted in.
if _collection_enabled LOKI_TELEMETRY=on LOKI_TELEMETRY_DISABLED=true; then bad "opt-out must override opt-in env"; else ok "LOKI_TELEMETRY_DISABLED=true overrides LOKI_TELEMETRY=on"; fi
if _collection_enabled LOKI_TELEMETRY=on DO_NOT_TRACK=1; then bad "DO_NOT_TRACK must override opt-in env"; else ok "DO_NOT_TRACK=1 overrides LOKI_TELEMETRY=on"; fi
# Each documented opt-out disables collection (even with config opt-in present).
mkdir -p "$FAKE_HOME/.loki"
printf 'TELEMETRY_ENABLED=true\n' > "$FAKE_HOME/.loki/config"
if _collection_enabled LOKI_TELEMETRY=off; then bad "LOKI_TELEMETRY=off should disable"; else ok "LOKI_TELEMETRY=off disables (over config opt-in)"; fi
if _collection_enabled DO_NOT_TRACK=1; then bad "DO_NOT_TRACK=1 should disable"; else ok "DO_NOT_TRACK=1 disables (over config opt-in)"; fi
rm -f "$FAKE_HOME/.loki/config"
# Config-file opt-out wins even when config also has the opt-in line.
printf 'TELEMETRY_ENABLED=true\nTELEMETRY_DISABLED=true\n' > "$FAKE_HOME/.loki/config"
if _collection_enabled; then bad "config TELEMETRY_DISABLED=true must win over ENABLED"; else ok "config TELEMETRY_DISABLED=true wins over ENABLED"; fi
rm -f "$FAKE_HOME/.loki/config"

# ---------------------------------------------------------------------------
# loki_show_disclosure_once (v7.89.0): now a SILENT no-op. The verbose per-run
# disclosure block was removed (it cluttered logs + its "off by default" copy no
# longer matched the on-by-default-for-individuals model). Disclosure now lives
# (1) one-time on the welcome screen + the bin/loki first-egress notice, and
# (2) in docs/PRIVACY.md. The function is kept as a callable no-op (callers in
# run.sh must not break) and still records the DISCLOSURE_SHOWN sentinel for any
# back-compat reader. It must print NOTHING.
# ---------------------------------------------------------------------------
_show_disclosure() {
    env -i PATH="$PATH" HOME="$FAKE_HOME" \
        bash -c ". '$REPO_ROOT/autonomy/crash.sh'; loki_show_disclosure_once" 2>&1
}

rm -rf "$FAKE_HOME/.loki" 2>/dev/null || true
out1="$(_show_disclosure)"
# It must be SILENT now (no verbose block). Empty output is the contract.
if [ -z "$out1" ]; then
    ok "loki_show_disclosure_once is a silent no-op (first call)"
else
    bad "disclosure should print nothing now, got: [$out1]"
fi
# Sentinel still persisted for back-compat.
if grep -q "^DISCLOSURE_SHOWN=true" "$FAKE_HOME/.loki/config" 2>/dev/null; then
    ok "disclosure still records DISCLOSURE_SHOWN=true sentinel"
else
    bad "DISCLOSURE_SHOWN sentinel not written"
fi

# Second call: still silent.
out2="$(_show_disclosure)"
if [ -z "$out2" ]; then
    ok "disclosure silent on second call"
else
    bad "disclosure re-printed on second call: [$out2]"
fi
rm -rf "$FAKE_HOME/.loki" 2>/dev/null || true

# ---------------------------------------------------------------------------
# End-to-end capture: plant secrets in message + stack; assert the written
# scrubbed report contains NONE of them and error_class == "TypeError".
# ---------------------------------------------------------------------------
GHP_SECRET="ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
SSH_PATH="/Users/jdoe/.ssh/id_rsa"
EMAIL_SECRET="admin@example.com"

written_path="$(
    env -i PATH="$PATH" HOME="$FAKE_HOME" \
        python3 "$REPO_ROOT/autonomy/lib/crash_capture.py" \
        --error-class TypeError \
        --message "secret $SSH_PATH $GHP_SECRET $EMAIL_SECRET" \
        --stack "at h ($SSH_PATH:1:1)" \
        --target-dir "$TARGET_DIR" 2>/dev/null
)"

if [ -n "$written_path" ] && [ -f "$written_path" ]; then
    ok "capture wrote a scrubbed report"
else
    bad "capture did not write a report (path=[$written_path])"
fi

if [ -f "$written_path" ]; then
    blob="$(cat "$written_path")"
    printf '%s' "$blob" | grep -q -- "$GHP_SECRET" \
        && bad "written report LEAKS the github token" \
        || ok "written report has no github token"
    printf '%s' "$blob" | grep -q -- "$SSH_PATH" \
        && bad "written report LEAKS the /Users path" \
        || ok "written report has no /Users path"
    printf '%s' "$blob" | grep -q -- "$EMAIL_SECRET" \
        && bad "written report LEAKS the email" \
        || ok "written report has no email"
    # error_class is the leading sanitized token.
    ec="$(_CRASH_FILE="$written_path" python3 -c "import json,os;print(json.load(open(os.environ['_CRASH_FILE'])).get('error_class'))" 2>/dev/null)"
    [ "$ec" = "TypeError" ] && ok "written report error_class == TypeError" \
        || bad "error_class expected TypeError got [$ec]"
    # It must be valid JSON and whitelist-only (no message/stack keys).
    bad_keys="$(_CRASH_FILE="$written_path" python3 -c "
import json,os
d=json.load(open(os.environ['_CRASH_FILE']))
allowed={'os','arch','loki_version','node_version','bun_version','error_class','stack_signature','rarv_phase','exit_code','friction_kind','project_id_hash','fingerprint','rules_version','redactions_count','captured_at'}
print(','.join(sorted(set(d)-allowed)))
" 2>/dev/null)"
    [ -z "$bad_keys" ] && ok "written report is whitelist-only" \
        || bad "written report has non-whitelisted keys: [$bad_keys]"
fi

# ---------------------------------------------------------------------------
# bash cmd_crash routes (forced bash via LOKI_LEGACY_BASH=1). Run from inside
# an EMPTY project dir so .loki/crash (relative to cwd) does not exist.
# ---------------------------------------------------------------------------
EMPTY_DIR="$TMP_ROOT/empty"
mkdir -p "$EMPTY_DIR"
_loki_bash() {
    # Run from EMPTY_DIR; force bash route; isolated HOME.
    ( cd "$EMPTY_DIR" && env LOKI_LEGACY_BASH=1 HOME="$FAKE_HOME" bash "$REPO_ROOT/bin/loki" "$@" )
}

# loki crash with no reports -> "No crash reports found.", exit 0.
out="$(_loki_bash crash 2>&1)"; rc=$?
printf '%s' "$out" | grep -q "No crash reports found" \
    && ok "loki crash (empty): prints no-reports message" \
    || bad "loki crash (empty): missing no-reports message [$out]"
[ "$rc" -eq 0 ] && ok "loki crash (empty): exit 0" || bad "loki crash (empty): exit $rc"

# loki crash LIST is an explicit alias for the bare list (v7.19.4): a user
# mirroring 'proof list' / 'memory list' must not hit "Unknown crash subcommand".
out="$(_loki_bash crash list 2>&1)"; rc=$?
printf '%s' "$out" | grep -q "No crash reports found" \
    && ok "loki crash list (empty): lists like bare crash" \
    || bad "loki crash list (empty): not treated as list [$out]"
[ "$rc" -eq 0 ] && ok "loki crash list (empty): exit 0" || bad "loki crash list (empty): exit $rc"
printf '%s' "$out" | grep -qi "Unknown crash subcommand" \
    && bad "loki crash list: still rejected as unknown subcommand" \
    || ok "loki crash list: not rejected as unknown"

# Seed a crash dir so 'show <bad-id>' takes the dir-exists-but-no-match branch
# (which is the branch that returns nonzero).
mkdir -p "$EMPTY_DIR/.loki/crash"
printf '{"error_class":"X","fingerprint":"abc"}' > "$EMPTY_DIR/.loki/crash/seed-1.json"
out="$(_loki_bash crash show zzz-no-such-id 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "loki crash show <bad-id>: nonzero exit ($rc)" \
    || bad "loki crash show <bad-id>: expected nonzero, got 0 [$out]"
rm -rf "$EMPTY_DIR/.loki"

# ---------------------------------------------------------------------------
# telemetry off/on idempotency under the opt-in model:
#   off -> exactly one TELEMETRY_DISABLED line, no TELEMETRY_ENABLED line.
#   on  -> exactly one TELEMETRY_ENABLED line, no TELEMETRY_DISABLED line.
# The two markers must never coexist.
# ---------------------------------------------------------------------------
_count_line() { # $1 prefix
    local n
    n="$(grep -c "$1" "$FAKE_HOME/.loki/config" 2>/dev/null; true)"
    printf '%s' "$n" | head -1
}

rm -rf "$FAKE_HOME/.loki" 2>/dev/null || true
_loki_bash telemetry off >/dev/null 2>&1
_loki_bash telemetry off >/dev/null 2>&1
[ "$(_count_line '^TELEMETRY_DISABLED=')" = "1" ] && ok "telemetry off idempotent (1 DISABLED line after two offs)" \
    || bad "telemetry off not idempotent: $(_count_line '^TELEMETRY_DISABLED=') DISABLED lines"
[ "$(_count_line '^TELEMETRY_ENABLED=')" = "0" ] && ok "telemetry off leaves no ENABLED line" \
    || bad "telemetry off left $(_count_line '^TELEMETRY_ENABLED=') ENABLED lines"

# Confirm collection now reports disabled via the config probe.
if _collection_enabled; then bad "after 'off' collection should be disabled"; else ok "after 'off' collection_enabled reports disabled"; fi

# 'on' writes the positive consent marker and removes any opt-out.
_loki_bash telemetry on >/dev/null 2>&1
_loki_bash telemetry on >/dev/null 2>&1
[ "$(_count_line '^TELEMETRY_DISABLED=')" = "0" ] && ok "telemetry on removes the opt-out line" \
    || bad "telemetry on left $(_count_line '^TELEMETRY_DISABLED=') DISABLED lines"
[ "$(_count_line '^TELEMETRY_ENABLED=')" = "1" ] && ok "telemetry on idempotent (1 ENABLED line after two ons)" \
    || bad "telemetry on not idempotent: $(_count_line '^TELEMETRY_ENABLED=') ENABLED lines"

# After explicit opt-in, collection reports enabled.
if _collection_enabled; then ok "after 'on' collection_enabled reports enabled"; else bad "after 'on' collection should be enabled"; fi
rm -rf "$FAKE_HOME/.loki" 2>/dev/null || true

# ===========================================================================
# DEFECT 1: stack/fingerprint parity via the REAL loki_crash_capture helper.
# The earlier tests only drove crash_capture.py with --stack "text" (argv).
# They never exercised loki_crash_capture, which uses `--stack -` + stdin and
# was producing an EMPTY stack_signature. Drive the real helper with a
# multi-frame stack and assert a NON-EMPTY signature with the expected symbols.
# Helper reads TARGET_DIR from the environment (not an argument).
# ===========================================================================
# Run the real helper in a clean subshell with isolated HOME (so the config
# probe never reads the real ~/.loki/config). Under the opt-in model the helper
# is gated OFF by default, so we set LOKI_TELEMETRY=on to exercise the capture
# path (this test is about stack/fingerprint parity, not the gate).
_run_real_helper() {
    # $1 target dir, $2 home dir, $3 multi-line stack. The stack is passed as a
    # real env var (LOKI_TEST_STACK) via env, NOT as a positional after
    # `bash -c`, which would land in $0 and be lost.
    env -i PATH="$PATH" HOME="$2" TARGET_DIR="$1" LOKI_TEST_STACK="$3" LOKI_TELEMETRY=on \
        bash -c '
            . "'"$REPO_ROOT"'/autonomy/crash.sh"
            loki_crash_capture "TypeError" "boom message" "$LOKI_TEST_STACK" "act" "1"
        ' 2>/dev/null
}

D1_DIR="$TMP_ROOT/d1"
D1_HOME="$TMP_ROOT/d1home"
mkdir -p "$D1_DIR" "$D1_HOME"
D1_STACK="$(printf 'at handler (/Users/jdoe/src/app.ts:10:5)\nat run (/Users/jdoe/src/run.ts:20:7)')"
_run_real_helper "$D1_DIR" "$D1_HOME" "$D1_STACK"

d1_file="$(find "$D1_DIR/.loki/crash" -maxdepth 1 -name '*.json' -type f 2>/dev/null | head -1)"
if [ -n "$d1_file" ] && [ -f "$d1_file" ]; then
    ok "real loki_crash_capture wrote a report (stdin stack path)"
    d1_sig="$(_CRASH_FILE="$d1_file" python3 -c "import json,os;print(json.dumps(json.load(open(os.environ['_CRASH_FILE'])).get('stack_signature')))" 2>/dev/null)"
    # NON-EMPTY signature with the expected symbols -- this is the exact thing
    # the original defect violated (empty stack_signature from the stdin path).
    [ "$d1_sig" = '["handler", "run"]' ] && ok "real helper stack_signature == [handler, run] (non-empty)" \
        || bad "real helper stack_signature wrong/empty: [$d1_sig]"
else
    bad "real loki_crash_capture wrote NO report (defect 1 fix may not have landed)"
fi

# Fingerprint parity: the real helper (stdin) and the argv path must yield the
# SAME fingerprint for an identical (error_class, stack). Paths differ on
# purpose (jdoe vs alice) to prove path normalization keeps them equal.
D1B_DIR="$TMP_ROOT/d1b"
mkdir -p "$D1B_DIR"
printf 'at handler (/home/alice/src/app.ts:10:5)\nat run (/home/alice/src/run.ts:20:7)' \
    | python3 "$REPO_ROOT/autonomy/lib/crash_capture.py" \
        --error-class TypeError --message "boom message" --stack - \
        --target-dir "$D1B_DIR" >/dev/null 2>&1
d1b_file="$(find "$D1B_DIR/.loki/crash" -maxdepth 1 -name '*.json' -type f 2>/dev/null | head -1)"
if [ -n "$d1_file" ] && [ -n "$d1b_file" ]; then
    fp_helper="$(_CRASH_FILE="$d1_file" python3 -c "import json,os;print(json.load(open(os.environ['_CRASH_FILE'])).get('fingerprint'))" 2>/dev/null)"
    fp_argv="$(_CRASH_FILE="$d1b_file" python3 -c "import json,os;print(json.load(open(os.environ['_CRASH_FILE'])).get('fingerprint'))" 2>/dev/null)"
    [ -n "$fp_helper" ] && [ "$fp_helper" = "$fp_argv" ] \
        && ok "fingerprint parity: real helper == argv path (path-independent)" \
        || bad "fingerprint mismatch helper=[$fp_helper] argv=[$fp_argv]"
else
    bad "fingerprint parity: missing one side (helper=[$d1_file] argv=[$d1b_file])"
fi

# ===========================================================================
# DEFECT 2: path traversal. `crash show/submit ../../pwn` must exit nonzero and
# print NONE of an external file's contents. The id is joined as
# crashDir/<id>.json, so `../../pwn` resolves to $WORK/pwn.json -- seed the
# bait THERE (not a blind /tmp path) so the test is non-vacuous: if the guard
# were removed the marker WOULD leak. A legit show by fingerprint and by
# filename-id must STILL work (positive controls).
# ===========================================================================
TRAV_DIR="$TMP_ROOT/trav"
mkdir -p "$TRAV_DIR/.loki/crash"
# Seed a legit scrubbed report (filename id = legit-fp-1; fingerprint = legitfp).
printf '{"error_class":"TypeError","fingerprint":"legitfp","captured_at":"2026-06-06T00:00:00Z","stack_signature":["f"],"rules_version":"1.0"}' \
    > "$TRAV_DIR/.loki/crash/legit-fp-1.json"
# Seed the leak bait where ../../pwn.json resolves from crashDir.
PWN_MARKER="PWNED_SECRET_MARKER_9f3a"
printf '{"secret":"%s"}' "$PWN_MARKER" > "$TRAV_DIR/pwn.json"
# Also create the deeper-traversal target's would-be location (never .json there,
# so it can never resolve -- kept purely as a nonzero-exit vector).

_loki_trav() {
    ( cd "$TRAV_DIR" && env LOKI_LEGACY_BASH=1 HOME="$FAKE_HOME" NO_COLOR=1 bash "$REPO_ROOT/bin/loki" "$@" )
}

for vec in "../../pwn" "../../../etc/hosts" "..%2f..%2fpwn"; do
    out="$(_loki_trav crash show "$vec" 2>&1)"; rc=$?
    [ "$rc" -ne 0 ] && ok "crash show '$vec': nonzero exit ($rc)" \
        || bad "crash show '$vec': expected nonzero, got 0"
    printf '%s' "$out" | grep -q "$PWN_MARKER" \
        && bad "crash show '$vec': LEAKED external file marker" \
        || ok "crash show '$vec': no external file contents"
done
# submit traversal vector too.
out="$(_loki_trav crash submit "../../pwn" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "crash submit '../../pwn': nonzero exit ($rc)" \
    || bad "crash submit '../../pwn': expected nonzero, got 0"
printf '%s' "$out" | grep -q "$PWN_MARKER" \
    && bad "crash submit '../../pwn': LEAKED external file marker" \
    || ok "crash submit '../../pwn': no external file contents"

# Positive controls: legit show by fingerprint AND by filename-id must work.
out="$(_loki_trav crash show legitfp 2>&1)"; rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"fingerprint": "legitfp"'; } \
    && ok "crash show <fingerprint>: legit lookup still works" \
    || bad "crash show <fingerprint>: legit lookup broke [rc=$rc]"
out="$(_loki_trav crash show legit-fp-1 2>&1)"; rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"fingerprint": "legitfp"'; } \
    && ok "crash show <filename-id>: legit lookup still works" \
    || bad "crash show <filename-id>: legit lookup broke [rc=$rc]"

# ===========================================================================
# DEFECT 3 (opt-in model): the unified gate also controls LOCAL capture.
#   - default (no switch): NO file (opt-in model -- off by default).
#   - explicit opt-in (LOKI_TELEMETRY=on): a file IS written (positive control).
#   - opt-out (DO_NOT_TRACK=1 / LOKI_TELEMETRY=off): NO file even if opted in.
# ===========================================================================
_capture_with_env() {
    # $1 target dir, $2 home dir, then KEY=VALUE env assignments.
    local target="$1" home="$2"; shift 2
    env -i PATH="$PATH" HOME="$home" TARGET_DIR="$target" "$@" \
        bash -c '
            . "'"$REPO_ROOT"'/autonomy/crash.sh"
            loki_crash_capture "TypeError" "boom" "at f (/x.ts:1:1)" "act" "1"
        ' >/dev/null 2>&1
}
_crash_file_count() {
    find "$1/.loki/crash" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' '
}

D3_HOME="$TMP_ROOT/d3home"; mkdir -p "$D3_HOME"

# Default (no switch) -> NO file (opt-in model: off by default).
D3_DEF="$TMP_ROOT/d3def"; mkdir -p "$D3_DEF"
_capture_with_env "$D3_DEF" "$D3_HOME"
[ "$(_crash_file_count "$D3_DEF")" -eq 0 ] \
    && ok "default (no opt-in): loki_crash_capture writes NO file" \
    || bad "default: a crash file was written (opt-in model violated)"

# Positive control: explicit opt-in -> a file IS written.
D3_ON="$TMP_ROOT/d3on"; mkdir -p "$D3_ON"
_capture_with_env "$D3_ON" "$D3_HOME" LOKI_TELEMETRY=on
[ "$(_crash_file_count "$D3_ON")" -ge 1 ] \
    && ok "LOKI_TELEMETRY=on: loki_crash_capture writes a file (control)" \
    || bad "LOKI_TELEMETRY=on: no file written (probe broken or defect)"

# Opt-out wins over opt-in: DO_NOT_TRACK=1 -> NO file even with opt-in env.
D3_DNT="$TMP_ROOT/d3dnt"; mkdir -p "$D3_DNT"
_capture_with_env "$D3_DNT" "$D3_HOME" LOKI_TELEMETRY=on DO_NOT_TRACK=1
[ "$(_crash_file_count "$D3_DNT")" -eq 0 ] \
    && ok "DO_NOT_TRACK=1 over opt-in: loki_crash_capture writes NO file" \
    || bad "DO_NOT_TRACK=1: a crash file was written (opt-out not honored)"

# LOKI_TELEMETRY=off -> NO file.
D3_OFF="$TMP_ROOT/d3off"; mkdir -p "$D3_OFF"
_capture_with_env "$D3_OFF" "$D3_HOME" LOKI_TELEMETRY=off
[ "$(_crash_file_count "$D3_OFF")" -eq 0 ] \
    && ok "LOKI_TELEMETRY=off: loki_crash_capture writes NO file" \
    || bad "LOKI_TELEMETRY=off: a crash file was written (opt-out not honored)"

# ===========================================================================
# P3-2: dashboard/telemetry.py send_telemetry must NOT egress by default and
# MUST egress only after explicit opt-in. We mock the network honestly by
# replacing urllib.request.urlopen with a recorder (it asserts urlopen is NOT
# invoked with a clean env, and IS invoked only after opt-in). The gating logic
# is NOT faked -- the real _is_enabled runs. send_telemetry spawns a daemon
# thread, so we join briefly before asserting.
# ===========================================================================
_py_egress_probe() {
    # args become KEY=VALUE env assignments for the python process.
    env -i PATH="$PATH" HOME="$FAKE_HOME" LOKI_TELEMETRY_PKG="$REPO_ROOT/dashboard" "$@" \
        python3 - <<'PYEOF'
import os, sys, importlib.util, types, time

pkg_dir = os.environ["LOKI_TELEMETRY_PKG"]
# Load dashboard/telemetry.py as a standalone module (no package import side effects).
spec = importlib.util.spec_from_file_location("loki_telemetry_under_test", os.path.join(pkg_dir, "telemetry.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

calls = []
def fake_urlopen(req, *a, **k):
    # Record the call; honest mock -- we never let a real request leave.
    try:
        calls.append(getattr(req, "full_url", str(req)))
    except Exception:
        calls.append("call")
    class _R:
        def read(self): return b""
        def __enter__(self): return self
        def __exit__(self, *a): return False
    return _R()

# Replace the symbol the module actually calls (it imported urlopen by name).
mod.urlopen = fake_urlopen

mod.send_telemetry("test_event", {"k": "v"})
# send runs in a daemon thread; give it a moment to either fire or be gated out.
time.sleep(0.5)
print("CALLS=%d" % len(calls))
PYEOF
}

# Clean env, no config -> default OFF -> urlopen NOT called.
rm -rf "$FAKE_HOME/.loki" 2>/dev/null || true
out="$(_py_egress_probe)"
printf '%s' "$out" | grep -q "CALLS=0" \
    && ok "telemetry.py default: NO network egress (urlopen not called)" \
    || bad "telemetry.py default egressed: [$out]"

# Explicit opt-in via env -> urlopen IS called exactly once.
out="$(_py_egress_probe LOKI_TELEMETRY=on)"
printf '%s' "$out" | grep -q "CALLS=1" \
    && ok "telemetry.py LOKI_TELEMETRY=on: egresses exactly once" \
    || bad "telemetry.py opt-in did not egress once: [$out]"

# Opt-in via config -> urlopen IS called.
mkdir -p "$FAKE_HOME/.loki"; printf 'TELEMETRY_ENABLED=true\n' > "$FAKE_HOME/.loki/config"
out="$(_py_egress_probe)"
printf '%s' "$out" | grep -q "CALLS=1" \
    && ok "telemetry.py config TELEMETRY_ENABLED=true: egresses once" \
    || bad "telemetry.py config opt-in did not egress: [$out]"

# Kill switch fully disables egress even with config opt-in present.
out="$(_py_egress_probe DO_NOT_TRACK=1)"
printf '%s' "$out" | grep -q "CALLS=0" \
    && ok "telemetry.py DO_NOT_TRACK=1 kill switch: NO egress (over config opt-in)" \
    || bad "telemetry.py kill switch failed: [$out]"
out="$(_py_egress_probe LOKI_TELEMETRY=off)"
printf '%s' "$out" | grep -q "CALLS=0" \
    && ok "telemetry.py LOKI_TELEMETRY=off kill switch: NO egress" \
    || bad "telemetry.py LOKI_TELEMETRY=off failed: [$out]"
rm -rf "$FAKE_HOME/.loki" 2>/dev/null || true

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
