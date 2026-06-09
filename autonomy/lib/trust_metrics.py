#!/usr/bin/env python3
"""Trust-layer metrics aggregator (single project).

Computes the four AVAILABLE-TODAY trust metrics from
internal/BENCHMARK-PROGRAM-2026-06.md section 3, plus the corpus-level
denominators that make them honest. These metrics are the real
differentiator: no single-pass agent can report them because no
single-pass agent refuses its own "done" claim.

Metric definitions (verbatim from the benchmark doc, section 3):

  Metric 1 -- Evidence-gate block rate
    Fraction of instrumented runs in which the verified-completion evidence
    gate refused at least one "done" claim (empty diff vs run-start SHA, or
    red tests) before completion was honored.

  Metric 2 -- Gate failure-rate distribution per run
    Per run, the count and which-gate breakdown of quality-gate failures
    before the run reached an acceptable state; published as a distribution
    across N runs (median, p90), not a single number.

  Metric 3 -- Council rejection / split rate
    Across council votes, the fraction REJECTED, and of those the
    split-verdict fraction (rejected with at least one approver). Reported
    as a rate with the underlying vote count.

  Metric 4 -- Cost-per-VERIFIED-task
    Dollars and tokens spent per verified-completed run. Local denominator =
    runs whose proof.json final_verdict is a pass (the EXTERNAL grader
    denominator from the doc is not available on a single machine; see
    NOTE_EXTERNAL_GRADER). Reported raw alongside the count.

DATA SOURCES (the design):

  The runtime's single-state control files are deliberately NOT used as the
  cross-run corpus because the SUCCESSFUL-run case erases exactly the
  self-correction event we want to publish:
    - .loki/council/evidence-block.json is DELETED on the passing run
    - .loki/quality/gate-failure-count.json is RESET by clear_gate_failure
    - .loki/metrics/efficiency/iteration-*.json is wiped at run start
  So this module reads two durable records instead:
    1. .loki/metrics/trust-events.jsonl -- append-only event log written by
       record_trust_event() (run_start, evidence_block, council_vote,
       gate_failure). One JSON object per line.
    2. .loki/proofs/<id>/proof.json -- the persistent per-run proof corpus
       (council.final_verdict, cost, iterations).

HONESTY RULE (the central trap): a metric is only emitted when its source
artifact genuinely exists. We distinguish "instrumented, 0 events" from "not
instrumented at all": the denominator of Metrics 1 and 2 is the count of
INSTRUMENTED runs (runs that emitted a run_start event), never the proof
corpus. Every metric reports its own n= explicitly. A metric with no source
data is reported available=False, never a fabricated 0.

No external deps. Python 3.8+ (matches the rest of autonomy/lib).
Single project only; an --all-projects registry aggregator is OUT of scope
(see cmd_trust_metrics help).

Public API:
  record_trust_event(loki_dir, event_type, **fields) -> bool
  compute_trust_metrics(loki_dir) -> dict   (schema_version 1)
  format_metrics_human(m) -> str
  format_metrics_json(m) -> str
  write_metrics_cache(loki_dir, m) -> str | None
  main(argv) -> int
"""

import json
import os
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = 1

# Verdict tokens that count as a verified / passing run (mirrors
# trust_trajectory._PASS_TOKENS for cross-module consistency).
_PASS_TOKENS = ("APPROVE", "APPROVED", "COMPLETE", "PASS", "PASSED")

# Event types written to trust-events.jsonl. Kept as constants so the writer
# (run.sh sites) and reader cannot drift apart silently.
EVENT_RUN_START = "run_start"
EVENT_EVIDENCE_BLOCK = "evidence_block"
EVENT_COUNCIL_VOTE = "council_vote"
EVENT_GATE_FAILURE = "gate_failure"

_EVENTS_FILENAME = "trust-events.jsonl"

NOTE_EXTERNAL_GRADER = (
    "cost-per-verified uses the LOCAL verified denominator (proof.json "
    "final_verdict pass). The benchmark doc's external-grader denominator "
    "is not available on a single machine and is not computed here."
)


def _utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _obj(v):
    return v if isinstance(v, dict) else {}


