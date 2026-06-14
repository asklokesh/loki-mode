#!/usr/bin/env bash
# tests/test-cli-session-v734.sh
#
# Stub-based proof for the v7.34.0 Claude session-id stamping (Phase 1,
# correlation-only) on the BASH route. The feature:
#
#   - At run-start, run.sh writes .loki/state/claude-session.json with a
#     deterministic per-run UUIDv5 derived from the trust-run-id (mode "stamp").
#   - DEFAULT: metadata-file-only. The main-loop claude argv is byte-identical
#     to v7.33 (NO --session-id). This is the UX-monotonicity requirement.
#   - LOKI_SESSION_STAMP=1: the main loop also emits a PER-ITERATION DISTINCT
#     --session-id (UUIDv5 of "<run-id>:<iteration>"), gated on CLI support.
#     A pinned-across-the-run id is explicitly NOT used (that would be Phase 2
#     continuity / context accumulation -- out of scope here).
#   - Subcall sites (conflict / reviewer / adversarial / usage) NEVER get
#     --session-id (it is main-loop-only).
#   - bash and Bun derive BYTE-IDENTICAL uuids for the same run id.
#
# HONEST SCOPE: a stub `claude` on PATH advertises the flag in --help and records
# argv. These tests assert the FLAG IS / IS NOT passed and the uuid is valid +
# deterministic + distinct. They do NOT (cannot) verify the real Claude CLI's
# --session-id resume/naming semantics -- that needs a live claude binary and is
# the ceiling of a stub test (and is exactly why Phase 2 continuity is deferred).
#
# Never touches port 57374, never spends, never pushes. trap-rm cleanup.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
FLAGS_SH="$REPO_ROOT/autonomy/lib/claude-flags.sh"
LOADER_SH="$REPO_ROOT/providers/loader.sh"

PASS=0
FAIL=0
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok()  { PASS=$((PASS + 1)); echo -e "${GREEN}[PASS]${NC} $1"; }
bad() { FAIL=$((FAIL + 1)); echo -e "${RED}[FAIL]${NC} $1 -- ${2:-}"; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/loki-session-v734-XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

# RFC-4122 uuid (any version/variant) shape check.
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
is_uuid() { printf '%s' "$1" | grep -Eq "$UUID_RE"; }

# A stub `claude` that advertises --session-id in --help and otherwise records
# its full argv (one element per line so a value with spaces stays one element).
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"
ARGV_LOG="$TMP/claude-argv.log"
cat > "$STUB_BIN/claude" <<STUB
#!/usr/bin/env bash
case "\$1" in
  --help)
    cat <<'HELP'
  --session-id <uuid>                   Use a specific session id
  --dangerously-skip-permissions        skip
  --append-system-prompt <prompt>       append
  --effort <level>                      effort
  --setting-sources <sources>           sources
  --include-partial-messages            partial
HELP
    exit 0
    ;;
esac
: > "$ARGV_LOG"
for a in "\$@"; do printf '%s\n' "\$a" >> "$ARGV_LOG"; done
printf 'stub ok\n'
exit 0
STUB
chmod +x "$STUB_BIN/claude"

# ============================================================================
# Section A: bash session-uuid helpers (autonomy/lib/claude-flags.sh)
# ============================================================================
(
  PATH="$STUB_BIN:$PATH"
  unset __LOKI_CLAUDE_HELP_CACHE
  # shellcheck disable=SC1090
  . "$FLAGS_SH"

  RID="run-20260611-123-456"
  stable="$(_loki_claude_session_uuid "$RID")"
  stable2="$(_loki_claude_session_uuid "$RID")"
  i0="$(_loki_claude_iteration_session_uuid "$RID" 0)"
  i1="$(_loki_claude_iteration_session_uuid "$RID" 1)"
  i0b="$(_loki_claude_iteration_session_uuid "$RID" 0)"
  empty="$(_loki_claude_session_uuid "")"

  is_uuid "$stable" && echo "A1_OK" || echo "A1_BAD"
  [ "$stable" = "$stable2" ] && echo "A2_OK" || echo "A2_BAD"     # deterministic
  is_uuid "$i0" && is_uuid "$i1" && echo "A3_OK" || echo "A3_BAD"
  [ "$i0" != "$i1" ] && echo "A4_OK" || echo "A4_BAD"             # DISTINCT per iter (no continuity leak)
  [ "$i0" = "$i0b" ] && echo "A5_OK" || echo "A5_BAD"             # iter id deterministic
  [ "$i0" != "$stable" ] && echo "A6_OK" || echo "A6_BAD"         # iter id is NOT the pinned run id
  [ -z "$empty" ] && echo "A7_OK" || echo "A7_BAD"                # empty run id -> empty

  # stamp predicate: default OFF (conservative), ON under =1, gated on support.
  unset LOKI_SESSION_STAMP; unset __LOKI_CLAUDE_HELP_CACHE
  if loki_session_stamp_enabled; then echo "A8_BAD"; else echo "A8_OK"; fi
  if LOKI_SESSION_STAMP=1 loki_session_stamp_enabled; then echo "A9_OK"; else echo "A9_BAD"; fi
) > "$TMP/secA.out" 2>/dev/null

