"""The operator surface: the four evidence readers, reachable over HTTP.

WHAT THIS FIXES. dashboard/api_runs.py, api_evidence.py, api_tests.py and
api_releases.py read real Loki lifecycle state from the filesystem, and every
one of them was written with a strict envelope contract: an empty result
carries a REASON, an unmeasured number reads None rather than 0, and the
sources consulted are named so any row can be audited.

None of them had an APIRouter. They were libraries that only the test suite
imported -- four readers, zero of them reachable by a user. Mounting them is
the whole point of this module.

WHY ONE ROUTER AND NOT FOUR. Four separately-mounted routers would each need
their own prefix decision, their own error convention and their own auth
story, and they would drift. One router with one convention is the thing a
later reader can keep correct.

WHAT THIS DELIBERATELY DOES NOT EXPOSE. There is no `/runs` LIST route here,
even though api_runs.list_runs is the most obviously useful function in the
set. api_v2 already serves GET /api/v2/runs and already falls back to this
exact adapter when its SQL store is empty. Adding a second list surface would
recreate precisely the divergence that fallback was written to avoid: two
endpoints answering "what runs exist" from different stores, disagreeing, with
no way for a caller to know which one lied. The per-run detail route below has
no v2 equivalent, so it adds a surface rather than forking one.

THE ENVELOPE IS PASSED THROUGH UNCHANGED. Every route returns exactly what the
reader returned. It is tempting to unwrap `{"runs": [...]}` into a bare list
for convenience, and that would silently discard `reason`, `source` and
`freshness_s` -- the three fields that separate "there are no runs" from "I
could not read the runs". A caller that cannot tell those apart will render
the second as the first, which is the exact failure this codebase treats as
worse than an error.

READ-ONLY BY CONSTRUCTION. Every route is a GET and every underlying reader
only opens files. Nothing here mutates a run, and nothing here shells out.
"""

import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/operator", tags=["operator"])


# Auth is imported at module scope, which is correct: dashboard/auth.py
# imports PyJWT LAZILY (inside functions, auth.py:64 and :622), so importing
# auth does NOT require PyJWT to be installed. An earlier version of this file
# deferred the import on the theory that it did, and in doing so called the
# async dependency by hand and threw away the un-awaited coroutine -- the scope
# check silently stopped running. require_scope returns an ASYNC callable that
# FastAPI must inject (it takes Security(get_current_token)), so it belongs in
# Depends() and nowhere else.
from . import auth

# Every route below carries the "read" scope, matching api_v2. These endpoints
# expose run detail, gate results, receipt verdicts and release state -- all of
# it operational evidence about a real workspace, and none of it public.
#
# This is not optional politeness: tests/dashboard/test_all_data_gets_scoped.py
# is a regression guard for the v7.x finding that 68 of 110 GET routes carried
# no dependency, so an unauthenticated caller could read runs, tasks, memory and
# findings whenever LOKI_ENTERPRISE_AUTH was on. It caught these four routes
# unguarded on their first run, which is precisely what it exists to do.
_READ = [Depends(auth.require_scope("read"))]


def _loki_dir() -> str:
    """The workspace this dashboard is reporting on.

    Resolved per-request rather than at import time: the dashboard is started
    from the workspace directory in some deployments and given LOKI_DIR in
    others, and an import-time snapshot would pin whichever was true when the
    module first loaded.
    """
    return os.environ.get("LOKI_DIR") or os.path.join(_safe_getcwd(), ".loki")


def _safe_getcwd() -> str:
    """os.getcwd() raises FileNotFoundError once the cwd is deleted.

    These helpers run per request, so letting that propagate turns a stale
    working directory into a blanket 500 across the whole API. Fall back to
    this package's tree, which is on disk by definition.
    """
    try:
        return os.getcwd()
    except OSError:
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _repo_dir() -> str:
    return os.environ.get("LOKI_REPO_DIR") or _safe_getcwd()


