#!/usr/bin/env python3
"""Turn a `loki doctor --json` report into an ordered remediation plan.

WHY THIS EXISTS. `loki doctor` tells you WHAT is broken. It does not tell you
what to type. On a bare machine the report names two blockers and the user is
left to work out the commands and the ORDER themselves -- and the order is not
obvious: doctor's own fix for a missing provider is
`npm install -g @anthropic-ai/claude-code`, which cannot run until Node.js is
installed, and Node.js is the OTHER blocker. Handing someone two commands in
report order makes the first one fail.

WHAT IT REFUSES TO DO, and this is the actual product:

  1. It never invents a command. A blocker with no remedy we can justify is
     printed as "no automated fix known", verbatim and unadorned. A wrong
     command is strictly worse than no command: the user runs it, it succeeds
     at doing something irrelevant, and now they trust a broken system. Every
     remedy here is either lifted from the report's own text or from a table
     whose provenance is cited below.
  2. It never executes. It prints. `loki doctor` is a read-only diagnosis and
     so is this; the human runs the commands.
  3. It never reads an empty result as success. Zero derived blockers means
     "healthy" ONLY when the input actually parsed as a doctor report -- see
     the vacuity guard in plan().

PROVENANCE OF EVERY REMEDY. Nothing here is a parallel table invented to sit
alongside the repo's existing knowledge:

  - Provider install commands come from the report itself. `ai_provider.detail`
    carries the literal string "No AI provider CLI. Fix: npm install -g
    @anthropic-ai/claude-code" (written at autonomy/loki:11519 for the text
    path and in cmd_doctor_json for --json). We PARSE that "Fix:" rather than
    restating it, so doctor stays the single source of truth: change the
    command there and this follows automatically.
  - _TOOL_FIXES is MIXED provenance, and the split is stated per entry in the
    table itself rather than summarised here, because "derived from the repo"
    and "conventional package-manager command" are different strengths of
    claim and this file exists to keep them apart:
      SOURCED   `brew install python3` (autonomy/loki:500), `brew install jq`
                (:552), and `https://nodejs.org` (autonomy/provider-offer.sh:321)
                are the commands the CLI already prints for these same tools.
                Duplicated rather than imported because they live in bash
                `echo` statements inside cmd_* functions.
      UNSOURCED `brew install node`, `brew install git`, `brew install curl`
                and every `apt-get install ...` appear NOWHERE else in this
                repo. They are the standard invocations for these packages,
                not something doctor told us. They are included because they
                are the ordinary, verifiable way to install these tools -- but
                do not read them as repo-derived, and if one is ever wrong the
                fault is here, not upstream.
  - Auth remedies are deliberately ABSENT. `cmd_why`'s PROVIDER_AUTH map
    (autonomy/loki:4185) keys on a LAST_ERROR error_class, which is a
    different axis entirely -- `loki doctor --json` has no auth blocker to map
    from. Manufacturing one so this tool could show off an ordering
    dependency would be exactly the fabrication requirement 1 forbids.

INPUT CONTRACT. Blockers are DERIVED, not read: `doctor --json` emits no
blocker list (that string is built only in the text path, autonomy/loki:11367).
Anything with status "fail" is a blocker, and failable things live in three
places -- `checks[]`, plus the siblings `ai_provider` and `disk`. The advisory
siblings (`sentrux`, `receipt_signing`, `memory`, `model_catalog`) are never
"fail" by construction and are not scanned.

KNOWN LIMITATION, stated rather than papered over: the text path reports two
blockers that have NO representation in --json at all -- a broken skill symlink
(autonomy/loki:11636) and missing quality-gate detectors (:11968). This tool
cannot see them, because the JSON it consumes does not carry them. It handles
them if they ever appear as blocker text, but it cannot derive them today.
"""

import argparse
import json
import re
import sys

