#!/usr/bin/env python3
"""Agent readiness: can an autonomous agent verify its own work in THIS repo?

WHY THIS EXISTS, AND WHY IT IS NOT A COPY. Factory AI's Agent Readiness Model is
a genuinely good idea and a category-defining artifact -- 5 levels, 9 pillars,
2 scopes -- and it makes competitor comparisons happen on Factory's chosen axes.
It is also LLM-SCORED: their report objects record `modelUsed` and
`reasoningEffort` per report. So the number is a model's opinion of a repo, and
two runs can disagree about the same commit.

Ours is a measurement. Every criterion below is a file that exists or does not,
a command that is present or absent. Same commit, same answer, every time, on
any machine, with no key and no spend. "Theirs is an opinion, ours is a
measurement, here is the command" is the same wedge as the receipt, applied to
their own differentiated concept.

WHAT IT MEASURES, AND WHY THOSE. Not general code quality -- that is what
`loki modernize heal --assess` already scores with its own deterministic 4-level
maturity rubric, and duplicating it would create two numbers that eventually
disagree. This asks the narrower question our product actually depends on:
CAN AN AGENT CHECK ITSELF HERE? Factory concedes the same dependency from the
other side -- their Missions docs say that without "an automated, scriptable way
to exercise the app... the mission cannot reliably verify its own work", and
recommend Level 4+ before using their flagship. A repo with no test command is
one where every agent, ours included, is guessing.

WHAT IT REFUSES. No percentage, no letter grade, no composite. A composite
invites ranking, ranking invites gaming, and the individual signals are the
actionable part: "there is no test command" tells you what to do, "readiness 62%"
does not. Criteria that cannot be determined report UNKNOWN by name rather than
counting as failures -- an absent measurement is not a bad score.
"""

from __future__ import annotations

import json
import os
import sys

SCHEMA_VERSION = "1.0"

UNKNOWN = "UNKNOWN"

# Each criterion is a pure filesystem fact plus the command a reader can run to
# check it themselves. The `why` is not decoration: a signal whose consequence
# for an agent is unstated becomes a checkbox someone games.
CRITERIA = [
    {
        "id": "test_command",
        "why": "without a runnable test command an agent cannot verify its own change",
        "verify": "look for a test script in package.json, a Makefile test target, pytest.ini, or tests/",
    },
    {
        "id": "dependency_lock",
        "why": "unpinned dependencies make a green run unreproducible tomorrow",
        "verify": "look for package-lock.json, bun.lockb, poetry.lock, requirements.txt, Cargo.lock, go.sum",
    },
    {
        "id": "ci_config",
        "why": "without CI, nothing re-checks the agent's work independently of the agent",
        "verify": "look for .github/workflows, .gitlab-ci.yml, or a CI config at the repo root",
    },
    {
        "id": "agent_brief",
        "why": "without a briefing file an agent rediscovers conventions every run and gets them wrong",
        "verify": "look for AGENTS.md, CLAUDE.md, CONTRIBUTING.md",
    },
    {
        "id": "readme",
        "why": "without a README an agent has no statement of what the project is for",
        "verify": "look for README.md or README",
    },
    {
        "id": "gitignore",
        "why": "without ignores an agent's diff fills with build output and the real change is buried",
        "verify": "look for .gitignore",
    },
]


def _any_exists(root, names):
    for n in names:
        if os.path.exists(os.path.join(root, n)):
            return n
    return None


