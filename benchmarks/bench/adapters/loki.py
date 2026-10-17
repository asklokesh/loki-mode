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
import re

try:
    from . import _base
except ImportError:  # allow running as a loose script / sys.path import
    import _base  # type: ignore


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))


def loki_bin():
    """Binary the bench runs. Default is the repo's own bin/loki, NEVER bare
    `loki` on PATH (a stale global install made a paid run measure old code
    while recording the repo SHA). LOKI_BENCH_LOKI_BIN overrides."""
    override = os.environ.get("LOKI_BENCH_LOKI_BIN", "").strip()
    return override or os.path.join(REPO_ROOT, "bin", "loki")


def parse_loki_version(text):
    """Extract X.Y.Z from `Loki Mode vX.Y.Z`. None if absent."""
    m = re.search(r"Loki Mode v(\d+\.\d+\.\d+)", text or "")
    return m.group(1) if m else None


def repo_version():
    try:
        with open(os.path.join(REPO_ROOT, "VERSION")) as fh:
            return fh.read().strip()
    except OSError:
        return None


def version_mismatch_error(probed_text):
    """Return an error string when the probed binary is not the repo version,
    else None. LOKI_BENCH_ALLOW_VERSION_MISMATCH=1 waives the check."""
    if os.environ.get("LOKI_BENCH_ALLOW_VERSION_MISMATCH") == "1":
        return None
    probed = parse_loki_version(probed_text)
    want = repo_version()
    if probed is not None and probed == want:
        return None
    return ("loki binary %s reports version %s but the repo VERSION is %s; "
            "refusing a paid run that would measure different code. Set "
            "LOKI_BENCH_LOKI_BIN to a matching build or "
            "LOKI_BENCH_ALLOW_VERSION_MISMATCH=1 to override."
            % (loki_bin(), probed or "unknown", want or "unknown"))


