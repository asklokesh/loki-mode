#!/usr/bin/env python3
"""functional-verify.py -- FV-1: does the built app actually DO what the spec asked?

The completion verifier proves code was written + tests/build passed. It does NOT
prove the spec's BEHAVIORS work: a "waitlist" spec can be built as a static page
that captures nothing, yet read VERIFIED (measured: ~half of backend-implying
specs). This harness closes that gap by EXERCISING the running app against
assertions DERIVED FROM THE SPEC, and reporting an honest functional signal.

SCOPE (FV-1, deliberately narrow + honest):
  - It reports a DESCRIPTIVE signal only. It does NOT feed the VERIFIED headline
    (that is FV-2: a founder-gated trust-semantics decision, council-reviewed).
  - It derives HTTP endpoint assertions from the spec (GET/POST/DELETE <path>) and
    runs the CRUD lifecycle they imply against the LIVE app. It never fabricates:
    an endpoint it cannot reach is `inconclusive`, a behavior that failed is
    `failed`, a behavior proven is `passed`. Same inconclusive-never-false moat as
    the rest of the trust layer.
  - It requires the app to already be running (URL passed in) -- app-runner (>=
    v7.121.3, static sites included) starts it; this harness only probes.

Output: JSON to stdout -- {spec_behaviors: [...], summary: {passed, failed,
inconclusive}, functional_status: verified|partial|failed|inconclusive}.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request


# --- spec -> behavioral assertions ------------------------------------------

# Endpoint declarations in a spec/PRD: "GET /api/tasks", "POST /api/tasks",
# "DELETE /api/tasks/:id". Method + path; path may carry a :param placeholder.
_ENDPOINT_RE = re.compile(
    r'\b(GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9_./:{}-]*)',
)


def _clean_path(path: str) -> str:
    """Strip trailing sentence punctuation a spec sentence leaves on a path
    (e.g. "DELETE /api/tasks/:id." -> "/api/tasks/:id"). Without this, a probe
    hits a wrong URL and fabricates a failure on a working app -- a fake-RED in
    the FV layer itself, exactly what this harness exists to prevent."""
    return path.rstrip(".,;:)]}") or path


def derive_endpoint_assertions(spec_text: str) -> list[dict]:
    """Extract {method, path} endpoint assertions the spec explicitly names.

    Deduped, order-preserved. A path with a :param / {param} is a resource route
    (used for the DELETE-a-created-resource lifecycle below)."""
    seen = set()
    out = []
    for m in _ENDPOINT_RE.finditer(spec_text or ""):
        method = m.group(1).upper()
        path = _clean_path(m.group(2))
        key = (method, path)
        if key in seen:
            continue
        seen.add(key)
        out.append({"method": method, "path": path,
                    "is_resource": bool(re.search(r'[:{]', path))})
    return out


# Wording that marks an endpoint as protected. Matched on the endpoint's own line
# or on the nearest enclosing markdown heading (its section).
_PROTECTED_RE = re.compile(
    r'\b(requires?\s+(auth\w*|login|a\s+login|credentials|a\s+(bearer\s+|valid\s+)?token)'
    r'|(must|needs?\s+to)\s+be\s+(logged[ -]in|authenticated)'
    r'|login\s+required|auth(entication)?\s+required'
    r'|authenticated(\s+users?)?(\s+only)?|admin[ -]only|admins?\s+only'
    r'|protected\s+(endpoint|route|resource|api|path|page)s?|is\s+protected'
    r'|(without|no|missing)\s+(\w+\s+)?(auth\w*|credentials|token)\b[^.;]*?\b40[13])\b',
    re.IGNORECASE)
_NEGATION_WORDS = {"no", "not", "never", "without", "unauthenticated", "public",
                   "isn't", "doesn't", "don't", "cannot", "can't"}


def _is_protected_text(text: str) -> bool:
    """True when a protected-wording match is not directly negated. Negation
    cancels only the match it modifies: one of the two words right before it,
    inside the same clause (no ; , . or : between)."""
    for m in _PROTECTED_RE.finditer(text or ""):
        clause = re.split(r'[;,.:]', text[:m.start()])[-1]
        prev = re.findall(r"[\w']+", clause.lower())[-2:]
        if not any(w in _NEGATION_WORDS for w in prev):
            return True
    return False


def derive_auth_assertions(spec_text: str) -> list[dict]:
    """Endpoints the spec marks protected (same line or enclosing heading).
    Returns [{method, path}], deduped, order-preserved."""
    seen = set()
    out = []
    heading = ""
    for line in (spec_text or "").splitlines():
        if re.match(r'\s*#{1,6}\s', line):
            heading = line
        eps = list(_ENDPOINT_RE.finditer(line))
        if not eps:
            continue
        if not (_is_protected_text(line) or _is_protected_text(heading)):
            continue
        for m in eps:
            key = (m.group(1).upper(), _clean_path(m.group(2)))
            if key in seen:
                continue
            seen.add(key)
            out.append({"method": key[0], "path": key[1]})
    return out


# --- run assertions against the live app ------------------------------------

def _req(base_url: str, method: str, path: str, body=None, timeout=8):
    """One HTTP call. Returns (status_code, json_or_text) or (None, error_str)."""
    url = base_url.rstrip("/") + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw) if raw else None
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, OSError) as e:
        return None, str(e)


def verify_crud_lifecycle(base_url: str, assertions: list[dict]) -> list[dict]:
    """The core functional check: for a REST resource the spec names, prove the
    CRUD LIFECYCLE actually works end to end (not just that a route responds):
      POST creates -> the created item appears on GET -> DELETE removes it ->
      it is gone from a subsequent GET.
    This is what distinguishes a working backend from a static shell: a static
    page returns 200 on GET but a POST does not persist. Each behavior is
    passed / failed / inconclusive, never fabricated."""
    results = []

    # Collection GET/POST endpoints (non-resource) and their resource DELETE.
    gets = [a for a in assertions if a["method"] == "GET" and not a["is_resource"]]
    posts = [a for a in assertions if a["method"] == "POST" and not a["is_resource"]]
    deletes = [a for a in assertions if a["method"] == "DELETE" and a["is_resource"]]

    # 1. Every named collection GET must actually respond 2xx.
    for a in gets:
        code, payload = _req(base_url, "GET", a["path"])
        if code is None:
            results.append({"behavior": f"GET {a['path']} responds",
                            "status": "inconclusive", "detail": f"unreachable: {payload}"})
        elif 200 <= code < 300:
            results.append({"behavior": f"GET {a['path']} responds",
                            "status": "passed", "detail": f"HTTP {code}"})
        else:
            results.append({"behavior": f"GET {a['path']} responds",
                            "status": "failed", "detail": f"HTTP {code}"})

    # 2. POST-creates-and-persists lifecycle: for each collection POST that has a
    #    matching collection GET, POST an item and assert the collection grew.
    for p in posts:
        coll = p["path"]
        matching_get = next((g for g in gets if g["path"] == coll), None)
        if matching_get is None:
            results.append({"behavior": f"POST {coll} persists (verifiable)",
                            "status": "inconclusive",
                            "detail": "no matching collection GET to confirm persistence"})
            continue
        before_code, before = _req(base_url, "GET", coll)
        before_n = len(before) if isinstance(before, list) else None
        # A minimal, generic payload. Real apps validate; we send a common shape.
        post_code, created = _req(base_url, "POST", coll,
                                  body={"title": "fv-probe", "name": "fv-probe",
                                        "text": "fv-probe"})
        after_code, after = _req(base_url, "GET", coll)
        after_n = len(after) if isinstance(after, list) else None
        if post_code is None or after_code is None:
            results.append({"behavior": f"POST {coll} persists",
                            "status": "inconclusive",
                            "detail": "app unreachable during lifecycle"})
        elif post_code and 200 <= post_code < 300 and before_n is not None \
                and after_n is not None and after_n > before_n:
            results.append({"behavior": f"POST {coll} persists",
                            "status": "passed",
                            "detail": f"collection grew {before_n} -> {after_n} after POST"})
        elif post_code and 200 <= post_code < 300 and (before_n is None or after_n is None):
            # POST accepted but the collection is not a JSON array we can count:
            # we cannot PROVE persistence -> honest inconclusive, never a pass.
            results.append({"behavior": f"POST {coll} persists",
                            "status": "inconclusive",
                            "detail": f"POST HTTP {post_code} but GET is not a countable list"})
        elif post_code in (400, 422):
            # The endpoint EXISTS and rejected OUR probe payload (validation).
            # That is a working backend with a schema our generic {title,name,text}
            # did not satisfy -- NOT proof the behavior is broken. Marking it failed
            # would be a fake-RED (a strict-but-working app read as non-working).
            # Honest inconclusive; FV-2 must never wire a failed verdict off this.
            results.append({"behavior": f"POST {coll} persists",
                            "status": "inconclusive",
                            "detail": f"POST HTTP {post_code}: endpoint exists but rejected the "
                                      "probe payload (schema mismatch, not proof of no-persistence)"})
        else:
            # POST 404 (endpoint absent), 501 (not implemented), or 2xx-but-the-
            # collection did NOT grow -> the behavior the spec implies does NOT
            # work (a static shell or a non-persisting backend). Genuine failed.
            results.append({"behavior": f"POST {coll} persists",
                            "status": "failed",
                            "detail": f"POST HTTP {post_code}; collection {before_n} -> {after_n} "
                                      "(no persistence -- a static shell or non-working backend)"})

        # 3. DELETE lifecycle: if the spec names a resource DELETE and we created
        #    an item with an id, delete it and assert it's gone.
        created_id = None
        if isinstance(created, dict):
            created_id = created.get("id") or created.get("_id")
        if deletes and created_id is not None:
            dpath_tmpl = deletes[0]["path"]
            dpath = re.sub(r'[:{][A-Za-z0-9_]+[}]?', str(created_id), dpath_tmpl)
            del_code, _ = _req(base_url, "DELETE", dpath)
            _, after_del = _req(base_url, "GET", coll)
            still_there = isinstance(after_del, list) and any(
                isinstance(x, dict) and (x.get("id") == created_id or x.get("_id") == created_id)
                for x in after_del)
            if del_code is None:
                results.append({"behavior": f"DELETE {dpath_tmpl} removes",
                                "status": "inconclusive", "detail": "unreachable"})
            elif 200 <= del_code < 300 and not still_there:
                results.append({"behavior": f"DELETE {dpath_tmpl} removes",
                                "status": "passed",
                                "detail": f"item {created_id} gone after DELETE (HTTP {del_code})"})
            else:
                results.append({"behavior": f"DELETE {dpath_tmpl} removes",
                                "status": "failed",
                                "detail": f"DELETE HTTP {del_code}; item still present={still_there}"})
    return results


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def _probe_unauth(base_url: str, method: str, path: str, timeout=8):
    """One credential-free call, redirects not followed.
    Returns (status, body_nonempty, location_or_error)."""
    probe = re.sub(r'(:[A-Za-z_]\w*|\{[^}]*\})', 'loki-auth-probe', path)
    url = base_url.rstrip("/") + probe
    data = b"{}" if method in ("POST", "PUT", "PATCH") else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, bool(resp.read().strip()), ""
    except urllib.error.HTTPError as e:
        return e.code, False, e.headers.get("Location", "") or ""
    except (urllib.error.URLError, OSError) as e:
        return None, False, str(e)


def verify_auth_behaviors(base_url: str, auth_assertions: list[dict]) -> list[dict]:
    """Probe each spec-protected endpoint unauthenticated.
    401/403 -> passed; 2xx served -> failed; anything else -> inconclusive."""
    results = []
    for a in auth_assertions:
        method, path = a["method"], a["path"]
        name = f"auth: {method} {path} rejects unauthenticated requests"
        code, has_body, extra = _probe_unauth(base_url, method, path)
        if code in (401, 403):
            st, detail = "passed", f"HTTP {code} without credentials"
        elif code is not None and 200 <= code < 300 and (has_body or method != "GET"):
            st, detail = "failed", f"served without credentials (HTTP {code})"
        elif code is not None and 300 <= code < 400 and re.search(
                r'(^|/)(login|signin|sign-in|auth|oauth)\b', extra, re.IGNORECASE):
            st, detail = "passed", f"HTTP {code} redirect to {extra}"
        elif code is None:
            st, detail = "inconclusive", f"unreachable: {extra}"
        else:
            st, detail = "inconclusive", f"HTTP {code}; cannot tell if protected"
        results.append({"behavior": name, "status": st, "detail": detail})
    return results


def summarize(results: list[dict]) -> dict:
    passed = sum(1 for r in results if r["status"] == "passed")
    failed = sum(1 for r in results if r["status"] == "failed")
    inconclusive = sum(1 for r in results if r["status"] == "inconclusive")
    # functional_status: verified only if >=1 behavior passed and NONE failed;
    # failed if any behavior failed; inconclusive if nothing could be exercised.
    if failed > 0:
        status = "failed"
    elif passed > 0 and inconclusive == 0:
        status = "verified"
    elif passed > 0:
        status = "partial"
    else:
        status = "inconclusive"
    return {"passed": passed, "failed": failed, "inconclusive": inconclusive,
            "functional_status": status}


def run(spec_text: str, base_url: str) -> dict:
    assertions = derive_endpoint_assertions(spec_text)
    auth = verify_auth_behaviors(base_url, derive_auth_assertions(spec_text))
    if not assertions:
        return {"spec_behaviors": [], "summary": {"passed": 0, "failed": 0,
                "inconclusive": 0, "functional_status": "inconclusive"},
                "auth_behaviors": [], "note": "no HTTP endpoint behaviors derivable from the spec"}
    results = verify_crud_lifecycle(base_url, assertions)
    summ = summarize(results + auth)
    return {"assertions_derived": assertions, "spec_behaviors": results,
            "auth_behaviors": auth, "summary": summ, "functional_status": summ["functional_status"]}


def main(argv):
    if len(argv) < 3:
        print("usage: functional-verify.py <spec_file> <base_url>", file=sys.stderr)
        return 2
    spec_file, base_url = argv[1], argv[2]
    try:
        with open(spec_file, errors="replace") as f:
            spec_text = f.read()
    except OSError as e:
        print(json.dumps({"error": f"cannot read spec: {e}"}))
        return 1
    print(json.dumps(run(spec_text, base_url), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
