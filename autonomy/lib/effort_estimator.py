#!/usr/bin/env python3
"""Engineering-hours estimator for the per-build proof.json (Rank 6).

Replaces the naive "iterations x 15min" number (which is blind to the actual
work) with a WORK-based estimate: it reads the real signals available at
proof-generation time -- the git diff stat (insertions / deletions / files
changed), the number of files touched, whether tests were written, and the
task/PRD scope -- and predicts the equivalent human-engineering-hours plus a
low/high band.

Two methods, chosen HONESTLY at runtime:

  method="llm"       An LLM was available AND returned a parseable number. The
                     model id is recorded. Gated behind LOKI_EFFORT_LLM=1 so a
                     model is NEVER called on every build by default (cost /
                     latency / the 30s proof cap). Any failure -- no key, no
                     CLI, timeout, unparseable output -- FAILS OPEN to the
                     heuristic. We never emit method="llm" with a number the
                     model did not actually give us.

  method="heuristic" The deterministic work-based fallback. Same inputs, a
                     fixed formula, reproducible for identical inputs. This is
                     the default path (and the only path in headless CI /
                     offline). Labeled uncalibrated -- see `calibrated` below.

The estimate is ALWAYS labeled calibrated=false ("uncalibrated") in this lane:
no ground-truth engineer-hour dataset has scored it yet, so the number is a
transparent estimate, never presented as validated. A separate calibration
harness may flip that once an error metric clears a threshold.

inputs_hash: sha256 over the canonical inputs (diff stat + files + tests +
scope). Identical whether the method is llm or heuristic, so the estimate is
reproducible and auditable -- a reader can recompute the hash from the same
proof and confirm the estimator saw exactly these inputs.

This module is import-only and never raises to the caller: estimate() catches
everything and falls open to the heuristic (and, in the worst case, a zeroed
estimate) so proof.json generation can never be broken by it.
"""

import hashlib
import json
import os
import re
import subprocess


# Schema of the emitted effort_estimate object. Bumped if the shape changes so
# a reader can tell which estimator produced a given field set.
ESTIMATOR_VERSION = "1"

# The brief is stored truncated to this many chars in proof.json (matches
# proof-generator.generate()'s brief[:600]); the hashed brief_len is capped to
# the same bound so inputs_hash is recomputable from the written receipt.
_BRIEF_HASH_CAP = 600


