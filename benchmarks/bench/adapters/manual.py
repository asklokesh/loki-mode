#!/usr/bin/env python3
"""Manual adapter for tools with no automatable local CLI (Devin, Cursor).

These tools cannot be driven headless on a host we control, so we cannot run
them ourselves. The HONEST approach: record externally-supplied numbers that
an operator obtained by running the tool, with MANDATORY provenance, and stamp
provenance.kind=manual + verified=false so the report renders them as
"unverified". This adapter NEVER fabricates a number: if the operator did not
supply a value, it stays null.

It still NEVER reports success or quality. Even a manually-entered run is
graded by the read-only grader, not asserted by the operator.

Manual-entry file (JSON) MUST contain a provenance block with all of:
  operator     - who ran the tool and entered the numbers
  date         - ISO date the external run was performed
  tool_version - the competitor tool version used
  run_link     - URL to the run, OR run_screenshot path to a screenshot

Missing any mandatory provenance field raises ManualEntryError: an entry with
no provenance is worse than no entry at all (it looks fabricated).
"""

import json
import os

try:
    from . import _base
except ImportError:
    import _base  # type: ignore


REQUIRED_PROVENANCE = ("operator", "date", "tool_version")
# At least one of these proves the run happened.
PROOF_FIELDS = ("run_link", "run_screenshot")


class ManualEntryError(ValueError):
    """Raised when a manual entry is missing mandatory provenance."""


def _validate_provenance(prov):
    if not isinstance(prov, dict):
        raise ManualEntryError(
            "manual entry requires a 'provenance' object with operator, date, "
            "tool_version and a run_link or run_screenshot"
        )
    missing = [k for k in REQUIRED_PROVENANCE
               if not str(prov.get(k) or "").strip()]
    if missing:
        raise ManualEntryError(
            "manual entry missing mandatory provenance field(s): %s"
            % ", ".join(missing)
        )
    if not any(str(prov.get(k) or "").strip() for k in PROOF_FIELDS):
        raise ManualEntryError(
            "manual entry requires a run_link or a run_screenshot path as proof"
        )


def run_from_entry(entry, *, tool=None):
    """Build adapter output from a parsed manual-entry dict.

    Raises ManualEntryError if mandatory provenance is absent. Stamps
    provenance.kind=manual and verified=false unconditionally.
    """
    if not isinstance(entry, dict):
        raise ManualEntryError("manual entry must be a JSON object")

    prov_in = entry.get("provenance")
    _validate_provenance(prov_in)

    tool_name = tool or entry.get("tool")
    if not str(tool_name or "").strip():
        raise ManualEntryError("manual entry must name the 'tool' (e.g. devin)")

    # Operator-supplied measurements. Absent values stay null; never default
    # a cost or token count to zero (that would read as fabricated).
    def _num(key, caster):
        v = entry.get(key)
        if v is None:
            return None
        try:
            return caster(v)
        except Exception:
            return None

    provenance = {
        "kind": "manual",
        "verified": False,
        "operator": str(prov_in.get("operator")),
        "date": str(prov_in.get("date")),
        "tool_version": str(prov_in.get("tool_version")),
        "run_link": (str(prov_in.get("run_link")) if prov_in.get("run_link")
                     else None),
        "run_screenshot": (str(prov_in.get("run_screenshot"))
                           if prov_in.get("run_screenshot") else None),
        "note": str(prov_in.get("note") or ""),
    }

    return _base.build_output(
        tool=str(tool_name),
        tool_version=str(prov_in.get("tool_version")),
        model_used=(str(entry.get("model_used")) if entry.get("model_used")
                    else None),
        duration_s=_num("duration_s", float),
        iterations=_num("iterations", int),
        tokens_in=_num("tokens_in", int),
        tokens_out=_num("tokens_out", int),
        cost_usd=_num("cost_usd", float),
        exit_status=str(entry.get("exit_status") or "manual"),
        provenance=provenance,
    )


def run(workdir=None, spec=None, *, manual_entry=None, tool=None):
    """Read a --manual-entry JSON file and produce the adapter-output dict.

    workdir/spec are accepted for a uniform adapter signature but unused: a
    manual tool was run elsewhere. `manual_entry` is the path to the JSON file.
    """
    if not manual_entry:
        raise ManualEntryError(
            "manual adapter requires --manual-entry <file> with provenance"
        )
    if not os.path.isfile(manual_entry):
        raise ManualEntryError("manual-entry file not found: %s" % manual_entry)
    try:
        with open(manual_entry) as fh:
            entry = json.load(fh)
    except Exception as exc:
        raise ManualEntryError(
            "could not parse manual-entry file %s: %s" % (manual_entry, exc)
        )
    return run_from_entry(entry, tool=tool)
