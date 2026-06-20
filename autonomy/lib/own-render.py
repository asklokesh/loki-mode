#!/usr/bin/env python3
"""Finish-and-own renderer for Loki Mode (Loop 5, v7.88.0).

A PURE render layer over EXISTING honest data. It reads the artifacts the
runner already wrote (the Evidence Receipt proof.json, completion.json,
USAGE.md, the app-runner state, the assumptions ledger) and restates them in
plain English for a NON-technical founder.

Design rules (LOOP5-FINISH-AND-OWN-PLAN.md):
  - NEVER recompute or fabricate. Every line maps to a real artifact value.
  - The "Is it working?" verdict is taken VERBATIM from honesty.headline.
    Green ("ready") is gated on headline == "VERIFIED" AND tests passed AND
    the build ran. This honesty gate is the core of the lib.
  - Tolerant of missing artifacts: each one absent is marked honestly rather
    than guessed at.
  - No LLM call here (keep it pure / deterministic / testable). The "What you
    have now" paragraph is a deterministic template over the recorded brief +
    diff stat. No invented features.
  - Exit 0 always: this is a report, never a gate.

CLI:
  python3 autonomy/lib/own-render.py [--loki-dir .loki] [--md|--json]
"""

import argparse
import json
import os
import sys


# ---------------------------------------------------------------------------
# tolerant readers
# ---------------------------------------------------------------------------

def _read_json(path, default=None):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return default


def _read_text(path, default=""):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read()
    except Exception:
        return default


def _latest_proof(loki_dir):
    """Return (run_id, proof_dict) for the most recent proof, or (None, None).

    Proof run dirs are named with a timestamp prefix (YYYYmmddTHHMMSSZ-...),
    so a lexicographic sort puts the newest last. We pick the newest dir that
    actually contains a readable proof.json.
    """
    proofs_dir = os.path.join(loki_dir, "proofs")
    try:
        entries = sorted(os.listdir(proofs_dir))
    except Exception:
        return None, None
    for run_id in reversed(entries):
        proof = _read_json(os.path.join(proofs_dir, run_id, "proof.json"))
        if isinstance(proof, dict):
            return run_id, proof
    return None, None


def _live_url(loki_dir):
    """Return the live app URL only when the app runner reports it running."""
    state = _read_json(os.path.join(loki_dir, "app-runner", "state.json"))
    if isinstance(state, dict) and state.get("status") == "running":
        url = str(state.get("url") or "").strip()
        if url:
            return url
    return ""


def _usage_section(usage_text, header):
    """Pull the body of a '## <header>' section from USAGE.md, verbatim.

    Returns the lines under the matching heading up to the next '## ' heading,
    trimmed of blank edges. Empty string when the section is absent.
    """
    if not usage_text:
        return ""
    lines = usage_text.splitlines()
    out = []
    capturing = False
    want = header.strip().lower()
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("## "):
            if capturing:
                break
            name = stripped[3:].strip().lower()
            # Match on a prefix so "## Verify (it works)" matches "Verify".
            capturing = name == want or name.startswith(want + " ") \
                or name.startswith(want + " (")
            continue
        if capturing:
            out.append(line)
    # Trim leading/trailing blank lines.
    while out and not out[0].strip():
        out.pop(0)
    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out)


def _strip_md_fences(text):
    """Remove markdown code-fence lines (``` or ```lang) from a USAGE.md section
    body. USAGE.md already wraps commands in fenced blocks; own re-wraps each
    section in ONE fence, so leaving the inner fences in produces nested,
    broken-rendering ``` inside ``` for the non-technical reader. We drop the
    fence delimiter lines but keep the content + prose between them verbatim."""
    if not text:
        return ""
    kept = []
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            continue  # drop the fence delimiter line itself
        kept.append(line)
    # Re-trim blank edges left behind after removing fences.
    while kept and not kept[0].strip():
        kept.pop(0)
    while kept and not kept[-1].strip():
        kept.pop()
    return "\n".join(kept)


# ---------------------------------------------------------------------------
# honesty gate (the core)
# ---------------------------------------------------------------------------