def _canonical(obj):
    """Stable JSON serialization for hashing (sorted keys, compact)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def _to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _canonical_inputs(files_changed, tests, spec, iterations):
    """The exact inputs the estimate is a function of, in a canonical shape.

    Only work signals -- NOT wall-clock or cost, which are noisy and would make
    the hash non-reproducible across machines. Iteration count is carried as a
    weak secondary signal (it slightly widens the band) but is deliberately not
    the primary driver: the backlog AC requires the estimate reflect real work,
    not iteration count alone.
    """
    fc = files_changed or {}
    files = fc.get("files") or []
    t = tests or {}
    sp = spec or {}
    it = iterations or {}
    return {
        "diff": {
            "count": _to_int(fc.get("count")),
            "insertions": _to_int(fc.get("insertions")),
            "deletions": _to_int(fc.get("deletions")),
            # Sorted file paths so ordering never perturbs the hash.
            "files": sorted(
                str(f.get("path", "")) for f in files if isinstance(f, dict)
            ),
        },
        "tests": {
            "status": str(t.get("status") or "not_run"),
            "passed_count": _to_int(t.get("passed_count")),
            "failed_count": _to_int(t.get("failed_count")),
        },
        "scope": {
            # NOTE: the raw spec source is a filesystem PATH (e.g. an absolute
            # path into the build's temp dir), which is build-location noise, NOT
            # a work signal -- hashing it would make identical work produce
            # different hashes across machines/dirs. We hash only whether a spec
            # was present, plus the brief length (a real proxy for scope size).
            # The full brief text is not hashed (brittle to whitespace edits).
            "has_spec": bool(str(sp.get("source") or "")
                             not in ("", "codebase-analysis")),
            # Cap the hashed length at the SAME 600-char bound the generator
            # applies to spec.brief before writing proof.json (generate() does
            # brief[:600] after the estimate is computed). Without this cap, a
            # brief longer than 600 chars would hash the full length while the
            # receipt stores only 600, so a third party recomputing inputs_hash
            # from the written proof.json would get a different value -- the hash
            # would be self-consistent but NOT reproducible from the artifact,
            # defeating the auditability the hash exists for.
            "brief_len": min(len(str(sp.get("brief") or "")), _BRIEF_HASH_CAP),
        },
        "iterations": _to_int(it.get("count")),
    }


def _inputs_hash(canon_inputs):
    return hashlib.sha256(
        _canonical(canon_inputs).encode("utf-8")
    ).hexdigest()


def heuristic_estimate(canon_inputs):
    """Deterministic WORK-based hours from the canonical inputs.

    Model (transparent + reproducible):
      - A baseline per changed file (reading, wiring, context switching).
      - A per-line component on net churn (insertions + deletions), the bulk of
        the signal, scaled to a rough "lines of considered code per hour".
      - A test bonus: writing tests is real engineering effort the line count
        alone under-counts.
      - A scope bonus from the PRD/brief size (bigger specs = more design).

    Returns (hours, low, high) rounded to 2 decimals. The band is a fixed
    +/- fraction, slightly widened by iteration count (more back-and-forth =
    more uncertainty). Every constant is a stated assumption, NOT a calibrated
    value -- hence the estimate is always labeled uncalibrated.
    """
    diff = canon_inputs.get("diff", {})
    files = diff.get("files", []) or []
    n_files = _to_int(diff.get("count")) or len(files)
    churn = _to_int(diff.get("insertions")) + _to_int(diff.get("deletions"))

    # Test signal: from the tests block AND from test-looking changed files.
    tests = canon_inputs.get("tests", {})
    test_files = 0
    for p in files:
        pl = str(p).lower()
        if any(kw in pl for kw in
               ("test", "spec", ".test.", ".spec.", "_test.", "_spec.")):
            test_files += 1
    tests_ran = str(tests.get("status")) in ("verified", "failed", "passed")

    # --- constants (assumptions, uncalibrated) ---
    PER_FILE_HOURS = 0.15          # ~9 min of context per file touched
    LINES_PER_HOUR = 40.0          # considered (not typed) lines per hour
    TEST_FILE_BONUS_HOURS = 0.35   # writing a test file is real effort
    TESTS_RAN_BONUS_HOURS = 0.25   # having a runnable, green/red suite at all
    SCOPE_HOURS_PER_1K_CHARS = 0.5  # design time scaling with brief size

    hours = 0.0
    hours += n_files * PER_FILE_HOURS
    hours += (churn / LINES_PER_HOUR) if churn > 0 else 0.0
    hours += test_files * TEST_FILE_BONUS_HOURS
    if tests_ran:
        hours += TESTS_RAN_BONUS_HOURS
    brief_len = _to_int((canon_inputs.get("scope") or {}).get("brief_len"))
    hours += (brief_len / 1000.0) * SCOPE_HOURS_PER_1K_CHARS

    # A build that changed nothing is genuinely ~0 human-hours; do not invent
    # effort from a bare iteration count.
    if n_files == 0 and churn == 0:
        hours = 0.0

    hours = round(hours, 2)

    # Band: +/- 40% base, widened up to +20% more by iteration churn.
    iters = _to_int(canon_inputs.get("iterations"))
    widen = min(iters * 0.02, 0.20)
    low = round(hours * (1.0 - min(0.40 + widen, 0.75)), 2)
    high = round(hours * (1.0 + 0.40 + widen), 2)
    if low < 0:
        low = 0.0
    return hours, low, high


_HOURS_RE = re.compile(r"(-?\d+(?:\.\d+)?)")


def _parse_llm_hours(text):
    """Extract (hours, low, high) from an LLM completion, or None.

    Accepts a JSON object {"hours":..,"low":..,"high":..} anywhere in the
    output (preferred), else falls back to the first number as hours. Returns
    None on anything unparseable so the caller fails open. NEVER guesses a band
    it was not given: if only hours is found, low/high are derived as a fixed
    band around it (and the method is still honestly "llm" -- the CENTRAL number
    came from the model)."""
    if not text or not str(text).strip():
        return None
    s = str(text)
    # Prefer an embedded JSON object.
    for m in re.finditer(r"\{[^{}]*\}", s):
        try:
            obj = json.loads(m.group(0))
        except Exception:
            continue
        if isinstance(obj, dict) and "hours" in obj:
            try:
                h = float(obj["hours"])
            except (TypeError, ValueError):
                continue
            if h < 0:
                continue
            low = obj.get("low")
            high = obj.get("high")
            try:
                low = float(low) if low is not None else round(h * 0.6, 2)
            except (TypeError, ValueError):
                low = round(h * 0.6, 2)
            try:
                high = float(high) if high is not None else round(h * 1.4, 2)
            except (TypeError, ValueError):
                high = round(h * 1.4, 2)
            return round(h, 2), round(low, 2), round(high, 2)
    # Fallback: first bare number in the text.
    m = _HOURS_RE.search(s)
    if m:
        try:
            h = float(m.group(1))
        except ValueError:
            return None
        if h < 0:
            return None
        return round(h, 2), round(h * 0.6, 2), round(h * 1.4, 2)
    return None


def _llm_estimate(canon_inputs, timeout=18):
    """Try an LLM estimate. Returns (hours, low, high, model) or None.

    Gated behind LOKI_EFFORT_LLM=1 so a model is never invoked on every build.
    Honors LOKI_EFFORT_LLM_STUB (its OWN stub env, NOT the wiki one) for
    deterministic tests: a file path or literal completion string. Any failure
    returns None -> caller falls open to the heuristic.
    """
    if os.environ.get("LOKI_EFFORT_LLM", "") not in ("1", "true", "yes", "on"):
        return None

    prompt = _build_prompt(canon_inputs)

    stub = os.environ.get("LOKI_EFFORT_LLM_STUB")
    if stub is not None:
        completion = _read_stub(stub)
        model = os.environ.get("LOKI_EFFORT_LLM_MODEL", "stub")
        parsed = _parse_llm_hours(completion)
        if parsed is None:
            return None
        h, low, high = parsed
        return h, low, high, model

    provider = os.environ.get("LOKI_PROVIDER", "claude")
    cmds = {
        "claude": ["claude", "-p", prompt],
    }
    base = cmds.get(provider)
    if base is None or not _which(base[0]):
        return None
    model = os.environ.get("SESSION_MODEL") or provider
    try:
        out = subprocess.run(
            base, capture_output=True, text=True, timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 and not (out.stdout or "").strip():
        return None
    parsed = _parse_llm_hours(out.stdout)
    if parsed is None:
        return None
    h, low, high = parsed
    return h, low, high, model


def _build_prompt(canon_inputs):
    diff = canon_inputs.get("diff", {})
    return (
        "You are estimating how many hours a competent human software engineer "
        "would take to produce EXACTLY this change, from scratch, including "
        "design, implementation, and testing. Respond with ONLY a JSON object "
        "of the form {\"hours\": <number>, \"low\": <number>, \"high\": "
        "<number>} and nothing else.\n\n"
        "Change signals:\n"
        "- files changed: %d\n"
        "- lines inserted: %d\n"
        "- lines deleted: %d\n"
        "- test status: %s\n"
        "- scope brief length (chars): %d\n"
        % (
            _to_int(diff.get("count")),
            _to_int(diff.get("insertions")),
            _to_int(diff.get("deletions")),
            str((canon_inputs.get("tests") or {}).get("status")),
            _to_int((canon_inputs.get("scope") or {}).get("brief_len")),
        )
    )


def _read_stub(stub):
    if os.path.sep in stub or stub.endswith(".txt") or stub.endswith(".json"):
        if os.path.isfile(stub):
            try:
                with open(stub, encoding="utf-8", errors="replace") as f:
                    return f.read()
            except OSError:
                return ""
    return stub


def _which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        cand = os.path.join(d, name)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def estimate(files_changed, tests, spec, iterations):
    """Return the effort_estimate object for proof.json. Never raises.

    Shape:
      {
        hours, low, high,               # equivalent human-engineering-hours
        method: "llm" | "heuristic",
        model,                          # model id on the llm path, else ""
        inputs_hash,                    # sha256 over the canonical inputs
        calibrated,                     # always False in this lane
        label,                          # human-facing honesty label
        estimator_version,
      }
    """
    try:
        canon = _canonical_inputs(files_changed, tests, spec, iterations)
    except Exception:
        canon = {"diff": {"count": 0, "insertions": 0, "deletions": 0,
                          "files": []}, "tests": {}, "scope": {},
                 "iterations": 0}
    try:
        ihash = _inputs_hash(canon)
    except Exception:
        ihash = ""

    method = "heuristic"
    model = ""
    hours = low = high = 0.0

    # LLM path first (opt-in); fail open to heuristic on ANY problem.
    try:
        llm = _llm_estimate(canon)
    except Exception:
        llm = None
    if llm is not None:
        hours, low, high, model = llm
        method = "llm"
    else:
        try:
            hours, low, high = heuristic_estimate(canon)
        except Exception:
            hours, low, high = 0.0, 0.0, 0.0
        method = "heuristic"
        model = ""

    label = (
        "estimated (uncalibrated, %s)" % method
    )
    return {
        "hours": hours,
        "low": low,
        "high": high,
        "method": method,
        "model": model,
        "inputs_hash": ihash,
        "calibrated": False,
        "label": label,
        "estimator_version": ESTIMATOR_VERSION,
    }
