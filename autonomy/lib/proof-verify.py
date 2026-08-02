#!/usr/bin/env python3
"""Deterministic re-verifier for Loki Mode proof-of-run receipts.

Companion to proof-generator.py. The generator writes proof.json with an
integrity hash so a skeptic can prove the JSON bytes were not edited since
they were hashed. This module goes further: it re-checks the receipt's
recorded FACTS against the live repo, so a skeptic can prove the recorded
diff STILL matches what is in git, not merely that the JSON bytes are
unaltered. It also re-derives the honesty headline from the recorded facts
(see headline_consistent below) to catch an INCONSISTENT edit -- a proof
whose headline was flipped to VERIFIED while the facts still say not_run.

What this does NOT do -- honest scope. On the UNSIGNED path (no valid gpg
signature) the generator is TRUSTED: the recorded facts are taken at face
value. A forger who rewrites BOTH the facts AND the headline to a mutually
consistent lie, then recomputes the integrity hash, still passes every
check here -- the hash proves only bytes-unedited-since-hashing, and the
re-derived diff can be made to match a repo the forger controls. Neutral,
adversarial non-forgeability (the generator is NOT trusted) requires the
SIGNED record: a detached gpg signature from a key the verifier trusts.
When gpg_ok is True the generator is not trusted; when gpg_ok is "n/a" it
is. This module reports that distinction (generator_trusted) rather than
overclaiming that re-checking the diff makes a receipt non-forgeable. It
does not.

Three checks (mirrors dashboard/audit.py verify-CLI style):

  1. TAMPER CHECK (hash_ok): strip verification.hash, re-canonicalize exactly
     as the generator does (sort_keys=True, compact separators, the same
     ensure_ascii setting), sha256, compare to the recorded verification.hash.
     Any mismatch means the JSON was edited after signing.

  2. DRIFT CHECK (diff_drift): from the recorded git base sha, re-derive the
     final committed, staged, unstaged, deleted, and untracked workspace diff.
     Compare its stat and diff_sha256 to the receipt. When tree_sha256 is
     present, also bind exact final file content so equal line counts cannot
     hide content drift.

  3. GPG (gpg_ok): if a detached signature is present and gpg is available,
     verify it over the canonical bytes. Otherwise "n/a".

Honesty rules (CLAUDE.md binding):
  - Never claim "verified" when a check could not run. If the base ref is
    missing or unresolvable, diff_drift is reported as None and `ok` is False
    with a reason; we never silently pass an undrifted-but-unchecked receipt.
  - Surface honesty.degraded from the proof so the verifier output also shows
    the gaps the generator already disclosed.
  - set -u / robust: missing file, malformed JSON, missing fields produce a
    clear error and exit 2, never a traceback-as-UX.

Schema compatibility:
  - Generator schema v1.0 records the diff under top-level files_changed{} and
    diffs[], with NO recorded base sha, so drift cannot be re-derived (the
    verifier says so honestly rather than pretending).
  - Schema v1.1 (if/when the generator slice lands it) records
    facts.git.{base_sha, head_sha, diff, diff_sha256}. This verifier prefers
    facts.git when present and falls back to the v1.0 layout otherwise.

CLI:
    python3 autonomy/lib/proof-verify.py <proof.json> [repo_dir]
  Prints the JSON result. Exit 0 if ok, 1 on tamper / drift / bad signature,
  2 on a usage / load error (missing file, malformed JSON).
"""

import hashlib
import json
import os
import re
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from tree_digest import compute_tree_digest
from workspace_diff import collect_workspace_diff


# ---------------------------------------------------------------------------
# canonicalization (MUST match proof-generator._canonical exactly)
# ---------------------------------------------------------------------------