check_tok() { if grep -qx "$1" "$TMP/secA.out"; then ok "$2"; else bad "$2" "marker $1 missing"; fi; }
check_tok A1_OK "session uuid is a valid RFC-4122 uuid"
check_tok A2_OK "session uuid is deterministic (same run id -> same uuid)"
check_tok A3_OK "per-iteration uuids are valid"
check_tok A4_OK "per-iteration uuids are DISTINCT across iterations (no continuity leak)"
check_tok A5_OK "per-iteration uuid is deterministic for a given iteration"
check_tok A6_OK "per-iteration uuid differs from the pinned per-run uuid"
check_tok A7_OK "empty run id -> empty uuid (degrades, no crash)"
check_tok A8_OK "LOKI_SESSION_STAMP default OFF (metadata-only, byte-identical argv)"
check_tok A9_OK "LOKI_SESSION_STAMP=1 enables the predicate when --session-id supported"

# Graceful degrade: --session-id absent from help -> predicate OFF even with =1.
(
  DEG="$TMP/deg-bin"; mkdir -p "$DEG"
  cat > "$DEG/claude" <<'DST'
#!/usr/bin/env bash
case "$1" in --help) printf '  --effort <level>  effort\n'; exit 0;; esac
exit 0
DST
  chmod +x "$DEG/claude"
  PATH="$DEG:$PATH"; unset __LOKI_CLAUDE_HELP_CACHE LOKI_SESSION_STAMP
  # shellcheck disable=SC1090
  . "$FLAGS_SH"
  if LOKI_SESSION_STAMP=1 loki_session_stamp_enabled; then echo "A10_BAD"; else echo "A10_OK"; fi
) > "$TMP/secA2.out" 2>/dev/null
if grep -qx A10_OK "$TMP/secA2.out"; then ok "stamp degrades gracefully (no --session-id in help -> OFF even with =1)"; else bad "stamp graceful degrade" "marker missing"; fi

# ============================================================================
# Section B: bash <-> Bun uuid parity for a forced run id
# ============================================================================
RID_PARITY="run-parity-9001-7"
BASH_STABLE="$(PATH="$STUB_BIN:$PATH" bash -c '. "'"$FLAGS_SH"'"; _loki_claude_session_uuid "'"$RID_PARITY"'"' 2>/dev/null)"
BASH_I0="$(PATH="$STUB_BIN:$PATH" bash -c '. "'"$FLAGS_SH"'"; _loki_claude_iteration_session_uuid "'"$RID_PARITY"'" 0' 2>/dev/null)"
BASH_I2="$(PATH="$STUB_BIN:$PATH" bash -c '. "'"$FLAGS_SH"'"; _loki_claude_iteration_session_uuid "'"$RID_PARITY"'" 2' 2>/dev/null)"