def _is_ready(proof):
    """Deterministic green gate. True ONLY when:
      - honesty.headline == "VERIFIED", AND
      - facts.tests.status in (passed, verified), AND
      - the build actually ran (facts.build.ran true / status not 'not_run').

    Any one missing -> not ready. This is the line that must never overclaim.
    """
    if not isinstance(proof, dict):
        return False
    honesty = proof.get("honesty") or {}
    if str(honesty.get("headline") or "").strip().upper() != "VERIFIED":
        return False
    facts = proof.get("facts") or {}
    tests = facts.get("tests") or {}
    if str(tests.get("status") or "").strip().lower() not in ("passed", "verified"):
        return False
    build = facts.get("build") or {}
    build_ran = bool(build.get("ran")) or \
        str(build.get("status") or "").strip().lower() not in ("not_run", "", "none")
    return build_ran


# ---------------------------------------------------------------------------
# section builders (markdown). Each returns a list of lines.
# ---------------------------------------------------------------------------

def _section_what_you_have(proof):
    """1. 'What you have now' - product-terms restatement of the brief + diff.

    Deterministic template only: the recorded brief verbatim plus a one-line
    files-changed summary. No invented features, no LLM call.
    """
    lines = ["## What you have now", ""]
    spec = (proof or {}).get("spec") or {}
    brief = str(spec.get("brief") or "").strip()
    if brief:
        # Restate the brief as the description of what was built. Quote it so the
        # reader sees it is their own words, not a Loki claim.
        first = brief.splitlines()[0].strip()
        lines.append("You asked Loki to build this:")
        lines.append("")
        lines.append("> " + first)
    else:
        lines.append("Loki worked directly on an existing codebase here (no written "
                     "spec was recorded for this run).")
    lines.append("")

    facts = (proof or {}).get("facts") or {}
    git = facts.get("git") or {}
    diff = git.get("diff") or (proof or {}).get("files_changed") or {}
    count = diff.get("count") or 0
    ins = diff.get("insertions") or 0
    dele = diff.get("deletions") or 0
    if count:
        lines.append("It changed %d file%s (%d lines added, %d removed)."
                     % (count, "" if count == 1 else "s", ins, dele))
    else:
        lines.append("No file changes were recorded for this run.")
    return lines


def _build_age_note(run_id):
    """An honest 'this verdict describes the build at <when>' line + a pointer to
    re-verify against current code. A non-technical owner must not read an old
    receipt as a statement about code they edited since the build."""
    lines = []
    when = _run_id_when(run_id)
    if when:
        lines.append("This describes the build Loki finished on %s. If you (or a "
                     "developer) changed the code after that, this verdict is about "
                     "the older version, not your current files." % when)
    else:
        lines.append("This describes the last build Loki finished. If the code "
                     "changed since then, this verdict is about the older version.")
    if run_id:
        lines.append("To confirm it still matches your current code, run: "
                     "`loki proof verify %s`" % run_id)
    return lines


def _run_id_when(run_id):
    """Format a human date from a proof run_id (YYYYmmddTHHMMSSZ-...). Returns ''
    if the id is not in that shape (no fabrication -- only restate what is there)."""
    if not run_id:
        return ""
    stamp = str(run_id).split("-", 1)[0]
    # Expect YYYYmmddTHHMMSSZ
    if len(stamp) >= 16 and stamp[8:9] == "T" and stamp[15:16] == "Z":
        y, mo, d = stamp[0:4], stamp[4:6], stamp[6:8]
        hh, mm = stamp[9:11], stamp[11:13]
        if y.isdigit() and mo.isdigit() and d.isdigit():
            return "%s-%s-%s at %s:%s UTC" % (y, mo, d, hh, mm)
    return ""


def _verdict_translation(proof):
    """A one-sentence plain-language translation of the honesty verdict for a
    non-technical owner. Honesty gate is sacred here:

      - ready (_is_ready True)  -> a true, non-overclaiming positive line.
      - partial ("VERIFIED ..." headline that is NOT a clean pass, e.g.
        "VERIFIED WITH GAPS") -> "the code is there and it builds, but Loki
        could not fully prove it works - see what is unverified below."
      - everything else (NOT VERIFIED, missing/unknown headline) -> a plain,
        NON-reassuring statement. NEVER softened into something comforting.

    Returns '' when there is nothing safe to add (we never invent reassurance).
    """
    headline = str(((proof or {}).get("honesty") or {}).get("headline")
                   or "").strip().upper()
    if _is_ready(proof):
        return ("In plain terms: Loki built what you asked for and checked that "
                "it works.")
    # Partial verification: the build produced something Loki could confirm
    # partially, but not fully. Gated on the headline AFFIRMING verification
    # (starts with VERIFIED) while NOT being a clean ready pass. "NOT VERIFIED"
    # starts with "NOT" so it can never reach this branch.
    if headline.startswith("VERIFIED"):
        return ("In plain terms: the code is there and the build ran, but Loki "
                "could not fully prove it works - see what is unverified below.")
    # No affirmative verification at all. State it plainly, do not reassure.
    return ("In plain terms: Loki could not confirm this build works. Treat it "
            "as unfinished until the gaps below are resolved.")


