#!/usr/bin/env python3
"""Standalone proof-of-run generator for Loki Mode (R1).

Single implementation called by both routes:
  - bash:  autonomy/run.sh generate_proof_of_run() via python3
  - Bun:   loki-ts/src/runner/proof.ts via spawn

Assembles the frozen proof.json schema v1.0 from .loki/ state, runs the
redaction chokepoint exactly once, computes an integrity hash, and writes
.loki/proofs/<run_id>/proof.json plus a self-contained index.html.

Design rules (R1-proof-of-run-PLAN.md):
  - Redaction runs once on the assembled dict BEFORE serialization.
  - The generator REFUSES to emit if redaction did not run.
  - HTML is built only from the redacted dict.
  - Catch all exceptions; never raise to the caller. Print one warning line.
  - Idempotent: re-running for the same run_id overwrites cleanly.
"""

import argparse
import hashlib
import json
import os
import random
import string
import subprocess
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = "1.0"

# Make proof_redact importable regardless of cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import proof_redact  # noqa: E402


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def _gen_run_id():
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return ts + "-" + rand


def _to_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default


def _to_float(v, default=0.0):
    try:
        return float(v)
    except Exception:
        return default


# ---------------------------------------------------------------------------
# data collection
# ---------------------------------------------------------------------------

def _collect_efficiency(loki_dir):
    """Sum cost + tokens across .loki/metrics/efficiency/iteration-*.json.

    Returns cost dict and a best-effort model name (last non-empty seen).

    Credibility: cost.usd is set to None when NO valid efficiency record was
    read (cost was never collected for this run). A skeptic seeing "$0.00" on
    HN assumes the artifact is fake; "cost not recorded" is the honest signal.
    A genuine 0.0 (records existed but summed to zero) is preserved as 0.0.
    """
    cost = {
        "usd": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
    }
    model = ""
    collected = False
    eff_dir = os.path.join(loki_dir, "metrics", "efficiency")
    try:
        names = sorted(os.listdir(eff_dir))
    except Exception:
        names = []
    for name in names:
        if not (name.startswith("iteration-") and name.endswith(".json")):
            continue
        rec = _read_json(os.path.join(eff_dir, name), default=None)
        if not isinstance(rec, dict):
            continue
        collected = True
        cost["usd"] += _to_float(rec.get("cost_usd"))
        cost["input_tokens"] += _to_int(rec.get("input_tokens"))
        cost["output_tokens"] += _to_int(rec.get("output_tokens"))
        cost["cache_read_tokens"] += _to_int(rec.get("cache_read_tokens"))
        cost["cache_creation_tokens"] += _to_int(rec.get("cache_creation_tokens"))
        if rec.get("model"):
            model = str(rec.get("model"))
    if collected:
        # Round usd to a sane precision but keep it precise (anti-pattern:
        # round suspiciously-clean numbers). 4 decimals preserves odd values.
        cost["usd"] = round(cost["usd"], 4)
    else:
        # No efficiency files were read: cost was not collected for this run.
        cost["usd"] = None
    return cost, model


def _collect_council(loki_dir):
    state = _read_json(os.path.join(loki_dir, "council", "state.json"), default={})
    if not isinstance(state, dict):
        state = {}
    enabled = bool(state.get("enabled", False))
    verdicts = state.get("verdicts") or []
    final_verdict = ""
    if isinstance(verdicts, list) and verdicts:
        last = verdicts[-1]
        if isinstance(last, dict):
            final_verdict = str(last.get("verdict") or last.get("decision") or "")
        else:
            final_verdict = str(last)
    threshold = state.get("threshold")
    if threshold is None:
        threshold = state.get("approval_threshold")

    reviewers = []
    votes_dir = os.path.join(loki_dir, "council", "votes")
    try:
        vote_files = sorted(os.listdir(votes_dir))
    except Exception:
        vote_files = []
    for vf in vote_files:
        if not vf.endswith(".json"):
            continue
        rec = _read_json(os.path.join(votes_dir, vf), default=None)
        if not isinstance(rec, dict):
            continue
        reviewers.append({
            "role": str(rec.get("role") or rec.get("reviewer") or ""),
            "vote": str(rec.get("vote") or rec.get("decision") or ""),
            # Full text here; truncation to <=300 happens AFTER redaction so a
            # secret straddling the cap cannot be sliced into a sub-pattern
            # fragment that escapes the redactor.
            "summary": str(rec.get("summary") or rec.get("rationale") or ""),
        })

    return {
        "enabled": enabled,
        "final_verdict": final_verdict,
        "threshold": threshold,
        "reviewers": reviewers,
        "findings_link": None,
    }