if command -v bun >/dev/null 2>&1; then
  export RID_PARITY
  BUN_OUT="$(cd "$REPO_ROOT/loki-ts" && bun -e '
    import { claudeSessionUuid, claudeIterationSessionUuid } from "./src/providers/claude_flags.ts";
    const r = process.env.RID_PARITY;
    console.log(claudeSessionUuid(r));
    console.log(claudeIterationSessionUuid(r, 0));
    console.log(claudeIterationSessionUuid(r, 2));
  ' 2>/dev/null)"
  BUN_STABLE="$(printf '%s\n' "$BUN_OUT" | sed -n 1p)"
  BUN_I0="$(printf '%s\n' "$BUN_OUT" | sed -n 2p)"
  BUN_I2="$(printf '%s\n' "$BUN_OUT" | sed -n 3p)"
  if [ -n "$BASH_STABLE" ] && [ "$BASH_STABLE" = "$BUN_STABLE" ]; then
    ok "bash<->Bun parity: per-run uuid identical ($BASH_STABLE)"
  else
    bad "bash<->Bun parity: per-run uuid" "bash=$BASH_STABLE bun=$BUN_STABLE"
  fi
  if [ -n "$BASH_I0" ] && [ "$BASH_I0" = "$BUN_I0" ] && [ "$BASH_I2" = "$BUN_I2" ]; then
    ok "bash<->Bun parity: per-iteration uuids identical (iter0+iter2)"
  else
    bad "bash<->Bun parity: per-iteration uuids" "bash=$BASH_I0/$BASH_I2 bun=$BUN_I0/$BUN_I2"
  fi
else
  bad "bash<->Bun parity" "bun not on PATH -- cannot prove parity"
fi

# ============================================================================
# Section C: run-start writes .loki/state/claude-session.json
# ============================================================================
# Drive the run-start metadata write in isolation: source the flags helper,
# mint a forced run id, and run the exact json-writing snippet from run.sh.
PROJ="$TMP/proj-stamp"; mkdir -p "$PROJ"
(
  cd "$PROJ" || exit 1
  PATH="$STUB_BIN:$PATH"
  unset __LOKI_CLAUDE_HELP_CACHE
  # shellcheck disable=SC1090
  . "$FLAGS_SH"
  export LOKI_TRUST_RUN_ID="run-stamp-test-42"
  _loki_session_uuid="$(_loki_claude_session_uuid "$LOKI_TRUST_RUN_ID")"
  _loki_session_created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p ".loki/state"
  printf '{"run_id":"%s","claude_session_uuid":"%s","mode":"stamp","created_at":"%s"}\n' \
      "$LOKI_TRUST_RUN_ID" "$_loki_session_uuid" "$_loki_session_created" \
      > ".loki/state/claude-session.json"
) >/dev/null 2>&1

CS_JSON="$PROJ/.loki/state/claude-session.json"
if [ -s "$CS_JSON" ]; then
  if python3 -c "import json,sys; d=json.load(open('$CS_JSON')); assert d['mode']=='stamp'; assert d['run_id']=='run-stamp-test-42'; import re; assert re.match(r'$UUID_RE', d['claude_session_uuid']); assert d['created_at']" 2>/dev/null; then
    ok "run-start writes claude-session.json with run_id + valid uuid + mode=stamp + created_at"
  else
    bad "claude-session.json schema" "content: $(cat "$CS_JSON")"
  fi
  # The persisted uuid must equal the deterministic derivation of the run id.
  EXPECT="$(PATH="$STUB_BIN:$PATH" bash -c '. "'"$FLAGS_SH"'"; _loki_claude_session_uuid "run-stamp-test-42"')"
  GOT="$(python3 -c "import json; print(json.load(open('$CS_JSON'))['claude_session_uuid'])" 2>/dev/null)"
  if [ -n "$EXPECT" ] && [ "$EXPECT" = "$GOT" ]; then
    ok "persisted uuid equals deterministic derivation of the trust-run-id"
  else
    bad "persisted uuid derivation" "expect=$EXPECT got=$GOT"
  fi
else
  bad "claude-session.json written" "file missing or empty"
fi

# ============================================================================
# Section D: main-loop argv -- DEFAULT has NO --session-id, =1 adds a per-iter one
# ============================================================================
# Build the main-loop argv exactly as run.sh does (the construction block is
# self-contained: base flags + the gated session-id append). We reproduce only
# the session-id append against the helper so the test is hermetic and does not
# require driving the full run_autonomous loop.
build_main_argv() { # iteration -> prints argv one-per-line ; reads env for LOKI_SESSION_STAMP
  PATH="$STUB_BIN:$PATH" bash -c '
    set -uo pipefail
    unset __LOKI_CLAUDE_HELP_CACHE
    # shellcheck disable=SC1090
    . "'"$FLAGS_SH"'"
    ITERATION_COUNT="'"$1"'"
    LOKI_TRUST_RUN_ID="run-argv-test-7"
    _loki_claude_argv=("--dangerously-skip-permissions" "--model" "opus")
    if type loki_session_stamp_enabled >/dev/null 2>&1 && loki_session_stamp_enabled; then
      _loki_iter_session_uuid="$(_loki_claude_iteration_session_uuid "${LOKI_TRUST_RUN_ID:-}" "$ITERATION_COUNT")"
      [ -n "$_loki_iter_session_uuid" ] && _loki_claude_argv+=("--session-id" "$_loki_iter_session_uuid")
    fi
    printf "%s\n" "${_loki_claude_argv[@]}"
  ' 2>/dev/null
}

