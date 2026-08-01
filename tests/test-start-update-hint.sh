#!/usr/bin/env bash
# `loki start` must tell the user when their install is stale.
#
# WHY. The update hint existed and worked -- but was wired only into `doctor`
# and `version`, neither of which anyone runs before a build. So a stale install
# stayed invisible for as long as it took someone to go looking.
#
# That cost something real. This machine ran builds on 8.8.0 while npm was at
# 8.41.0, and that specific gap mattered: v8.38.0 fixed four quality-gate
# detectors that had NEVER been packaged, so on 8.8.0 mutation-integrity
# fail-closed on EVERY iteration and first-pass completion was impossible no
# matter how good the model output was. The tool gave the user no way to know.
#
# THE REGRESSION THIS PINS. The hint prints on STDERR. A first draft called it
# as `maybe_print_update_hint 2>/dev/null`, which discards the only thing the
# call produces -- the feature was silently dead and every test still passed,
# because a suppressed message and an absent message look identical.
#
# Also pinned: the function must stay fail-silent (CI, non-TTY, opt-out) so
# adding it to the hot path can never break a build or add latency.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: loki start surfaces a stale install"

# --- WIRING: start must call it ---------------------------------------------
if grep -q '^\s*maybe_print_update_hint' "$LOKI"; then
    ok "the hint is called somewhere"
else
    bad "maybe_print_update_hint is never called"
fi

_start_line="$(grep -n '^cmd_start()' "$LOKI" | head -1 | cut -d: -f1)"
if [ -n "$_start_line" ] \
   && awk -v a="$_start_line" -v b="$((_start_line + 60))" \
        'NR>=a && NR<=b && /maybe_print_update_hint/' "$LOKI" | grep -q .; then
    ok "WIRING: cmd_start calls the update hint"
else
    bad "WIRING: cmd_start does not call the hint -- a stale install stays invisible on the command users actually run"
fi

# --- THE REGRESSION: stderr must not be discarded ---------------------------
# The hint writes to stderr. Redirecting it makes the call a no-op that looks
# correct in every source review.
_call="$(awk -v a="$_start_line" -v b="$((_start_line + 60))" \
    'NR>=a && NR<=b && /maybe_print_update_hint/' "$LOKI")"
case "$_call" in
    *"2>/dev/null"*|*"2>&-"*)
        bad "cmd_start discards the hint's stderr -- the call prints nothing" ;;
    *)
        ok "cmd_start does not discard the hint's stderr" ;;
esac

# --- BEHAVIOUR: warns when stale, silent when current -----------------------
# Needs a TTY: the function deliberately returns early when stdout is not a
# terminal, so piping to grep suppresses it. `script` supplies a pty.
if ! command -v script >/dev/null 2>&1; then
    echo "  SKIP: no script(1) for a pty; source assertions above still apply"
else
    D="$(mktemp -d "${TMPDIR:-/tmp}/loki-hint-XXXXXX")"
    mkdir -p "$D/.loki/cache"
    _cache="$D/.loki/cache/update-check-bash.json"

    # A far-future latest must warn.
    printf '{"checkedAt":%s,"latest":"9.99.0"}\n' "$(date +%s)" > "$_cache"
    # Capture FIRST, then match. `... | grep -qi` exits on the first match and
    # closes the pipe; under script(1) that races with output delivery and the
    # match is intermittently missed -- the assertion failed here while the
    # identical command passed by hand.
    _out="$(HOME="$D" script -q /dev/null bash "$LOKI" start 2>&1 || true)"
    case "$_out" in
        *"newer loki-mode is available"*) ok "a stale install warns on start" ;;
        *) bad "a stale install prints NO warning on start" ;;
    esac

    # The current version must stay silent -- a nag on every run trains users
    # to ignore the line, which costs more than it saves.
    printf '{"checkedAt":%s,"latest":"%s"}\n' "$(date +%s)" \
        "$(cat "$REPO_ROOT/VERSION" 2>/dev/null | tr -d '[:space:]')" > "$_cache"
    _out="$(HOME="$D" script -q /dev/null bash "$LOKI" start 2>&1 || true)"
    case "$_out" in
        *"newer loki-mode is available"*) bad "an up-to-date install still nags" ;;
        *) ok "an up-to-date install stays silent" ;;
    esac

    # Opt-out must win.
    printf '{"checkedAt":%s,"latest":"9.99.0"}\n' "$(date +%s)" > "$_cache"
    _out="$(HOME="$D" LOKI_NO_UPDATE_CHECK=1 script -q /dev/null bash "$LOKI" start 2>&1 || true)"
    case "$_out" in
        *"newer loki-mode is available"*) bad "LOKI_NO_UPDATE_CHECK=1 does not suppress the hint" ;;
        *) ok "LOKI_NO_UPDATE_CHECK=1 suppresses the hint" ;;
    esac

    rm -rf "$D"
fi

# --- fail-silent guards must remain -----------------------------------------
# This now runs on the hot path, so a hang or a crash here would break builds.
_fn="$(sed -n '/^maybe_print_update_hint()/,/^}/p' "$LOKI")"
for guard in 'LOKI_NO_UPDATE_CHECK' '${CI:-}' '! -t 1' '--max-time'; do
    case "$_fn" in
        *"$guard"*) ok "guard present: $guard" ;;
        *) bad "guard MISSING: $guard -- the hot path could hang or nag" ;;
    esac
done

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
