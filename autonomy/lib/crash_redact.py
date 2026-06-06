#!/usr/bin/env python3
"""Shared crash-report scrubber for Loki Mode (Phase 0, local-only).

This is the single security chokepoint for the crash-reporting feature. It is
called by all three routes (bash client via python3, Bun client via findPython3,
and -- in a later phase -- the FastAPI backend via import) so redaction can
never drift between them. It layers crash-specific deny rules on top of the
proof-of-run redactor and then emits a WHITELIST-ONLY payload.

Design rules (docs/CRASH-REPORTING-PLAN.md sections 5 and Phase 0):
  - Run proof_redact.redact_tree over the raw dict first (reuse the hardened,
    ReDoS-checked patterns).
  - Apply crash-specific deny rules (emails, IPs, repo names) to surviving
    strings BEFORE whitelisting.
  - Emit ONLY whitelisted keys; anything else is DROPPED, not redacted, so
    free-text (prompts, diffs, briefs) can never reach the payload.
  - Compute fingerprint and project_id_hash AFTER scrub, on the REDACTED data,
    so the client and the backend derive identical values.
  - FAIL CLOSED: never raise out of scrub_and_whitelist; on any internal error
    return a minimal safe dict with NO raw data.
"""

import hashlib
import json
import re
import sys
import os

# Make proof_redact importable regardless of cwd (same trick as
# proof-generator.py lines 32-37).
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import proof_redact  # noqa: E402

# Separate from proof_redact.RULES_VERSION. Bump only when crash scrub or
# whitelist behavior changes in a way callers must be able to detect.
CRASH_RULES_VERSION = "1.0"

# Number of normalized stack frames kept in the signature / fingerprint.
STACK_FRAMES_N = 5

# The ONLY keys allowed to leave the machine. Anything not here is dropped.
_WHITELIST = (
    "os",
    "arch",
    "loki_version",
    "node_version",
    "bun_version",
    "error_class",
    "stack_signature",
    "rarv_phase",
    "exit_code",
    "friction_kind",
    "project_id_hash",
    "fingerprint",
    "rules_version",
    "redactions_count",
    "captured_at",
)

# Crash-specific deny patterns. All quantifiers are bounded to stay ReDoS-safe;
# no nested unbounded groups. Slight over-redaction is preferred over a pattern
# that can backtrack.

# Email: bounded local part and domain. RFC-imperfect on purpose; we want a
# linear scan, not a validator.
_EMAIL = re.compile(
    r"[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,24}"
)

