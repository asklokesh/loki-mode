#!/usr/bin/env bash
# The no-spend preview paths must WORK and must be FINDABLE from `loki start --help`.
#
# WHY THIS EXISTS. Dry-run was never missing: `loki plan` analyzes a spec
# without executing, and LOKI_CONFIG_DUMP=1 prints the resolved configuration
# and exits. Both worked. Neither was mentioned by `loki start --help`, which
# documented only `--dry-run` -- an ISSUE-MODE flag. A user holding a PRD who
# wanted to preview before spending read that help, saw a flag that did not
# apply to them, and concluded there was no dry run.
#
# That is the same failure shape as the image signing in this repo that was
# built, gated behind an env var, and documented nowhere: capability that
# exists but cannot be found is indistinguishable from capability that does not
# exist. This test asserts BOTH halves -- that the paths work, and that the
# help points at them -- because fixing either alone leaves the user stuck.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/spec.md" <<'SPEC'
# Todo App
Build a simple todo list with add, complete, and delete.
SPEC

# Captured, never piped into a matcher: under `set -o pipefail` a `| head` that
# closes the pipe early makes the CLI die of SIGPIPE and the pipeline report
# nonzero regardless of the match. That exact mistake silently inverted a sister
# test in this suite.
help_out="$("$LOKI" start --help </dev/null 2>&1 || true)"

# 1. The help must name `loki plan`. Without this the PRD-mode user never
#    learns the preview exists.
case "$help_out" in
    *"loki plan"*) ok "start --help points at 'loki plan' for a no-spend preview" ;;
    *) bad "start --help never mentions 'loki plan' -- the PRD-mode preview is unfindable" ;;
esac

# 2. It must also say --dry-run is issue-mode only. Listing both without that
#    distinction is its own trap: a PRD user reaches for --dry-run and it does
#    not apply to them.
case "$help_out" in
    *"issue-mode only"*|*"ISSUE-REF"*) ok "help scopes --dry-run to issue mode" ;;
    *) bad "help does not distinguish issue-mode --dry-run from the PRD preview" ;;
esac

case "$help_out" in
    *LOKI_CONFIG_DUMP*) ok "help documents LOKI_CONFIG_DUMP" ;;
    *) bad "LOKI_CONFIG_DUMP is undocumented in start --help" ;;
esac

# 3. `loki plan --json` must actually emit the fields the help promises. A help
#    text that names a command which does not deliver is worse than silence.
plan_out="$("$LOKI" plan "$WORK/spec.md" --json </dev/null 2>/dev/null || true)"
plan_keys="$(printf '%s' "$plan_out" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNPARSEABLE"); raise SystemExit
need = ("complexity", "cost", "iterations")
print("OK" if all(k in d for k in need) else "MISSING:" + ",".join(k for k in need if k not in d))
' 2>/dev/null)"

case "$plan_keys" in
    OK) ok "loki plan --json emits complexity, cost and iterations as documented" ;;
    UNPARSEABLE) bad "loki plan --json did not emit parseable JSON" ;;
    *) bad "loki plan --json is missing documented fields (${plan_keys})" ;;
esac

# 4. LOKI_CONFIG_DUMP must exit cleanly WITHOUT starting a run. The whole
#    promise is "spend nothing", so this asserts the absence of run activity,
#    not merely a zero exit.
dump_out="$(cd "$WORK" && LOKI_CONFIG_DUMP=1 "$LOKI" start "$WORK/spec.md" </dev/null 2>&1 || true)"
dump_rc=$?

if [ "$dump_rc" -eq 0 ] && printf '%s' "$dump_out" | grep -q "LOKI_"; then
    ok "LOKI_CONFIG_DUMP=1 prints resolved config and exits 0"
else
    bad "LOKI_CONFIG_DUMP=1 did not print config and exit cleanly (rc=${dump_rc})"
fi

if printf '%s' "$dump_out" | grep -qiE "^(iteration [0-9]|starting RARV)"; then
    bad "LOKI_CONFIG_DUMP=1 appears to have STARTED a run -- it must spend nothing"
else
    ok "LOKI_CONFIG_DUMP=1 started no run"
fi

# 5. The issue-mode flags must still be forwarded. Two write-only locals
#    (issue_dry_run, issue_no_start) were removed as dead; the real plumbing is
#    issue_mode_args. They LOOKED load-bearing, so this asserts the flags are
#    still accepted rather than trusting the read.
for flag in --dry-run --no-start; do
    if printf '%s' "$help_out" | grep -q -- "$flag"; then
        ok "issue-mode ${flag} is still documented"
    else
        bad "issue-mode ${flag} disappeared from help"
    fi
done

if grep -q 'issue_mode_args+=("--dry-run")' "$LOKI"; then
    ok "--dry-run is still forwarded through issue_mode_args"
else
    bad "--dry-run is no longer forwarded to issue mode -- the flag is broken"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