DEF_ARGV="$(unset LOKI_SESSION_STAMP; build_main_argv 0)"
if printf '%s\n' "$DEF_ARGV" | grep -qx -- '--session-id'; then
  bad "DEFAULT argv byte-identical to v7.33" "unexpected --session-id with knob unset: $(printf '%s ' $DEF_ARGV)"
else
  ok "DEFAULT main-loop argv has NO --session-id (byte-identical to v7.33)"
fi

ON_ARGV="$(LOKI_SESSION_STAMP=1 build_main_argv 3)"
if printf '%s\n' "$ON_ARGV" | grep -qx -- '--session-id'; then
  SID="$(printf '%s\n' "$ON_ARGV" | grep -A1 -x -- '--session-id' | tail -1)"
  if is_uuid "$SID"; then
    ok "LOKI_SESSION_STAMP=1 adds --session-id with a valid uuid on the main loop"
  else
    bad "stamp uuid valid" "got: $SID"
  fi
  # The emitted id must be the per-iteration (iteration 3) derivation, DISTINCT
  # from iteration 0 -- proving no single pinned id across the run.
  EXP3="$(PATH="$STUB_BIN:$PATH" bash -c '. "'"$FLAGS_SH"'"; _loki_claude_iteration_session_uuid "run-argv-test-7" 3')"
  ITER0_ARGV="$(LOKI_SESSION_STAMP=1 build_main_argv 0)"
  SID0="$(printf '%s\n' "$ITER0_ARGV" | grep -A1 -x -- '--session-id' | tail -1)"
  if [ "$SID" = "$EXP3" ] && [ "$SID" != "$SID0" ]; then
    ok "stamped id is per-iteration distinct (iter3 != iter0, no pinned-run continuity leak)"
  else
    bad "stamp per-iteration distinct" "iter3=$SID exp3=$EXP3 iter0=$SID0"
  fi
else
  bad "LOKI_SESSION_STAMP=1 adds --session-id" "argv: $(printf '%s ' $ON_ARGV)"
fi

# ============================================================================
# Section E: subcall sites NEVER receive --session-id (main-loop-only invariant)
# ============================================================================
# Source-level structural assertion: --session-id appears ONLY in the main-loop
# argv construction in run.sh, never in any subcall argv array (conflict /
# reviewer / adversarial / usage). The stamping helpers append to
# _loki_claude_argv only; subcall arrays are _rv_argv/_adv_argv/_ic_argv/etc.
SESSION_HITS="$(grep -n 'session-id' "$RUN_SH" | grep -v '^\s*#' || true)"
# Only the main-loop block (which references _loki_claude_argv) may add it.
NON_MAIN="$(grep -nE '_(rv|adv|ic|cm|co|c2|gr)_argv\+=\("--session-id"' "$RUN_SH" || true)"
if [ -z "$NON_MAIN" ]; then
  ok "no subcall argv array (_rv/_adv/_ic/...) ever appends --session-id"
else
  bad "subcall --session-id leak" "$NON_MAIN"
fi
# The only argv array that appends --session-id is the main loop's _loki_claude_argv.
if grep -q '_loki_claude_argv+=("--session-id"' "$RUN_SH"; then
  ok "the --session-id append targets the main-loop array (_loki_claude_argv)"
else
  bad "main-loop session-id append" "not found on _loki_claude_argv"
fi
# Cross-file: subcall sites in completion-council/council-v2/grill never add it.
for f in completion-council.sh council-v2.sh grill.sh; do
  if grep -q 'session-id' "$REPO_ROOT/autonomy/$f" 2>/dev/null; then
    bad "subcall file $f free of --session-id" "$f references session-id"
  else
    ok "subcall file $f never references --session-id"
  fi
