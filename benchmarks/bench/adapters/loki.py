#!/usr/bin/env python3
"""Loki Mode adapter for the R2 benchmark harness.

Runs `loki start <spec> --provider claude --no-dashboard --yes` in the workdir
(the magic-ab/run.sh pattern), then collects cost via the shared
efficiency_cost module so the benchmark's Loki cost equals the proof's Loki
cost. Reports ONLY what the run did: tool/version/model/duration/iterations/
tokens/cost/exit_status/provenance. It NEVER reports success or quality; the
read-only grader (outside the agent container) decides that.

Importable and unit-testable with the CLI mocked: the subprocess call happens
only inside run(), and the loki/version probe accepts an injectable runner.
"""

import json
import os

try:
    from . import _base
except ImportError:  # allow running as a loose script / sys.path import
    import _base  # type: ignore


def _detect_loki_version(runner=None, cwd=None):
    """Best-effort `loki version` probe. Returns a string or None."""
    rc, out, _err, _status, _dur = _base.run_cli(
        ["loki", "version"], cwd=cwd or os.getcwd(), timeout=30, runner=runner
    )
    if rc != 0:
        return None
    text = (out or "").strip()
    return text.splitlines()[0].strip() if text else None


def _count_iteration_completes(loki_dir):
    """Canonical iterations = count of 'iteration_complete' events in
    events.jsonl -- the SAME source speed-benchmark.sh uses (len(completes)),
    so the two harnesses can never disagree. events.jsonl is the real
    per-session timeline; session.json can be mid-write. Returns None if the
    file is absent/unreadable so the caller can fall back."""
    path = os.path.join(loki_dir, "events.jsonl")
    try:
        n = 0
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if isinstance(ev, dict) and ev.get("type") == "iteration_complete":
                    n += 1
        return n
    except Exception:
        return None


def _read_iteration_count(loki_dir):
    """Iteration count for the bench schema. CANONICAL source is the
    events.jsonl 'iteration_complete' count (matches speed-benchmark.sh); the
    session.json/autonomy-state.json counter is only a FALLBACK for when
    events.jsonl is absent (older runs)."""
    canonical = _count_iteration_completes(loki_dir)
    if canonical is not None:
        return canonical
    for name in ("session.json", "autonomy-state.json"):
        path = os.path.join(loki_dir, name)
        try:
            with open(path) as fh:
                state = json.load(fh)
        except Exception:
            continue
        if isinstance(state, dict):
            val = (state.get("iteration") or state.get("iterations")
                   or state.get("current_iteration"))
            if val is not None:
                try:
                    return int(val)
                except Exception:
                    return None
    return None


def _read_failure_reason(loki_dir):
    """The classified reason a terminal failure occurred, from the durable record
    loki itself writes (.loki/state/LAST_ERROR.json: {error_class, brief, ...}).
    A failure whose reason is not captured cannot be learned from -- so surface
    it. Returns a dict {error_class, brief} or None when there is no record
    (a clean run). Best-effort: any read/parse problem returns None."""
    path = os.path.join(loki_dir, "state", "LAST_ERROR.json")
    try:
        with open(path) as fh:
            rec = json.load(fh)
    except Exception:
        return None
    if not isinstance(rec, dict):
        return None
    cls = rec.get("error_class")
    brief = rec.get("brief")
    if cls is None and brief is None:
        return None
    return {"error_class": cls, "brief": brief}


def _read_honesty(loki_dir):
    """The LATEST proof's honesty block, reduced to {headline, degraded}.

    Source: .loki/proofs/<run_id>/proof.json -> honesty (run dirs are
    timestamp-prefixed, so the lexicographically largest is this run's final
    proof). Persisting degraded[] in the row matters because the workdir is
    deleted after grading: without it the cause of a "VERIFIED WITH GAPS"
    headline cannot be recovered. Returns None when no proof is readable
    (no proof machinery ran). Best-effort: any read/parse problem returns None.
    """
    proofs_dir = os.path.join(loki_dir, "proofs")
    try:
        run_dirs = sorted(
            d for d in os.listdir(proofs_dir)
            if os.path.isdir(os.path.join(proofs_dir, d))
        )
    except Exception:
        return None
    if not run_dirs:
        return None
    path = os.path.join(proofs_dir, run_dirs[-1], "proof.json")
    try:
        with open(path) as fh:
            proof = json.load(fh)
    except Exception:
        return None
    honesty = proof.get("honesty") if isinstance(proof, dict) else None
    if not isinstance(honesty, dict):
        return None
    headline = honesty.get("headline")
    headline = headline.strip() if isinstance(headline, str) and headline.strip() else None
    degraded = honesty.get("degraded")
    if not isinstance(degraded, list):
        degraded = None
    if headline is None and degraded is None:
        return None
    return {"headline": headline, "degraded": degraded}


def _read_verify_verdict(loki_dir):
    """The build's HONESTY verdict (honesty.headline, e.g. "VERIFIED" /
    "NOT VERIFIED") from the latest proof. This is the honesty AXIS the
    equivalence report reads from provenance.verify_verdict -- without it the
    axis is not_captured. Returns the headline string or None."""
    honesty = _read_honesty(loki_dir)
    return honesty["headline"] if honesty else None