# ---------------------------------------------------------------------------
# Writer (called from the runtime via record_trust_event; additive, best-effort)
# ---------------------------------------------------------------------------

def record_trust_event(loki_dir, event_type, **fields):
    """Append one durable trust event to .loki/metrics/trust-events.jsonl.

    Best-effort and side-effect-only: returns True on success, False on any
    failure, and never raises. The runtime callers must not depend on the
    return value or on stdout (this writes nothing to stdout). Each record
    carries run_id + iteration + ts + type so it joins to the proof corpus.
    """
    try:
        out_dir = os.path.join(loki_dir, "metrics")
        os.makedirs(out_dir, exist_ok=True)
        record = {
            "type": str(event_type),
            "run_id": str(
                fields.pop("run_id", "")
                or os.environ.get("LOKI_SESSION_ID", "")
                or "unknown"
            ),
            "iteration": _to_int(fields.pop("iteration", 0), 0),
            "ts": str(fields.pop("ts", "") or _utc_now()),
        }
        # Remaining caller fields are folded in verbatim (already simple types).
        for k, v in fields.items():
            record[k] = v
        line = json.dumps(record, sort_keys=True)
        with open(os.path.join(out_dir, _EVENTS_FILENAME), "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        return True
    except Exception:
        return False


def _to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Reader / aggregation
# ---------------------------------------------------------------------------

def _load_events(loki_dir):
    """Read trust-events.jsonl into a list of dicts. Missing file -> []."""
    path = os.path.join(loki_dir, "metrics", _EVENTS_FILENAME)
    events = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except (ValueError, TypeError):
                    # Skip a torn / partial line, never fail the whole report.
                    continue
                if isinstance(obj, dict):
                    events.append(obj)
    except (OSError, FileNotFoundError):
        return []
    return events


def _verdict_is_pass(verdict):
    v = str(verdict or "").strip().upper()
    if not v:
        return None
    for tok in _PASS_TOKENS:
        if v.startswith(tok):
            return True
    return False


def _load_proofs(loki_dir):
    """Read every proof.json into a list keyed by run_id with cost+verdict."""
    proofs_dir = os.path.join(loki_dir, "proofs")
    out = []
    try:
        entries = sorted(os.listdir(proofs_dir))
    except (OSError, FileNotFoundError):
        return out
    for name in entries:
        d = os.path.join(proofs_dir, name)
        if not os.path.isdir(d):
            continue
        proof = _read_json(os.path.join(d, "proof.json"), default=None)
        if not isinstance(proof, dict):
            continue
        out.append(proof)
    return out


def _percentile(sorted_vals, pct):
    """Nearest-rank percentile over a pre-sorted non-empty list."""
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    # Nearest-rank: rank = ceil(pct/100 * n), 1-indexed.
    import math
    rank = max(1, math.ceil((pct / 100.0) * len(sorted_vals)))
    rank = min(rank, len(sorted_vals))
    return sorted_vals[rank - 1]


def _median(sorted_vals):
    n = len(sorted_vals)
    if n == 0:
        return None
    mid = n // 2
    if n % 2 == 1:
        return float(sorted_vals[mid])
    return (sorted_vals[mid - 1] + sorted_vals[mid]) / 2.0


# ---------------------------------------------------------------------------
# Metric 1: evidence-gate block rate
# ---------------------------------------------------------------------------

def _metric_evidence_block(events):
    """Block rate over INSTRUMENTED runs.

    Denominator = runs that emitted a run_start event (instrumented).
    Numerator   = those runs that also emitted >=1 evidence_block event.
    A proof corpus with no run_start events -> available=False (not 0%),
    so we never present an old, un-instrumented corpus as "0% block rate".
    """
    instrumented = set()
    blocked = set()
    block_events = 0
    for e in events:
        et = e.get("type")
        rid = e.get("run_id") or "unknown"
        if et == EVENT_RUN_START:
            instrumented.add(rid)
        elif et == EVENT_EVIDENCE_BLOCK:
            blocked.add(rid)
            block_events += 1
    # Only count runs that are instrumented; a block event for a run with no
    # run_start still proves instrumentation of that run, so union them in.
    instrumented |= blocked
    n = len(instrumented)
    if n == 0:
        return {
            "available": False,
            "reason": "no instrumented runs yet (no run_start events in "
                      "trust-events.jsonl). Distinct from a measured 0%.",
        }
    blocked_runs = len(blocked & instrumented)
    return {
        "available": True,
        "instrumented_runs": n,
        "runs_with_block": blocked_runs,
        "block_events_total": block_events,
        "block_rate": round(blocked_runs / n, 4),
    }


# ---------------------------------------------------------------------------
# Metric 2: gate failure-rate distribution per run
# ---------------------------------------------------------------------------

def _metric_gate_distribution(events):
    """Per-run gate-failure counts + which-gate breakdown, then a distribution.

    Each gate_failure event carries gate=<name>. We tally per run, then report
    median / p90 of the per-run failure counts across instrumented runs, plus
    the aggregate which-gate breakdown. Denominator = instrumented runs.
    """
    instrumented = set()
    per_run_counts = {}
    gate_breakdown = {}
    for e in events:
        et = e.get("type")
        rid = e.get("run_id") or "unknown"
        if et == EVENT_RUN_START:
            instrumented.add(rid)
            per_run_counts.setdefault(rid, 0)
        elif et == EVENT_GATE_FAILURE:
            instrumented.add(rid)
            per_run_counts[rid] = per_run_counts.get(rid, 0) + 1
            gate = str(e.get("gate") or "unknown")
            gate_breakdown[gate] = gate_breakdown.get(gate, 0) + 1
    n = len(instrumented)
    if n == 0:
        return {
            "available": False,
            "reason": "no instrumented runs yet (no run_start/gate_failure "
                      "events). Distinct from a measured 0 failures.",
        }
    counts = sorted(per_run_counts.get(rid, 0) for rid in instrumented)
    total_failures = sum(counts)
    return {
        "available": True,
        "instrumented_runs": n,
        "total_gate_failures": total_failures,
        "per_run_median": _median(counts),
        "per_run_p90": _percentile(counts, 90),
        "per_run_max": counts[-1] if counts else 0,
        "gate_breakdown": dict(sorted(gate_breakdown.items())),
    }


# ---------------------------------------------------------------------------
# Metric 3: council rejection / split rate
# ---------------------------------------------------------------------------

def _metric_council(events):
    """Rejection rate and split-verdict-among-rejections rate over all votes.

    Each council_vote event carries approve, reject, result. A "split" reject
    is a REJECTED vote that still had at least one approver (approve > 0).
    Denominator = total recorded council votes.
    """
    votes = [e for e in events if e.get("type") == EVENT_COUNCIL_VOTE]
    total = len(votes)
    if total == 0:
        return {
            "available": False,
            "reason": "no council votes recorded in trust-events.jsonl. "
                      "Distinct from a measured 0% rejection rate.",
        }
    rejected = 0
    split_rejected = 0
    for v in votes:
        result = str(v.get("result") or "").strip().upper()
        approve = _to_int(v.get("approve"), 0)
        is_reject = result.startswith("REJECT") or (
            not result and _to_int(v.get("reject"), 0) > approve
        )
        if is_reject:
            rejected += 1
            if approve > 0:
                split_rejected += 1
    return {
        "available": True,
        "total_votes": total,
        "rejected_votes": rejected,
        "rejection_rate": round(rejected / total, 4),
        "split_rejected_votes": split_rejected,
        # Split rate is reported as a fraction OF the rejections (per the doc:
        # "of those, the split-verdict fraction").
        "split_rate_of_rejections": (
            round(split_rejected / rejected, 4) if rejected else None
        ),
    }


# ---------------------------------------------------------------------------
# Metric 4: cost-per-verified-task (local denominator)
# ---------------------------------------------------------------------------

def _proof_cost(proof):
    """Return (usd, total_tokens) from a proof's cost block, or (None, None)."""
    cost = _obj(proof.get("cost"))
    usd = cost.get("usd")
    try:
        usd = float(usd)
    except (TypeError, ValueError):
        usd = None
    tokens = cost.get("total_tokens")
    if tokens is None:
        # Some proofs carry input/output separately.
        it = cost.get("input_tokens")
        ot = cost.get("output_tokens")
        if it is not None or ot is not None:
            tokens = _to_int(it, 0) + _to_int(ot, 0)
    try:
        tokens = int(tokens) if tokens is not None else None
    except (TypeError, ValueError):
        tokens = None
    return usd, tokens


def _metric_cost_per_verified(proofs):
    """Sum cost over verified runs / count(verified). Local denominator only.

    A "verified" run = proof.json council.final_verdict is a pass token.
    Honesty: if NO proof carries cost, available=False (we never divide a
    fabricated 0 cost). If cost exists but no run is verified, we say so
    explicitly rather than dividing by zero.
    """
    verified_with_cost = 0
    usd_sum = 0.0
    usd_seen = False
    tokens_sum = 0
    tokens_seen = False
    verified_total = 0
    any_cost = False

    for p in proofs:
        verdict_pass = _verdict_is_pass(_obj(p.get("council")).get("final_verdict"))
        usd, tokens = _proof_cost(p)
        if usd is not None or tokens is not None:
            any_cost = True
        if verdict_pass:
            verified_total += 1
            if usd is not None or tokens is not None:
                verified_with_cost += 1
                if usd is not None:
                    usd_sum += usd
                    usd_seen = True
                if tokens is not None:
                    tokens_sum += tokens
                    tokens_seen = True

    if not any_cost:
        return {
            "available": False,
            "reason": "no proof.json carries cost data (cost never collected "
                      "for any run). Distinct from a measured $0.",
            "note": NOTE_EXTERNAL_GRADER,
        }
    if verified_with_cost == 0:
        return {
            "available": False,
            "reason": "cost data exists but no run is verified-complete "
                      "(council.final_verdict pass) with cost; cannot divide.",
            "verified_runs": verified_total,
            "note": NOTE_EXTERNAL_GRADER,
        }
    return {
        "available": True,
        "verified_runs": verified_total,
        "verified_runs_with_cost": verified_with_cost,
        "total_usd": round(usd_sum, 6) if usd_seen else None,
        "total_tokens": tokens_sum if tokens_seen else None,
        "usd_per_verified": (
            round(usd_sum / verified_with_cost, 6) if usd_seen else None
        ),
        "tokens_per_verified": (
            round(tokens_sum / verified_with_cost, 1) if tokens_seen else None
        ),
        "note": NOTE_EXTERNAL_GRADER,
    }


# ---------------------------------------------------------------------------
# Top-level compute
# ---------------------------------------------------------------------------

def compute_trust_metrics(loki_dir):
    events = _load_events(loki_dir)
    proofs = _load_proofs(loki_dir)
    run_starts = sum(1 for e in events if e.get("type") == EVENT_RUN_START)

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _utc_now(),
        "loki_dir": loki_dir,
        "scope": "single-project",
        "corpus": {
            "events_total": len(events),
            "instrumented_runs": run_starts,
            "proofs_total": len(proofs),
        },
        "metrics": {
            "evidence_block_rate": _metric_evidence_block(events),
            "gate_failure_distribution": _metric_gate_distribution(events),
            "council_rejection_rate": _metric_council(events),
            "cost_per_verified_task": _metric_cost_per_verified(proofs),
        },
    }