def _canonical(obj):
    """Canonical JSON form used for the integrity hash.

    Mirrors proof-generator.py _canonical(): json.dumps with sort_keys=True
    and compact separators. The generator does not pass ensure_ascii, so it
    defaults to True; we match that here so the recomputed hash is identical.
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


# ---------------------------------------------------------------------------
# git helpers
# ---------------------------------------------------------------------------

def _git(repo_dir, args, timeout=30):
    """Run git in repo_dir. Returns stdout string, or None on any failure."""
    try:
        out = subprocess.run(
            ["git", "-C", repo_dir] + args,
            capture_output=True, text=True, timeout=timeout,
        )
        if out.returncode != 0:
            return None
        return out.stdout
    except Exception:
        return None


def _is_git_repo(repo_dir):
    return _git(repo_dir, ["rev-parse", "--is-inside-work-tree"]) is not None


def _rev_resolvable(repo_dir, ref):
    """True iff `ref` names something in repo_dir that a diff can be taken from.

    Accepts a COMMIT or a TREE. The tree case is load-bearing: a greenfield run
    starts in a repo with no commits, so the generator records the EMPTY TREE
    (4b825dc6...) as its baseline -- "everything that now exists". That object
    is a tree, not a commit, so a commit-only check rejects it and the verifier
    reports "base ref unresolvable" for a perfectly genuine proof.

    `git diff <empty-tree>` works fine, so the diff really is re-derivable; only
    the resolvability probe was too narrow. This does NOT loosen the forgery
    defense -- an unknown or fabricated SHA still resolves as neither and is
    still rejected.
    """
    if not ref:
        return False
    for kind in ("commit", "tree"):
        out = _git(repo_dir, ["rev-parse", "--verify", "--quiet", "%s^{%s}" % (ref, kind)])
        if out and out.strip():
            return True
    return False


def _numstat(repo_dir, base, head):
    """Return final-worktree stats relative to ``base``.

    ``head`` remains in the signature for installed-layout compatibility. The
    live working tree is the proof target, not only its current commit.
    """
    stat, _ = collect_workspace_diff(repo_dir, str(base), False)
    return stat


def _diff_sha256_from_stat(files_changed):
    """Recompute the generator's diff_sha256 from a stat object.

    MUST match proof-generator._diff_sha256: sha256 of the canonical
    {count, insertions, deletions, files} object (NOT the full patch text)."""
    fc = files_changed or {}
    canon = {
        "count": fc.get("count", 0),
        "insertions": fc.get("insertions", 0),
        "deletions": fc.get("deletions", 0),
        "files": fc.get("files", []),
    }
    return hashlib.sha256(_canonical(canon).encode("utf-8")).hexdigest()


def _full_diff(repo_dir, base, head):
    """Return the full `git diff base head` patch text, or None."""
    return _git(repo_dir, ["diff", str(base), str(head)])


def _to_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default


# ---------------------------------------------------------------------------
# headline re-derivation (MUST match proof-generator._compute_headline exactly)
# ---------------------------------------------------------------------------

# DRIFT-GUARD: mirrored from proof-generator.py. A gate the AGENT authored the
# input to (it writes both the test and the fix) or that is an LLM judgment
# cannot be independent evidence, so it must never force or lift a headline.
# Keyed on the ADVISORY set so an unknown or renamed gate defaults to EXOGENOUS
# and keeps its power to block -- fail-closed, never fail-open.
#
# This block exists because the generator gained a provenance split while this
# file did not, and the two then disagreed about what a receipt meant. The
# verifier is the INDEPENDENT re-derivation users are told to trust; if it
# cannot reproduce the generator's headline, `loki proof verify` reports drift
# on a receipt that was never tampered with -- a false alarm from our own trust
# artifact, which is worse than no verifier at all.
_ADVISORY_GATES = frozenset((
    "test_coverage", "unit_tests", "test_suite", "semantic_tests", "tests",
    "code_review", "devils_advocate", "devil_advocate", "magic_debate",
    "council", "anti_sycophancy",
))


def _gate_key(name):
    """Normalize a gate name for provenance lookup (mirrors the generator).

    run.sh emits the same gate under multiple spellings (`static-analysis` vs
    `static_analysis`) and track_gate_failure appends `_PAUSED`/`_ESCALATED`,
    so an exact-match lookup would misfile real gates.
    """
    s = str(name or "").strip().lower().replace("-", "_")
    return re.sub(r"_(paused|escalated|not_run|blocked)$", "", s)


def _gate_provenance(name):
    """'advisory' for a model-authored gate, else 'exogenous' (fail-closed)."""
    return "advisory" if _gate_key(name) in _ADVISORY_GATES else "exogenous"


def _is_exogenous(gate):
    """Provenance of a gate dict, honoring a stamped value when present.

    The generator stamps `provenance` so its `unresolved` override survives (a
    gate that HALTED the run is an execution fact, not a model opinion). We
    honor that stamp and fall back to name lookup for older receipts written
    before the split existed.
    """
    if not isinstance(gate, dict):
        return True
    stamped = gate.get("provenance")
    if stamped:
        return stamped == "exogenous"
    return _gate_provenance(gate.get("name")) == "exogenous"


def _compute_headline(facts, degraded):
    """Deterministic headline re-derived from the recorded facts.

    MUST match proof-generator.py _compute_headline() byte-for-byte in logic
    (same DRIFT-GUARD contract as _canonical / _diff_sha256_from_stat above).
    We mirror rather than import because proof-generator.py has a hyphen in its
    filename (not a plain import) and this file already mirrors its sibling's
    hashing helpers with the same "MUST match" discipline. If the generator's
    rules change, this copy MUST be updated in lockstep.

    Redaction note: proof_redact.py only rewrites secret/path substrings inside
    string values; it never touches the status enums, integer counts, exit_code,
    or the shape/length of the degraded list that this function reads, and it
    leaves bool(command) truthy. So re-deriving from the STORED (post-redaction)
    facts yields the identical headline the generator computed pre-redaction.
    """
    tests = facts.get("tests") or {}
    build = facts.get("build") or {}
    git = facts.get("git") or {}
    diff_nonempty = bool((git.get("diff") or {}).get("count"))

    sec = facts.get("security") or {}
    sec_high = bool(sec.get("ran") and (sec.get("high_active") or 0) > 0)
    fn = facts.get("functional") or {}
    fn_failed = bool(
        os.environ.get("LOKI_FV_GATE") == "1"
        and fn.get("ran")
        and fn.get("functional_status") == "failed"
    )
    execution = facts.get("execution") or {}
    execution_outcome = str(execution.get("outcome") or "").lower()
    failed_run_statuses = {
        "failed",
        "force_stopped",
        "inconclusive_spec_contradiction",
        "interrupted",
        "max_iterations_reached",
        "max_retries_exceeded",
        "paused",
        "policy_blocked",
        "provider_deadline_partial_mutation",
    }
    execution_failed = bool(
        execution.get("terminated")
        or execution.get("exit_code") not in (None, 0)
        or str(execution.get("run_status") or "").lower() in failed_run_statuses
        or (
            execution_outcome
            and execution_outcome not in ("complete", "completed", "success")
        )
    )
    any_failed = (
        execution_failed
        or tests.get("status") == "failed"
        or build.get("status") == "failed"
        or any(g.get("status") == "failed"
               for g in (facts.get("quality_gates") or []))
        or sec_high
        or fn_failed
    )
    if any_failed:
        return "NOT VERIFIED"

    tests_verified = (
        tests.get("status") == "verified"
        and bool(tests.get("command"))
        and tests.get("exit_code") == 0
    )
    if tests_verified and not degraded and diff_nonempty:
        return "VERIFIED"
    any_verified = (
        tests.get("status") == "verified"
        or build.get("status") == "verified"
        or any(g.get("status") == "passed"
               for g in (facts.get("quality_gates") or []))
    )
    if any_verified and degraded:
        return "VERIFIED WITH GAPS"
    return "NOT VERIFIED"


# ---------------------------------------------------------------------------
# proof field extraction (schema v1.0 + v1.1 tolerant)
# ---------------------------------------------------------------------------

def _recorded_git_refs(proof):
    """Return (base_sha, head_sha) the receipt recorded, or (None, None).

    Prefers schema v1.1 facts.git.{base_sha,head_sha}. Schema v1.0 records no
    base sha, so this returns (None, None) there and the caller reports drift
    as unverifiable rather than passing it silently.
    """
    facts = proof.get("facts")
    if isinstance(facts, dict):
        git = facts.get("git")
        if isinstance(git, dict):
            base = git.get("base_sha")
            head = git.get("head_sha")
            return (str(base) if base else None,
                    str(head) if head else None)
    return None, None


def _recorded_diff_stat(proof):
    """Return the recorded {count, insertions, deletions}, schema-tolerant.

    v1.1 records facts.git.diff = {count, insertions, deletions, ...}.
    v1.0 records top-level files_changed = {count, insertions, deletions, ...}.
    Returns None if neither is present / usable.
    """
    facts = proof.get("facts")
    if isinstance(facts, dict):
        git = facts.get("git")
        if isinstance(git, dict) and isinstance(git.get("diff"), dict):
            d = git["diff"]
            return {
                "count": _to_int(d.get("count")),
                "insertions": _to_int(d.get("insertions")),
                "deletions": _to_int(d.get("deletions")),
            }
    fc = proof.get("files_changed")
    if isinstance(fc, dict):
        return {
            "count": _to_int(fc.get("count")),
            "insertions": _to_int(fc.get("insertions")),
            "deletions": _to_int(fc.get("deletions")),
        }
    return None


def _recorded_diff_sha256(proof):
    """Return facts.git.diff_sha256 if recorded (v1.1 only), else None."""
    facts = proof.get("facts")
    if isinstance(facts, dict):
        git = facts.get("git")
        if isinstance(git, dict):
            v = git.get("diff_sha256")
            if v:
                return str(v)
    return None


def _recorded_tree_sha256(proof):
    facts = proof.get("facts")
    if isinstance(facts, dict):
        git = facts.get("git")
        if isinstance(git, dict) and git.get("tree_sha256"):
            return str(git["tree_sha256"])
    value = proof.get("tree_sha256")
    return str(value) if value else None


def _recorded_degraded(proof):
    """Return the honesty.degraded list the generator disclosed, or []."""
    honesty = proof.get("honesty")
    if isinstance(honesty, dict):
        deg = honesty.get("degraded")
        if isinstance(deg, list):
            # Disabled-gate entries are appended by the generator AFTER it
            # computes the headline (v8.19.0), so they were never an input to
            # the recorded value. Re-deriving WITH them made an honest proof
            # look edited: on a run with security switched off the generator
            # recorded "VERIFIED" and this function re-derived "VERIFIED WITH
            # GAPS", and the mismatch is reported to the user as "the headline
            # was edited to misrepresent the facts".
            #
            # Accusing an honest receipt of forgery is the worst failure this
            # verifier can have, so the re-derivation must use exactly the list
            # the generator used: everything except the post-hoc gate entries.
            # Entries the generator appended AFTER computing the headline were
            # never an input to the recorded value, so re-deriving with them
            # makes an honest proof look edited. Keyed on the explicit
            # post_headline flag, not on a status string: the first version of
            # this filter matched status=="disabled" and broke the moment a
            # second post-headline entry arrived with a different status.
            # status=="disabled" is still honoured for proofs written by
            # v8.19.0-v8.19.2, which predate the flag.
            deg = [d for d in deg
                   if not (isinstance(d, dict)
                           and (d.get("post_headline") is True
                                or d.get("status") == "disabled"))]
            return [str(x) for x in deg]
    return []


def _recorded_degraded_raw(proof):
    """Return honesty.degraded EXACTLY as recorded (for headline re-derivation).

    _recorded_degraded coerces items to str for the report; _compute_headline
    only cares whether the list is empty, so we pass the raw list to preserve
    the generator's exact truthiness semantics.
    """
    honesty = proof.get("honesty")
    if isinstance(honesty, dict):
        deg = honesty.get("degraded")
        if isinstance(deg, list):
            # Disabled-gate entries are appended by the generator AFTER it
            # computes the headline (v8.19.0), so they were never an input to
            # the recorded value. Re-deriving WITH them made an honest proof
            # look edited: on a run with security switched off the generator
            # recorded "VERIFIED" and this function re-derived "VERIFIED WITH
            # GAPS", and the mismatch is reported to the user as "the headline
            # was edited to misrepresent the facts".
            #
            # Accusing an honest receipt of forgery is the worst failure this
            # verifier can have, so the re-derivation must use exactly the list
            # the generator used: everything except the post-hoc gate entries.
            # Entries the generator appended AFTER computing the headline were
            # never an input to the recorded value, so re-deriving with them
            # makes an honest proof look edited. Keyed on the explicit
            # post_headline flag, not on a status string: the first version of
            # this filter matched status=="disabled" and broke the moment a
            # second post-headline entry arrived with a different status.
            # status=="disabled" is still honoured for proofs written by
            # v8.19.0-v8.19.2, which predate the flag.
            deg = [d for d in deg
                   if not (isinstance(d, dict)
                           and (d.get("post_headline") is True
                                or d.get("status") == "disabled"))]
            return deg
    return []


def _recorded_headline(proof):
    """Return honesty.headline as recorded (stripped str), or None if absent."""
    honesty = proof.get("honesty")
    if isinstance(honesty, dict):
        h = honesty.get("headline")
        if isinstance(h, str) and h.strip():
            return h.strip()
    return None


# ---------------------------------------------------------------------------
# gpg
# ---------------------------------------------------------------------------

def _gpg_available():
    try:
        out = subprocess.run(["gpg", "--version"], capture_output=True,
                             text=True, timeout=10)
        return out.returncode == 0
    except Exception:
        return False


def _verify_gpg(canonical_bytes, signature):
    """Verify a detached signature over canonical_bytes.

    Returns True (good sig), False (bad sig / gpg failure), or "n/a" when no
    signature is present or gpg is unavailable.
    """
    if not signature:
        return "n/a"
    if not _gpg_available():
        return "n/a"
    import tempfile
    data_path = None
    sig_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as df:
            df.write(canonical_bytes)
            data_path = df.name
        sig_bytes = signature
        if isinstance(sig_bytes, str):
            sig_bytes = sig_bytes.encode("utf-8")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".sig") as sf:
            sf.write(sig_bytes)
            sig_path = sf.name
        out = subprocess.run(
            ["gpg", "--verify", sig_path, data_path],
            capture_output=True, text=True, timeout=30,
        )
        return out.returncode == 0
    except Exception:
        return False
    finally:
        for p in (data_path, sig_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# the verifier
# ---------------------------------------------------------------------------

class ProofLoadError(Exception):
    """Raised for a missing file / malformed JSON / unusable proof shape."""


def _load_proof(proof_path):
    if not os.path.isfile(proof_path):
        raise ProofLoadError("proof file not found: %s" % proof_path)
    try:
        with open(proof_path, "r") as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        raise ProofLoadError("malformed JSON in %s: %s" % (proof_path, exc))
    except OSError as exc:
        raise ProofLoadError("could not read %s: %s" % (proof_path, exc))
    if not isinstance(data, dict):
        raise ProofLoadError("proof root is not a JSON object: %s" % proof_path)
    return data


def verify_integrity(proof):
    """Verify the receipt hash, signature, and recorded headline.

    This is the canonical in-memory integrity check shared by the CLI verifier
    and supervised execution binding. Repository drift is intentionally left to
    verify(), whose caller supplies the repository path.
    """
    result = {
        "hash_ok": False,
        "gpg_ok": "n/a",
        "generator_trusted": True,
        "headline_consistent": None,
        "degraded": _recorded_degraded(proof) if isinstance(proof, dict) else [],
        "reason": "",
        "ok": False,
    }
    if not isinstance(proof, dict):
        result["reason"] = "proof root is not a JSON object"
        return result

    verification = proof.get("verification")
    if not isinstance(verification, dict) or not verification.get("hash"):
        result["reason"] = "no verification.hash recorded; cannot prove integrity"
        return result

    unsigned = dict(proof)
    unsigned.pop("verification", None)
    canonical_bytes = _canonical(unsigned).encode("utf-8")
    recorded_hash = str(verification.get("hash"))
    recomputed = hashlib.sha256(canonical_bytes).hexdigest()
    result["hash_ok"] = recomputed == recorded_hash
    if not result["hash_ok"]:
        result["reason"] = (
            "integrity hash mismatch (proof.json was edited after signing)"
        )

    result["gpg_ok"] = _verify_gpg(
        canonical_bytes, verification.get("gpg_signature")
    )
    result["generator_trusted"] = result["gpg_ok"] is not True

    recorded_headline = _recorded_headline(proof)
    facts = proof.get("facts")
    if recorded_headline is not None and isinstance(facts, dict):
        derived = _compute_headline(facts, _recorded_degraded_raw(proof))
        result["headline_consistent"] = derived == recorded_headline
        if not result["headline_consistent"] and not result["reason"]:
            result["reason"] = (
                "honesty.headline (%r) disagrees with the headline re-derived "
                "from the recorded facts (%r); the headline was edited to "
                "misrepresent the facts" % (recorded_headline, derived)
            )

    # COST COHERENCE. The receipt is the product's trust artifact, and the
    # verifier checked hashes, diffs, gates and the headline -- but never cost.
    # A receipt could therefore claim ANY cost, $0.00 or $10,000, and
    # `loki proof verify` would still pass it.
    #
    # That was not hypothetical. A real FireLater receipt shipped
    # {"usd": 0.0, ..., "available": true} -- a shareable document asserting the
    # run was FREE, because the collector keyed availability on a record file
    # existing rather than carrying data (fixed v8.52.0). The verifier could not
    # see it.
    #
    # This checks INTERNAL COHERENCE, which is what a verifier can honestly
    # assert: the receipt must not contradict itself. It deliberately does NOT
    # re-price the run -- that would require the token counts and price table at
    # verify time, and a verifier that guesses is worse than one that abstains.
    #
    # The incoherent shapes:
    #   available=True with every field zero/None -> claims measurement, has none
    #   available=False with a non-zero usd       -> claims unmeasured, shows a number
    #   usd present but no tokens at all          -> a cost from nowhere
    result["cost_coherent"] = None
    _cost = proof.get("cost") if isinstance(proof.get("cost"), dict) else None
    if _cost is not None:
        _avail = _cost.get("available")
        _usd = _cost.get("usd")
        _toks = [
            _cost.get(k) for k in
            ("input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens")
        ]
        _any_tok = any(isinstance(t, (int, float)) and t > 0 for t in _toks)
        _usd_pos = isinstance(_usd, (int, float)) and _usd > 0

        _bad = ""
        if _avail is True and not _any_tok and not _usd_pos:
            _bad = ("cost.available is true but every token count and usd is "
                    "zero or absent; the receipt claims a measurement it does "
                    "not have (an unmeasured run is unknown, not free)")
        elif _avail is False and (_usd_pos or _any_tok):
            _bad = ("cost.available is false but the receipt carries non-zero "
                    "cost or token values")
        elif _usd_pos and not _any_tok:
            _bad = ("cost.usd is non-zero but no tokens were recorded; the "
                    "cost has no basis in the receipt")

        result["cost_coherent"] = not _bad
        if _bad and not result["reason"]:
            result["reason"] = _bad

    result["ok"] = bool(
        result["hash_ok"]
        and result["gpg_ok"] in (True, "n/a")
        and result["headline_consistent"] is not False
        and result["cost_coherent"] is not False
    )
    if result["ok"]:
        result["reason"] = ""
    elif not result["reason"]:
        result["reason"] = (
            "gpg signature verification failed"
            if result["gpg_ok"] is False
            else "verification failed"
        )
    return result


def verify(proof_path, repo_dir="."):
    """Re-verify a proof.json against the repo.

    Returns a dict:
      {
        hash_ok:            bool                tamper check passed
        diff_drift:         bool | None         True=drift, False=match,
                                                 None=could not check
        diff_recheck:       {recorded, current} the two diff stats compared
        gpg_ok:             True | False | "n/a"  signature verdict
        generator_trusted:  bool                see note below
        headline_consistent: bool | None        see note below
        degraded:           [str]               honesty.degraded from the proof
        reason:             str                 why ok is False (when it is)
        ok:                 bool                overall verdict
      }

    `ok` = hash_ok AND diff_drift is False AND gpg_ok in (True, "n/a")
           AND headline_consistent is not False.
    Note: diff_drift None (unverifiable) makes ok False, by design -- we never
    report "verified" when the central fact could not be re-checked.

    generator_trusted: True on the UNSIGNED path (gpg_ok != True), False when a
    valid signature is present (gpg_ok is True). On the unsigned path the facts
    are taken at face value; neutral non-forgeability is NOT guaranteed. This
    field exists so the report can state that honestly even when ok is True (at
    which point `reason` is cleared).

    headline_consistent: defense-in-depth. We re-derive the honesty headline
    from the RECORDED facts (same logic as proof-generator._compute_headline)
    and compare it to the stored honesty.headline. False means an INCONSISTENT
    edit -- e.g. the headline was flipped to VERIFIED while the facts still say
    not_run. That catches a careless/partial forgery. It does NOT catch a
    CONSISTENT forger who rewrites both the facts AND the headline to a matching
    lie and recomputes the integrity hash: on the unsigned path that still
    passes (generator_trusted stays True). None means we could not re-derive
    (no recorded headline, or no facts to derive from) -- not a failure.
    """
    proof = _load_proof(proof_path)

    integrity = verify_integrity(proof)
    result = {
        **integrity,
        "diff_drift": None,
        "diff_recheck": {"recorded": None, "current": None},
        "tree_drift": None,
        "tree_recheck": {"recorded": None, "current": None},
        "ok": False,
    }

    if not integrity["hash_ok"] and not (
        isinstance(proof.get("verification"), dict)
        and proof["verification"].get("hash")
    ):
        return result

    # ----- 2. DRIFT CHECK --------------------------------------------------
    recorded_stat = _recorded_diff_stat(proof)
    result["diff_recheck"]["recorded"] = recorded_stat

    base_sha, head_sha = _recorded_git_refs(proof)

    if not _is_git_repo(repo_dir):
        result["diff_drift"] = None
        if not result["reason"]:
            result["reason"] = "repo_dir is not a git work tree; drift unverifiable"
    elif not base_sha:
        # Schema v1.0 (or a v1.1 proof missing base_sha): no recorded base ref,
        # so the diff cannot be re-derived. Report honestly, do NOT pass.
        result["diff_drift"] = None
        if not result["reason"]:
            result["reason"] = "base ref unresolvable (no recorded base_sha; drift unverifiable)"
    elif not _rev_resolvable(repo_dir, base_sha):
        result["diff_drift"] = None
        if not result["reason"]:
            result["reason"] = ("base ref unresolvable (%s not found in repo; "
                                "drift unverifiable)" % base_sha)
    else:
        # Drift answers "does this receipt still describe the CURRENT branch
        # state". A receipt is for verifying the work as it stands now, so we
        # diff base..live-HEAD: a new commit since the receipt was generated is
        # genuine drift (the receipt no longer matches the branch). The recorded
        # head_sha is used for the tamper/hash check, not here. (The integrity
        # hash already proves the receipt's own bytes are unedited; drift proves
        # the recorded FACTS still match the repo.)
        head_ref = "HEAD"
        current_stat = _numstat(repo_dir, base_sha, head_ref)
        result["diff_recheck"]["current"] = current_stat

        if current_stat is None:
            result["diff_drift"] = None
            if not result["reason"]:
                result["reason"] = "git diff could not be computed; drift unverifiable"
        else:
            drift = False
            if recorded_stat is not None:
                drift = (
                    recorded_stat.get("count") != current_stat.get("count")
                    or recorded_stat.get("insertions") != current_stat.get("insertions")
                    or recorded_stat.get("deletions") != current_stat.get("deletions")
                )
            else:
                # We can re-derive the diff but the receipt recorded no stat to
                # compare against -- cannot confirm the facts match.
                result["diff_drift"] = None
                if not result["reason"]:
                    result["reason"] = ("no recorded diff stat to compare; "
                                        "drift unverifiable")

            # diff_sha256: a stronger content check than the counts. Only when
            # the receipt recorded one (v1.1).
            recorded_dsha = _recorded_diff_sha256(proof)
            if result["diff_drift"] is not False and recorded_stat is not None:
                # only evaluate sha when we are still in the comparable branch
                pass
            if recorded_dsha is not None and current_stat is not None:
                # Recompute the SAME canonical stat-hash the generator wrote
                # (proof-generator._diff_sha256), NOT a hash of the patch text.
                cur_dsha = _diff_sha256_from_stat(current_stat)
                result["diff_recheck"]["current_diff_sha256"] = cur_dsha
                result["diff_recheck"]["recorded_diff_sha256"] = recorded_dsha
                if cur_dsha != recorded_dsha:
                    drift = True

            if recorded_stat is not None:
                result["diff_drift"] = drift
                if drift and not result["reason"]:
                    result["reason"] = "recorded diff no longer matches the repo (drift detected)"

    recorded_tree = _recorded_tree_sha256(proof)
    result["tree_recheck"]["recorded"] = recorded_tree
    if recorded_tree:
        current_tree = compute_tree_digest(repo_dir)
        result["tree_recheck"]["current"] = current_tree or None
        if not current_tree:
            if not result["reason"]:
                result["reason"] = "final workspace tree could not be re-derived"
        else:
            result["tree_drift"] = current_tree != recorded_tree
            if result["tree_drift"] and not result["reason"]:
                result["reason"] = "recorded final workspace tree no longer matches the repo"

    # ----- overall verdict -------------------------------------------------
    result["ok"] = bool(
        integrity["ok"]
        and result["diff_drift"] is False
        and (not recorded_tree or result["tree_drift"] is False)
    )
    if result["ok"]:
        result["reason"] = ""
    elif not result["reason"]:
        if result["gpg_ok"] is False:
            result["reason"] = "gpg signature verification failed"
        else:
            result["reason"] = "verification failed"
    return result


# ---------------------------------------------------------------------------
# CLI shim (mirrors dashboard/audit.py _unified_cli style)
# ---------------------------------------------------------------------------

def _cli(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(json.dumps(
            {"error": "usage: proof-verify.py <proof.json> [repo_dir]"}))
        return 2
    proof_path = argv[0]
    repo_dir = argv[1] if len(argv) > 1 else "."
    try:
        result = verify(proof_path, repo_dir)
    except ProofLoadError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 2
    except Exception as exc:  # defensive: never a traceback-as-UX
        print(json.dumps({"ok": False, "error": "verify failed: %s" % exc}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(_cli())