# Ceilings for the receipt walk on the HTTP path. Generous enough that a real
# workspace (this repo's own archive is on the order of 75 receipts) never hits
# them, low enough that a pathological tree cannot hold a worker open. Both are
# overridable so an operator with a genuinely large archive can raise them
# rather than silently receiving PARTIAL results forever.
def _int_env(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, "") or default)
        return v if v > 0 else default
    except ValueError:
        return default


_RECEIPT_SCAN_MAX_ENTRIES = _int_env("LOKI_RECEIPT_SCAN_MAX_ENTRIES", 50000)
_RECEIPT_SCAN_MAX_SECONDS = _int_env("LOKI_RECEIPT_SCAN_MAX_SECONDS", 10)


def _allowed_roots() -> list:
    """The only trees a caller may ask this API to walk.

    LOKI_OPERATOR_ROOTS (os.pathsep-separated) when set, else the workspace and
    the repo. Resolved to real paths so the comparison in _resolve_workspace
    happens after symlinks are followed, not before.
    """
    raw = os.environ.get("LOKI_OPERATOR_ROOTS")
    candidates = raw.split(os.pathsep) if raw else [_loki_dir(), _repo_dir()]
    roots = []
    for c in candidates:
        c = c.strip()
        if not c:
            continue
        try:
            roots.append(os.path.realpath(c))
        except OSError:
            continue
    return roots


def _resolve_workspace(workspace: Optional[str]) -> str:
    """Confine `workspace` to an allowed root, or refuse.

    WHY THIS EXISTS. receipts_report walks its argument with an UNBOUNDED
    rglob (api_evidence.py:346) and stats every entry. Passed a caller-supplied
    path this is a filesystem-traversal primitive: `?workspace=/` walks the
    whole disk, `../../..` climbs out of the workspace, and a symlink inside an
    allowed root points anywhere at all. The auth dependency is not a
    sufficient answer, because LOKI_ENTERPRISE_AUTH is off by default, so on a
    default deployment this route is reachable unauthenticated.

    The check is done on the REALPATH of both sides. Comparing the raw string
    would be defeated by `..` segments and by a symlink whose name sits happily
    inside an allowed root while its target does not.

    Containment is tested by prefix on a path with a trailing separator:
    plain startswith would let "/workspaces-evil" pass as inside
    "/workspaces".
    """
    if workspace is None:
        return _loki_dir()
    try:
        target = os.path.realpath(workspace)
    except OSError as exc:
        raise HTTPException(status_code=400,
                            detail="workspace is not a usable path: %s" % exc)
    for root in _allowed_roots():
        if target == root or target.startswith(root.rstrip(os.sep) + os.sep):
            return target
    # The refusal names the parameter but NOT the allowed roots: echoing them
    # back turns a rejection into a filesystem-layout oracle.
    raise HTTPException(
        status_code=403,
        detail="workspace is outside the configured operator roots")


def _fail(what: str, exc: Exception):
    """A reader that raised is a 503, never an empty 200.

    This is the honesty rule at the transport layer. Returning `{"runs": []}`
    when the reader threw would be indistinguishable from a healthy empty
    workspace, and the dashboard would render "no runs" over a broken disk.
    """
    logger.warning("operator reader %s failed: %s", what, exc)
    raise HTTPException(
        status_code=503,
        detail="%s is unavailable: %s" % (what, exc),
    )


@router.get("/runs/{run_id}", dependencies=_READ)
def operator_run_detail(run_id: str):
    """One run plus its per-iteration records.

    Per-iteration detail exists only for the CURRENT run -- the efficiency
    records are wiped at run start (autonomy/run.sh). For any older run the
    reader returns an empty `iterations` with a reason saying so, which is
    correct and must not be mistaken for a run that did no work.
    """
    try:
        from . import api_runs
        return api_runs.get_run(_loki_dir(), run_id)
    except Exception as exc:
        _fail("run detail", exc)