def _collect_quality_gates(loki_dir):
    gates_raw = _read_json(
        os.path.join(loki_dir, "state", "quality-gates.json"), default=None
    )
    gates = []
    passed = 0
    total = 0
    if isinstance(gates_raw, dict):
        for name, val in gates_raw.items():
            status = "unknown"
            if isinstance(val, bool):
                status = "passed" if val else "failed"
            elif isinstance(val, dict):
                if "passed" in val:
                    status = "passed" if val.get("passed") else "failed"
                elif "status" in val:
                    status = str(val.get("status"))
            else:
                status = str(val)
            gates.append({"name": str(name), "status": status})
            total += 1
            if status == "passed":
                passed += 1
    return {"passed": passed, "total": total, "gates": gates}


def _git_diffstat(target_dir, include_diffs):
    """Return (files_changed dict, diffs list|None).

    base = $_LOKI_ITER_START_SHA, else HEAD~1. Non-git -> empty.
    """
    empty = {"count": 0, "insertions": 0, "deletions": 0, "files": []}

    def _git(args):
        try:
            out = subprocess.run(
                ["git", "-C", target_dir] + args,
                capture_output=True, text=True, timeout=30,
            )
            if out.returncode != 0:
                return None
            return out.stdout
        except Exception:
            return None

    # Confirm we are in a git repo.
    if _git(["rev-parse", "--is-inside-work-tree"]) is None:
        return empty, (None if not include_diffs else None)

    base = os.environ.get("_LOKI_ITER_START_SHA", "").strip()
    if not base:
        base = "HEAD~1"

    numstat = _git(["diff", "--numstat", base, "HEAD"])
    if numstat is None:
        # base may be invalid (shallow / first commit); fall back to HEAD only.
        numstat = _git(["diff", "--numstat", "HEAD"])
    if numstat is None:
        return empty, (None if not include_diffs else None)

    files = []
    ins_total = 0
    del_total = 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ins_s, del_s, path = parts[0], parts[1], parts[2]
        ins = _to_int(ins_s) if ins_s != "-" else 0
        dele = _to_int(del_s) if del_s != "-" else 0
        ins_total += ins
        del_total += dele
        files.append({
            "path": path,
            "insertions": ins,
            "deletions": dele,
            "status": "binary" if ins_s == "-" else "modified",
        })

    files_changed = {
        "count": len(files),
        "insertions": ins_total,
        "deletions": del_total,
        "files": files,
    }

    diffs = None
    if include_diffs:
        diffs = []
        patch = _git(["diff", base, "HEAD"])
        if patch is None:
            patch = _git(["diff", "HEAD"])
        if patch:
            # Split per file on the diff --git markers, preserving the header.
            chunks = []
            current = []
            for line in patch.splitlines(keepends=True):
                if line.startswith("diff --git ") and current:
                    chunks.append("".join(current))
                    current = [line]
                else:
                    current.append(line)
            if current:
                chunks.append("".join(current))
            for chunk in chunks:
                # Best-effort path extraction from the "diff --git a/x b/x" line.
                p = ""
                first = chunk.splitlines()[0] if chunk else ""
                bits = first.split(" b/")
                if len(bits) == 2:
                    p = bits[1].strip()
                diffs.append({"path": p, "patch": chunk})

    return files_changed, diffs


def _collect_iterations(loki_dir):
    completed = _read_json(os.path.join(loki_dir, "queue", "completed.json"), default=[])
    failed = _read_json(os.path.join(loki_dir, "queue", "failed.json"), default=[])
    n_completed = len(completed) if isinstance(completed, list) else 0
    n_failed = len(failed) if isinstance(failed, list) else 0
    count = _to_int(os.environ.get("ITERATION_COUNT"), n_completed + n_failed)
    if count < n_completed + n_failed:
        count = n_completed + n_failed
    return {"count": count, "succeeded": n_completed, "failed": n_failed}


def _collect_spec(loki_dir, target_dir):
    """Return spec dict {source, brief}. brief truncated to 600 chars."""
    prd_path = os.environ.get("PRD_PATH", "").strip()
    source = ""
    brief = ""
    if prd_path and os.path.isfile(prd_path):
        source = prd_path
        brief = _read_text(prd_path)
    else:
        gen = os.path.join(loki_dir, "generated-prd.md")
        if os.path.isfile(gen):
            source = gen
            brief = _read_text(gen)
        else:
            source = "codebase-analysis"
            brief = ""
    # Full brief here; the <=600 cap is applied AFTER redaction in generate()
    # so a secret straddling the cap cannot be sliced into an under-length
    # fragment that bypasses the redactor.
    return {"source": source, "brief": brief}


