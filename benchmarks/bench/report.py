#!/usr/bin/env python3
"""R2 benchmark report generator.

Reads a result-row JSON (produced by the runner/grader) and emits:
  - results.json : a normalized summary (per-tool aggregates + winner)
  - RESULTS.md   : a human report with a per-tool table, the winner, and the
                   MANDATORY methodology + disclaimers section.

CREDIBILITY INVARIANTS (enforced here, tested in tests/test_bench_report.py):
  - The winner is whoever the GRADER DATA says: highest success-rate k/N.
    There is NO Loki-favoring formatting or tie-break. Ties are reported as
    ties (no winner picked), documented in the prose.
  - A null cost renders "not recorded", NEVER "$0.00".
  - Manual rows (provenance.kind == manual / verified == false) are tagged
    "unverified" and are EXCLUDED from the winner computation (an unverified,
    operator-supplied anecdote must never beat a measured result).
  - The methodology section is ALWAYS present (read from
    methodology-template.md; a built-in fallback guarantees presence).

Input result-row shape (subset; the runner owns the full schema):
  {
    "suite": "...", "date": "...", "commit": "...", "command": "...",
    "rows": [
      {"tool": "loki", "model_used": "...", "provenance": {...},
       "trials": [{"success": true, "quality": 0.9, "duration_s": 12.3,
                   "iterations": 4, "cost_usd": 0.12}, ...]},
      ...
    ]
  }

Success comes from trials[].success (set by the GRADER, never by an adapter).
Adapters never write success; this report only consumes the grader's verdict.
"""

import argparse
import json
import os
import statistics
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_METHODOLOGY_PATH = os.path.join(_HERE, "methodology-template.md")

if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import bench_schema as _schema  # noqa: E402

_METHODOLOGY_FALLBACK = (
    "## Methodology and disclaimers\n\n"
    "This report's methodology template was not found on disk. The harness is "
    "the product, not the number: tasks come from frozen public sets via their "
    "own official harnesses, success is decided by a read-only held-out grader "
    "outside the agent container, Loki never grades itself, N>=3 trials are run "
    "and the conservative figure leads, cost is reported raw (never a single "
    "blended figure; null renders 'not recorded'), public sets are likely "
    "contaminated so relative gaps are the signal, and failures are published "
    "alongside wins. Manual entries are operator-supplied and unverified.\n"
)

# Banner injected at the top of RESULTS.md when a result is marked as sample
# or demo data. Gated on results["sample"] being truthy so non-sample renders
# are byte-identical to before this change. Set result_row["sample"] = true in
# the input JSON, or pass --sample on the CLI, to activate.
_SAMPLE_BANNER = (
    "> **SAMPLE / MOCK DEMONSTRATION DATA - NOT A REAL BENCHMARK RUN**\n"
    ">\n"
    "> This file was generated to test the report renderer. The numbers (success\n"
    "> rates, costs, timings) are fabricated. No actual benchmark tasks were run.\n"
    "> No real tool comparison was performed. Do not cite this as a measured result.\n"
    "> Real benchmark results will be published at a later date once paid runs are\n"
    "> authorized."
)