# Prerequisite ordering. Lower rank runs first. The only edges asserted are
# ones with a real causal dependency, because a fabricated ordering is the same
# class of lie as a fabricated command.
#
#   disk (0)      -- every remedy below writes files; no space means they all fail.
#   runtime (1)   -- node/python3 are what the package managers RUN.
#   tool (2)      -- jq/git/curl: independent, but cheap and unblocking.
#   provider (3)  -- MUST follow runtime: doctor's own provider fix is
#                    `npm install -g ...`, and npm ships with Node.js. On the
#                    real capture that produced this file, Node.js and the
#                    provider were both blockers simultaneously.
#   unknown (9)   -- last: we cannot reason about what we cannot identify.
_RANK = {"disk": 0, "runtime": 1, "tool": 2, "provider": 3, "unknown": 9}

# Per-tool remedies, keyed on doctor's own `name` field. A tool ABSENT from
# this table gets an honest "no known fix" -- never a guess. Adding a row is
# therefore the one place fabrication can enter this file, so each row is
# tagged with where its command came from:
#   [repo]  this exact command is printed elsewhere in loki-mode (line cited)
#   [conv]  conventional package-manager invocation, NOT found in this repo
# If you add a row, tag it. An untagged row is an unaudited claim.
_TOOL_FIXES = {
    # [repo] https://nodejs.org -- autonomy/provider-offer.sh:321. [conv] brew install node.
    "Node.js": ("runtime", "Install Node.js 18+: brew install node    (macOS)  |  https://nodejs.org"),
    # [repo] autonomy/loki:500.
    "Python 3": ("runtime", "Install Python 3.8+: brew install python3    (macOS)"),
    # [repo] brew arm -- autonomy/loki:552. [conv] apt-get arm.
    "jq": ("tool", "brew install jq    (macOS)  |  apt-get install jq    (Debian/Ubuntu)"),
    # [conv] both arms.
    "git": ("tool", "brew install git    (macOS)  |  apt-get install git    (Debian/Ubuntu)"),
    # [conv] both arms.
    "curl": ("tool", "brew install curl    (macOS)  |  apt-get install curl    (Debian/Ubuntu)"),
}

_NO_FIX = "no automated fix known for this blocker -- diagnose manually, then re-run: loki doctor"

# doctor embeds its own remedy as "Fix: <cmd>" or "Reinstall: <cmd>". Parsing it
# keeps doctor authoritative instead of duplicating the command here.
_EMBEDDED_FIX = re.compile(r"(?:Fix|Reinstall):\s*(.+?)\s*$")


def _embedded_fix(text):
    """Return the command doctor embedded in its own blocker text, else None.

    None is a real answer, not a failure to try: it routes the blocker to the
    honest no-fix path instead of to a guess.
    """
    if not text:
        return None
    m = _EMBEDDED_FIX.search(str(text).strip())
    return m.group(1) if m else None


def derive_blockers(report):
    """Every status=="fail" item in a doctor report, as (id, category, title, fix).

    fix is None when we have no justified remedy. Callers MUST render None as
    the no-fix line rather than substituting anything.
    """
    out = []
    if not isinstance(report, dict):
        return out

    for chk in report.get("checks") or []:
        if not isinstance(chk, dict) or chk.get("status") != "fail":
            continue
        name = str(chk.get("name") or "unknown check")
        # Distinguish absent from too-old: same blocker name, different user
        # experience, and doctor already knows which it is.
        if chk.get("found") and chk.get("min_version"):
            title = "%s is older than the required %s (found %s)" % (
                name, chk["min_version"], chk.get("version") or "unknown")
        else:
            title = "%s is not installed" % name
        category, fix = _TOOL_FIXES.get(name, ("unknown", None))
        out.append((name, category, title, fix))

    ai = report.get("ai_provider")
    if isinstance(ai, dict) and ai.get("status") == "fail":
        detail = ai.get("detail")
        # Reuse doctor's embedded command; do not restate it.
        out.append(("ai_provider", "provider",
                    "No AI provider CLI installed (at least one is required)",
                    _embedded_fix(detail)))

    disk = report.get("disk")
    if isinstance(disk, dict) and disk.get("status") == "fail":
        gb = disk.get("available_gb")
        avail = "unknown" if gb is None else "%sGB" % gb
        out.append(("disk", "disk",
                    "Insufficient disk space (%s available, need >= 1GB)" % avail,
                    "Free at least 1GB on your home volume, then re-run: loki doctor"))

    return out