def _collect_meta(loki_dir, repo_root):
    orch = _read_json(
        os.path.join(loki_dir, "state", "orchestrator.json"), default={}
    )
    if not isinstance(orch, dict):
        orch = {}
    started_at = str(orch.get("startedAt") or "")
    version = str(orch.get("version") or "")
    if not version and repo_root:
        version = _read_text(os.path.join(repo_root, "VERSION")).strip()
    return started_at, version


def _wall_clock_sec(started_at, generated_at):
    def _parse(s):
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    a = _parse(started_at)
    b = _parse(generated_at)
    if a and b:
        delta = (b - a).total_seconds()
        return int(delta) if delta >= 0 else 0
    return 0


# ---------------------------------------------------------------------------
# assembly + emit
# ---------------------------------------------------------------------------

def _canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _build_proof(args, loki_dir, target_dir, repo_root):
    generated_at = _utc_now_iso()
    run_id = args.run_id or os.environ.get("LOKI_SESSION_ID") or _gen_run_id()

    started_at, version_from_state = _collect_meta(loki_dir, repo_root)
    loki_version = args.loki_version or version_from_state or "unknown"

    cost, model_from_eff = _collect_efficiency(loki_dir)
    provider_name = args.provider or os.environ.get("PROVIDER_NAME") or "claude"
    model = model_from_eff or os.environ.get("SESSION_MODEL") or ""

    files_changed, diffs = _git_diffstat(target_dir, args.include_diffs)
    iterations = _collect_iterations(loki_dir)
    spec = _collect_spec(loki_dir, target_dir)
    council = _collect_council(loki_dir)
    quality_gates = _collect_quality_gates(loki_dir)

    deployed_url = os.environ.get("LOKI_DEPLOYED_URL") or None

    # Assemble WITHOUT redaction / verification fields (advisor ordering).
    proof = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "generated_at": generated_at,
        "loki_version": loki_version,
        "started_at": started_at,
        "wall_clock_sec": _wall_clock_sec(started_at, generated_at),
        "spec": spec,
        "provider": {"name": provider_name, "model": model},
        "iterations": iterations,
        "files_changed": files_changed,
        "diffs": diffs,
        "council": council,
        "quality_gates": quality_gates,
        "cost": cost,
        "deployment": {"deployed_url": deployed_url, "public_url": None},
    }
    return proof, run_id


def _council_ratio(proof):
    """Return (approve_count, total) mirroring the template's councilSummary:
    council enabled + non-empty reviewers[], counting APPROVE/APPROVED votes.
    Returns None when there is no usable council data.
    """
    council = proof.get("council") or {}
    if not council.get("enabled"):
        return None
    reviewers = council.get("reviewers") or []
    if not isinstance(reviewers, list) or not reviewers:
        return None
    ok = 0
    for r in reviewers:
        if not isinstance(r, dict):
            continue
        v = str(r.get("vote") or "").upper()
        if v in ("APPROVE", "APPROVED"):
            ok += 1
    return ok, len(reviewers)


def _fmt_usd_hook(usd):
    """Format a USD cost for the social hook, mirroring the template's fmtUsd:
    up to 4 decimals, trimmed, padded to >=2. Returns None when uncollected."""
    if usd is None:
        return None
    try:
        n = float(usd)
    except Exception:
        return None
    s = ("%.4f" % n).rstrip("0").rstrip(".")
    if "." not in s:
        s += ".00"
    elif len(s.split(".")[1]) == 1:
        s += "0"
    return "$" + s


def _build_social_hook(proof):
    """One-line viral hook embedding the real measured cost + files changed +
    council ratio. When cost was not collected, omit the cost (never fabricate
    a number, never print "$0.00")."""
    usd = _fmt_usd_hook((proof.get("cost") or {}).get("usd"))
    lead = ("Built autonomously for " + usd) if usd is not None \
        else "Built autonomously by Loki Mode"
    parts = [lead]
    fc = (proof.get("files_changed") or {}).get("count", 0)
    try:
        fc = int(fc)
    except Exception:
        fc = 0
    parts.append("%d file%s changed" % (fc, "" if fc == 1 else "s"))
    cr = _council_ratio(proof)
    if cr:
        parts.append("%d-of-%d reviewers approved" % (cr[0], cr[1]))
    return " - ".join(parts)


