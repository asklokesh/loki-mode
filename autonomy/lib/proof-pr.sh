#!/usr/bin/env bash
# proof-pr.sh -- shared, PRINT-ONLY Evidence Receipt renderer for PR bodies.
#
# LOAD-BEARING INVARIANT: this lib is pure and print-only. It NEVER runs
# `git push`, NEVER runs `gh pr create`, NEVER mutates the repo, NEVER posts a
# check-run. It reads ONLY the already-redacted proof.json passed to it (past the
# redaction chokepoint at proof-generator.py:1086) and prints a markdown block
# that gets appended into a PR body. It is the single source of truth sourced by
# autonomy/run.sh (the three create_session_pr / body-file / delegate PR sites)
# and autonomy/loki (cmd_github) so every PR surface renders a byte-identical,
# correct receipt and cannot drift. Mirrors the contract of git-pr-advisory.sh.
#
# HONESTY GATE (R-HON-1): the ONLY input that may produce a green/VERIFIED claim
# is honesty.headline == "VERIFIED" read from the redacted proof.json. The
# renderer NEVER recomputes a verdict, NEVER reads council/LLM opinion to turn
# green, NEVER infers VERIFIED from a bare pass.
#
# DETERMINISM (R-DET-2): when an expected_head_sha is supplied AND the proof is
# VERIFIED, the renderer cross-checks it against facts.git.head_sha; on mismatch
# it does NOT render green, it prints an honest "does not match this branch head"
# line. Production callers pass an empty expected_head_sha (the session commit at
# run.sh sits BETWEEN proof generation and PR creation, so the post-commit branch
# head is structurally offset from the proof's pre-commit head; feeding it would
# false-degrade every legitimate receipt). The anti-stale guarantee on the
# production path is R-DET-1: the persisted run_id pointer (.loki/state/
# last-proof-id.txt), not a head comparison. The R-DET-2 capability stays intact
# and is exercised by the SDET fixtures.
#
# set -e SAFE: this lib may be sourced under `set -uo pipefail` (run.sh) AND
# `set -euo pipefail` (loki). Every fallible command ends with `|| true` or sits
# in a guarded `if`; no bare `((..))`; every var defaulted with `${VAR:-}`;
# every optional tool is `command -v`-guarded. All print paths `return 0` so a
# sourced call cannot abort the caller under set -e.

# Double-source guard.
[ -n "${_PROOF_PR_SH:-}" ] && return 0
_PROOF_PR_SH=1

