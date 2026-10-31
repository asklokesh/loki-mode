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
import subprocess

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


def engine_sha():
    """HEAD SHA of the checkout that holds the loki binary the bench runs, so a
    row names the exact engine even when the harness comes from another branch.
    None when the binary is not inside a git checkout."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(loki_bin())))
    try:
        out = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    sha = (out.stdout or "").strip()
    return sha if out.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha) else None


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

# Full Anthropic model ids: claude-*, optional [1m] suffix, and the vendor
# forms anthropic/claude-* and <region>.anthropic.claude-* (Bedrock/Vertex).
_FULL_MODEL_ID = re.compile(
    r"^(?:claude-|(?:[a-z0-9-]+/)?anthropic[/.]claude-|[a-z]{2,6}\.anthropic\.claude-)")


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


def _run_outcome(loki_dir, rc):
    """(outcome, source). The receipt verdict (upper-cased) when readable; else the
    exit code: 0 is VERIFIED or ALREADY_SATISFIED (reported as VERIFIED, the
    receipt-less case cannot tell them apart and neither carries a diff to open a
    PR for beyond VERIFIED), 6 or 20 (the latter with LOKI_DURABLE_STATE=1) is
    PARTIAL, any other code is FAILED. (None, None) when rc is unknown."""
    receipt = _read_v10_receipt(loki_dir)
    if receipt is not None and isinstance(receipt.get("verdict"), str) and receipt["verdict"].strip():
        return receipt["verdict"].strip().upper(), "receipt"
    if rc == 0:
        return "VERIFIED", "exit_code"
    if rc in (6, 20):
        return "PARTIAL", "exit_code"
    if isinstance(rc, int):
        return "FAILED", "exit_code"
    return None, None


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


def _read_group_cost(loki_dir):
    """Group-run (multi-unit launcher) spend from the kind=group_cost efficiency
    records run_group.ts writes. Returns {usd, units_measured, units_unmeasured}
    or None when the run had no group records. usd is None when every group unit
    was unmeasured: unknown is never $0."""
    eff_dir = os.path.join(loki_dir, "metrics", "efficiency")
    try:
        names = sorted(os.listdir(eff_dir))
    except Exception:
        return None
    usd, priced, measured, unmeasured, seen = 0.0, False, 0, 0, False
    for name in names:
        if not (name.startswith("iteration-") and name.endswith(".json")):
            continue
        rec = _read_json_file(os.path.join(eff_dir, name))
        if rec is None or rec.get("kind") != "group_cost":
            continue
        seen = True
        v = rec.get("cost_usd")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            usd += float(v)
            priced = True
            u = rec.get("units_measured")
            measured += u if isinstance(u, int) and not isinstance(u, bool) else 1
        else:
            unmeasured += 1
    if not seen:
        return None
    return {"usd": round(usd, 4) if priced else None,
            "units_measured": measured, "units_unmeasured": unmeasured}


def _read_advisor(loki_dir):
    """Advisor use summed from the per-session result-cost records (advisor_calls, advisor_errors).
    Returns {calls, errors}, or None when no result-cost record exists: unknown is never zero.
    A record with no advisor_calls key means the session streamed no advisor call."""
    metrics = os.path.join(loki_dir, "metrics")
    try:
        names = sorted(os.listdir(metrics))
    except Exception:
        return None
    calls = errors = 0
    seen = False
    for name in names:
        if not (name.startswith("result-cost-") and name.endswith(".json")):
            continue
        rec = _read_json_file(os.path.join(metrics, name))
        if rec is None:
            continue
        seen = True
        for key in ("advisor_calls", "advisor_errors"):
            v = rec.get(key)
            if isinstance(v, int) and not isinstance(v, bool) and v > 0:
                if key == "advisor_calls":
                    calls += v
                else:
                    errors += v
    return {"calls": calls, "errors": errors} if seen else None


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
                         ("cache_creation", "cache_creation_tokens"),
                         ("input", "input_tokens")):
            v = rec.get(src)
            if isinstance(v, int) and not isinstance(v, bool):
                # "input" appears only when the ledger recorded it, so the
                # council cache share denominator is never guessed.
                slot[key] = slot.get(key, 0) + v
    main = {"cache_read": max(0, (cr or 0) - sum(p["cache_read"] for p in per.values())),
            "cache_creation": max(0, (cc or 0) - sum(p["cache_creation"] for p in per.values()))}
    return {("main_session" if per else "total"): main, **per}


def _collect_cost(loki_dir):
    """(cost, model_used, cache_by_phase) from the shared collector; the empty
    cost dict when it cannot load, so None usd keeps meaning not recorded."""
    cost = {"usd": None, "input_tokens": None, "output_tokens": None}
    eff = _base.load_efficiency_cost()
    if eff is None:
        return cost, None, None
    try:
        collected, model_from_eff = eff.collect_efficiency(loki_dir)
        if collected.get("usd") is None:
            fallback = _read_result_cost(loki_dir)
            if fallback is not None:
                collected, model_from_eff = fallback[0], fallback[1]
        return (collected, model_from_eff or None,
                _cache_tokens_by_phase(loki_dir, collected, eff))
    except Exception:
        return cost, None, None


def _read_result_cost(loki_dir):
    """Spend from .loki/metrics/result-cost-*.json (the provider's own
    total_cost_usd per session), for runs that wrote no efficiency records.
    Returns (cost dict, model) or None when no file carries a numeric cost:
    unknown is never zero."""
    metrics = os.path.join(loki_dir, "metrics")
    try:
        names = sorted(os.listdir(metrics))
    except Exception:
        return None
    usd, priced, model = 0.0, False, ""
    toks = {"input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_creation_tokens": 0}
    for name in names:
        if not (name.startswith("result-cost-") and name.endswith(".json")):
            continue
        rec = _read_json_file(os.path.join(metrics, name))
        if rec is None:
            continue
        v = rec.get("total_cost_usd")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            usd += float(v)
            priced = True
        for k in toks:
            t = rec.get(k)
            if isinstance(t, int) and not isinstance(t, bool):
                toks[k] += t
        if rec.get("model"):
            model = str(rec["model"])
    if not priced:
        return None
    return dict(toks, usd=round(usd, 4), available=True), model


def _read_stage_durations(loki_dir):
    """{stage: seconds} from the latest engine10 run's stage.completed events
    (data.duration_s). None when there is no readable event log or no stage
    carried a duration. A repeated stage keeps its last completion."""
    events = _read_v10_events(_latest_v10_run_dir(loki_dir))
    if not events:
        return None
    out = {}
    for ev in events:
        if ev.get("type") != "stage.completed" or not isinstance(ev.get("stage"), str):
            continue
        data = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        d = data.get("duration_s")
        if isinstance(d, (int, float)) and not isinstance(d, bool):
            out[ev["stage"]] = float(d)
    return out or None


def _num_sub(a, b):
    return round(a - b, 4) if isinstance(a, (int, float)) and isinstance(b, (int, float)) else None


def run(workdir, spec, *, model="claude", timeout=900, runner=None,
        provider="claude", profile=None, extra_env=None,
        interrupt_after_stage=None):
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
      interrupt_after_stage: resume-cost instrument (100x axis D). Kill the run
        when the stage line `(<stage> done` is printed, then `loki start
        --resume` it. provenance.resume records both legs; the extra cost over
        an uninterrupted control is computed by runner.run_resume_pair.
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
        and (_pin in _REAL_MODEL_ALIASES or _FULL_MODEL_ID.match(_pin))
    ):
        run_env["LOKI_SESSION_MODEL"] = (model or "").strip() if _FULL_MODEL_ID.match(_pin) else _pin
    # Stage lines print as `[00:17] plan  done ...` (name padded), and only
    # under --verbose, so the stop marker needs both.
    stop = (r"\[\d+:\d{2}\] %s\s+done\b" % re.escape(interrupt_after_stage)
            if interrupt_after_stage else None)
    if interrupt_after_stage:
        cmd.append("--verbose")
    rc, out, err, status, duration = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout, runner=runner,
        env=run_env, stop_marker=stop,
    )

    loki_dir = os.path.join(workdir, ".loki")
    resume = None
    if interrupt_after_stage:
        # Leg 1 was stopped at the marker (or finished before it: not killed).
        # Cost is cumulative in .loki, so the resume leg is total minus leg 1.
        leg1_cost, _m, _c = _collect_cost(loki_dir)
        resume = {"interrupt_after_stage": interrupt_after_stage,
                  "killed": status == "interrupted", "leg1_s": duration,
                  "leg1_usd": leg1_cost.get("usd"), "leg2_s": None,
                  "leg2_usd": None, "leg2_rc": None}
        if status == "interrupted":
            rc2, out2, err2, status2, dur2 = _base.run_cli(
                [loki_bin(), "start", "--resume"], cwd=workdir,
                timeout=timeout, runner=runner, env=run_env)
            resume["leg2_s"], resume["leg2_rc"] = dur2, rc2
            rc, out, err, status = rc2, out + out2, err + err2, status2
            duration = round(duration + dur2, 3)
    iterations = _read_iteration_count(loki_dir)
    failure_reason = _read_failure_reason(loki_dir)
    honesty = _read_honesty(loki_dir)
    verify_verdict = honesty["headline"] if honesty else None
    engine = _read_engine(loki_dir)
    run_outcome, run_outcome_source = _run_outcome(loki_dir, rc)

    # Cost: shared with the proof generator. None usd == not recorded.
    cost, model_used, cache_by_phase = _collect_cost(loki_dir)
    if resume is not None and resume["killed"]:
        resume["leg2_usd"] = _num_sub(cost.get("usd"), resume["leg1_usd"])

    # The collector labels the main-session spend "implement", which misreads as a
    # phase split. With no ledger phases it is the whole run: call it "total";
    # beside ledger phases it is the main session: call it "main_session".
    group_cost = _read_group_cost(loki_dir)
    phases = cost.get("cost_by_phase")
    if isinstance(phases, dict) and "implement" in phases:
        phases = dict(phases)
        main = phases.pop("implement")
        # Group unit spend is written as "implement"; show it as its own phase
        # so the main session is not overstated.
        if group_cost and group_cost["usd"] is not None:
            main = round(max(0.0, main - group_cost["usd"]), 4)
            phases["group"] = group_cost["usd"]
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
        cache_read_tokens=cost.get("cache_read_tokens"),
        cache_creation_tokens=cost.get("cache_creation_tokens"),
        exit_status=status if rc == 0 else status,
        provenance={
            "kind": "automated",
            "verified": True,
            "harness": "loki.start",
            "engine_sha": engine_sha(),
            "command": " ".join(cmd),
            # Why a terminal failure happened (from loki's own LAST_ERROR.json);
            # None on a clean run. Lets a failed trial be diagnosed and learned
            # from instead of showing only an opaque exit code.
            "failure_reason": failure_reason,
            # The build's honesty verdict (proof.json honesty.headline, e.g.
            # "VERIFIED" / "NOT VERIFIED"). None when no proof ran. This feeds the
            # equivalence report's HONESTY axis (was not_captured before this).
            "verify_verdict": verify_verdict,
            # The run's own outcome, from the receipt when one exists, else from
            # the exit code. Consumers decide PR-readiness from this, not from the
            # exit status, which records a PARTIAL (rc 6 or 20) as an error.
            "run_outcome": run_outcome,
            "run_outcome_source": run_outcome_source,
            # Persisted because the workdir is deleted after grading: the
            # gap behind a "WITH GAPS" headline must survive in the row.
            "honesty": honesty,
            "engine": engine,
            # Advisor calls the session actually streamed ({calls, errors}); None when no cost
            # record was written. The advisor parity verdict reads this to prove it attached.
            "advisor": _read_advisor(loki_dir),
            # True spend split by phase, and whether the child-session ledger
            # was read ("present") or missing ("absent"), from the shared
            # efficiency_cost collector.
            "cost_by_phase": phases,
            "group_cost": group_cost,
            "ledger": cost.get("ledger"),
            "cost_profile": profile or None,
            "lever_env": lever_env,
            "resume": resume,
            "journal_reuse_wall_s": resume["leg2_s"] if resume else None,
            "cache_tokens_by_phase": cache_by_phase,
            # Seconds per engine10 stage from the run's events.jsonl; None when
            # the run wrote no event log.
            "stage_durations_s": _read_stage_durations(loki_dir),
            # True when the usd is a lower bound (token-only main session or
            # unpriced child sessions); a consumer must not treat it as complete.
            "cost_partial": bool(cost.get("cost_partial")),
            # The real process outcome, so a caller never has to infer rc from status.
            "rc": rc,
            "stdout_tail": _tail(out),
            "stderr_tail": _tail(err),
        },
    )


LEAN_ARM = "loki-lean"


def run_lean(workdir, spec, **kwargs):
    """The `loki-lean` benchmark arm: the same run as `run` with LOKI_LEAN=1.

    `run` already passes --no-pr, so this arm never writes upstream. The row is
    labelled `loki-lean` (tool and provenance.arm) so it never pools with the
    plain `loki` arm; LOKI_LEAN=1 is recorded in provenance.lever_env.
    """
    extra = dict(kwargs.pop("extra_env", None) or {})
    extra["LOKI_LEAN"] = "1"
    out = run(workdir, spec, extra_env=extra, **kwargs)
    out["tool"] = LEAN_ARM
    out["provenance"]["arm"] = LEAN_ARM
    return out