def _attr_esc(s):
    """HTML-attribute-escape a string destined for content="...".`"""
    return (str(s).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def _render_fallback_html(proof):
    """Self-contained index.html built ONLY from the redacted proof dict.

    No external resources (no src=, @import, or http(s) links into assets).
    Renders Tier1-4 fields in the ranked order from the spec.
    """
    data_json = json.dumps(proof, indent=2)
    cost = proof.get("cost", {})
    fc = proof.get("files_changed", {})
    council = proof.get("council", {})
    prov = proof.get("provider", {})
    dep = proof.get("deployment", {})
    spec = proof.get("spec", {})
    deployed = dep.get("deployed_url") or "(local only / none)"

    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))

    usd_val = cost.get("usd", None)
    usd_disp = _fmt_usd_hook(usd_val)

    rows = []
    rows.append("<h1>Loki Mode -- Proof of Run</h1>")
    if usd_disp is not None:
        rows.append('<p class="hook">%s to run. Here is the bill, the diff, and the run id.</p>'
                    % esc(usd_disp))
    else:
        rows.append('<p class="hook">Cost not recorded for this run. Here is the diff and the run id.</p>')

    # Tier 1: one-click verifiable.
    rows.append("<h2>Live / Deployed</h2>")
    rows.append("<p>Deployed URL: %s</p>" % esc(deployed))
    rows.append("<p>Files changed: %s (+%s / -%s)</p>" % (
        esc(fc.get("count", 0)), esc(fc.get("insertions", 0)),
        esc(fc.get("deletions", 0))))

    # Tier 2: itemized cost (the hero) + wall clock + diffstat.
    rows.append("<h2>Itemized Bill</h2>")
    rows.append("<ul>")
    rows.append("<li>Cost (USD): %s</li>" % (
        esc(usd_disp) if usd_disp is not None else "not recorded for this run"))
    rows.append("<li>Input tokens: %s</li>" % esc(cost.get("input_tokens", 0)))
    rows.append("<li>Output tokens: %s</li>" % esc(cost.get("output_tokens", 0)))
    rows.append("<li>Cache read tokens: %s</li>" % esc(cost.get("cache_read_tokens", 0)))
    rows.append("<li>Cache creation tokens: %s</li>" % esc(cost.get("cache_creation_tokens", 0)))
    rows.append("<li>Wall clock (sec): %s</li>" % esc(proof.get("wall_clock_sec", 0)))
    rows.append("</ul>")

    # Tier 3: council + flagged-and-resolved.
    rows.append("<h2>Council Review</h2>")
    rows.append("<p>Enabled: %s | Final verdict: %s</p>" % (
        esc(council.get("enabled")), esc(council.get("final_verdict") or "n/a")))

    # Tier 4: provenance / anti-spam.
    rows.append("<h2>Provenance</h2>")
    rows.append("<p>Spec source: %s</p>" % esc(spec.get("source")))
    rows.append("<p>Loki version: %s | Provider: %s | Model: %s</p>" % (
        esc(proof.get("loki_version")), esc(prov.get("name")), esc(prov.get("model"))))
    rows.append("<p>Run id: %s | Generated: %s</p>" % (
        esc(proof.get("run_id")), esc(proof.get("generated_at"))))
    ver = proof.get("verification", {})
    rows.append('<p class="hash">Integrity hash (%s): %s</p>' % (
        esc(ver.get("algo", "sha256")), esc(ver.get("hash", ""))))
    red = proof.get("redaction", {})
    rows.append("<p>Redaction applied: %s (%s redactions, rules v%s)</p>" % (
        esc(red.get("applied")), esc(red.get("redactions_count")),
        esc(red.get("rules_version"))))

    body = "\n".join(rows)
    html = (
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n"
        "<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        "<title>Loki Mode Proof of Run -- " + esc(proof.get("run_id", "")) + "</title>\n"
        "<style>\n"
        "body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:780px;"
        "margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.5}\n"
        "h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.6rem;border-bottom:1px solid #ddd}\n"
        ".hook{font-size:1.1rem;font-weight:600}\n"
        ".hash{font-family:monospace;font-size:.8rem;word-break:break-all;color:#555}\n"
        "ul{padding-left:1.2rem}\n"
        "pre{background:#f6f6f6;padding:1rem;overflow:auto;font-size:.75rem;border-radius:6px}\n"
        "</style>\n</head>\n<body>\n"
        + body +
        "\n<h2>Raw proof.json (redacted)</h2>\n<pre>"
        + esc(data_json) +
        "</pre>\n</body>\n</html>\n"
    )
    return html