# IPv4: four bounded octets. Over-matches things like version strings on
# purpose (acceptable -- versions are emitted via the whitelisted, separately
# sourced loki_version field, not parsed from free text).
_IPV4 = re.compile(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b")

# IPv6: a simple bounded colon-hex form. Requires at least two groups so a bare
# "a:b" style label does not match. Bounded repetition keeps it linear.
_IPV6 = re.compile(r"\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b")


def _parse_owner_repo(git_remote):
    """Extract a normalized 'owner/repo' from a git remote URL, or None.

    Handles https://host/owner/repo(.git) and scp-style git@host:owner/repo(.git).
    Returns the literal 'owner/repo' string for deny matching, lowercased host
    is irrelevant here (we want the owner/repo path segment).
    """
    if not git_remote or not isinstance(git_remote, str):
        return None
    s = git_remote.strip()
    # scp-style: git@github.com:owner/repo.git
    m = re.match(r"^[^@]+@[^:]+:(.+)$", s)
    if m:
        path = m.group(1)
    else:
        # url-style: strip scheme and host, keep the path.
        m = re.match(r"^[A-Za-z][A-Za-z0-9+.\-]*://[^/]+/(.+)$", s)
        if m:
            path = m.group(1)
        else:
            path = s
    path = path.rstrip("/")
    if path.endswith(".git"):
        path = path[:-4]
    # Keep only the last two path segments (owner/repo).
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 2:
        return parts[-2] + "/" + parts[-1]
    return None


def _apply_crash_deny(s, repo_literals):
    """Apply crash-specific deny rules to one string. Returns (new, count).

    repo_literals: list of literal strings (repo names, owner/repo) to redact.
    Literals are matched via str.replace (never interpolated into a regex) so a
    repo name containing regex metacharacters cannot break the scan.
    """
    if not isinstance(s, str) or not s:
        return s, 0
    total = 0
    s, n = _EMAIL.subn("[REDACTED:EMAIL]", s)
    total += n
    s, n = _IPV6.subn("[REDACTED:IP]", s)
    total += n
    s, n = _IPV4.subn("[REDACTED:IP]", s)
    total += n
    for lit in repo_literals:
        if lit and lit in s:
            total += s.count(lit)
            s = s.replace(lit, "[REDACTED:REPO]")
    return s, total


def _crash_deny_tree(obj, repo_literals):
    """Recurse a JSON-like structure applying crash deny rules. Returns
    (new_obj, count). Mirrors proof_redact.redact_tree shape."""
    if isinstance(obj, str):
        return _apply_crash_deny(obj, repo_literals)
    if isinstance(obj, dict):
        out = {}
        total = 0
        for k, v in obj.items():
            new_k, ck = (k, 0)
            if isinstance(k, str):
                new_k, ck = _apply_crash_deny(k, repo_literals)
            new_v, cv = _crash_deny_tree(v, repo_literals)
            out[new_k] = new_v
            total += ck + cv
        return out, total
    if isinstance(obj, (list, tuple)):
        out = []
        total = 0
        for item in obj:
            new_item, c = _crash_deny_tree(item, repo_literals)
            out.append(new_item)
            total += c
        return out, total
    return obj, 0


def normalize_stack(frames, n=STACK_FRAMES_N):
    """Extract function/symbol names from raw stack frames; return the top n.

    Strips file paths, line numbers, columns, hex addresses, the leading "at ",
    and surrounding parens. Must be deterministic and machine-independent: two
    machines with different home paths must produce identical output for the
    same logical stack.

    Handles both common forms:
      - Python: 'File "/p/f.py", line 42, in func_name'
      - Node/Bun: 'at func_name (/p/f.js:10:5)' and anonymous 'at /p/f.js:1:1'
    """
    out = []
    if not isinstance(frames, (list, tuple)):
        return out
    for frame in frames:
        if not isinstance(frame, str):
            continue
        line = frame.strip()
        if not line:
            continue
        sym = None

        # Python traceback frame: '... in <symbol>' is the function name.
        m = re.search(r",\s*line\s+\d+,\s*in\s+(.+)$", line)
        if m:
            sym = m.group(1).strip()
        else:
            # Node/Bun: 'at <symbol> (<loc>)' -> capture symbol before '('.
            m = re.match(r"^at\s+(.*?)\s*\(", line)
            if m:
                sym = m.group(1).strip()
            else:
                # 'at <loc>' (anonymous) -> no symbol; mark as anonymous.
                m = re.match(r"^at\s+(.+)$", line)
                if m:
                    candidate = m.group(1).strip()
                    # If it looks like a bare path:line:col, it is anonymous.
                    if re.search(r":\d+(:\d+)?$", candidate) or "/" in candidate or "\\" in candidate:
                        sym = "<anonymous>"
                    else:
                        sym = candidate
                else:
                    # Not a recognized frame line (e.g. a Python traceback
                    # header "Traceback (most recent call last):" or the final
                    # "ValueError: boom" exception line). These are not frames,
                    # so skip them: the spec is "extract ONLY the function/symbol
                    # name per frame."
                    continue

        if sym is None:
            continue
        # Strip any trailing location that slipped through, hex addresses,
        # and balanced parens content.
        sym = re.sub(r"\s*\(.*\)\s*$", "", sym)
        sym = re.sub(r"\s*0x[0-9A-Fa-f]+\s*$", "", sym)
        sym = re.sub(r"[:@]\d+(:\d+)?$", "", sym)
        sym = sym.strip()
        if not sym:
            sym = "<anonymous>"
        out.append(sym)
        if len(out) >= n:
            break
    return out


def compute_fingerprint(error_class, stack_signature):
    """sha256 of error_class + "\\n" + joined stack_signature, hexdigest.

    Computed AFTER scrub on the redacted error_class and stack_signature so the
    client and the backend (recomputing from the received whitelisted payload)
    derive identical values.
    """
    ec = error_class if isinstance(error_class, str) else ""
    sig = stack_signature if isinstance(stack_signature, list) else []
    sig = [s if isinstance(s, str) else str(s) for s in sig]
    payload = ec + "\n" + "\n".join(sig)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def project_id_hash(git_remote):
    """Non-reversible project id from the git remote, sha256 UNSALTED hexdigest.

    Normalizes: strips scheme, .git suffix, trailing slash, lowercases host.
    If no remote, hashes the literal "no-remote".

    Unsalted tradeoff (stated explicitly): unsalted gives cross-user dedup (two
    users hitting the same bug in the same public repo collapse to one triage
    issue, which is the point of the occurrence counter). A per-user salt would
    kill that dedup. Unsalted is dictionary-attackable for known public repos,
    but the project id reveals only "which public repo," which is already public,
    so the privacy cost is acceptable. Private-repo origins still hash to an
    opaque value with no path/name leakage.
    """
    if not git_remote or not isinstance(git_remote, str) or not git_remote.strip():
        return hashlib.sha256(b"no-remote").hexdigest()
    s = git_remote.strip()
    # scp-style git@host:path -> host/path
    m = re.match(r"^[^@]+@([^:]+):(.+)$", s)
    if m:
        host = m.group(1).lower()
        path = m.group(2)
        norm = host + "/" + path
    else:
        # url-style: strip scheme, lowercase host, keep path.
        m = re.match(r"^[A-Za-z][A-Za-z0-9+.\-]*://([^/]+)(/.*)?$", s)
        if m:
            host = m.group(1).lower()
            path = m.group(2) or ""
            norm = host + path
        else:
            norm = s
    norm = norm.rstrip("/")
    if norm.endswith(".git"):
        norm = norm[:-4]
    norm = norm.rstrip("/")
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


# Allowed friction_kind values. Anything else is dropped to None so a misused
# caller cannot smuggle free text through this whitelisted field.
_FRICTION_KINDS = ("retry_loop", "rate_limit_loop", "gate_failure")

# Allowed RARV phase labels (uppercase), verified from autonomy/run.sh
# get_rarv_phase_name and its callers. The literal lowercase "iteration"
# default (run.sh:9437) is handled separately so it can be kept lowercase.
_RARV_PHASES = frozenset(
    ("REASON", "ACT", "REFLECT", "VERIFY", "UNKNOWN", "CONVERGE", "CLOSE")
)

# Characters allowed in a sanitized short token (identifier-like + a few
# separators common in error class / phase names, e.g. "errno.ENOENT",
# "Foo:Bar", "REVIEW").
_TOKEN_ALLOWED = re.compile(r"[^A-Za-z0-9_.:\-]")


def _sanitize_token(value, max_len):
    """Reduce a string to a strict short token, or "" if nothing survives.

    Takes the leading token (up to the first whitespace), keeps only
    [A-Za-z0-9_.:-], and truncates to max_len. Returns "" when the input is not
    a string or nothing survives, so callers can apply their own fallback. This
    is the shared core for hardening free-text-capable whitelisted fields: it
    guarantees a misused field can never carry an arbitrary message or secret
    (including a short secret below proof_redact's 20-char ReDoS floor).
    """
    if not isinstance(value, str):
        return ""
    parts = value.split(None, 1)
    token = parts[0] if parts else ""
    token = _TOKEN_ALLOWED.sub("", token)
    return token[:max_len]


def sanitize_error_class(value):
    """Reduce error_class to a strict class-name shape.

    error_class is a free-text-capable whitelisted field, so harden it
    independently of the regex scrubber (which only catches secrets >= 20 chars
    because of the ReDoS floor in proof_redact). A short secret in a misused
    error_class would otherwise survive. Leading token only, [A-Za-z0-9_.:-],
    truncated to 64 chars, falling back to "UnknownError" if empty.
    """
    token = _sanitize_token(value, 64)
    return token if token else "UnknownError"


def sanitize_rarv_phase(value):
    """Allowlist rarv_phase to the known RARV phase set, else None.

    rarv_phase is a closed enum (verified from autonomy/run.sh
    get_rarv_phase_name and its callers), so allowlist it rather than
    shape-sanitize: a leading-token sanitize would keep a leading token even
    when the token itself is a short secret. An allowlist makes it impossible
    for any free text or secret to ride in rarv_phase.

    Matching is case-insensitive and normalized to uppercase (the TS route
    uppercases too), EXCEPT the literal lowercase "iteration" default used in
    run.sh:9437 is kept lowercase. Anything not in the set becomes None.
    """
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    upper = stripped.upper()
    if upper in _RARV_PHASES:
        return upper
    if stripped.lower() == "iteration":
        return "iteration"
    return None


def sanitize_exit_code(value):
    """Coerce exit_code to an integer, or None.

    An exit code is always numeric, so int(value) if it parses else None. This
    guarantees no string content (and thus no secret) can ride in exit_code even
    if a caller passes a string.
    """
    if isinstance(value, bool):
        # bool is a subclass of int; treat it as non-numeric here.
        return None
    if isinstance(value, int):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def sanitize_friction_kind(value):
    """Allowlist friction_kind to the known set, else None.

    Prevents a misused caller from placing free text (and thus a short secret)
    into this whitelisted field.
    """
    if isinstance(value, str) and value in _FRICTION_KINDS:
        return value
    return None


def _safe_minimal():
    """Fail-closed result: no raw data, ever."""
    return {
        "error_class": "ScrubError",
        "rules_version": CRASH_RULES_VERSION,
        "redactions_count": 0,
    }


def scrub_and_whitelist(
    raw,
    home=None,
    repo_root=None,
    git_remote=None,
    public_repo=None,
    private_repo=None,
):
    """Scrub a raw crash context and emit a whitelist-only payload.

    Steps:
      1. proof_redact.redact_tree over raw (with set_context/reset_context).
      2. crash-specific deny rules (emails, IPv4/IPv6, repo names) on surviving
         string values.
      3. compute stack_signature (from redacted frames), project_id_hash, and
         fingerprint -- all on redacted data.
      4. WHITELIST-only emit; drop everything else.

    Never raises. On any internal error returns the safe minimal dict.
    """
    try:
        if not isinstance(raw, dict):
            return _safe_minimal()

        # 1. proof_redact pass.
        proof_redact.reset_context()
        try:
            proof_redact.set_context(home=home, repo_root=repo_root)
            redacted, proof_count = proof_redact.redact_tree(raw)
        finally:
            proof_redact.reset_context()

        # 2. crash-specific deny rules on surviving strings.
        repo_literals = []
        for lit in (public_repo, private_repo):
            if lit and isinstance(lit, str):
                repo_literals.append(lit)
        owner_repo = _parse_owner_repo(git_remote)
        if owner_repo:
            repo_literals.append(owner_repo)
        redacted, crash_count = _crash_deny_tree(redacted, repo_literals)

        total_redactions = proof_count + crash_count

        # 3. derived fields on REDACTED data.
        # stack_signature: prefer an explicit list of frames; accept either
        # "stack_signature" or "stack" as the source of frames.
        frames = redacted.get("stack_signature")
        if not isinstance(frames, list):
            frames = redacted.get("stack")
        stack_signature = normalize_stack(frames, n=STACK_FRAMES_N)

        # Harden every free-text-capable whitelisted field BEFORE it enters the
        # output or the fingerprint. The regex scrubber only catches secrets
        # >= 20 chars (proof_redact ReDoS floor), so a short secret in a misused
        # error_class, rarv_phase, or exit_code would otherwise survive.
        # error_class is reduced to a strict short token (it is genuinely
        # variable -- an exception class name); rarv_phase is allowlisted to the
        # known RARV phase enum; exit_code is coerced to an integer. None of
        # them can carry an arbitrary message or secret. The fingerprint is
        # computed on the sanitized error_class so client and backend (which
        # re-sanitize the received payload) still derive the same hash.
        error_class = sanitize_error_class(redacted.get("error_class"))

        fingerprint = compute_fingerprint(error_class, stack_signature)
        pid_hash = project_id_hash(git_remote)

        # 4. whitelist-only emit. Start from redacted source for whitelisted
        # keys, then overlay the freshly computed / sanitized fields.
        out = {}
        for key in _WHITELIST:
            if key in redacted:
                out[key] = redacted[key]
        out["stack_signature"] = stack_signature
        out["error_class"] = error_class
        # rarv_phase: strict short token (or None) so it cannot carry free text.
        if "rarv_phase" in redacted:
            out["rarv_phase"] = sanitize_rarv_phase(redacted.get("rarv_phase"))
        # exit_code: coerce to int (or None) so no string content can ride in it.
        if "exit_code" in redacted:
            out["exit_code"] = sanitize_exit_code(redacted.get("exit_code"))
        # friction_kind is allowlisted; drop to None if not a known value.
        out["friction_kind"] = sanitize_friction_kind(redacted.get("friction_kind"))
        out["fingerprint"] = fingerprint
        out["project_id_hash"] = pid_hash
        out["rules_version"] = CRASH_RULES_VERSION
        out["redactions_count"] = total_redactions
        return out
    except Exception:
        # Fail closed: never leak raw data through an exception path.
        return _safe_minimal()


if __name__ == "__main__":
    # Read a JSON dict from stdin, scrub, print scrubbed JSON to stdout.
    # This is how the bash/TS clients call the scrubber directly.
    try:
        data = json.load(sys.stdin)
    except Exception:
        print(json.dumps(_safe_minimal()))
        sys.exit(0)
    if not isinstance(data, dict):
        print(json.dumps(_safe_minimal()))
        sys.exit(0)
    # Optional context can be passed inside a "_ctx" sidecar key (not emitted,
    # since it is not whitelisted). This lets callers supply home/repo/remote
    # without separate argv plumbing for the simple stdin path.
    ctx = data.pop("_ctx", {}) if isinstance(data.get("_ctx"), dict) else {}
    result = scrub_and_whitelist(
        data,
        home=ctx.get("home"),
        repo_root=ctx.get("repo_root"),
        git_remote=ctx.get("git_remote"),
        public_repo=ctx.get("public_repo"),
        private_repo=ctx.get("private_repo"),
    )
    print(json.dumps(result))