def plan(report):
    """Ordered remediation plan for a doctor report.

    Returns a dict with `status` in {healthy, action_required, not_a_report}
    and `steps`. The three-way status is the vacuity guard: an empty blocker
    list means HEALTHY only if the input was recognisably a doctor report.
    `{}` on stdin also yields zero blockers, and calling that healthy would be
    the exact fake-green this repo exists to refuse.
    """
    if not isinstance(report, dict) or not (
            "checks" in report or "summary" in report or "ai_provider" in report):
        return {
            "status": "not_a_report",
            "executed": False,
            "steps": [],
            "note": "Input is not a loki doctor report (no checks/summary/ai_provider). "
                    "Produce one with: loki doctor --json",
        }

    blockers = derive_blockers(report)
    steps = []
    for i, (bid, category, title, fix) in enumerate(
            sorted(blockers, key=lambda b: (_RANK.get(b[1], 9), b[0]))):
        steps.append({
            "order": i + 1,
            "id": bid,
            "category": category,
            "blocker": title,
            "command": fix,
            "fix_known": fix is not None,
        })

    result = {
        "status": "healthy" if not steps else "action_required",
        "executed": False,
        "steps": steps,
    }

    # Cross-check derivation against doctor's own tally. If doctor counted
    # failures we could not turn into blockers, the gap is OURS -- say so,
    # rather than reporting a short plan as a complete one.
    summary = report.get("summary")
    if isinstance(summary, dict):
        failed = summary.get("failed")
        if isinstance(failed, int) and failed > len(blockers):
            result["parse_gap"] = (
                "doctor reported %d failing checks but only %d could be mapped to a "
                "blocker; the remainder are not represented in this plan" % (failed, len(blockers)))
    return result


def render(p):
    """Human-readable plan. Mirrors plan() exactly -- no extra claims."""
    lines = []
    if p["status"] == "not_a_report":
        lines.append("Cannot plan: %s" % p["note"])
        return "\n".join(lines)

    if p["status"] == "healthy":
        lines.append("System is healthy -- loki doctor reported no blockers.")
        lines.append("Nothing to remediate. Start a build: loki start <spec>")
        return "\n".join(lines)

    n = len(p["steps"])
    lines.append("Remediation plan -- %d blocker%s, in order (prerequisites first)."
                 % (n, "" if n == 1 else "s"))
    lines.append("These commands are NOT run for you. Copy, review, then run them yourself.")
    lines.append("")
    for s in p["steps"]:
        lines.append("%d. %s" % (s["order"], s["blocker"]))
        lines.append("   %s" % (s["command"] if s["fix_known"] else _NO_FIX))
        lines.append("")
    if p.get("parse_gap"):
        lines.append("Note: %s" % p["parse_gap"])
        lines.append("")
    lines.append("Then re-run: loki doctor")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="doctor-fix.py",
        description="Plan (never run) the fixes for a `loki doctor --json` report.")
    ap.add_argument("--report", help="doctor JSON file; defaults to stdin")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the plan as JSON")
    args = ap.parse_args(argv)

    raw = open(args.report, encoding="utf-8").read() if args.report else sys.stdin.read()
    try:
        report = json.loads(raw)
    except (ValueError, TypeError):
        # Unparseable input is not "healthy" and not a blocker list either.
        report = None

    p = plan(report)
    if args.as_json:
        print(json.dumps(p, indent=2))
    else:
        print(render(p))
    # Exit 1 on action_required so this is CI-gateable, matching doctor's own
    # convention. not_a_report is exit 2: a broken input is not a clean bill of
    # health and must never be mistaken for one.
    return {"healthy": 0, "action_required": 1, "not_a_report": 2}[p["status"]]


if __name__ == "__main__":
    sys.exit(main())