def _render_html(proof, repo_root):
    """Prefer the shared template; fall back to the self-contained renderer."""
    template_path = os.path.join(_HERE, "proof-template.html")
    tpl = _read_text(template_path, default="")
    marker = "__PROOF_JSON__"
    if tpl and marker in tpl:
        # Substitute the dynamic social hook BEFORE the JSON payload, so a proof
        # value that happens to contain the hook token cannot get clobbered.
        # The hook embeds the real measured cost + files-changed + council ratio
        # (cost-free variant when uncollected) for the viral punch.
        hook = _build_social_hook(proof)
        tpl = tpl.replace("__PROOF_OG_DESCRIPTION__", _attr_esc(hook))
        # Template renders client-side from an inlined JSON blob. Per the
        # template GENERATOR CONTRACT, escape "<" so a value containing
        # "</script>" or "<!--" cannot break out of the script block.
        payload = json.dumps(proof, ensure_ascii=False).replace("<", "\\u003c")
        return tpl.replace(marker, payload)
    return _render_fallback_html(proof)


def generate(args):
    loki_dir = os.path.abspath(args.loki_dir)
    target_dir = os.path.dirname(loki_dir) or "."

    # Resolve repo root: walk up for VERSION + autonomy/run.sh.
    repo_root = ""
    probe = _HERE
    for _ in range(6):
        if (os.path.isfile(os.path.join(probe, "VERSION"))
                and os.path.isfile(os.path.join(probe, "autonomy", "run.sh"))):
            repo_root = probe
            break
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent

    # Configure redaction context (best effort; generic rules still apply).
    proof_redact.reset_context()
    proof_redact.set_context(
        home=os.environ.get("HOME") or os.path.expanduser("~"),
        repo_root=target_dir,
    )

    proof, run_id = _build_proof(args, loki_dir, target_dir, repo_root)

    # THE CHOKEPOINT: redact the assembled dict exactly once.
    redacted, count = proof_redact.redact_tree(proof)

    # Refuse to emit if redaction did not run. redact_tree always returns a
    # dict + int count; a missing/None result means the chokepoint failed.
    if not isinstance(redacted, dict) or count is None:
        raise RuntimeError("redaction did not run; refusing to emit proof")

    # Apply schema length caps AFTER redaction (security ordering: never
    # truncate a raw string and risk slicing a secret into an under-length
    # fragment that escapes the redactor). Caps: brief <=600, summary <=300.
    try:
        spec_obj = redacted.get("spec")
        if isinstance(spec_obj, dict) and isinstance(spec_obj.get("brief"), str):
            spec_obj["brief"] = spec_obj["brief"][:600]
        council_obj = redacted.get("council")
        if isinstance(council_obj, dict):
            for rv in council_obj.get("reviewers") or []:
                if isinstance(rv, dict) and isinstance(rv.get("summary"), str):
                    rv["summary"] = rv["summary"][:300]
    except Exception:
        pass

    redacted["redaction"] = {
        "applied": True,
        "rules_version": proof_redact.RULES_VERSION,
        "redactions_count": int(count),
    }

    # Integrity hash over the canonical form INCLUDING redaction but EXCLUDING
    # verification (advisor ordering). Verifier re-canonicalizes the compact
    # sort_keys form, never the pretty bytes on disk.
    digest = hashlib.sha256(_canonical(redacted).encode("utf-8")).hexdigest()
    redacted["verification"] = {
        "hash": digest,
        "algo": "sha256",
        "scope": "integrity",
    }

    # Determine output dir.
    if args.out_dir:
        out_dir = os.path.abspath(args.out_dir)
    else:
        out_dir = os.path.join(loki_dir, "proofs", run_id)
    os.makedirs(out_dir, exist_ok=True)

    proof_path = os.path.join(out_dir, "proof.json")
    with open(proof_path, "w") as f:
        json.dump(redacted, f, indent=2)

    html = _render_html(redacted, repo_root)
    html_path = os.path.join(out_dir, "index.html")
    with open(html_path, "w") as f:
        f.write(html)

    if not args.quiet:
        print("proof-of-run written: " + proof_path)
    return out_dir


def main(argv=None):
    parser = argparse.ArgumentParser(description="Loki Mode proof-of-run generator")
    parser.add_argument("--loki-dir", default=".loki")
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--include-diffs", action="store_true")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--loki-version", default="")
    parser.add_argument("--provider", default="")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    try:
        generate(args)
        return 0
    except Exception as exc:  # never raise to caller (fire-and-forget)
        # One-line warning only; do not leak a stack trace into run output.
        sys.stderr.write("warn: proof-of-run generation failed: %s\n" % exc)
        return 0


if __name__ == "__main__":
    sys.exit(main())