def _read_engine(loki_dir):
    """Which engine produced this run, so rows are never compared across
    engines. engine10 writes .loki/engine.json {"engine": "v10"} (EV-1 marker);
    a .loki dir without the marker is the legacy autonomy/run.sh loop. None
    when there is no .loki dir at all (nothing ran)."""
    if not os.path.isdir(loki_dir):
        return None
    try:
        with open(os.path.join(loki_dir, "engine.json")) as fh:
            marker = json.load(fh)
        eng = marker.get("engine") if isinstance(marker, dict) else None
        if isinstance(eng, str) and eng.strip():
            return eng.strip()
    except Exception:
        pass
    return "legacy"


def run(workdir, spec, *, model="claude", timeout=900, runner=None,
        provider="claude"):
    """Run Loki on `spec` inside `workdir` and return the adapter-output dict.

    Args:
      workdir: directory to run in (the spec should already be present/copied).
      spec: path (relative to workdir or absolute) of the spec to build from.
      model: provider/model label recorded as model_used fallback.
      timeout: hard wall-clock cap in seconds.
      runner: injectable subprocess.run-compatible callable (tests mock the CLI).
      provider: provider passed to `loki start --provider`.
    """
    tool_version = _detect_loki_version(runner=runner, cwd=workdir)

    cmd = [
        "loki", "start", spec,
        "--provider", provider,
        "--no-dashboard",
        "--yes",
    ]
    run_env = {"LOKI_AUTO_CONFIRM": "true"}
    # Model pin: `loki start` has no --model flag; the whole-run tier pin is the
    # LOKI_SESSION_MODEL env var (run.sh:742, default sonnet). The `model` arg
    # here doubles as a provider LABEL ("claude") when no real model is chosen,
    # so only pin when it is an actual model alias / id -- otherwise we would set
    # LOKI_SESSION_MODEL="claude" (invalid) and silently change nothing. Without
    # this, `--model haiku` in the bench was dropped (the run stayed on sonnet),
    # making tier-routing (Rank 2) unmeasurable.
    # Do NOT promote the task-spec's default_model LABEL to a session pin when the
    # CALLER already set LOKI_SESSION_MODEL in the parent env (e.g. the matrix
    # runner pinning haiku). _base.run_cli merges os.environ then this run_env on
    # top, so an unconditional set here would clobber the caller's real pin with
    # the task label ("claude-sonnet-5") and silently dispatch sonnet. Only pin
    # from the `model` arg when the parent env did NOT already choose a model.
    _pin = (model or "").strip().lower()
    _REAL_MODEL_ALIASES = ("haiku", "sonnet", "opus", "fable")
    if (
        "LOKI_SESSION_MODEL" not in os.environ
        and _pin
        and (_pin in _REAL_MODEL_ALIASES or _pin.startswith("claude-"))
    ):
        run_env["LOKI_SESSION_MODEL"] = _pin
    rc, _out, _err, status, duration = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout, runner=runner,
        env=run_env,
    )

    loki_dir = os.path.join(workdir, ".loki")
    iterations = _read_iteration_count(loki_dir)
    failure_reason = _read_failure_reason(loki_dir)
    honesty = _read_honesty(loki_dir)
    verify_verdict = honesty["headline"] if honesty else None
    engine = _read_engine(loki_dir)

    # Cost: shared with the proof generator. None usd == not recorded.
    cost = {"usd": None, "input_tokens": None, "output_tokens": None}
    model_used = None
    eff = _base.load_efficiency_cost()
    if eff is not None:
        try:
            collected, model_from_eff = eff.collect_efficiency(loki_dir)
            cost = collected
            model_used = model_from_eff or None
        except Exception:
            pass

    return _base.build_output(
        tool="loki",
        tool_version=tool_version,
        model_used=model_used or model,
        duration_s=duration,
        iterations=iterations,
        tokens_in=cost.get("input_tokens"),
        tokens_out=cost.get("output_tokens"),
        cost_usd=cost.get("usd"),
        exit_status=status if rc == 0 else status,
        provenance={
            "kind": "automated",
            "verified": True,
            "harness": "loki.start",
            "command": " ".join(cmd),
            # Why a terminal failure happened (from loki's own LAST_ERROR.json);
            # None on a clean run. Lets a failed trial be diagnosed and learned
            # from instead of showing only an opaque exit code.
            "failure_reason": failure_reason,
            # The build's honesty verdict (proof.json honesty.headline, e.g.
            # "VERIFIED" / "NOT VERIFIED"). None when no proof ran. This feeds the
            # equivalence report's HONESTY axis (was not_captured before this).
            "verify_verdict": verify_verdict,
            # Persisted because the workdir is deleted after grading: the
            # gap behind a "WITH GAPS" headline must survive in the row.
            "honesty": honesty,
            "engine": engine,
            # True spend split by phase, and whether the child-session ledger
            # was read ("present") or missing ("absent"), from the shared
            # efficiency_cost collector.
            "cost_by_phase": cost.get("cost_by_phase"),
            "ledger": cost.get("ledger"),
        },
    )
