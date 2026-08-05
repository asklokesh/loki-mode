#!/usr/bin/env python3
"""Render a ci-gate verdict as CI-native output. Never invent a verdict.

WHY THIS EXISTS. tools/ci-gate.py already decides correctly and exits 0/1/2.
But in a CI run its text table lands in a collapsed log that nobody opens. The
two surfaces an engineer actually reads are the run page ($GITHUB_STEP_SUMMARY,
markdown) and the PR diff annotations (::error / ::warning workflow commands).
Nothing carried our verdict to either, so the gate's most important state --
"this policy could not be checked" -- was invisible at exactly the moment it
mattered.

    python3 tools/ci-gate.py <ws> --max-usd 5 --json \
        | python3 tools/gate-report.py --format markdown >> "$GITHUB_STEP_SUMMARY"

THE RULE THIS FILE EXISTS TO HOLD, inherited from ci-gate.py:

    A POLICY THAT COULD NOT BE EVALUATED HAS NOT PASSED.

A renderer is where that rule dies quietly. A table styles UNEVALUABLE like a
minor note; an annotation layer emits ::error for failures and simply skips
everything else. Both produce a run page with no red on it, and a reviewer
reads absence-of-red as pass. So UNEVALUABLE renders exactly as prominently as
FAIL, and in the github format it is a ::warning at minimum -- never silent,
never ::notice. There is one severity map, below, and both formats read it.

WHY THE EXIT CODE IS RE-EMITTED. In `ci-gate.py ... | gate-report.py` the shell
keeps ONLY the last command's status. ci-gate's 2 is discarded by the pipe. If
this file exited 0 for a rendered blind gate, adding a human-readable report
would have converted a blocked merge into a green check -- the pipeline would
be made LESS safe by the act of describing itself. So the input's own exit_code
is re-emitted, and anything that is not a recognised verdict exits 2.

WHAT IT REFUSES TO DO. It never computes a state, only relays one. A row with
no state, or a state word this file does not recognise, is UNEVALUABLE -- the
input did not carry a verdict, and a renderer that fills that gap with "pass"
is manufacturing evidence. Empty stdin and malformed JSON are errors on stderr
with exit 2, never an empty report: a report of nothing is indistinguishable
from a clean run.

Exit: mirrors the input verdict (0 pass, 1 failed, 2 unevaluable); 2 on any
input this file could not parse.
"""

import argparse
import json
import sys

PASS, FAIL, UNEVALUABLE = 0, 1, 2

# THE ONE MAPPING. Both formats read it, so a change of severity cannot apply
# to one surface and not the other. "notice" is reserved for PASS: an
# unevaluable policy demoted to a notice is precisely the silent-green failure
# this tool exists to prevent.
_SEVERITY = {"PASS": "notice", "FAIL": "error", "UNEVALUABLE": "warning"}

_EXIT = {"PASS": PASS, "FAIL": FAIL, "UNEVALUABLE": UNEVALUABLE}

# ponytail: markdown emphasis is derived, not a second table to drift.
_UNKNOWN = ("UNEVALUABLE", "state not reported by the gate: the input carried "
            "no recognised verdict for this policy, so it has not passed")


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that: it is an error
    about the INVOCATION, and nothing about the subject was examined. The
    two call for opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so
    every tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _state_of(row):
    """The row's own verdict, or UNEVALUABLE. Never a default of PASS."""
    if not isinstance(row, dict):
        return _UNKNOWN[0], "malformed policy entry: %r" % (row,), "?"
    state = row.get("state")
    policy = str(row.get("policy") or "?")
    reason = row.get("reason")
    reason = reason.strip() if isinstance(reason, str) and reason.strip() \
        else "no detail reported"
    if not isinstance(state, str) or state.upper() not in _SEVERITY:
        return _UNKNOWN[0], "%s (was %r)" % (_UNKNOWN[1], state), policy
    return state.upper(), reason, policy


def _rows(verdict):
    """Every policy row, plus a synthetic row when the gate carried none.

    An empty policies list with a top-level UNEVALUABLE is ci-gate's
    "no policy configured" verdict. Rendering an empty table there would draw a
    header and no rows, which reads as a clean run -- the exact inversion this
    file exists to stop.
    """
    policies = verdict.get("policies")
    out = []
    if isinstance(policies, list):
        for row in policies:
            out.append(_state_of(row))
    if out:
        return out
    # No policy results arrived. Whatever the header claims, nothing was
    # checked, so this row is UNEVALUABLE unconditionally -- trusting a
    # top-level "PASS" here would render a green table built from zero
    # evidence, which is the one thing this file must never do.
    return [(_UNKNOWN[0], _overall_reason(verdict), "(none)")]


def _overall_reason(verdict):
    reason = verdict.get("reason")
    if isinstance(reason, str) and reason.strip():
        return reason.strip()
    return "the gate reported no policy results and no reason"