# render_evidence_receipt_md <proof_json_path> [expected_head_sha] [expected_base_sha]
# Prints the Evidence Receipt markdown block for a PR body. PRINT-ONLY: never
# pushes, never creates a PR, never mutates the repo. Always returns 0. A missing
# or unreadable proof prints ONE honest "unavailable" line and returns 0 so it
# can NEVER crash the caller or block PR creation.
#
# expected_base_sha is accepted for call-site symmetry but is intentionally
# unused for any green/red gate: the proof's base is a sha (_LOKI_ITER_START_SHA)
# while a PR base is a branch NAME, so a base comparison would misfire. The base
# is informational only and is printed from the proof itself.
render_evidence_receipt_md() {
    local proof_json_path="${1:-}"
    local expected_head_sha="${2:-}"
    local _expected_base_sha="${3:-}"
    : "$_expected_base_sha"

    # No python3 -> degrade honestly, never crash.
    if ! command -v python3 >/dev/null 2>&1; then
        printf '%s\n' "Evidence Receipt: unavailable for this run."
        return 0
    fi

    # Pass every input as argv (sys.argv), NEVER interpolated into the heredoc:
    # quote-safe and injection-safe against a hostile proof path. The heredoc
    # delimiter is quoted so bash performs no expansion inside the program.
    # Capture into a var so a non-zero python exit degrades honestly without a
    # brace group on the heredoc command (which bash mis-parses). The program
    # always handles its own errors and prints, so a non-zero exit is a last
    # resort (interpreter crash) -> print the single honest line.
    local _receipt_out=""
    local _receipt_rc=0
    _receipt_out="$(python3 - "$proof_json_path" "$expected_head_sha" <<'PROOF_PR_PY' 2>/dev/null
import json
import sys


def _line(s=""):
    sys.stdout.write(s + "\n")


def main():
    argv = sys.argv[1:]
    proof_path = argv[0] if len(argv) > 0 else ""
    expected_head = (argv[1] if len(argv) > 1 else "").strip()

    if not proof_path:
        _line("Evidence Receipt: unavailable for this run.")
        return 0
    try:
        with open(proof_path, "r") as f:
            proof = json.load(f)
    except Exception:
        _line("Evidence Receipt: unavailable for this run.")
        return 0
    if not isinstance(proof, dict):
        _line("Evidence Receipt: unavailable for this run.")
        return 0

    honesty = proof.get("honesty")
    honesty = honesty if isinstance(honesty, dict) else {}
    headline = str(honesty.get("headline") or "").strip()
    if not headline:
        _line("Evidence Receipt: unavailable for this run.")
        return 0

    facts = proof.get("facts")
    facts = facts if isinstance(facts, dict) else {}
    git = facts.get("git") if isinstance(facts.get("git"), dict) else {}
    tests = facts.get("tests") if isinstance(facts.get("tests"), dict) else {}
    build = facts.get("build") if isinstance(facts.get("build"), dict) else {}
    security = facts.get("security") if isinstance(facts.get("security"), dict) else {}
    cost = facts.get("cost") if isinstance(facts.get("cost"), dict) else {}
    meta = facts.get("meta") if isinstance(facts.get("meta"), dict) else {}

    diff = git.get("diff") if isinstance(git.get("diff"), dict) else {}
    diff_count = diff.get("count")
    diff_sha = str(git.get("diff_sha256") or "")
    base_sha = str(git.get("base_sha") or "")
    head_sha = str(git.get("head_sha") or "")

    # run_id: prefer facts.meta.run_id, fall back to the top-level mirror.
    run_id = str(meta.get("run_id") or proof.get("run_id") or "").strip()

    # R-DET-2 cross-check. Only a supplied expected_head AND a VERIFIED headline
    # can trigger it. On mismatch we do NOT print a VERIFIED banner; we print an
    # honest line so a stale / wrong-run proof fails safe, never fake-green.
    head_mismatch = (
        bool(expected_head)
        and headline == "VERIFIED"
        and head_sha != ""
        and head_sha != expected_head
    )

    # ---- Render -----------------------------------------------------------
    _line("### Evidence Receipt")
    _line()

    if head_mismatch:
        _line(
            "Evidence Receipt: available but does not match this branch head "
            "(proof head " + (head_sha or "(none)")
            + ", branch head " + (expected_head or "(none)") + "). Run "
            "`loki proof verify " + (run_id or "<run_id>") + "` to inspect."
        )
        _line()
        # Fall through: still render facts + verify-yourself so the reviewer can
        # check, but emit NO green headline label.
        effective_headline = ""
    else:
        # Headline mapped 1:1 from honesty.headline. Plain text label, NO color
        # codes -- this goes into a PR body. R-HON-1: only VERIFIED is green.
        effective_headline = headline
        _line("Headline: " + headline)
        _line()

    # Facts table. Deterministic, non-LLM facts a skeptic can recompute.
    def _stat(d):
        s = str(d.get("status") or "").strip()
        return s if s else "not_run"

    tests_cell = _stat(tests)
    tests_cmd = str(tests.get("command") or "").strip()
    if tests_cmd:
        tests_cell = tests_cell + " (`" + tests_cmd + "`)"
    build_cell = _stat(build)
    build_cmd = str(build.get("command") or "").strip()
    if build_cmd:
        build_cell = build_cell + " (`" + build_cmd + "`)"

    sec_cell = _stat(security)
    if security.get("ran"):
        ha = security.get("high_active") or 0
        try:
            ha = int(ha)
        except Exception:
            ha = 0
        if ha > 0:
            sec_cell = sec_cell + " (" + str(ha) + " un-waived HIGH)"

    cost_usd = cost.get("usd")
    cost_cell = "not recorded" if cost_usd is None else ("$" + str(cost_usd))

    files_cell = "0" if diff_count is None else str(diff_count)

    _line("| Fact | Value |")
    _line("| --- | --- |")
    _line("| Files changed | " + files_cell + " |")
    _line("| Diff sha256 | `" + (diff_sha or "(none)") + "` |")
    _line("| Tests | " + tests_cell + " |")
    _line("| Build | " + build_cell + " |")
    _line("| Security | " + sec_cell + " |")
    _line("| Cost | " + cost_cell + " |")
    _line("| Base sha | `" + (base_sha or "(none)") + "` |")
    _line("| Head sha | `" + (head_sha or "(none)") + "` |")
    _line()

    # Gaps: when headline != VERIFIED, list honesty.degraded[] verbatim. By
    # _compute_degraded design an empty list with a non-VERIFIED headline is
    # impossible, but guard anyway (R-HON-2).
    if effective_headline != "VERIFIED":
        degraded = honesty.get("degraded")
        degraded = degraded if isinstance(degraded, list) else []
        if degraded:
            _line("Not yet verified:")
            for d in degraded:
                if not isinstance(d, dict):
                    continue
                item = str(d.get("item") or "").strip()
                status = str(d.get("status") or "").strip()
                reason = str(d.get("reason") or "").strip()
                _line(
                    "- " + (item or "(item)")
                    + ": " + (status or "(status)")
                    + (" -- " + reason if reason else "")
                )
            _line()

    # Verify-yourself block. ALWAYS rendered, even on NOT VERIFIED -- the whole
    # point is that the reviewer can recompute the verdict and does not have to
    # trust Loki.
    _line("You do not have to trust this. Verify it yourself:")
    _line()
    _line("```")
    _line(
        "loki proof verify " + (run_id or "<run_id>")
        + "  (base " + (base_sha or "(none)") + ")"
    )
    _line("```")
    _line()

    # What the headline means: a first-time reviewer must understand that
    # VERIFIED WITH GAPS is honest, not a failure.
    _line(
        "What the headline means: VERIFIED means every recorded check passed; "
        "VERIFIED WITH GAPS means the checks that ran passed but some checks "
        "were not run (listed above); NOT VERIFIED means a check failed or "
        "nothing could be verified. The headline is computed only from "
        "deterministic, re-derivable facts, never from an AI opinion."
    )
    return 0


sys.exit(main())
PROOF_PR_PY
    )" || _receipt_rc=$?

    if [ "$_receipt_rc" != "0" ] || [ -z "$_receipt_out" ]; then
        printf '%s\n' "Evidence Receipt: unavailable for this run."
        return 0
    fi
    printf '%s\n' "$_receipt_out"
    return 0
}