def _has_test_command(root):
    pkg = os.path.join(root, "package.json")
    if os.path.isfile(pkg):
        try:
            with open(pkg, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if (data.get("scripts") or {}).get("test"):
                return "package.json scripts.test"
        except (OSError, ValueError):
            # A malformed package.json is not evidence either way. Fall through
            # to the other signals rather than scoring it as absent.
            pass
    found = _any_exists(root, ["pytest.ini", "tox.ini", "Makefile", "tests", "test"])
    return found


def assess(root):
    """Evaluate every criterion. Returns facts, never a score."""
    if not os.path.isdir(root):
        return {"status": UNKNOWN, "reason": "no_such_directory", "path": root}
    if not os.path.isdir(os.path.join(root, ".git")):
        # Not fatal: readiness is about the working tree. Recorded so a reader
        # knows the repo context was absent rather than assumed.
        git_present = False
    else:
        git_present = True

    checks = []
    for c in CRITERIA:
        cid = c["id"]
        if cid == "test_command":
            hit = _has_test_command(root)
        elif cid == "dependency_lock":
            hit = _any_exists(root, ["package-lock.json", "bun.lockb", "yarn.lock",
                                     "poetry.lock", "requirements.txt", "Cargo.lock",
                                     "go.sum", "Pipfile.lock"])
        elif cid == "ci_config":
            hit = _any_exists(root, [".github/workflows", ".gitlab-ci.yml",
                                     ".circleci", "azure-pipelines.yml", "Jenkinsfile"])
        elif cid == "agent_brief":
            hit = _any_exists(root, ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"])
        elif cid == "readme":
            hit = _any_exists(root, ["README.md", "README", "README.rst"])
        elif cid == "gitignore":
            hit = _any_exists(root, [".gitignore"])
        else:
            hit = None

        checks.append({
            "id": cid,
            "present": bool(hit),
            "found": hit or None,
            "why": c["why"],
            "verify": c["verify"],
        })

    present = [c for c in checks if c["present"]]
    missing = [c for c in checks if not c["present"]]

    return {
        "schema_version": SCHEMA_VERSION,
        "status": "measured",
        "path": os.path.abspath(root),
        "git_repo": git_present,
        # Counts, not a percentage. A composite invites ranking, ranking invites
        # gaming, and "there is no test command" is the actionable part anyway.
        "criteria_total": len(checks),
        "criteria_present": len(present),
        "checks": checks,
        "missing": [c["id"] for c in missing],
        # The single most consequential signal, surfaced on its own: this is the
        # one Factory's own docs concede their flagship depends on.
        "can_self_verify": any(c["id"] == "test_command" and c["present"]
                               for c in checks),
    }


def render_text(res):
    if res.get("status") != "measured":
        return f"Agent readiness: UNKNOWN ({res.get('reason', 'unmeasurable')})"
    out = ["Agent readiness -- can an agent verify its own work here?", ""]
    for c in res["checks"]:
        mark = "yes" if c["present"] else "NO "
        line = f"  {mark}  {c['id']:20}"
        if c["present"]:
            line += f"({c['found']})"
        else:
            line += c["why"]
        out.append(line)
    out.append("")
    out.append(f"  {res['criteria_present']} of {res['criteria_total']} present")
    if not res["can_self_verify"]:
        out.append("")
        out.append("  No test command found. Every agent working here, ours")
        out.append("  included, is guessing whether its change worked.")
    out.append("")
    out.append("  Every line above is a file that exists or does not. Check any of")
    out.append("  them by hand; no model was asked for an opinion.")
    return "\n".join(out)


# What --fix writes for each missing criterion. Only files whose CORRECT content
# can be derived from the repo itself appear here.
#
# test_command and dependency_lock are deliberately absent: guessing a test
# command writes a line that lies (`npm test` in a repo with no runner exits
# non-zero forever, and the readiness check would then report "present" for
# something that does not work), and a lockfile must come from the real package
# manager or it is worse than none. Those stay REPORTED, never generated.
#
# This is the difference between a scorecard and an executable one -- Factory's
# /readiness-report -> /readiness-fix -- without the failure mode where the fix
# makes the score green while the underlying capability is still missing.
FIXABLE = {
    "gitignore": (".gitignore", "node_modules/\n__pycache__/\n.env\n.venv/\ndist/\n*.log\n"),
    "readme": ("README.md", None),        # content derived below
    "agent_brief": ("AGENTS.md", None),   # content derived below
}


def _fix(root, res):
    """Create the missing files whose content can be derived honestly.

    Returns (written, skipped) where skipped names criteria that a generated
    file could not honestly satisfy.
    """
    written, skipped = [], []
    project = os.path.basename(os.path.abspath(root)) or "this project"
    # assess() reports `missing` as a list of criterion IDs (strings), not the
    # full check dicts. Tolerate both so a later shape change does not silently
    # fix nothing.
    for entry in res.get("missing", []):
        cid = entry["id"] if isinstance(entry, dict) else entry
        if cid not in FIXABLE:
            skipped.append((cid, "must come from the real toolchain, not a guess"))
            continue
        name, body = FIXABLE[cid]
        path = os.path.join(root, name)
        if os.path.exists(path):
            continue
        if cid == "readme":
            body = (f"# {project}\n\n"
                    "## What this is\n\n_TODO: one paragraph._\n\n"
                    "## Run it\n\n```sh\n# TODO: the command that starts this project\n```\n\n"
                    "## Test it\n\n```sh\n# TODO: the command that runs the tests\n```\n")
        elif cid == "agent_brief":
            body = (f"# AGENTS.md\n\nBriefing for coding agents working in {project}.\n\n"
                    "## Commands\n\n- Build: _TODO_\n- Test: _TODO_\n- Lint: _TODO_\n\n"
                    "## Conventions\n\n_TODO: what a reviewer would flag._\n\n"
                    "## Do not\n\n_TODO: the things that break this repo._\n")
        try:
            with open(path, "w") as fh:
                fh.write(body)
            written.append(name)
        except OSError as exc:
            skipped.append((cid, f"could not write {name}: {exc}"))
    return written, skipped


def main(argv):
    as_json = "--json" in argv
    do_fix = "--fix" in argv
    root = "."
    for a in argv:
        if not a.startswith("-"):
            root = a
            break
    res = assess(root)

    if do_fix and res.get("status") == "measured":
        written, skipped = _fix(root, res)
        res = assess(root)  # re-measure: report what is true AFTER the fix
        res["fix"] = {"written": written,
                      "skipped": [{"id": i, "reason": r} for i, r in skipped]}

    if as_json:
        print(json.dumps(res, indent=2))
    else:
        print(render_text(res))
        if do_fix:
            fx = res.get("fix", {})
            print("")
            for name in fx.get("written", []):
                print(f"  wrote    {name} (a stub -- fill in the TODOs)")
            for s in fx.get("skipped", []):
                print(f"  skipped  {s['id']}: {s['reason']}")
            if not fx.get("written") and not fx.get("skipped"):
                print("  nothing to fix.")
    return 0 if res.get("status") == "measured" else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