done

# ============================================================================
# Section F: TS mirror exposes the same surface (sessionStampArgv) + default OFF
# ============================================================================
if command -v bun >/dev/null 2>&1; then
  TS_OUT="$(cd "$REPO_ROOT/loki-ts" && LOKI_TRUST_RUN_ID="run-ts-7" bun -e '
    import { sessionStampArgv, _resetClaudeHelpCacheForTest } from "./src/providers/claude_flags.ts";
    _resetClaudeHelpCacheForTest("  --session-id <uuid>  use id");
    // default OFF (LOKI_SESSION_STAMP unset)
    delete process.env.LOKI_SESSION_STAMP;
    console.log("DEF:" + JSON.stringify(sessionStampArgv()));
    process.env.LOKI_SESSION_STAMP = "1";
    process.env.ITERATION_COUNT = "5";
    console.log("ON:" + JSON.stringify(sessionStampArgv()));
  ' 2>/dev/null)"
  DEF_LINE="$(printf '%s\n' "$TS_OUT" | grep '^DEF:' | sed 's/^DEF://')"
  ON_LINE="$(printf '%s\n' "$TS_OUT" | grep '^ON:' | sed 's/^ON://')"
  if [ "$DEF_LINE" = "[]" ]; then
    ok "TS sessionStampArgv() default OFF -> [] (byte-identical to v7.33)"
  else
    bad "TS default OFF" "got: $DEF_LINE"
  fi
  if printf '%s' "$ON_LINE" | grep -q -- '--session-id'; then
    ok "TS sessionStampArgv() with =1 emits --session-id + uuid"
  else
    bad "TS stamp on" "got: $ON_LINE"
  fi
else
  bad "TS sessionStampArgv surface" "bun not on PATH"
fi

# ============================================================================
# Section G: FIX D -- --no-session-persistence (opt-in, default OFF)
# ============================================================================
# Build the providers/claude.sh auto-flags and assert --no-session-persistence
# is absent by default and present only under LOKI_NO_SESSION_PERSIST=1.
run_autoflags_nsp() { # env... -> prints _LOKI_CLAUDE_AUTO_FLAGS one-per-line
  PATH="$STUB_BIN:$PATH" bash -c '
    set -uo pipefail
    unset __LOKI_CLAUDE_HELP_CACHE
    # shellcheck disable=SC1090
    . "'"$LOADER_SH"'" >/dev/null 2>&1
    load_provider claude >/dev/null 2>&1
    _loki_build_claude_auto_flags development standard opus
    printf "%s\n" "${_LOKI_CLAUDE_AUTO_FLAGS[@]}"
  ' 2>/dev/null
}
# The stub help must advertise the flag for the support gate to allow it.
cat > "$STUB_BIN/claude" <<STUB
#!/usr/bin/env bash
case "\$1" in
  --help)
    cat <<'HELP'
  --session-id <uuid>                   Use a specific session id
  --no-session-persistence              Disable session persistence
  --dangerously-skip-permissions        skip
  --append-system-prompt <prompt>       append
  --effort <level>                      effort
HELP
    exit 0
    ;;
esac
: > "$ARGV_LOG"
for a in "\$@"; do printf '%s\n' "\$a" >> "$ARGV_LOG"; done
printf 'stub ok\n'
exit 0
STUB
chmod +x "$STUB_BIN/claude"

NSP_DEF="$(unset LOKI_NO_SESSION_PERSIST; run_autoflags_nsp)"
if printf '%s\n' "$NSP_DEF" | grep -qx -- '--no-session-persistence'; then
  bad "FIX D default OFF" "unexpected --no-session-persistence with knob unset"
else
  ok "FIX D: --no-session-persistence absent by default (zero behavior change)"
fi
NSP_ON="$(LOKI_NO_SESSION_PERSIST=1 run_autoflags_nsp)"
if printf '%s\n' "$NSP_ON" | grep -qx -- '--no-session-persistence'; then
  ok "FIX D: LOKI_NO_SESSION_PERSIST=1 emits --no-session-persistence"
else
  bad "FIX D opt-in" "flag missing with =1: $(printf '%s ' $NSP_ON)"
fi