def _section_is_it_working(proof, run_id=None):
    """2. 'Is it working?' - VERBATIM honesty.headline gating.

    Green only when _is_ready(). Otherwise plainly states what was not verified
    and lists honesty.degraded[]. NEVER prints a ready/ship line unless ready.
    Always dates the verdict + points to re-verify, so a stale receipt is never
    read as current truth.
    """
    lines = ["## Is it working?", ""]
    honesty = (proof or {}).get("honesty") or {}
    headline = str(honesty.get("headline") or "").strip()
    degraded = honesty.get("degraded") or []

    if _is_ready(proof):
        lines.append("Yes. Loki verified this build: the tests passed and the "
                     "build ran cleanly.")
        lines.append("")
        lines.append(_verdict_translation(proof))
        lines.append("")
        lines.append("Verdict (Loki's honest receipt): %s" % (headline or "VERIFIED"))
        lines.append("")
        lines.extend(_build_age_note(run_id))
        return lines

    # Not ready. State the verdict plainly and list every gap.
    if headline:
        lines.append("Not fully verified. Loki's honest verdict for this run is: "
                     "%s" % headline)
    else:
        lines.append("Not verified. Loki did not record a verdict for this run.")
    lines.append("")
    lines.append(_verdict_translation(proof))
    lines.append("")
    lines.append("This means Loki is NOT telling you it is ready to ship. Here is "
                 "what was not verified:")
    lines.append("")
    if isinstance(degraded, list) and degraded:
        for d in degraded:
            if isinstance(d, dict):
                item = str(d.get("item") or "").strip() or "(unnamed check)"
                status = str(d.get("status") or "").strip()
                reason = str(d.get("reason") or "").strip()
                bits = [b for b in (status, reason) if b]
                tail = (" - " + "; ".join(bits)) if bits else ""
                lines.append("- %s%s" % (item, tail))
            else:
                lines.append("- %s" % str(d))
    else:
        lines.append("- (no specific gaps were itemized, but the verdict above is "
                     "not a clean pass)")
    lines.append("")
    lines.extend(_build_age_note(run_id))
    return lines


def _section_run_on_computer(proof, usage_text, live_url):
    """3. 'How to run it on your computer' - quote Start/Verify from USAGE.md."""
    lines = ["## How to run it on your computer", ""]
    if live_url:
        lines.append("It is running right now on this machine at: %s" % live_url)
        lines.append("")
    # Strip USAGE.md's own ``` fences so each section is wrapped exactly once
    # below (otherwise nested fences render broken for the non-dev reader).
    start = _strip_md_fences(_usage_section(usage_text, "Start"))
    verify = _strip_md_fences(_usage_section(usage_text, "Verify"))
    install = _strip_md_fences(_usage_section(usage_text, "Install"))
    if install:
        lines.append("First, install it:")
        lines.append("")
        lines.append("```")
        lines.append(install)
        lines.append("```")
        lines.append("")
    if start:
        lines.append("To start it:")
        lines.append("")
        lines.append("```")
        lines.append(start)
        lines.append("```")
        lines.append("")
    if verify:
        lines.append("To check it works:")
        lines.append("")
        lines.append("```")
        lines.append(verify)
        lines.append("```")
    if not (start or verify or install):
        lines.append("No run instructions (USAGE.md) were found for this build. "
                     "Once you run a build to completion, Loki writes a USAGE.md at "
                     "the project root with the exact commands.")
    return lines


def _section_put_online(proof):
    """4. 'How to put it online' - mention loki deploy / preview; URL if present."""
    lines = ["## How to put it online", ""]
    deployment = (proof or {}).get("deployment") or {}
    deployed_url = str(deployment.get("deployed_url") or "").strip()
    if deployed_url:
        lines.append("This build was deployed. It is live at: %s" % deployed_url)
        lines.append("")
    else:
        lines.append("This build has not been put online yet.")
        lines.append("")
    lines.append("When you are ready, you have two options:")
    lines.append("")
    lines.append("- `loki deploy` - deploy it using your own cloud account.")
    lines.append("- `loki preview --public` - share a temporary public link to the "
                 "version running on your computer.")
    return lines


