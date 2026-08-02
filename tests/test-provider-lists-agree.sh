#!/usr/bin/env bash
# An opencode-only machine was told it had no AI provider.
#
# THE DEFECT. Two lists name the supported providers:
#
#   providers/loader.sh    auto_detect_provider()  claude cline codex aider opencode
#   autonomy/provider-offer.sh  detect_any_provider()   claude codex cline aider
#
# The second omitted `opencode` and swapped codex/cline. `detect_any_provider`
# is the PRE-FLIGHT GATE: `provider_offer_gate` routes through it, and
# `cmd_start` exits 2 when it fails. So on a machine where opencode was the only
# provider installed -- a fully working machine -- the user got:
#
#   No AI provider CLI found; cannot prompt to install in a non-interactive
#   shell. Run: npm install -g @anthropic-ai/claude-code
#   No provider available; cannot start a build.
#
# A redundant install instruction, and no build. That is a REQUIRED step added
# before first value, which is the highest-severity adoption defect this repo
# recognises.
#
# The order matters too, not just membership: with codex and cline both
# installed, quickstart named codex while the runner would actually pick cline.
#
# WHY A SHARED LIST WAS NOT THE FIX. detect_any_provider is deliberately
# PATH-only (see its comment): callers like cmd_demo and cmd_quick stay on the
# bash route and genuinely need a binary present, so routing it through the
# richer detector would be a fail-OPEN -- a green pre-flight followed by a
# runner that cannot invoke anything. The bug was the missing NAME, so the fix
# is the name, and this test pins the two lists together instead.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOADER="$REPO_ROOT/providers/loader.sh"
OFFER="$REPO_ROOT/autonomy/provider-offer.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: the two provider lists agree"

# --- extract both lists from source ------------------------------------------
_auto="$(sed -n '/^auto_detect_provider()/,/^}/p' "$LOADER" \
         | sed -n 's/.*for p in \(.*\); do.*/\1/p' | head -1)"
_gate="$(sed -n '/^detect_any_provider()/,/^}/p' "$OFFER" \
         | sed -n 's/.*for _dp in \(.*\); do.*/\1/p' | head -1)"

if [ -z "$_auto" ] || [ -z "$_gate" ]; then
    bad "could not extract a list (auto='$_auto' gate='$_gate'); test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
ok "both provider lists were extracted from source"

# Membership must match exactly. A gate that knows FEWER providers blocks a
# working machine; one that knows MORE fails open on a provider the runner
# cannot actually select.
_auto_sorted="$(printf '%s\n' $_auto | sort | tr '\n' ' ')"
_gate_sorted="$(printf '%s\n' $_gate | sort | tr '\n' ' ')"
if [ "$_auto_sorted" = "$_gate_sorted" ]; then
    ok "the pre-flight gate knows exactly the providers the detector does"
else
    bad "list mismatch -- gate=[$_gate] detector=[$_auto]"
fi

# Order is the SELECTION PRIORITY, so it must match too: quickstart reported
# codex on a box where the runner would have picked cline.
if [ "$_auto" = "$_gate" ]; then
    ok "priority order matches, so no surface names the wrong provider"
else
    bad "order differs -- gate=[$_gate] detector=[$_auto]"
fi

# opencode is named explicitly: it is the entry that was missing, and a generic
# comparison would pass again if BOTH lists dropped it.
case " $_gate " in
    *" opencode "*) ok "the gate includes opencode (the provider it blocked)" ;;
    *) bad "opencode is missing from the pre-flight gate again" ;;
esac

# --- BEHAVIOUR: an opencode-only machine must pass the gate ------------------
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-plists-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/bin"
for _t in bash sh sed grep awk tr cut cat head printf dirname basename env rm mkdir; do
    _p="$(command -v "$_t" 2>/dev/null)" && ln -sf "$_p" "$SCRATCH/bin/$_t" 2>/dev/null
done
printf '#!/bin/sh\necho "opencode 1.0"\n' > "$SCRATCH/bin/opencode"
chmod +x "$SCRATCH/bin/opencode"

if PATH="$SCRATCH/bin" bash -c ". '$OFFER' 2>/dev/null; detect_any_provider"; then
    ok "an opencode-only machine passes the pre-flight gate"
else
    bad "an opencode-only machine is STILL told it has no provider"
fi

# The opposite direction: with NO provider the gate must still fail, or this
# stops being a gate at all.
rm -f "$SCRATCH/bin/opencode"
if PATH="$SCRATCH/bin" bash -c ". '$OFFER' 2>/dev/null; detect_any_provider"; then
    bad "a machine with NO provider passed the gate -- it fails open now"
else
    ok "a machine with no provider is still blocked"
fi

# --- the FIFTH list: doctor's own provider check ------------------------------
# `_provider_cmds` in autonomy/loki backs `doctor --json`'s ai_provider verdict.
# It omitted opencode, so doctor reported "No AI provider CLI. Fix: npm install
# -g @anthropic-ai/claude-code" on a machine where the runner would have
# selected opencode without complaint. Same drift as the pre-flight gate above,
# on the surface a user consults FIRST when something looks wrong.
_doc="$(sed -n 's/^_provider_cmds = (\(.*\))$/\1/p' "$REPO_ROOT/autonomy/loki" \
        | tr -d "', " | head -1)"
_auto_squash="$(printf '%s' "$_auto" | tr -d ' ')"

if [ -z "$_doc" ]; then
    bad "could not read _provider_cmds from autonomy/loki; this check is inert"
elif [ "$_doc" = "$_auto_squash" ]; then
    ok "doctor's provider check matches the detector, membership and order"
else
    bad "doctor list drift -- doctor=[$_doc] detector=[$_auto_squash]"
fi

case "$_doc" in
    *opencode*) ok "doctor's check includes opencode" ;;
    *) bad "doctor would report 'No AI provider CLI' on an opencode-only machine" ;;
esac

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