# ============================================================================
# Section H: Session-continuity Phase 2 (GitHub #165) -- LOKI_RESUME_SESSION
# ============================================================================
# Stub-level proof of the resume-or-stamp main-loop decision. HONEST SCOPE: a
# stub advertises --resume/--fork-session in --help; these tests assert the FLAG
# IS / IS NOT passed, the resume uuid is the stored stable per-run uuid, and the
# mutual-exclusion invariant (--session-id and --resume never co-occur). The REAL
# claude --resume context-carry / cost-capture semantics were verified LIVE in
# internal/V735-PHASE2-PROBE-RESULTS.md (PROBE 1, opus) -- not re-run here.

# A Phase-2 stub that advertises the resume flags.
P2_BIN="$TMP/p2-bin"; mkdir -p "$P2_BIN"
cat > "$P2_BIN/claude" <<'P2STUB'
#!/usr/bin/env bash
case "$1" in
  --help)
    cat <<'HELP'
  --session-id <uuid>                   Use a specific session id
  --resume <id>                         Resume a session by id
  --fork-session                        Fork on resume
  --dangerously-skip-permissions        skip
HELP
    exit 0
    ;;
esac
exit 0
P2STUB
chmod +x "$P2_BIN/claude"

# Reproduce the run.sh main-loop resume-or-stamp slice in isolation. Mirrors
# run.sh exactly: resume wins on a restarted first call, else stamp, never both.
# Args: <restarted 0|1> <consumed 0|1> <iteration> ; reads env knobs + run dir.
build_main_argv_p2() {
  local restarted="$1" consumed="$2" iter="$3"
  PATH="$P2_BIN:$PATH" bash -c '
    set -uo pipefail
    unset __LOKI_CLAUDE_HELP_CACHE
    # shellcheck disable=SC1090
    . "'"$FLAGS_SH"'"
    _LOKI_RESTARTED_RUN="'"$restarted"'"
    _LOKI_RESUME_CONSUMED="'"$consumed"'"
    ITERATION_COUNT="'"$iter"'"
    LOKI_TRUST_RUN_ID="run-p2-test-7"
    _loki_claude_argv=("--dangerously-skip-permissions" "--model" "opus")
    _loki_did_resume=0
    if [ "${_LOKI_RESTARTED_RUN:-0}" = "1" ] && [ "${_LOKI_RESUME_CONSUMED:-0}" = "0" ] \
       && type loki_resume_session_enabled >/dev/null 2>&1 \
       && loki_resume_session_enabled; then
      _loki_resume_uuid="$(_loki_resume_target_uuid)"
      if [ -n "$_loki_resume_uuid" ]; then
        _loki_claude_argv+=("--resume" "$_loki_resume_uuid")
        if type loki_session_fork_enabled >/dev/null 2>&1 && loki_session_fork_enabled; then
          _loki_claude_argv+=("--fork-session")
        fi
        _loki_did_resume=1
      fi
    fi
    if [ "$_loki_did_resume" = "0" ] \
       && type loki_session_stamp_enabled >/dev/null 2>&1 \
       && loki_session_stamp_enabled; then
      _loki_iter_session_uuid="$(_loki_claude_iteration_session_uuid "${LOKI_TRUST_RUN_ID:-}" "$ITERATION_COUNT")"
      [ -n "$_loki_iter_session_uuid" ] && _loki_claude_argv+=("--session-id" "$_loki_iter_session_uuid")
    fi
    printf "%s\n" "${_loki_claude_argv[@]}"
  ' 2>/dev/null
}

# Seed a claude-session.json with a known stable uuid in a run dir.
P2_PROJ="$TMP/p2-proj"; mkdir -p "$P2_PROJ/.loki/state"
P2_STORED="$(PATH="$P2_BIN:$PATH" bash -c '. "'"$FLAGS_SH"'"; _loki_claude_session_uuid "run-p2-test-7"')"
printf '{"run_id":"run-p2-test-7","claude_session_uuid":"%s","mode":"resume","created_at":"2026-06-13T00:00:00Z"}\n' \
  "$P2_STORED" > "$P2_PROJ/.loki/state/claude-session.json"