def _section_developer_needs(proof):
    """5. 'What a developer needs to know' - group changed files by top dir."""
    lines = ["## What a developer needs to know", ""]
    facts = (proof or {}).get("facts") or {}
    git = facts.get("git") or {}
    diff = git.get("diff") or (proof or {}).get("files_changed") or {}
    files = diff.get("files") or []
    if isinstance(files, list) and files:
        groups = {}
        for f in files:
            if not isinstance(f, dict):
                continue
            path = str(f.get("path") or "").strip()
            if not path:
                continue
            top = path.split("/")[0] if "/" in path else "(project root)"
            groups.setdefault(top, 0)
            groups[top] += 1
        if groups:
            lines.append("The changes touch these areas of the codebase:")
            lines.append("")
            for top in sorted(groups):
                n = groups[top]
                lines.append("- %s (%d file%s)" % (top, n, "" if n == 1 else "s"))
            lines.append("")
    else:
        lines.append("No changed-file list was recorded for this run.")
        lines.append("")
    lines.append("A developer should read USAGE.md (run/verify commands) and the "
                 "developer handoff notes in .loki/memory/handoffs/.")
    return lines


def _section_verified(proof, run_id):
    """6. 'What is verified' - the proof commands."""
    lines = ["## What is verified", ""]
    if run_id:
        lines.append("Loki keeps a tamper-evident receipt of exactly what it did. "
                     "Anyone can inspect or re-check it:")
        lines.append("")
        lines.append("- `loki proof show %s` - read the full receipt." % run_id)
        lines.append("- `loki proof verify %s` - confirm the receipt has not been "
                     "altered." % run_id)
    else:
        lines.append("No receipt was found for this project yet. Loki writes one "
                     "when a build completes.")
    return lines


def _section_still_to_do(proof, completion):
    """7. 'What you still need to do or decide'.

    Rendered as a numbered, ordered checklist so a non-technical owner knows
    exactly what to handle and roughly in what order: run/try it, resolve
    anything Loki could not verify, then open a PR (merge) and deploy. Every
    item still maps to a real artifact value -- nothing is invented.
    """
    lines = ["## What you still need to do or decide", ""]
    # Action items, kept in a sensible do-this-first order:
    #   1) review assumptions, 2) resolve unverified gaps, 3) PR/merge, 4) deploy.
    items = []

    # Assumptions Loki had to make where the spec was ambiguous.
    total = 0
    high = 0
    if isinstance(completion, dict):
        try:
            total = int(completion.get("assumptions_total") or 0)
        except Exception:
            total = 0
        try:
            high = int(completion.get("assumptions_high") or 0)
        except Exception:
            high = 0
    if total > 0:
        msg = ("Review %d assumption%s Loki had to make where your spec was "
               "ambiguous" % (total, "" if total == 1 else "s"))
        if high > 0:
            msg += (" (%d of them high-impact)" % high)
        msg += ". See .loki/assumptions/ledger.md."
        items.append(msg)

    # Anything not verified (degraded items) is also a to-do.
    honesty = (proof or {}).get("honesty") or {}
    degraded = honesty.get("degraded") or []
    if isinstance(degraded, list) and degraded:
        for d in degraded:
            if isinstance(d, dict):
                item = str(d.get("item") or "").strip()
                reason = str(d.get("reason") or "").strip()
                if item:
                    items.append("Address: %s%s"
                                 % (item, (" (" + reason + ")") if reason else ""))

    # PR state.
    pr_url = ""
    if isinstance(completion, dict):
        pr_url = str(completion.get("pr_url") or "").strip()
    if pr_url:
        items.append("A pull request was opened: %s" % pr_url)
    else:
        items.append("No pull request was opened. Open one when you are ready to "
                     "merge the changes.")

    # Deployment state.
    deployment = (proof or {}).get("deployment") or {}
    if not str(deployment.get("deployed_url") or "").strip():
        items.append("It is not deployed yet. Use `loki deploy` when you are ready.")

    if items:
        lines.append("Work through these in order:")
        lines.append("")
        for i, it in enumerate(items, start=1):
            lines.append("%d. %s" % (i, it))
    else:
        lines.append("- Nothing outstanding was recorded. Read the sections above "
                     "to decide your next step.")
    return lines