def _detect_loki_version(runner=None, cwd=None):
    """Best-effort `loki version` probe. Returns a string or None."""
    rc, out, _err, _status, _dur = _base.run_cli(
        [loki_bin(), "version"], cwd=cwd or os.getcwd(), timeout=30, runner=runner
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


TAIL_CHARS = 2000


def _tail(text, n=TAIL_CHARS):
    text = text or ""
    return text[-n:]


def _latest_v10_run_dir(loki_dir):
    """Newest .loki/runs/<run-id> dir (engine10 layout, ENGINE.md section 9/10),
    or None. Run ids are timestamp-prefixed so the largest name is the latest."""
    runs = os.path.join(loki_dir, "runs")
    try:
        names = sorted(d for d in os.listdir(runs)
                       if os.path.isdir(os.path.join(runs, d)))
    except Exception:
        return None
    return os.path.join(runs, names[-1]) if names else None


def _read_json_file(path):
    try:
        with open(path) as fh:
            obj = json.load(fh)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _read_v10_events(run_dir):
    """Parsed events from <run_dir>/events.jsonl, or None when unreadable."""
    if not run_dir:
        return None
    events = []
    try:
        with open(os.path.join(run_dir, "events.jsonl")) as fh:
            for line in fh:
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if isinstance(ev, dict):
                    events.append(ev)
    except Exception:
        return None
    return events


def _read_v10_receipt(loki_dir):
    """engine10 receipt.json (schema loki.v10.receipt/1) of the latest run, or None."""
    run_dir = _latest_v10_run_dir(loki_dir)
    return _read_json_file(os.path.join(run_dir, "receipt.json")) if run_dir else None


def _read_v10_failure_reason(loki_dir):
    """Failure reason from engine10 events: the last stage.failed (stage name as
    class, its reason as brief), else a cap.hit. None when the log shows neither."""
    events = _read_v10_events(_latest_v10_run_dir(loki_dir))
    if not events:
        return None
    for ev in reversed(events):
        data = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        if ev.get("type") == "stage.failed":
            return {"error_class": ev.get("stage") or "stage.failed",
                    "brief": data.get("reason")}
        if ev.get("type") == "cap.hit":
            return {"error_class": "cap.hit", "brief": json.dumps(data, sort_keys=True)[:300]}
    return None


def _read_iteration_count(loki_dir):
    """Iteration count for the bench schema. CANONICAL source is the
    events.jsonl 'iteration_complete' count (matches speed-benchmark.sh); the
    session.json/autonomy-state.json counter is only a FALLBACK for when
    events.jsonl is absent (older runs)."""
    # engine10: one provider session per session.started event.
    v10 = _read_v10_events(_latest_v10_run_dir(loki_dir))
    if v10:
        n = sum(1 for ev in v10 if ev.get("type") == "session.started")
        if n:
            return n
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
    v10 = _read_v10_failure_reason(loki_dir)
    if v10 is not None:
        return v10
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
    receipt = _read_v10_receipt(loki_dir)
    if receipt is not None and isinstance(receipt.get("verdict"), str):
        np = receipt.get("not_proven")
        return {"headline": receipt["verdict"].strip() or None,
                "degraded": np if isinstance(np, list) else None}
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


LEVER_ENV_KEY = re.compile(r"^LOKI_[A-Z0-9_]+$")


def validate_lever_env(extra_env):
    """Return a clean {KEY: str(value)} lever dict. Only LOKI_* keys are allowed;
    anything else raises ValueError so a bench run never forwards arbitrary env."""
    out = {}
    for k, v in (extra_env or {}).items():
        if not isinstance(k, str) or not LEVER_ENV_KEY.match(k):
            raise ValueError("lever env key %r must match LOKI_[A-Z0-9_]+" % (k,))
        out[k] = str(v)
    return out


def _cache_tokens_by_phase(loki_dir, cost, eff):
    """{phase: {cache_read, cache_creation}} so cache economics are comparable
    across lever configs. Ledger records give child phases; the remainder of the
    collected total is the main session. None when no cache field was recorded."""
    cr, cc = cost.get("cache_read_tokens"), cost.get("cache_creation_tokens")
    if cr is None and cc is None:
        return None
    records = None
    if eff is not None:
        try:
            records, _bad = eff.read_child_ledger(loki_dir)
        except Exception:
            records = None
    per = {}
    for rec in records or []:
        ph = str(rec.get("phase") or "unknown")
        slot = per.setdefault(ph, {"cache_read": 0, "cache_creation": 0})
        for key, src in (("cache_read", "cache_read_tokens"),
                         ("cache_creation", "cache_creation_tokens")):
            v = rec.get(src)
            if isinstance(v, int) and not isinstance(v, bool):
                slot[key] += v
    main = {"cache_read": max(0, (cr or 0) - sum(p["cache_read"] for p in per.values())),
            "cache_creation": max(0, (cc or 0) - sum(p["cache_creation"] for p in per.values()))}
    return {("main_session" if per else "total"): main, **per}


def run(workdir, spec, *, model="claude", timeout=900, runner=None,
        provider="claude", profile=None, extra_env=None):
    """Run Loki on `spec` inside `workdir` and return the adapter-output dict.

    Args:
      workdir: directory to run in (the spec should already be present/copied).
      spec: path (relative to workdir or absolute) of the spec to build from.
      model: provider/model label recorded as model_used fallback.
      timeout: hard wall-clock cap in seconds.
      runner: injectable subprocess.run-compatible callable (tests mock the CLI).
      provider: provider passed to `loki start --provider`.
      profile: cost profile exported as LOKI_COST_PROFILE ("lean" or "off");
        None leaves the env untouched. Recorded as provenance.cost_profile.
      extra_env: LOKI_* lever overrides for one-lever ablations; recorded as
        provenance.lever_env so rows from different configs never pool.
    """
    lever_env = validate_lever_env(extra_env)
    tool_version = _detect_loki_version(runner=runner, cwd=workdir)

    cmd = [
        loki_bin(), "start", spec,
        "--provider", provider,
        "--no-dashboard",
        "--yes",
        # The seed's origin is a placeholder URL: never let the PR stage push to it.
        "--no-pr",
    ]
    # Prompts off so a stray fetch against the placeholder origin fails fast
    # instead of blocking on a credential prompt.
    run_env = {"LOKI_AUTO_CONFIRM": "true", "GIT_TERMINAL_PROMPT": "0",
               "GH_PROMPT_DISABLED": "1"}
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
    if profile:
        run_env["LOKI_COST_PROFILE"] = str(profile)
    run_env.update(lever_env)
    _pin = (model or "").strip().lower()
    _REAL_MODEL_ALIASES = ("haiku", "sonnet", "opus", "fable")
    if (
        "LOKI_SESSION_MODEL" not in os.environ
        and _pin
        and (_pin in _REAL_MODEL_ALIASES or _pin.startswith("claude-"))
    ):
        run_env["LOKI_SESSION_MODEL"] = _pin
    rc, out, err, status, duration = _base.run_cli(
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
    cache_by_phase = None
    eff = _base.load_efficiency_cost()
    if eff is not None:
        try:
            collected, model_from_eff = eff.collect_efficiency(loki_dir)
            cost = collected
            model_used = model_from_eff or None
            cache_by_phase = _cache_tokens_by_phase(loki_dir, cost, eff)
        except Exception:
            pass

    # The collector labels the main-session spend "implement", which misreads as a
    # phase split. With no ledger phases it is the whole run: call it "total";
    # beside ledger phases it is the main session: call it "main_session".
    phases = cost.get("cost_by_phase")
    if isinstance(phases, dict) and "implement" in phases:
        phases = dict(phases)
        main = phases.pop("implement")
        phases = {("main_session" if phases else "total"): main, **phases}

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
            "cost_by_phase": phases,
            "ledger": cost.get("ledger"),
            "cost_profile": profile or None,
            "lever_env": lever_env,
            "cache_tokens_by_phase": cache_by_phase,
            # True when the usd is a lower bound (token-only main session or
            # unpriced child sessions); a consumer must not treat it as complete.
            "cost_partial": bool(cost.get("cost_partial")),
            # The real process outcome, so a caller never has to infer rc from status.
            "rc": rc,
            "stdout_tail": _tail(out),
            "stderr_tail": _tail(err),
        },
    )