def _verdict_state(verdict):
    """The overall state, never weaker than the worst row.

    The header is a claim; the rows are the evidence. A body asserting PASS
    over a FAILED or unreported row is not a pass, so the summary line is
    reconciled against the rows here -- the same weakest-link rule ci-gate
    applies, and the same one exit_code() applies. Reporting a green summary
    above a red table is how a reader ends up trusting the wrong one.
    """
    state = verdict.get("state")
    claimed = state.upper() if isinstance(state, str) \
        and state.upper() in _SEVERITY else _UNKNOWN[0]
    worst = max([_EXIT[claimed]] +
                [_EXIT[row[0]] for row in _rows(verdict)])
    return {v: k for k, v in _EXIT.items()}[worst]


def render_markdown(verdict):
    state = _verdict_state(verdict)
    lines = ["## Merge gate: %s" % _headline(state), "",
             "| Policy | State | Detail |", "| --- | --- | --- |"]
    for row_state, reason, policy in _rows(verdict):
        # Bold every non-pass. An unevaluable row must not be visually quieter
        # than a failed one on the run page.
        cell = row_state if row_state == "PASS" else "**%s**" % row_state
        lines.append("| %s | %s | %s |" % (policy, cell, _cell(reason)))
    lines.append("")
    lines.append("%s -- %s" % (_headline(state), _overall_reason(verdict)))
    return "\n".join(lines)


def _headline(state):
    if state == "PASS":
        return "PASS"
    if state == "FAIL":
        return "FAIL"
    return "UNEVALUABLE (could not be checked -- this is not a pass)"


def _cell(text):
    # A pipe in a reason would silently split the row into extra columns.
    return " ".join(text.split()).replace("|", "\\|")


def render_github(verdict, file_hint=None):
    """Workflow commands. Non-pass rows are never silent."""
    lines = []
    loc = "file=%s," % file_hint if file_hint else ""
    for row_state, reason, policy in _rows(verdict):
        lines.append("::%s %stitle=gate: %s (%s)::%s"
                     % (_SEVERITY[row_state], loc, policy, row_state,
                        _annotation_text(reason)))
    state = _verdict_state(verdict)
    lines.append("::%s %stitle=merge gate %s::%s"
                 % (_SEVERITY[state], loc, state,
                    _annotation_text(_overall_reason(verdict))))
    return "\n".join(lines)


def _one_line(text):
    # A raw newline would terminate the workflow command mid-message and leave
    # the tail rendered as plain log noise.
    return " ".join(text.split())


def _annotation_text(text):
    # % opens an escape sequence in a workflow-command message, and
    # cost-guard's --max-increase-pct reasons carry literal percentages. Only
    # the github format needs this; plain text must keep its real % sign.
    return _one_line(text).replace("%", "%25")


def render_text(verdict):
    lines = ["%-10s %-12s %s" % ("POLICY", "STATE", "DETAIL")]
    for row_state, reason, policy in _rows(verdict):
        lines.append("%-10s %-12s %s" % (policy, row_state, _one_line(reason)))
    lines.append("")
    lines.append("GATE: %s -- %s" % (_headline(_verdict_state(verdict)),
                                     _overall_reason(verdict)))
    return "\n".join(lines)


_FORMATS = {"markdown": render_markdown, "github": render_github,
            "text": render_text}


def exit_code(verdict):
    """The input's own exit semantics. A pipe drops them; this restores them."""
    code = verdict.get("exit_code")
    if isinstance(code, bool) or not isinstance(code, int) \
            or code not in (PASS, FAIL, UNEVALUABLE):
        # No trustworthy verdict came in, so none goes out. 2 matches
        # ci-gate's own vocabulary: to a CI job, "blind" and "broken" are the
        # same fact and neither may merge.
        return UNEVALUABLE
    # Cross-check: a body claiming PASS while carrying a non-pass row is not a
    # pass. Weakest link, same rule ci-gate uses, applied to what arrived --
    # and the same reconciliation the rendered summary shows, so the exit code
    # can never disagree with the report a human just read.
    return max(code, _EXIT[_verdict_state(verdict)])


def main(argv=None):
    ap = _Parser(
        description="Render a ci-gate JSON verdict as CI-native output.")
    ap.add_argument("--format", choices=sorted(_FORMATS), default="markdown",
                    help="markdown (step summary), github (annotations), text")
    ap.add_argument("--file", dest="file_hint",
                    help="path to attach to github annotations; omitted when "
                         "not given, because an annotation on the wrong file "
                         "is worse than none")
    args = ap.parse_args(argv)

    raw = sys.stdin.read()
    if not raw.strip():
        # A report of nothing looks exactly like a clean run.
        sys.stderr.write("gate-report: empty stdin -- expected ci-gate JSON on "
                         "stdin. Nothing to report is not a pass.\n")
        return UNEVALUABLE
    try:
        verdict = json.loads(raw)
    except ValueError as exc:
        sys.stderr.write("gate-report: could not parse the gate verdict: %s\n"
                         % exc)
        return UNEVALUABLE
    if not isinstance(verdict, dict):
        sys.stderr.write("gate-report: expected a JSON object from ci-gate, "
                         "got %s\n" % type(verdict).__name__)
        return UNEVALUABLE

    # Render fully before printing: a malformed body must never emit a partial
    # report that a reader mistakes for the whole verdict.
    if args.format == "github":
        out = render_github(verdict, args.file_hint)
    else:
        out = _FORMATS[args.format](verdict)
    code = exit_code(verdict)
    print(out)
    return code


if __name__ == "__main__":
    sys.exit(main())