def write_metrics_cache(loki_dir, m):
    out_dir = os.path.join(loki_dir, "metrics")
    out_path = os.path.join(out_dir, "trust-metrics.json")
    try:
        os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=2)
        return out_path
    except Exception:
        return None


def format_metrics_json(m):
    return json.dumps(m, indent=2)


# ---------------------------------------------------------------------------
# Human formatting
# ---------------------------------------------------------------------------

def _fmt_pct(x):
    return "n/a" if x is None else ("%.1f%%" % (x * 100.0))


def format_metrics_human(m):
    lines = []
    corpus = _obj(m.get("corpus"))
    lines.append("Loki Mode Trust Metrics  (snapshot at %s)" % m.get("generated_at"))
    lines.append("Source: %s  [single project]" % m.get("loki_dir"))
    lines.append(
        "Corpus: %d events, %d instrumented run(s), %d proof(s)"
        % (corpus.get("events_total", 0),
           corpus.get("instrumented_runs", 0),
           corpus.get("proofs_total", 0))
    )
    lines.append("")
    mt = _obj(m.get("metrics"))

    # Metric 1
    e = _obj(mt.get("evidence_block_rate"))
    lines.append("1. Evidence-gate block rate")
    if not e.get("available"):
        lines.append("   not instrumented: %s" % e.get("reason"))
    else:
        lines.append(
            "   %s of runs caught an unproven 'done' claim  "
            "(%d/%d runs, %d block events)  n=%d"
            % (_fmt_pct(e.get("block_rate")),
               e.get("runs_with_block", 0),
               e.get("instrumented_runs", 0),
               e.get("block_events_total", 0),
               e.get("instrumented_runs", 0))
        )
    lines.append("")

    # Metric 2
    g = _obj(mt.get("gate_failure_distribution"))
    lines.append("2. Gate failure distribution per run")
    if not g.get("available"):
        lines.append("   not instrumented: %s" % g.get("reason"))
    else:
        lines.append(
            "   per-run failures  median=%s  p90=%s  max=%s  "
            "(total=%d over n=%d runs)"
            % (g.get("per_run_median"), g.get("per_run_p90"),
               g.get("per_run_max"), g.get("total_gate_failures", 0),
               g.get("instrumented_runs", 0))
        )
        breakdown = _obj(g.get("gate_breakdown"))
        if breakdown:
            lines.append("   which gate fired:")
            for name, cnt in breakdown.items():
                lines.append("     %-28s %d" % (name, cnt))
    lines.append("")

    # Metric 3
    c = _obj(mt.get("council_rejection_rate"))
    lines.append("3. Council rejection / split rate")
    if not c.get("available"):
        lines.append("   not instrumented: %s" % c.get("reason"))
    else:
        lines.append(
            "   rejection rate %s  (%d/%d votes)"
            % (_fmt_pct(c.get("rejection_rate")),
               c.get("rejected_votes", 0), c.get("total_votes", 0))
        )
        sr = c.get("split_rate_of_rejections")
        lines.append(
            "   split verdicts among rejections: %s  (%d/%d)"
            % (_fmt_pct(sr) if sr is not None else "n/a",
               c.get("split_rejected_votes", 0), c.get("rejected_votes", 0))
        )
    lines.append("")

    # Metric 4
    cv = _obj(mt.get("cost_per_verified_task"))
    lines.append("4. Cost per VERIFIED task  (local denominator)")
    if not cv.get("available"):
        lines.append("   not available: %s" % cv.get("reason"))
    else:
        usd = cv.get("usd_per_verified")
        tok = cv.get("tokens_per_verified")
        lines.append(
            "   $%s / verified run" % ("%.4f" % usd if usd is not None else "n/a")
            + ("   %.0f tokens / verified run" % tok if tok is not None else "")
        )
        lines.append(
            "   over %d verified run(s) with cost data"
            % cv.get("verified_runs_with_cost", 0)
        )
    lines.append("")
    lines.append("Honesty note: each metric reports its own n=. 'not instrumented'")
    lines.append("means no source artifact exists yet, NOT a measured zero.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _resolve_loki_dir(argv):
    for i, a in enumerate(argv):
        if a == "--loki-dir" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--loki-dir="):
            return a.split("=", 1)[1]
    env = os.environ.get("LOKI_DIR")
    if env:
        return env
    return os.path.join(os.getcwd(), ".loki")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    as_json = "--json" in argv
    no_cache = "--no-cache" in argv
    if "--all-projects" in argv:
        sys.stderr.write(
            "loki trust-metrics: --all-projects is out of scope (single "
            "project only). Run it inside each project directory.\n"
        )
        return 2
    loki_dir = _resolve_loki_dir(argv)
    m = compute_trust_metrics(loki_dir)
    if not no_cache:
        write_metrics_cache(loki_dir, m)
    if as_json:
        sys.stdout.write(format_metrics_json(m) + "\n")
    else:
        sys.stdout.write(format_metrics_human(m) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