@router.get("/tests", dependencies=_READ)
def operator_tests():
    """Latest gate evidence: tests, static analysis, build, coverage.

    Rows carry an explicit status rather than a bare boolean, because
    "not run" and "ran and failed" are different operator situations and a
    boolean collapses them.
    """
    try:
        from . import api_tests
        return api_tests.list_test_results(_loki_dir())
    except Exception as exc:
        _fail("test results", exc)


@router.get("/receipts", dependencies=_READ)
def operator_receipts(workspace: Optional[str] = Query(default=None)):
    """Evidence Receipts discovered for this workspace, with a batch verdict.

    Deliberately `receipts_report` and NOT `list_receipts`. The latter returns
    a bare list, and a bare list cannot distinguish "this workspace has no
    receipts" from "the walk failed" -- both arrive as []. The report carries
    an explicit `verdict` (EMPTY for a tree with nothing in it, which is its
    own state and not a pass), a `source` naming what was walked and what it
    was re-verified against, and an `error` field.

    The verdict is the WEAKEST state present, imported from the verifier
    rather than restated here, so this route cannot drift into disagreeing
    with `loki proof verify` about the same receipts.

    The `workspace` parameter is confined to the configured operator roots by
    _resolve_workspace before it reaches the walker. See that function for why
    an auth dependency alone does not cover this.
    """
    root = _resolve_workspace(workspace)
    try:
        from . import api_evidence
        # Bounded because this walk is reached from an HTTP request. Confining
        # the ROOT (above) limits where it walks; it does not limit how much,
        # and a deep allowed tree is still an unbounded rglob plus a stat per
        # entry. A truncated walk is reported honestly: receipts_report holds
        # the verdict down to UNVERIFIABLE and states that the audit is
        # PARTIAL, rather than certifying the subset it happened to reach.
        return api_evidence.receipts_report(
            root, repo_dir=_repo_dir(),
            max_entries=_RECEIPT_SCAN_MAX_ENTRIES,
            max_seconds=_RECEIPT_SCAN_MAX_SECONDS)
    except HTTPException:
        # A 403/400 from the confinement check is the ANSWER, not a failure to
        # read. Letting it fall into _fail would relabel a refused traversal as
        # a 503 "receipts unavailable", which reads as a broken disk and hides
        # that someone asked for a path they may not have.
        raise
    except Exception as exc:
        _fail("receipts", exc)


@router.get("/releases", dependencies=_READ)
def operator_releases(limit: int = Query(default=20, ge=1, le=200)):
    """Release history read from git tags, plus whether VERSION is ahead.

    On a checkout with no tags -- which is what GitHub Actions produces --
    the reader returns no rows, `newest_tag: None` and `version_is_ahead:
    None`. That last field is deliberately None and not False: "I cannot
    compare" is not "it is not ahead".
    """
    try:
        from . import api_releases
        return api_releases.list_releases(_repo_dir(), limit=limit)
    except Exception as exc:
        _fail("releases", exc)


@router.get("/phases", dependencies=_READ)
def operator_phases():
    """Measured phase history for the current run, from real phase_change events.

    Exists because the session-timeline component had no measured source and
    SYNTHESIZED one: a fixed phase rotation with `Math.random()` durations,
    rendered to an operator as history. The runtime does record the truth
    (autonomy/run.sh:6562 emits phase_change to .loki/events.jsonl, NOT to
    metrics/trust-events.jsonl); nothing exposed it.

    Segment endpoints are event timestamps and nothing else. The opening
    phase's start and the final phase's end were never emitted, so they read
    None and are reported as such -- an unmeasured boundary must not be
    back-computed from process uptime, which measures a different thing.
    """
    try:
        from . import api_phases
        return api_phases.phase_history(_loki_dir())
    except Exception as exc:
        _fail("phase history", exc)