def _median(values):
    nums = [v for v in values
            if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if not nums:
        return None
    return statistics.median(nums)


def _trial_iterations(trial):
    """Iterations for a trial: trial-level (synthetic) or adapter (real shape)."""
    if not isinstance(trial, dict):
        return None
    if isinstance(trial.get("iterations"), (int, float)):
        return trial.get("iterations")
    adapter = trial.get("adapter")
    if isinstance(adapter, dict) and isinstance(adapter.get("iterations"), (int, float)):
        return adapter.get("iterations")
    return None


def _row_model(row):
    """Model label: row-level model_used (synthetic), then real runner fields.

    The runner stamps the model at row["model"] and per-trial under
    trials[].adapter.model_used. Prefer the explicit row value, then fall back.
    """
    if not isinstance(row, dict):
        return None
    if row.get("model_used"):
        return row.get("model_used")
    if row.get("model"):
        return row.get("model")
    trials = row.get("trials")
    if isinstance(trials, list):
        for t in trials:
            if isinstance(t, dict):
                adapter = t.get("adapter")
                if isinstance(adapter, dict) and adapter.get("model_used"):
                    return adapter.get("model_used")
    return None


def row_model_mismatch(row):
    """The row's model LABEL versus the model its trials actually ran.

    WHY THIS EXISTS. _row_model() above prefers the row-level label and only
    falls back to trials[].adapter.model_used. That precedence is right for
    rendering, and silently wrong for TRUST: a row labelled `haiku` whose
    trials every recorded `sonnet` renders as haiku, and a cross-model
    comparison built from it compares a model against itself under two names.

    That is the sharpest failure available to a benchmark. A wrong number
    invites a re-measurement; a wrong MODEL ATTRIBUTION invites a conclusion
    about which model to buy, and nothing downstream can detect it, because
    every other field is internally consistent.

    Returns None when consistent or undecidable, else a dict naming both
    sides. Undecidable (no label, or no trial ever recorded a model) is NOT a
    mismatch: absence of evidence is not evidence of contradiction, and
    treating it as one would fail every legitimate older row.
    """
    if not isinstance(row, dict):
        return None
    label = row.get("model_used") or row.get("model")
    if not label:
        return None
    seen = []
    for t in (row.get("trials") or []):
        if not isinstance(t, dict):
            continue
        adapter = t.get("adapter")
        if isinstance(adapter, dict) and adapter.get("model_used"):
            seen.append(str(adapter["model_used"]))
    if not seen:
        return None
    # Substring match in both directions: a label "haiku" legitimately backs a
    # recorded "claude-haiku-4-5-20251001", and vice versa. Only a pair where
    # neither contains the other is a real contradiction.
    lab = str(label).lower()
    bad = sorted({s for s in seen
                  if lab not in s.lower() and s.lower() not in lab})
    if not bad:
        return None
    return {
        "row_label": str(label),
        "trials_recorded": bad,
        "why": ("the row is labelled with one model while its trials recorded "
                "another; any cross-model claim built on this row attributes "
                "results to the wrong model"),
    }


def fmt_usd(usd):
    """Format a USD value. None -> 'not recorded' (NEVER '$0.00')."""
    if usd is None:
        return "not recorded"
    try:
        n = float(usd)
    except Exception:
        return "not recorded"
    s = ("%.4f" % n).rstrip("0").rstrip(".")
    if "." not in s:
        s += ".00"
    elif len(s.split(".")[1]) == 1:
        s += "0"
    return "$" + s


def _trial_provenances(row):
    """Collect every adapter provenance dict carried by a row's trials.

    The runner nests provenance under trials[].adapter.provenance (one
    result-row per tool, N trials). This returns the list of those provenance
    dicts (empty when the row has no trials or no adapter provenance).
    """
    out = []
    if not isinstance(row, dict):
        return out
    trials = row.get("trials")
    if not isinstance(trials, list):
        return out
    for t in trials:
        if not isinstance(t, dict):
            continue
        adapter = t.get("adapter")
        if not isinstance(adapter, dict):
            continue
        prov = adapter.get("provenance")
        if isinstance(prov, dict):
            out.append(prov)
    return out


def _row_provenances(row):
    """Single source of truth for a row's provenance dict(s).

    Resolution order (row-level FIRST so the synthetic test shape keeps
    working, then the REAL runner shape where provenance lives under
    trials[].adapter.provenance):
      1. row-level row["provenance"] (synthetic / aggregated container shape),
      2. else every trials[].adapter.provenance (real runner shape).
    Returns a list of provenance dicts (may be empty).
    """
    if not isinstance(row, dict):
        return []
    prov = row.get("provenance")
    if isinstance(prov, dict):
        return [prov]
    return _trial_provenances(row)


def _prov_is_manual(prov):
    if not isinstance(prov, dict):
        return False
    if str(prov.get("kind") or "").lower() == "manual":
        return True
    # verified explicitly false also means do not treat as measured.
    return prov.get("verified") is False


def _is_manual(row):
    """A row is manual/unverified if ANY of its provenance records say so.

    Any-trial (not first-trial) is the credibility-safe direction: a single
    unverified, operator-supplied trial taints the whole row, so it can never
    win the leaderboard.
    """
    provs = _row_provenances(row)
    return any(_prov_is_manual(p) for p in provs)


def _provenance_tag(row):
    provs = _row_provenances(row)
    if not provs:
        return "unknown"
    if _is_manual(row):
        return "manual (unverified)"
    # Use the first provenance record for the kind label. Treat the row as
    # verified only if every record is explicitly verified=True.
    kind = str(provs[0].get("kind") or "automated")
    if all(p.get("verified") is True for p in provs):
        return "%s (verified)" % kind
    return kind


def summarize_row(row):
    """Aggregate one tool's trials into a summary dict.

    Only MEASURED trials feed k/N. A trial whose adapter reports it never
    produced a gradeable state (tool not installed, timed out, harness error) is
    excluded from both numerator and denominator instead of being published as a
    0 -- an uninstalled competitor scoring "0/3 (verified)" is a confident false
    claim. bench_schema.trial_is_measured is the single definition; see it for
    why exit_status is the discriminator and why absent reads as measured.
    """
    all_trials = row.get("trials") if isinstance(row.get("trials"), list) else []
    all_trials = [t for t in all_trials if isinstance(t, dict)]
    trials, unmeasured = _schema.split_measured(all_trials)
    n = len(trials)
    successes = sum(1 for t in trials if t.get("success") is True)
    success_rate = (successes / n) if n else None
    # quality may be a number (synthetic shape) or a dict {lint_ok, tests_ok}
    # (real grader shape). Only numeric qualities feed the median; dicts are
    # ignored (they render n/a) rather than crashing.
    qualities = [t.get("quality") for t in trials if isinstance(t, dict)]
    costs = [t.get("cost_usd") for t in trials if isinstance(t, dict)]
    durations = [t.get("duration_s") for t in trials if isinstance(t, dict)]
    # iterations may live trial-level (synthetic) or under adapter (real shape).
    iters = [_trial_iterations(t) for t in trials if isinstance(t, dict)]

    # cost median: only over trials where cost was recorded (non-null). If no
    # trial recorded a cost, the median is None -> renders "not recorded".
    cost_median = _median([c for c in costs if c is not None])

    return {
        "tool": row.get("tool"),
        "model_used": _row_model(row),
        "k": successes,
        "n": n,
        "n_attempted": len(all_trials),
        "n_unmeasured": len(unmeasured),
        "success_rate": success_rate,
        "quality_median": _median([q for q in qualities if q is not None]),
        "cost_usd_median": cost_median,
        "wall_clock_median": _median([d for d in durations if d is not None]),
        "iterations_median": _median([i for i in iters if i is not None]),
        "manual": _is_manual(row),
        "provenance_tag": _provenance_tag(row),
    }


def pick_winner(summaries):
    """Winner = highest success-rate among VERIFIED (non-manual) tools.

    Returns (winner_tool|None, reason). No Loki bias: pure data. Manual
    (unverified) rows are excluded. Ties yield no winner (reported as a tie).
    """
    eligible = [s for s in summaries
                if not s["manual"] and s["success_rate"] is not None and s["n"] > 0]
    if not eligible:
        return None, "no verified tool produced a gradeable trial"
    best = max(s["success_rate"] for s in eligible)
    leaders = [s for s in eligible if s["success_rate"] == best]
    if len(leaders) > 1:
        names = ", ".join(str(s["tool"]) for s in leaders)
        return None, "tie at %d%% success-rate among: %s" % (
            round(best * 100), names)
    w = leaders[0]
    return w["tool"], "highest grader success-rate %d/%d (%d%%)" % (
        w["k"], w["n"], round(w["success_rate"] * 100))


def _load_methodology():
    try:
        with open(_METHODOLOGY_PATH) as fh:
            text = fh.read().strip()
        if text:
            return text
    except Exception:
        pass
    return _METHODOLOGY_FALLBACK.strip()


def _is_runner_result_row(obj):
    """True for a single per-tool runner result-row (has trials + tool, no rows).

    The runner writes ONE file per tool: {tool, model, trials:[...], summary}.
    report's native container is {suite, rows:[...]}; this detects the runner
    shape so it can be wrapped into a one-row container for the leaderboard.
    """
    return (
        isinstance(obj, dict)
        and isinstance(obj.get("trials"), list)
        and "rows" not in obj
        and ("tool" in obj or "task_id" in obj)
    )


def normalize_input(data):
    """Coerce any supported input into a {suite, ..., rows:[...]} container.

    Supported inputs (so report.py is robust to BOTH the runner's real per-tool
    output and the test's synthetic container shape):
      1. {suite, rows:[...]}            -- native container (synthetic tests),
      2. a single runner result-row      -- wrapped as a one-row container,
      3. a list of any of the above      -- merged into one leaderboard.
    Returns a single container dict with a merged rows list.
    """
    if isinstance(data, list):
        container = {"rows": []}
        for item in data:
            sub = normalize_input(item)
            container["rows"].extend(sub.get("rows", []))
            for k in ("suite", "date", "commit", "command"):
                if not container.get(k) and sub.get(k):
                    container[k] = sub[k]
            if sub.get("sample"):
                container["sample"] = True
        return container

    if not isinstance(data, dict):
        return {"rows": []}

    if isinstance(data.get("rows"), list):
        return data

    if _is_runner_result_row(data):
        # Each runner result-row IS one leaderboard row (one tool, N trials).
        return {
            "suite": data.get("suite"),
            "date": data.get("date"),
            "commit": data.get("commit"),
            "command": data.get("command"),
            "sample": data.get("sample"),
            "rows": [data],
        }

    # Unknown dict: treat as an empty container (no crash).
    return {"suite": data.get("suite"), "rows": []}


def build_report(result_row):
    container = normalize_input(result_row)
    rows = container.get("rows") if isinstance(container.get("rows"), list) else []
    summaries = [summarize_row(r) for r in rows if isinstance(r, dict)]
    winner, reason = pick_winner(summaries)
    results = {
        "suite": container.get("suite"),
        "date": container.get("date"),
        "commit": container.get("commit"),
        "command": container.get("command"),
        "sample": container.get("sample"),
        "summaries": summaries,
        "winner": winner,
        "winner_reason": reason,
    }
    return results


def render_markdown(results):
    lines = []

    # Emit sample/demo banner when the result is marked as demonstration data.
    # Non-sample renders are byte-identical to before this change (field absent
    # or falsy -> no banner emitted).
    if results.get("sample"):
        lines.append(_SAMPLE_BANNER)
        lines.append("")

    suite = results.get("suite") or "(unspecified)"
    lines.append("# Loki Mode benchmark results: %s" % suite)
    lines.append("")
    meta = []
    if results.get("date"):
        meta.append("Date: %s" % results["date"])
    if results.get("commit"):
        meta.append("Commit: %s" % results["commit"])
    if results.get("command"):
        meta.append("Command: `%s`" % results["command"])
    if meta:
        lines.append("  \n".join(meta))
        lines.append("")

    # Winner line: data-driven, no Loki favoring.
    winner = results.get("winner")
    reason = results.get("winner_reason") or ""
    if winner:
        lines.append("**Winner: %s** (%s)." % (winner, reason))
    else:
        lines.append("**No single winner: %s.**" % reason)
    lines.append("")

    # Table.
    lines.append(
        "| Tool | Model | Success k/N | Cost USD (median) | Wall-clock (median) "
        "| Iterations (median) | Quality (median) | Provenance |"
    )
    lines.append(
        "|---|---|---|---|---|---|---|---|"
    )
    for s in results.get("summaries", []):
        # A row with nothing measured says so. "0/3" would be a score it never
        # earned; "n/a" alone hides that trials were attempted and lost.
        if s["n"]:
            kN = "%d/%d" % (s["k"], s["n"])
            if s.get("n_unmeasured"):
                kN += " (%d unmeasured)" % s["n_unmeasured"]
        elif s.get("n_attempted"):
            kN = "not measured (%d/%d trials produced no result)" % (
                s["n_unmeasured"], s["n_attempted"])
        else:
            kN = "n/a"
        cost = fmt_usd(s["cost_usd_median"])
        wall = ("%.1fs" % s["wall_clock_median"]
                if s["wall_clock_median"] is not None else "not recorded")
        iters = ("%g" % s["iterations_median"]
                 if s["iterations_median"] is not None else "n/a")
        qual = ("%.2f" % s["quality_median"]
                if s["quality_median"] is not None else "n/a")
        lines.append("| %s | %s | %s | %s | %s | %s | %s | %s |" % (
            s["tool"], s["model_used"] or "n/a", kN, cost, wall, iters, qual,
            s["provenance_tag"],
        ))
    lines.append("")

    # Note any manual/unverified rows explicitly.
    manual_tools = [s["tool"] for s in results.get("summaries", []) if s["manual"]]
    if manual_tools:
        lines.append(
            "> Unverified rows (%s) are operator-supplied manual entries "
            "(provenance verified=false) and are EXCLUDED from the winner "
            "computation. Treat them as anecdotes with provenance, not "
            "measured results." % ", ".join(str(t) for t in manual_tools)
        )
        lines.append("")

    lines.append(_load_methodology())
    lines.append("")
    return "\n".join(lines)


def generate(result_row, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    results = build_report(result_row)
    results_path = os.path.join(out_dir, "results.json")
    with open(results_path, "w") as fh:
        json.dump(results, fh, indent=2, sort_keys=True)
    md = render_markdown(results)
    md_path = os.path.join(out_dir, "RESULTS.md")
    with open(md_path, "w") as fh:
        fh.write(md)
    return results_path, md_path


def main(argv=None):
    parser = argparse.ArgumentParser(description="R2 benchmark report generator")
    parser.add_argument("result_row", nargs="+",
                        help="one or more result-row JSON files (per-tool runner "
                             "outputs are merged into one leaderboard)")
    parser.add_argument("--out-dir", default=".",
                        help="directory for results.json + RESULTS.md")
    parser.add_argument("--sample", action="store_true",
                        help="mark as SAMPLE/MOCK DEMONSTRATION DATA; emits a "
                             "prominent banner before the title so the output is "
                             "self-labeling and cannot be mistaken for a real run")
    args = parser.parse_args(argv)
    loaded = []
    for path in args.result_row:
        try:
            with open(path) as fh:
                loaded.append(json.load(fh))
        except Exception as exc:
            sys.stderr.write("error: could not read result-row %s: %s\n" % (path, exc))
            return 2
    # A single file passes through as-is; multiple files merge into one report.
    result_row = loaded[0] if len(loaded) == 1 else loaded
    # --sample overrides the input data flag (union: either source marks it).
    if args.sample:
        if isinstance(result_row, dict):
            result_row["sample"] = True
        elif isinstance(result_row, list):
            for item in result_row:
                if isinstance(item, dict):
                    item["sample"] = True
    # MODEL-ATTRIBUTION GATE, before anything is rendered.
    #
    # A row labelled with one model whose trials recorded another produces a
    # report that attributes results to the wrong model. Rendering it first and
    # warning afterwards is not equivalent: the artifact is the thing that gets
    # quoted, and once written it outlives the warning.
    #
    # Fails CLOSED with exit 1 and names both sides. Undecidable rows (no
    # label, or no trial recorded a model) are NOT failures -- absence of
    # evidence is not contradiction, and treating it as one would reject every
    # legitimate older row.
    _rows = result_row if isinstance(result_row, list) else [result_row]
    _mismatches = []
    for _r in _rows:
        _m = row_model_mismatch(_r)
        if _m:
            _mismatches.append(_m)
    if _mismatches:
        sys.stderr.write(
            "MODEL MISMATCH: refusing to write a report that would attribute "
            "results to the wrong model.\n")
        for _m in _mismatches:
            sys.stderr.write(
                "  row labelled %r but trials recorded %s\n"
                % (_m["row_label"], ", ".join(_m["trials_recorded"])))
        sys.stderr.write(
            "  Nothing was written. Fix the row's provenance, or drop the "
            "row; do not relabel it to match.\n")
        return 1

    rp, mp = generate(result_row, args.out_dir)
    print("wrote: %s" % rp)
    print("wrote: %s" % mp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
