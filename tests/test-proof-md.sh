#!/usr/bin/env bash
# `loki proof md <id>` emits paste-able Markdown on stdout, reusing the PR-body
# renderer rather than a second one.
#
# WHY THIS EXISTS. Every prompt-to-app competitor hands the user a live URL --
# Lovable publishes to [name].lovable.app and it works even at zero credit
# balance. That URL is the word-of-mouth mechanic: it goes in a Slack message to
# someone who never installs anything. A CLI structurally cannot do that.
#
# What we have instead is an artifact THEY do not: their verification output is
# ephemeral and lives in their dashboard (Lovable's is an in-dialog findings
# count; Claude Code's check run "never blocks merging"). Ours is a file.
#
# The renderer for the human-forwardable form ALREADY EXISTED --
# render_evidence_receipt_md in lib/proof-pr.sh -- but was reachable only when
# Loki opened a PR itself. The one form built for humans to forward could not be
# produced on demand. That is the built-and-unreachable pattern this project
# keeps finding (43 of 112 commands were missing from `loki help` for the same
# reason).
#
# ONE RENDERER, NOT TWO. Two writers of one artifact drift, and the drift shows
# up as a PR body and a pasted summary disagreeing about the same run.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# BOTH ROUTES, and this is the assertion that was missing. The first version of
# this test drove autonomy/loki directly and passed, while `loki proof md` --
# what a real user types -- answered "Unknown subcommand" on the DEFAULT (Bun)
# route. The feature shipped in v8.6.0 unreachable for most users.
#
# bin/loki is the Bun route; LOKI_LEGACY_BASH=1 selects bash. Same invocation
# the bun-parity workflow uses.
SHIM="$REPO_ROOT/bin/loki"

# 1. Reuse, not reimplementation. Asserted on the source: if a second renderer
#    appears, this is where it should be noticed.
if grep -q "render_evidence_receipt_md" "$LOKI"; then
    ok "proof md calls the shared PR-body renderer"
else
    bad "proof md does not use render_evidence_receipt_md -- a second renderer will drift"
fi

# 2. Documented. An artifact nobody can find is the failure being fixed here.
help_out="$("$LOKI" proof --help </dev/null 2>&1 || true)"
case "$help_out" in
    *"md <id>"*) ok "'md' is listed in proof --help" ;;
    *) bad "'md' is undocumented -- unreachable in practice" ;;
esac

# 3. Error paths, distinguishable. A missing ARGUMENT and a missing PROOF are
#    different mistakes and must not share an exit code.
"$LOKI" proof md </dev/null >/dev/null 2>&1
rc_noarg=$?
"$LOKI" proof md definitely-not-a-real-proof-id </dev/null >/dev/null 2>&1
rc_missing=$?

if [ "$rc_noarg" -eq 2 ]; then
    ok "missing id exits 2 (usage error)"
else
    bad "missing id exited ${rc_noarg}, expected 2"
fi
if [ "$rc_missing" -eq 1 ]; then
    ok "unknown proof id exits 1 (not found)"
else
    bad "unknown proof id exited ${rc_missing}, expected 1"
fi

# 4. Against a REAL receipt if this repo has one. Skipped rather than faked
#    when it does not -- a synthetic proof.json would test the fixture, not the
#    renderer.
proofs_dir="$REPO_ROOT/.loki/proofs"
id=""
[ -d "$proofs_dir" ] && id="$(ls "$proofs_dir" 2>/dev/null | head -1)"

if [ -z "$id" ] || [ ! -f "$proofs_dir/$id/proof.json" ]; then
    printf 'SKIP: no receipt in this checkout to render\n'
else
    out="$("$LOKI" proof md "$id" </dev/null 2>/dev/null || true)"

    case "$out" in
        "### Evidence Receipt"*) ok "stdout begins with the Markdown heading (pipeable)" ;;
        *) bad "stdout is not clean Markdown: $(printf '%s' "$out" | head -c 60)" ;;
    esac

    # The receipt must carry the diff binding. Without it the artifact is a
    # claim about nothing in particular, which is exactly what makes a
    # competitor's dashboard number unforwardable.
    if printf '%s' "$out" | grep -q "Diff sha256"; then
        ok "includes the diff_sha256 binding"
    else
        bad "no diff binding -- the artifact is not tied to a specific change"
    fi

    # THE HONESTY PROPERTY, and the reason this is worth forwarding at all. A
    # receipt that only reports good news is marketing, and nobody forwards
    # marketing. Gaps must be visible in the pasted form, not just the JSON.
    if printf '%s' "$out" | grep -qE "not_run|not recorded|NOT VERIFIED|WITH GAPS|VERIFIED"; then
        ok "states the headline and surfaces gaps verbatim"
    else
        bad "the pasted form hides what was not proven"
    fi
fi

# 5. THE ASSERTION THAT WAS MISSING. A user types `loki proof md`, which is the
#    shim, which defaults to the Bun route. Testing autonomy/loki alone passed
#    while the default route answered "Unknown subcommand" -- the feature
#    shipped unreachable. Drive the shim exactly as a user would.
if [ -x "$SHIM" ]; then
    "$SHIM" proof md </dev/null >/dev/null 2>&1
    shim_noarg=$?
    if [ "$shim_noarg" -eq 2 ]; then
        ok "default route: missing id exits 2 (subcommand is wired)"
    else
        bad "default route: 'proof md' exited ${shim_noarg} -- likely Unknown subcommand"
    fi

    if [ -n "$id" ] && [ -f "$proofs_dir/$id/proof.json" ]; then
        bun_out="$("$SHIM" proof md "$id" </dev/null 2>/dev/null || true)"
        bash_out="$(LOKI_LEGACY_BASH=1 "$SHIM" proof md "$id" </dev/null 2>/dev/null || true)"

        case "$bun_out" in
            "### Evidence Receipt"*) ok "default route emits the receipt Markdown" ;;
            *) bad "default route produced no usable Markdown" ;;
        esac

        # ONE RENDERER means the routes cannot disagree. If they ever do, a
        # second implementation has appeared somewhere.
        if [ "$bun_out" = "$bash_out" ]; then
            ok "both routes emit byte-identical Markdown"
        else
            bad "routes DIVERGE -- a second renderer has appeared"
        fi
    fi
else
    printf 'SKIP: bin/loki shim not executable here\n'
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