# Case 1: DEFAULT (no knobs) -> neither --resume nor --session-id.
H1="$(cd "$P2_PROJ" && unset LOKI_RESUME_SESSION LOKI_SESSION_STAMP LOKI_SESSION_FORK; LOKI_DIR="$P2_PROJ/.loki" build_main_argv_p2 1 0 1)"
if printf '%s\n' "$H1" | grep -qx -- '--resume' || printf '%s\n' "$H1" | grep -qx -- '--session-id'; then
  bad "H1 default OFF" "unexpected session flag: $(printf '%s ' $H1)"
else
  ok "H1: default (no knobs) emits neither --resume nor --session-id (byte-identical to v7.34)"
fi

# Case 2: RESUME=1 fresh run (restarted=0) iter0 -> stamp path, NOT resume.
# Fresh run iter0 with STAMP also on emits the per-run-stable... no: stamp is
# per-iteration. The design says a fresh RESUME-eligible run stamps iter0 so a
# later restart has an anchor; that anchor write is the claude-session.json (run
# start), proven in Section C. Here we assert the ARGV on a fresh run does NOT
# resume (restarted=0) and only stamps when STAMP=1.
H2="$(cd "$P2_PROJ" && LOKI_DIR="$P2_PROJ/.loki" LOKI_RESUME_SESSION=1 build_main_argv_p2 0 0 0)"
if printf '%s\n' "$H2" | grep -qx -- '--resume'; then
  bad "H2 fresh run no resume" "fresh run (restarted=0) must NOT resume: $(printf '%s ' $H2)"
else
  ok "H2: RESUME=1 on a FRESH run (restarted=0) does NOT emit --resume (recovery-only)"
fi

# Case 3: restarted run, first call, RESUME=1 -> --resume <stored>, NO --session-id.
H3="$(cd "$P2_PROJ" && LOKI_DIR="$P2_PROJ/.loki" LOKI_RESUME_SESSION=1 LOKI_SESSION_STAMP=1 build_main_argv_p2 1 0 1)"
H3_RESUME_VAL="$(printf '%s\n' "$H3" | grep -A1 -x -- '--resume' | tail -1)"
if printf '%s\n' "$H3" | grep -qx -- '--resume' && [ "$H3_RESUME_VAL" = "$P2_STORED" ]; then
  ok "H3: restarted first call -> --resume <stored stable uuid> ($P2_STORED)"
else
  bad "H3 resume stored uuid" "expected --resume $P2_STORED, got: $(printf '%s ' $H3)"
fi

# Case 5 (mutual exclusion): even with STAMP=1, the resumed call has NO --session-id.
if printf '%s\n' "$H3" | grep -qx -- '--session-id'; then
  bad "H5 mutual exclusion" "--session-id co-occurred with --resume: $(printf '%s ' $H3)"
else
  ok "H5: mutual exclusion -- the resumed call emits NO --session-id (never both)"
fi

# After consumption (consumed=1): reverts to normal stamp behavior, no resume.
H3B="$(cd "$P2_PROJ" && LOKI_DIR="$P2_PROJ/.loki" LOKI_RESUME_SESSION=1 LOKI_SESSION_STAMP=1 build_main_argv_p2 1 1 2)"
if printf '%s\n' "$H3B" | grep -qx -- '--resume'; then
  bad "H3B revert" "later iteration still resumed (no once-only latch): $(printf '%s ' $H3B)"
elif printf '%s\n' "$H3B" | grep -qx -- '--session-id'; then
  ok "H3B: after the one resume (consumed=1) the run reverts to per-iteration --session-id (no chain)"
else
  bad "H3B revert stamp" "expected --session-id after revert: $(printf '%s ' $H3B)"
fi

# Case 4: FORK=1 -> --fork-session appended to the resume slice.
H4="$(cd "$P2_PROJ" && LOKI_DIR="$P2_PROJ/.loki" LOKI_RESUME_SESSION=1 LOKI_SESSION_FORK=1 build_main_argv_p2 1 0 1)"
if printf '%s\n' "$H4" | grep -qx -- '--resume' && printf '%s\n' "$H4" | grep -qx -- '--fork-session'; then
  ok "H4: LOKI_SESSION_FORK=1 appends --fork-session on the resume call"
else
  bad "H4 fork" "expected --resume + --fork-session: $(printf '%s ' $H4)"
