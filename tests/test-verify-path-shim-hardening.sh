#!/usr/bin/env bash
# BACKLOG 48 / D7 same-class hardening: `loki outcomes canary verify` and the
# inline python3 heredocs behind `loki proof share`/`loki proof show`.
#
# WHY THIS EXISTS. D7 (docs/v10/DECISIONS.md) established that a verify path's
# Python invocation must not let the checkout under verification supply the
# verifier's own modules: python3 runs with -E (PYTHONPATH and a committed
# sitecustomize.py are both blocked before any in-script guard can run), and
# each inline heredoc drops '' and '.' from sys.path before its first real
# import. That guard was applied to the base proof verifier and the
# attestation checks, but not to `outcomes canary verify` or the proof
# share/show heredocs.
#
# THIS FILE ADDS A SECOND, RELATED THREAT the earlier D7 sites did not need:
# a NON-ABSOLUTE PATH COMPONENT. A leading/embedded "" in $PATH (what
# `PATH="x:$PATH"` on an unset PATH, or a stray `PATH=":$PATH"`, leaves) is
# treated by the shell exactly like ".", and so is any OTHER relative entry
# (a bare "bin", "./tools", ...): if the current directory (or a relative
# subdirectory of it) happens to be part of the checkout under
# verification/sharing and contains a file named python3, an unscoped
# `python3 ...` invocation runs THAT FILE, not the real interpreter -- no need
# to control any real, absolute PATH directory. -E alone does not close this:
# -E stops the environment from redirecting an already-resolved python3, it
# does nothing about which binary "python3" resolves to in the first place.
#
# THE RED LEG'S REFERENCE POINT MUST BE FIXED, NOT "HEAD". A first version of
# this test built its pre-fix comparison copy via `git show HEAD:autonomy/loki`.
# That only demonstrates the bug up until this test's own commit lands: once
# merged, HEAD *is* the fix, so the RED leg would silently and permanently stop
# demonstrating anything (every RED control would report "harness could not
# reproduce" forever, on every future run, on every branch). Instead this file
# pins a literal, unmoving SHA -- the immediate parent of the commit that added
# this fix -- captured once, below, as a constant. That commit predates this
# fix on every branch it is ever merged into, by construction, so `git show
# <PINNED_SHA>:autonomy/loki` always answers with the pre-fix source, no matter
# how much history accumulates on top of it afterward.
#
# A pinned SHA is only useful if it is actually fetchable: a shallow checkout
# (e.g. actions/checkout's default fetch-depth: 1, used by this repo's
# shell-tests CI job) will not have it. When that happens this file prints an
# explicit SKIP line and does not count the RED leg as PASS or FAIL, so a
# shallow CI run is visibly a skip in the log, never a silent, indistinguishable
# green. The GREEN legs (which need no history at all) still always run.
#
# RED is run against this pinned pre-fix `autonomy/loki` with a committed
# python3 shim sitting in the current directory and a non-absolute PATH entry:
# the shim runs and its fabricated output reaches the user. GREEN is the same
# attack against the working tree: the shim never runs, and the real tool's
# honest answer (or refusal) comes through instead.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"

# The immediate parent of the commit that introduced this D7 hardening. Fixed
# forever: never re-derive this from HEAD, HEAD^, or any other ref that
# changes meaning once this file is committed and merged.
PRE_FIX_SHA="c7b2d8b44cebf3921c58d8a8e5225658327c5953"

PASS=0; FAIL=0; SKIP=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
skip() { echo "  SKIP: $1"; SKIP=$((SKIP+1)); }

echo "TEST: verify-path python3 hardening (outcomes canary verify, proof share/show)"

[ -f "$LOKI_BIN" ] || { echo "  FAIL: $LOKI_BIN missing"; exit 1; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-vpsh.XXXXXX")"

# The pinned pre-fix copy of autonomy/loki, read from the fixed SHA above (not
# HEAD). It must live under REPO_ROOT/autonomy so its _LOKI_SCRIPT_DIR
# resolution finds the real tools/ directory, exactly like the shipped script
# does.
HEAD_COPY="$REPO_ROOT/autonomy/.test-vpsh-head-copy"
cleanup_head_copy() { rm -f "$HEAD_COPY" 2>/dev/null || true; }
trap 'cleanup_head_copy; rm -rf "$W" 2>/dev/null || true' EXIT INT TERM

if ! git -C "$REPO_ROOT" cat-file -e "${PRE_FIX_SHA}^{commit}" 2>/dev/null; then
  skip "pinned pre-fix ref $PRE_FIX_SHA unreachable (shallow checkout?) -- RED leg cannot run"
  HEAD_COPY=""
elif ! git -C "$REPO_ROOT" show "${PRE_FIX_SHA}:autonomy/loki" >"$HEAD_COPY" 2>/dev/null; then
  bad "harness: pinned ref $PRE_FIX_SHA exists but autonomy/loki could not be read from it -- RED leg skipped"
  cleanup_head_copy
  HEAD_COPY=""
else
  chmod +x "$HEAD_COPY"
fi

# A curated PATH containing every real binary these code paths need EXCEPT
# jq (so `proof show` takes its python3 fallback branch) and except a real
# `gh` (a stub below reports it authenticated and fakes gist creation, so
# `proof share` runs hermetically with no network and no real GitHub CLI).
REALBIN="$W/realbin"
mkdir -p "$REALBIN"
for b in bash sh cat echo printf mkdir rm cp chmod ls grep sed awk basename \
         dirname pwd true false test env python3 gpg head tail sort tr cut \
         date mktemp; do
  p="$(command -v "$b" 2>/dev/null || true)"
  [ -n "$p" ] && ln -sf "$p" "$REALBIN/$b"
done
cat >"$REALBIN/gh" <<'GHSTUB'
#!/bin/sh
case "$1 $2" in
    "auth status") exit 0 ;;