# ---------------------------------------------------------------------------
# top-level render
# ---------------------------------------------------------------------------

def _empty_doc_md(loki_dir):
    return "\n".join([
        "# What Loki built for you",
        "",
        "No completed build was found here yet.",
        "",
        "Run `loki start <spec>` to build something (a one-line idea, a PRD "
        "file, or a GitHub issue all work). When it finishes, come back and run "
        "`loki own` to read this plain-English summary of what you have.",
        "",
    ])


def _empty_doc_json(loki_dir):
    return {
        "ok": True,
        "found": False,
        "loki_dir": loki_dir,
        "message": "No completed build found here yet -- run loki start <spec>",
    }


def render_markdown(loki_dir):
    run_id, proof = _latest_proof(loki_dir)
    if proof is None:
        return _empty_doc_md(loki_dir)

    completion = _read_json(os.path.join(loki_dir, "state", "completion.json"))
    # USAGE.md lives at the project root (parent of .loki).
    project_root = os.path.dirname(os.path.abspath(loki_dir)) or "."
    usage_text = _read_text(os.path.join(project_root, "USAGE.md"))
    live_url = _live_url(loki_dir)

    blocks = [["# What Loki built for you", "",
               "Here is what Loki built and how to take it from here, in plain "
               "language - no code reading required."]]
    blocks.append(_section_what_you_have(proof))
    blocks.append(_section_is_it_working(proof, run_id))
    blocks.append(_section_run_on_computer(proof, usage_text, live_url))
    blocks.append(_section_put_online(proof))
    blocks.append(_section_developer_needs(proof))
    blocks.append(_section_verified(proof, run_id))
    blocks.append(_section_still_to_do(proof, completion))

    parts = []
    for b in blocks:
        parts.append("\n".join(b))
    return "\n\n".join(parts) + "\n"


def render_json(loki_dir):
    run_id, proof = _latest_proof(loki_dir)
    if proof is None:
        return _empty_doc_json(loki_dir)

    completion = _read_json(os.path.join(loki_dir, "state", "completion.json")) or {}
    project_root = os.path.dirname(os.path.abspath(loki_dir)) or "."
    usage_text = _read_text(os.path.join(project_root, "USAGE.md"))
    live_url = _live_url(loki_dir)

    honesty = proof.get("honesty") or {}
    deployment = proof.get("deployment") or {}
    facts = proof.get("facts") or {}
    git = facts.get("git") or {}
    diff = git.get("diff") or proof.get("files_changed") or {}

    return {
        "ok": True,
        "found": True,
        "run_id": run_id,
        "ready": _is_ready(proof),
        "headline": str(honesty.get("headline") or ""),
        "degraded": honesty.get("degraded") or [],
        "spec_brief": str((proof.get("spec") or {}).get("brief") or ""),
        "files_changed": {
            "count": diff.get("count") or 0,
            "insertions": diff.get("insertions") or 0,
            "deletions": diff.get("deletions") or 0,
        },
        "live_url": live_url,
        "deployed_url": str(deployment.get("deployed_url") or ""),
        "start_command": _usage_section(usage_text, "Start"),
        "verify_command": _usage_section(usage_text, "Verify"),
        "pr_url": str(completion.get("pr_url") or ""),
        "assumptions_total": completion.get("assumptions_total") or 0,
        "assumptions_high": completion.get("assumptions_high") or 0,
        "proof_show_cmd": ("loki proof show %s" % run_id) if run_id else "",
        "proof_verify_cmd": ("loki proof verify %s" % run_id) if run_id else "",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Loki Mode finish-and-own renderer (plain-English ownership doc)"
    )
    parser.add_argument("--loki-dir", default=".loki")
    fmt = parser.add_mutually_exclusive_group()
    fmt.add_argument("--md", action="store_const", const="md", dest="fmt")
    fmt.add_argument("--json", action="store_const", const="json", dest="fmt")
    parser.set_defaults(fmt="md")
    args = parser.parse_args(argv)

    loki_dir = os.path.abspath(args.loki_dir)
    try:
        if args.fmt == "json":
            print(json.dumps(render_json(loki_dir), indent=2))
        else:
            print(render_markdown(loki_dir))
    except Exception as exc:
        # This is a report, never a gate: emit an honest line and exit 0.
        if args.fmt == "json":
            print(json.dumps({"ok": False, "found": False, "error": str(exc)}))
        else:
            sys.stderr.write("warn: own-render failed: %s\n" % exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