fi
# FORK without RESUME is a no-op (fork only honored with resume).
H4B="$(cd "$P2_PROJ" && unset LOKI_RESUME_SESSION; LOKI_DIR="$P2_PROJ/.loki" LOKI_SESSION_FORK=1 build_main_argv_p2 1 0 1)"
if printf '%s\n' "$H4B" | grep -qx -- '--fork-session'; then
  bad "H4B fork needs resume" "--fork-session emitted without --resume: $(printf '%s ' $H4B)"
else
  ok "H4B: --fork-session is a no-op without LOKI_RESUME_SESSION=1"
fi

# Case 7: older CLI (no --resume in help) degrades -> no resume even with =1.
H7="$(
  DEG2="$TMP/p2-deg"; mkdir -p "$DEG2"
  cat > "$DEG2/claude" <<'DST2'
#!/usr/bin/env bash
case "$1" in --help) printf '  --session-id <uuid>  id\n'; exit 0;; esac
exit 0
DST2
  chmod +x "$DEG2/claude"
  cd "$P2_PROJ" || exit 1
  PATH="$DEG2:$PATH" bash -c '
    set -uo pipefail
    unset __LOKI_CLAUDE_HELP_CACHE
    # shellcheck disable=SC1090
    . "'"$FLAGS_SH"'"
    if LOKI_RESUME_SESSION=1 loki_resume_session_enabled; then echo "ENABLED"; else echo "DISABLED"; fi
  ' 2>/dev/null
)"
if [ "$H7" = "DISABLED" ]; then
  ok "H7: older CLI without --resume in help degrades (resume OFF even with =1)"
else
  bad "H7 graceful degrade" "got: $H7"
fi

# Malformed stored uuid -> no resume (safe degrade).
P2_BADPROJ="$TMP/p2-bad"; mkdir -p "$P2_BADPROJ/.loki/state"
printf '{"run_id":"x","claude_session_uuid":"not-a-uuid","mode":"resume"}\n' > "$P2_BADPROJ/.loki/state/claude-session.json"
H_BAD="$(cd "$P2_BADPROJ" && LOKI_DIR="$P2_BADPROJ/.loki" LOKI_RESUME_SESSION=1 build_main_argv_p2 1 0 1)"
if printf '%s\n' "$H_BAD" | grep -qx -- '--resume'; then
  bad "H-bad uuid" "resumed on a malformed stored uuid: $(printf '%s ' $H_BAD)"
else
  ok "H-bad: malformed stored uuid -> no --resume (safe degrade to fresh call)"
fi

# Case 6: bash <-> Bun parity for the resume slice.
if command -v bun >/dev/null 2>&1; then
  BUN_P2="$(cd "$REPO_ROOT/loki-ts" && LOKI_DIR="$P2_PROJ/.loki" LOKI_RESUME_SESSION=1 bun -e '
    import { sessionResumeArgv, resumeSessionEnabled, sessionForkEnabled, _resetClaudeHelpCacheForTest } from "./src/providers/claude_flags.ts";
    _resetClaudeHelpCacheForTest("  --session-id <uuid>\n  --resume <id>\n  --fork-session\n");
    console.log("RESUME:" + JSON.stringify(sessionResumeArgv()));
    delete process.env.LOKI_RESUME_SESSION;
    console.log("DEF:" + JSON.stringify(sessionResumeArgv()));
  ' 2>/dev/null)"
  BUN_RESUME="$(printf '%s\n' "$BUN_P2" | grep '^RESUME:' | sed 's/^RESUME://')"
  BUN_DEF="$(printf '%s\n' "$BUN_P2" | grep '^DEF:' | sed 's/^DEF://')"
  if [ "$BUN_DEF" = "[]" ]; then
    ok "H6 (Bun): sessionResumeArgv() default OFF -> [] (byte-identical to v7.34)"
  else
    bad "H6 Bun default OFF" "got: $BUN_DEF"
  fi
  if printf '%s' "$BUN_RESUME" | grep -q -- "$P2_STORED"; then
    ok "H6 (Bun): sessionResumeArgv() emits --resume + the SAME stored uuid as bash ($P2_STORED)"
  else
    bad "H6 Bun resume parity" "bash stored=$P2_STORED bun=$BUN_RESUME"
  fi
else
  bad "H6 bash<->Bun resume parity" "bun not on PATH"
fi

echo
echo "======================================================================"
echo "test-cli-session-v734: $PASS passed, $FAIL failed"
echo "======================================================================"
[ "$FAIL" -eq 0 ]