esac
if [ "$1" = "gist" ] && [ "$2" = "create" ]; then
    echo "https://gist.github.com/fake/deadbeef"
    exit 0
fi
exit 1
GHSTUB
chmod +x "$REALBIN/gh"

# The shim itself: a committed "python3" in the checkout that fabricates
# output and leaves a marker so the test can tell it ran, without needing to
# guess what real python3's stdout would have looked like.
write_shim() {
  local dir="$1" payload="$2"
  cat >"$dir/python3" <<SHIM
#!/bin/sh
echo SHIM_RAN >> "\$MARK_FILE"
printf '%s\n' '$payload'
exit 0
SHIM
  chmod +x "$dir/python3"
}

# Run one loki invocation with: cwd = a fixture directory containing the
# python3 shim, and PATH = "<relative>" (non-absolute component) + REALBIN.
# rel_entry is varied across call sites ("" for an empty component, "bin" or
# "./sub" for other relative spellings) so the fix is proven against more than
# just the two originally-covered cases ("" and ".").
run_attacked() {
  local loki_copy="$1" fixture="$2" mark="$3" rel_entry="$4"; shift 4
  rm -f "$mark"
  ( cd "$fixture" && \
    MARK_FILE="$mark" PATH="${rel_entry}:$REALBIN" \
    bash "$loki_copy" "$@" )
}

# --- Site 1: loki outcomes canary verify ------------------------------------
CANARY_FIX="$W/canary"
mkdir -p "$CANARY_FIX"
write_shim "$CANARY_FIX" '{"shimmed": true}'
if [ -n "$HEAD_COPY" ]; then
  MARK="$W/mark-canary-red"
  OUT="$(run_attacked "$HEAD_COPY" "$CANARY_FIX" "$MARK" "" \
    outcomes canary verify /nonexistent/r /nonexistent/o /nonexistent/rc 2>&1)"
  RC=$?
  if [ -s "$MARK" ]; then
    ok "RED: outcomes canary verify -- pinned pre-fix copy ran the cwd python3 shim (empty PATH component)"
  else
    bad "RED control failed: pinned pre-fix copy did not run the shim for outcomes canary verify (rc=$RC, out=$OUT) -- cannot demonstrate the bug"
  fi
fi
MARK="$W/mark-canary-green"
OUT="$(run_attacked "$LOKI_BIN" "$CANARY_FIX" "$MARK" "" \
  outcomes canary verify /nonexistent/r /nonexistent/o /nonexistent/rc 2>&1)"
RC=$?
if [ ! -s "$MARK" ] && [ "$RC" -eq 66 ]; then
  ok "GREEN: outcomes canary verify -- the cwd python3 shim never ran, real tool refused honestly (rc=66)"
else
  bad "GREEN failed: outcomes canary verify -- shim_ran=$([ -s "$MARK" ] && echo yes || echo no) rc=$RC out=$OUT"
fi

# --- Site 2: loki proof show (python3 -c fallback when jq is absent) -------
SHOW_FIX="$W/show"
mkdir -p "$SHOW_FIX/.loki/proofs/x1"
printf '{"run_id": "x1"}\n' >"$SHOW_FIX/.loki/proofs/x1/proof.json"
write_shim "$SHOW_FIX" '{"shimmed": true}'
if [ -n "$HEAD_COPY" ]; then
  MARK="$W/mark-show-red"
  OUT="$(run_attacked "$HEAD_COPY" "$SHOW_FIX" "$MARK" "" proof show x1 2>&1)"
  if [ -s "$MARK" ] && printf '%s' "$OUT" | grep -q '"shimmed": true'; then
    ok "RED: proof show -- pinned pre-fix copy's python3 fallback ran the cwd shim and printed fabricated JSON"
  else
    bad "RED control failed: pinned pre-fix copy did not run the shim for proof show (out=$OUT) -- cannot demonstrate the bug"
  fi
fi
MARK="$W/mark-show-green"
OUT="$(run_attacked "$LOKI_BIN" "$SHOW_FIX" "$MARK" "" proof show x1 --json 2>&1)"
if [ ! -s "$MARK" ] && printf '%s' "$OUT" | grep -q '"run_id": "x1"'; then
  ok "GREEN: proof show -- the cwd python3 shim never ran, real proof.json content was printed"
