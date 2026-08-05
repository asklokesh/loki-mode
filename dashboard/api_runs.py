"""Read-only "runs" view over the filesystem .loki/ directory.

NOT dashboard/runs.py. That module is the SQLAlchemy Run/RunEvent control
plane (a database row per run, created by the dashboard). This module reads
the engine's own on-disk state under .loki/ -- what the runner actually wrote
-- and never touches a database. Same word, two different objects; do not
merge them.

WHY THIS EXISTS. The dashboard's primary object is a run, and it had zero
routes able to list one from engine state. These are pure functions taking a
loki_dir, so they are testable without FastAPI and can be mounted by whoever
owns server.py.

THE SOURCES, and what each can and cannot tell us:

  .loki/metrics/trust-events.jsonl   append-only, one record per trust event,
      each carrying run_id (minted per run as run-<ts>-<pid>-<rand> by
      _loki_trust_run_id in autonomy/run.sh). THE ONLY source that survives
      across runs, and therefore the only reason list_runs can be plural.
  .loki/state/trust-run-id           the CURRENT run's minted id.
  .loki/metrics/efficiency/iteration-*.json   per-iteration cost and tokens.
      WIPED at run start (autonomy/run.sh:6212), so these describe the current
      run ONLY. A historical run's row therefore reports cost UNKNOWN -- not
      zero -- because the evidence was deleted, which is a real absence of
      measurement and must read as one.
  .loki/state/completion.json        terminal outcome of the last run.
  .loki/loki-run.json                run manifest (schema loki-run-manifest/v1).
  .loki/PAUSE, .loki/STOP, .loki/session.json   live status signals.

THE HONESTY RULE. An unmeasured cost is None, never 0.0. That predicate is
record_is_measured() in autonomy/lib/efficiency_cost.py and it is IMPORTED
here, not restated. Its own docstring explains why: "A second copy of this
predicate is how the honesty rule drifts: the four surfaces that once rendered
an unmeasured run as $0.00 each had their own idea of what counted as
measured." dashboard/server.py keeps a deliberate mirror; this module does not
add a third. If autonomy/lib is unreachable the cost fields read UNKNOWN and
the envelope says so -- a degraded read never invents a number.

Every returned envelope states `source` (the real paths read) and
`freshness_s` (age in seconds of the newest file that actually contributed,
None when nothing did), and carries an explicit `reason` when empty.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Optional

__all__ = ["list_runs", "get_run", "UNKNOWN"]

# What an unmeasured value reads as. Kept as a name so callers can render it
# without hardcoding None-means-unknown at each call site.
UNKNOWN = None

_RUN_ID_FILE = ("state", "trust-run-id")
_TRUST_EVENTS = ("metrics", "trust-events.jsonl")
_EFFICIENCY_DIR = ("metrics", "efficiency")
_COMPLETION = ("state", "completion.json")
_MANIFEST = "loki-run.json"
_SESSION = "session.json"
_ORCHESTRATOR = os.path.join("state", "orchestrator.json")

# Declared for the envelope so a caller can see exactly what was read, in the
# style already used at autonomy/loki:21677 (a real path, not a label).
_SOURCE_PATHS = (
    ".loki/metrics/trust-events.jsonl",
    ".loki/state/trust-run-id",
    ".loki/metrics/efficiency/iteration-*.json",
    ".loki/state/completion.json",
    ".loki/loki-run.json",
    ".loki/session.json",
)


# ---------------------------------------------------------------------------
# tiny io helpers -- every one of them returns a default rather than raising,
# because a dashboard read must degrade, never 500 on a missing file.
# ---------------------------------------------------------------------------

def _p(loki_dir: str, *parts: str) -> str:
    return os.path.join(loki_dir, *parts)


def _read_json(path: str, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def _mtime(path: str) -> Optional[float]:
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _freshness(mtimes: list, now: Optional[float] = None) -> Optional[int]:
    """Age in seconds of the NEWEST file that contributed. None if none did.

    None is load-bearing: "no file contributed" is not "contributed zero
    seconds ago". Clamped at 0 because a file written during this call (or by
    a clock that stepped) must not report a negative age.
    """
    real = [m for m in mtimes if m is not None]
    if not real:
        return None
    return max(0, int((now if now is not None else time.time()) - max(real)))


# ---------------------------------------------------------------------------
# the canonical measured-ness predicate, imported not copied
# ---------------------------------------------------------------------------

_EFF_MOD: Any = None
_EFF_TRIED = False


def _efficiency_module():
    """Load autonomy/lib/efficiency_cost.py by path. None if unreachable.

    autonomy/lib is not an importable package (proof-generator.py has a hyphen
    in its name), so server.py already loads siblings this way -- see
    _trust_module() at dashboard/server.py:7967. Cached, including the failure,
    so a missing file costs one stat per process rather than one per request.
    """
    global _EFF_MOD, _EFF_TRIED
    if _EFF_TRIED:
        return _EFF_MOD
    _EFF_TRIED = True
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    mod_path = os.path.join(repo_root, "autonomy", "lib", "efficiency_cost.py")
    try:
        import importlib.util as ilu
        spec = ilu.spec_from_file_location("loki_efficiency_cost", mod_path)
        if spec is None or spec.loader is None:
            return None
        mod = ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _EFF_MOD = mod
    except Exception:
        _EFF_MOD = None
    return _EFF_MOD


# ---------------------------------------------------------------------------
# per-iteration cost, from the current run's efficiency records
# ---------------------------------------------------------------------------

def _iteration_records(loki_dir: str) -> list:
    """[(iteration_int, record_dict, path)] sorted by iteration.

    Sorted NUMERICALLY. A lexical sort puts iteration-10 before iteration-2,
    which silently misorders any run past nine iterations.
    """
    eff_dir = _p(loki_dir, *_EFFICIENCY_DIR)
    try:
        names = os.listdir(eff_dir)
    except OSError:
        return []
    out = []
    for name in names:
        if not (name.startswith("iteration-") and name.endswith(".json")):
            continue
        path = os.path.join(eff_dir, name)
        rec = _read_json(path)
        if not isinstance(rec, dict):
            continue
        try:
            num = int(name[len("iteration-"):-len(".json")])
        except ValueError:
            continue
        out.append((num, rec, path))
    out.sort(key=lambda t: t[0])
    return out


def _cost_for_current_run(loki_dir: str):
    """(cost_usd, measured, note) for the run owning the efficiency dir.

    cost_usd is None whenever we did not measure -- no records, all-zero
    records, or the canonical module being unreachable. A genuine measured
    zero (records that carry data and sum to 0.0) stays 0.0; that distinction
    is the whole point of the predicate and is why collect_efficiency is
    called rather than re-summed here.
    """
    mod = _efficiency_module()
    if mod is None:
        return UNKNOWN, False, "efficiency_cost module unreachable"
    try:
        cost, _model = mod.collect_efficiency(loki_dir)
    except Exception as exc:
        return UNKNOWN, False, "efficiency read failed: %s" % (exc,)
    if not isinstance(cost, dict) or not cost.get("available"):
        return UNKNOWN, False, "no measured efficiency record"
    return cost.get("usd"), True, None


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

def _current_status(loki_dir: str) -> str:
    """Live status of the run occupying .loki/ right now.

    Precedence copied from the CLI's own status reader (autonomy/loki:4981):
    PAUSE file, then STOP file, then session.json status, then unknown. A
    missing file yields "unknown" and never "completed" -- absence of a signal
    is not evidence of success.
    """
    if os.path.isfile(_p(loki_dir, "PAUSE")):
        return "paused"
    if os.path.isfile(_p(loki_dir, "STOP")):
        return "stopped"
    session = _read_json(_p(loki_dir, _SESSION))
    if isinstance(session, dict):
        status = session.get("status")
        if status:
            return str(status)
    # THE CANONICAL PHASE, and the reason this fallback exists. session.json is
    # not written by the current runtime -- a live `loki start` produces
    # .loki/state/orchestrator.json instead, and the CLI reads its
    # `currentPhase` (autonomy/loki:4782). Reading only session.json made this
    # API report "unknown" for every live run while the CLI, on the same
    # workspace at the same instant, correctly reported BUILDING.
    #
    # Measured during a real run: CLI phase=BUILDING, API status=unknown.
    # Two surfaces disagreeing about one run is exactly the divergence the
    # operator API exists to prevent, so it now reads the same file the CLI
    # does.
    orch = _read_json(_p(loki_dir, _ORCHESTRATOR))
    if isinstance(orch, dict):
        phase = orch.get("currentPhase") or orch.get("phase")
        if phase:
            return str(phase).lower()
    return "unknown"


def _started_at(loki_dir: str, run_id: str, events: dict) -> Optional[str]:
    """Earliest trust-event ts for this run. None when never recorded."""
    stamps = [e.get("ts") for e in events.get(run_id, []) if e.get("ts")]
    return min(stamps) if stamps else None


# ---------------------------------------------------------------------------
# trust events: the only cross-run source
# ---------------------------------------------------------------------------

def _events_by_run(loki_dir: str) -> dict:
    """{run_id: [event, ...]} from trust-events.jsonl. Missing file -> {}.

    Malformed lines are skipped rather than failing the whole read: the file
    is appended to by a best-effort writer that can be killed mid-line, and one
    torn tail must not blank every run before it.
    """
    path = _p(loki_dir, *_TRUST_EVENTS)
    by_run: dict = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(rec, dict):
                    continue
                rid = rec.get("run_id")
                if not rid:
                    continue
                by_run.setdefault(str(rid), []).append(rec)
    except OSError:
        return {}
    return by_run


def _iterations_from_events(events: list) -> Optional[int]:
    """Highest iteration seen in this run's events, or None if never recorded.

    A LOWER BOUND, not a count. Trust events fire on trust events only, so a
    run that did ten iterations and emitted an event on three reports 3. It is
    the floor of what the run demonstrably did, which is why it is combined
    with max() against the other sources rather than trusted alone.

    Events carry iteration as an int (trust_metrics.record_trust_event coerces
    it). A run whose events all report iteration 0 has no iteration evidence,
    so this reports None rather than claiming the run did zero iterations.
    """
    seen = [e.get("iteration") for e in events
            if isinstance(e.get("iteration"), int) and not isinstance(e.get("iteration"), bool)]
    nonzero = [i for i in seen if i > 0]
    return max(nonzero) if nonzero else None


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

def _row(loki_dir: str, run_id: str, is_current: bool, events: dict,
         now: Optional[float] = None) -> dict:
    """One run row. Cost is only ever attached to the CURRENT run.

    The efficiency directory is wiped at run start, so its records belong to
    whichever run holds .loki/ now. Attributing them to a historical run would
    be a fabricated fact; that run reads cost UNKNOWN with a stated reason.
    """
    run_events = events.get(run_id, [])
    contributing = [_mtime(_p(loki_dir, *_TRUST_EVENTS))]

    completion = _read_json(_p(loki_dir, *_COMPLETION))
    manifest = _read_json(_p(loki_dir, _MANIFEST))

    iterations = _iterations_from_events(run_events)
    cost_usd: Any = UNKNOWN
    measured = False
    note = "cost records are wiped at run start; only the current run has them"

    if is_current:
        cost_usd, measured, cost_note = _cost_for_current_run(loki_dir)
        note = cost_note
        recs = _iteration_records(loki_dir)
        if recs:
            contributing.extend(_mtime(path) for _n, _r, path in recs)
            # The efficiency records are the sharper iteration evidence for the
            # live run; events only see iterations that emitted a trust event.
            #
            # `or None` for the same reason cost is None when unmeasured: a run
            # whose only record is iteration-0 has produced no evidence that any
            # iteration completed, and a rendered "0 iterations" is a plausible
            # -looking fact we did not measure. Every path into `iterations`
            # applies this rule, so the field is never a fabricated zero.
            iterations = max(iterations or 0, max(n for n, _r, _p2 in recs)) or None
        if isinstance(manifest, dict) and isinstance(manifest.get("iterations"), int):
            contributing.append(_mtime(_p(loki_dir, _MANIFEST)))
            iterations = max(iterations or 0, manifest["iterations"]) or None

    status = _current_status(loki_dir) if is_current else "unknown"
    if isinstance(completion, dict) and completion.get("outcome"):
        # A terminal outcome is the authoritative end state. Only the current
        # run's .loki/ wrote it, so it never labels a historical run.
        if is_current:
            status = str(completion["outcome"])
            contributing.append(_mtime(_p(loki_dir, *_COMPLETION)))

    return {
        "id": run_id,
        "status": status,
        "started_at": _started_at(loki_dir, run_id, events),
        "iterations": iterations,
        "cost_usd": cost_usd,
        "measured": measured,
        "cost_note": note,
        "current": is_current,
        "source": list(_SOURCE_PATHS),
        "freshness_s": _freshness(contributing, now=now),
    }


def list_runs(loki_dir: str, now: Optional[float] = None) -> dict:
    """Every run discoverable from .loki/, newest first.

    Returns an ENVELOPE, not a bare list, because the contract requires an
    explicit reason when the result is empty and a list cannot carry one:

        {"runs": [...], "source": [...], "freshness_s": int|None,
         "reason": None|str}

    reason is None when runs is non-empty. When runs is empty it states why in
    words -- no .loki, no run id ever minted, and so on. An empty list is never
    padded with a placeholder row.
    """
    envelope = {
        "runs": [],
        "source": list(_SOURCE_PATHS),
        "freshness_s": None,
        "reason": None,
    }
    if not loki_dir or not os.path.isdir(loki_dir):
        envelope["reason"] = "no .loki directory at %s" % (loki_dir,)
        return envelope

    events = _events_by_run(loki_dir)
    current_id = _read_text(_p(loki_dir, *_RUN_ID_FILE))

    ids = list(events.keys())
    if current_id and current_id not in ids:
        ids.append(current_id)

    if not ids:
        envelope["reason"] = (
            "no run id found: .loki/state/trust-run-id is absent and "
            ".loki/metrics/trust-events.jsonl recorded no run_id"
        )
        return envelope

    rows = [_row(loki_dir, rid, rid == current_id, events, now=now) for rid in ids]
    # Newest first. started_at is None for a run that never recorded one, and
    # those sort last rather than being dropped or dated.
    rows.sort(key=lambda r: (r["started_at"] is not None, r["started_at"] or ""),
              reverse=True)
    envelope["runs"] = rows
    envelope["freshness_s"] = _freshness(
        [_mtime(_p(loki_dir, *_TRUST_EVENTS)), _mtime(_p(loki_dir, *_RUN_ID_FILE))],
        now=now,
    )
    return envelope


def get_run(loki_dir: str, run_id: str, now: Optional[float] = None) -> dict:
    """One run, plus per-iteration detail. Same envelope discipline.

        {"run": {...}|None, "iterations": [...], "source": [...],
         "freshness_s": int|None, "reason": None|str}

    Per-iteration detail exists only for the CURRENT run (the records are
    wiped at run start). For any other run `iterations` is empty and `reason`
    says why, rather than returning invented rows.
    """
    envelope = {
        "run": None,
        "iterations": [],
        "source": list(_SOURCE_PATHS),
        "freshness_s": None,
        "reason": None,
    }
    if not loki_dir or not os.path.isdir(loki_dir):
        envelope["reason"] = "no .loki directory at %s" % (loki_dir,)
        return envelope
    if not run_id:
        envelope["reason"] = "no run_id given"
        return envelope

    events = _events_by_run(loki_dir)
    current_id = _read_text(_p(loki_dir, *_RUN_ID_FILE))
    if run_id not in events and run_id != current_id:
        envelope["reason"] = "run %s not found in .loki" % (run_id,)
        return envelope

    is_current = run_id == current_id
    row = _row(loki_dir, run_id, is_current, events, now=now)
    envelope["run"] = row
    envelope["freshness_s"] = row["freshness_s"]

    if not is_current:
        envelope["reason"] = (
            "per-iteration detail unavailable: .loki/metrics/efficiency is "
            "wiped at run start and now belongs to run %s" % (current_id or "unknown",)
        )
        return envelope

    mod = _efficiency_module()
    recs = _iteration_records(loki_dir)
    if not recs:
        envelope["reason"] = (
            "no per-iteration records at .loki/metrics/efficiency/iteration-*.json"
        )
        return envelope

    for num, rec, path in recs:
        # Per-iteration measured-ness uses the SAME canonical predicate as the
        # aggregate, so one iteration cannot be called measured by a rule the
        # total disagrees with.
        if mod is None:
            measured = False
        else:
            measured = bool(mod.record_is_measured(rec))
        envelope["iterations"].append({
            "iteration": num,
            "measured": measured,
            "cost_usd": rec.get("cost_usd") if measured else UNKNOWN,
            "input_tokens": rec.get("input_tokens") if measured else UNKNOWN,
            "output_tokens": rec.get("output_tokens") if measured else UNKNOWN,
            "model": rec.get("model") or UNKNOWN,
            "phase": rec.get("phase") or UNKNOWN,
            "status": rec.get("status") or UNKNOWN,
            "duration_ms": rec.get("duration_ms"),
            "timestamp": rec.get("timestamp") or UNKNOWN,
            "source": ".loki/metrics/efficiency/%s" % os.path.basename(path),
            "freshness_s": _freshness([_mtime(path)], now=now),
        })
    return envelope
