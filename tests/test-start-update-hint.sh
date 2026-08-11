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
    # script(1) TAKES ITS ARGUMENTS DIFFERENTLY ON THE TWO PLATFORMS, and the
    # divergence is silent rather than an error.
    #
    #   BSD (macOS):        script -q /dev/null CMD ARGS...
    #   util-linux (CI):    script -q -c "CMD ARGS..." /dev/null
    #
    # Under util-linux the BSD form reads /dev/null as the TYPESCRIPT FILE and
    # the rest as further operands, so the command does not run under a pty.
    # No usage error is printed. The result is a test that passes on every
    # macOS laptop and fails on every Linux runner -- which is exactly what it
    # did, and what the `env -u CI` fix alone did not cure, because there were
    # two independent reasons the hint stayed silent on CI and fixing one left
    # the other.
    #
    # Detected by BEHAVIOUR rather than by `uname`: ask each form whether it
    # actually yields a tty. A platform string is a proxy; `[ -t 1 ]` is the
    # property the code under test actually branches on.
    _PTY_FORM=""
    if script -q /dev/null bash -c '[ -t 1 ]' >/dev/null 2>&1; then
        _PTY_FORM="bsd"
    elif script -q -c '[ -t 1 ]' /dev/null >/dev/null 2>&1; then
        _PTY_FORM="util-linux"
    fi

    # Run "$@" under a pty, whichever flavour is installed, with CI unset.
    #
    # CI IS UNSET INSIDE THE FUNCTION, not by `env -u CI _under_pty ...` in
    # front of it. `env` execs a BINARY and cannot see shell functions, so that
    # spelling fails with "env: _under_pty: No such file or directory" -- the
    # command never runs, no hint is printed, and the assertion reports
    # "a stale install prints NO warning" for a reason that has nothing to do
    # with the feature. That is the same shape as the bug being fixed: a test
    # failing because the harness never invoked the thing under test.
    #
    # maybe_print_update_hint returns early on `[ -n "${CI:-}" ]` by design
    # (autonomy/loki:387), so the BEHAVIOURAL cases must run with it unset.
    # The `guard present: ${CI:-}` source assertion below is what proves that
    # suppression still exists; unsetting it here does not weaken it.
    _under_pty() {
        case "$_PTY_FORM" in
            bsd)        ( unset CI; script -q /dev/null "$@" </dev/null ) ;;
            util-linux) ( unset CI; script -q -c "$*" /dev/null </dev/null ) ;;
            *)          return 127 ;;
        esac
    }

fi

if [ "${_PTY_FORM:-}" = "" ] && command -v script >/dev/null 2>&1; then
    # Neither form produced a tty. That is an ABSENT MEASUREMENT, not a pass:
    # every behavioural case would report "no warning" for the wrong reason,
    # and a skip that silently runs the cases anyway is worse than no skip.
    echo "  SKIP: script(1) present but no form yielded a pty;"
    echo "        the behavioural cases are NOT run and NOT counted."
fi

if [ -n "${_PTY_FORM:-}" ]; then
    D="$(mktemp -d "${TMPDIR:-/tmp}/loki-hint-XXXXXX")"
    mkdir -p "$D/.loki/cache"
    _cache="$D/.loki/cache/update-check-bash.json"

    # A far-future latest must warn.
    printf '{"checkedAt":%s,"latest":"9.99.0"}\n' "$(date +%s)" > "$_cache"
    # `start --help` still exercises cmd_start and the hint, then exits before
    # entering the interactive no-spec workflow. A bare `start` under the PTY
    # waits for operator input forever and can wedge the full pre-push gate.
    # Capture FIRST, then match. `... | grep -qi` exits on the first match and
    # closes the pipe; under script(1) that races with output delivery and the
    # match is intermittently missed -- the assertion failed here while the
    # identical command passed by hand.
    # CI must be unset for the BEHAVIOURAL cases. maybe_print_update_hint
    # returns early on `[ -n "${CI:-}" ]` by design (autonomy/loki:387), so on
    # any CI runner this case asserted a nag that the feature is correct to
    # suppress -- red on GitHub, green on every laptop. Note the silent case
    # below needs it too: under CI it passed VACUOUSLY, staying quiet because
    # the hint was suppressed rather than because the version was current.
    # The `guard present: ${CI:-}` source assertion above is what proves the
    # suppression still exists; unsetting it here does not weaken that.
    _out="$(HOME="$D" _under_pty bash "$LOKI" start --help 2>&1 || true)"
    case "$_out" in
        *"newer loki-mode is available"*) ok "a stale install warns on start" ;;
        *) bad "a stale install prints NO warning on start" ;;
    esac

    # The current version must stay silent -- a nag on every run trains users
    # to ignore the line, which costs more than it saves.
    printf '{"checkedAt":%s,"latest":"%s"}\n' "$(date +%s)" \
        "$(cat "$REPO_ROOT/VERSION" 2>/dev/null | tr -d '[:space:]')" > "$_cache"
    _out="$(HOME="$D" _under_pty bash "$LOKI" start --help 2>&1 || true)"
    case "$_out" in
        *"newer loki-mode is available"*) bad "an up-to-date install still nags" ;;
        *) ok "an up-to-date install stays silent" ;;
    esac

    # Opt-out must win.
    printf '{"checkedAt":%s,"latest":"9.99.0"}\n' "$(date +%s)" > "$_cache"
    _out="$(HOME="$D" LOKI_NO_UPDATE_CHECK=1 _under_pty bash "$LOKI" start --help 2>&1 || true)"
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