else
  bad "GREEN failed: proof show -- shim_ran=$([ -s "$MARK" ] && echo yes || echo no) out=$OUT"
fi

# --- Site 3: loki proof share (three python3 heredocs: preview/hook/badge) -
SHARE_FIX="$W/share"
mkdir -p "$SHARE_FIX/.loki/proofs/x1"
printf '<html>proof page</html>\n' >"$SHARE_FIX/.loki/proofs/x1/index.html"
printf '{"run_id":"x1","cost":{"usd":1.23},"files_changed":{"count":3},"council":{"final_verdict":"PASS"},"honesty":{"headline":"VERIFIED"},"redaction":{"applied":true,"rules_version":1,"redactions_count":0}}\n' \
  >"$SHARE_FIX/.loki/proofs/x1/proof.json"
write_shim "$SHARE_FIX" '{"shimmed": true}'
if [ -n "$HEAD_COPY" ]; then
  MARK="$W/mark-share-red"
  OUT="$(run_attacked "$HEAD_COPY" "$SHARE_FIX" "$MARK" "" proof share x1 --yes 2>&1)"
  if [ -s "$MARK" ] && printf '%s' "$OUT" | grep -q '"shimmed": true'; then
    ok "RED: proof share -- pinned pre-fix copy's redaction-preview heredoc ran the cwd shim"
  else
    bad "RED control failed: pinned pre-fix copy did not run the shim for proof share (out=$OUT) -- cannot demonstrate the bug"
  fi
fi
MARK="$W/mark-share-green"
OUT="$(run_attacked "$LOKI_BIN" "$SHARE_FIX" "$MARK" "" proof share x1 --yes 2>&1)"
if [ ! -s "$MARK" ] && printf '%s' "$OUT" | grep -q 'cost.usd:        1.23' \
   && printf '%s' "$OUT" | grep -q 'council verdict: PASS'; then
  ok "GREEN: proof share -- the cwd python3 shim never ran, real cost/verdict data was shown"
else
  bad "GREEN failed: proof share -- shim_ran=$([ -s "$MARK" ] && echo yes || echo no) out=$OUT"
fi

# --- Direct unit coverage of loki_verify_tool_path() itself -----------------
# The three sites above only ever exercise "" (empty PATH component). This
# proves the helper rejects OTHER relative spellings too ("bin", "./sub"),
# which is exactly the second reviewer finding: the pre-rework helper's case
# statement matched only "" and "." literally and let every other relative
# PATH entry (e.g. a bare "bin") through.
HELPER_SRC="$(sed -n '/^loki_verify_tool_path() {/,/^}/p' "$LOKI_BIN")"
if [ -z "$HELPER_SRC" ]; then
  bad "harness: could not extract loki_verify_tool_path() from $LOKI_BIN"
else
  UNIT_FIX="$W/unit"
  mkdir -p "$UNIT_FIX/bin" "$UNIT_FIX/sub"
  write_shim "$UNIT_FIX/bin" '{"bin_shim": true}'
  write_shim "$UNIT_FIX/sub" '{"sub_shim": true}'
  RESOLVED="$(cd "$UNIT_FIX" && PATH="bin:./sub:$REALBIN" bash -c "
    $HELPER_SRC
    loki_verify_tool_path python3
  ")"
  case "$RESOLVED" in
    "$REALBIN/python3")
      ok "UNIT GREEN: loki_verify_tool_path skips bare-relative 'bin' and './sub' PATH entries, resolves to the real absolute binary"
      ;;
    *)
      bad "UNIT GREEN failed: loki_verify_tool_path returned '$RESOLVED', expected '$REALBIN/python3' (relative PATH entry leaked through)"
      ;;
  esac

  # Mutation control: the pre-rework helper (case "" | . ) continue ;;) DID
  # let "bin" through. Prove the unit test is actually discriminating by
  # reproducing that narrower guard here, inline, with no git dependency.
  OLD_HELPER_SRC="$(printf '%s\n' "$HELPER_SRC" | sed 's/\/\*) ;;/"" | .) continue ;;/; s/\*) continue ;;//')"
  OLD_RESOLVED="$(cd "$UNIT_FIX" && PATH="bin:./sub:$REALBIN" bash -c "
    $OLD_HELPER_SRC
    loki_verify_tool_path python3
  ")"
  if [ "$OLD_RESOLVED" = "bin/python3" ]; then
    ok "UNIT RED: the narrower '\"\" | .' guard lets a bare 'bin' PATH entry resolve to a relative, shim-reachable path"
  else
    bad "UNIT RED control failed: narrower guard returned '$OLD_RESOLVED', expected 'bin/python3' -- mutation control did not reproduce the original bug"
  fi
fi

cleanup_head_copy

echo ""
echo "  Passed: $PASS   Failed: $FAIL   Skipped: $SKIP"
[ "$FAIL" -eq 0 ]
