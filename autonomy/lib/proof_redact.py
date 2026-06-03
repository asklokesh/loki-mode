"""Redaction module for Loki Mode proof-of-run artifacts.

This is the single security chokepoint for the proof-of-run feature. The
generator assembles the full proof dict, then calls redact_tree() exactly
once before serialization. The HTML page is built only from the redacted
dict. If redaction did not run, the generator refuses to emit.

RULES_VERSION is part of the frozen schema; bump it only when the redaction
behavior changes in a way callers must be able to detect.

Patterns implemented (see R1-proof-of-run-PLAN.md REDACTION RULES):
  - Anthropic keys (sk-ant-...) -> [REDACTED:ANTHROPIC_KEY]
  - OpenAI-style keys (sk-...)  -> [REDACTED:OPENAI_KEY]
  - Google API keys (AI...)     -> [REDACTED:GOOGLE_KEY]
  - GitHub tokens (gh[pousr]_)  -> [REDACTED:GITHUB_TOKEN]
  - AWS access key ids (AKIA..) -> [REDACTED:AWS_KEY]
  - AWS secret access keys       -> [REDACTED:AWS_SECRET]
  - Slack tokens (xox[baprs]-)  -> [REDACTED:SLACK_TOKEN]
  - Bearer tokens               -> Bearer [REDACTED]
  - JWTs (eyJ...)               -> [REDACTED:JWT]
  - PEM PRIVATE KEY blocks      -> dropped whole -> [REDACTED:PRIVATE_KEY]
  - .env / JSON / YAML secret assigns -> KEY=[REDACTED] / "key": "[REDACTED]"
  - Connection-string credentials -> scheme://user:[REDACTED]@host
  - Absolute user home paths    -> ~ (or repo-relative when ctx HOME matches)
"""

import re

RULES_VERSION = "1.0"

# Module-level context set via set_context() by the generator before
# redact_tree() runs. Lets path redaction prefer repo-relative output when a
# repo root is known. Context-free fallbacks always apply regardless.
_CTX = {"home": None, "repo_root": None}


def set_context(home=None, repo_root=None):
    """Provide optional context used by path redaction.

    home: the user's home dir ($HOME). Absolute paths under it collapse to ~.
    repo_root: the repository root. Absolute paths under it become repo-rel.
    Both are best-effort; the generic /Users/<n>/ and /home/<n>/ collapse
    runs even when this is never called.
    """
    if home:
        _CTX["home"] = home.rstrip("/")
    if repo_root:
        _CTX["repo_root"] = repo_root.rstrip("/")


def reset_context():
    """Clear context. Mainly for tests."""
    _CTX["home"] = None
    _CTX["repo_root"] = None


# Each entry: (compiled_regex, replacement). Order matters: the most specific
# patterns must run before broader ones (e.g. sk-ant- before sk-).
_PATTERNS = [
    # Anthropic keys must precede the generic sk- rule.
    (re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"), "[REDACTED:ANTHROPIC_KEY]"),
    # GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_.
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED:GITHUB_TOKEN]"),
    # Slack tokens: xoxb-, xoxa-, xoxp-, xoxr-, xoxs-.
    (re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "[REDACTED:SLACK_TOKEN]"),
    # AWS access key id.
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[REDACTED:AWS_KEY]"),
    # JWTs: three base64url segments separated by dots, starting eyJ.
    (
        re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
        "[REDACTED:JWT]",
    ),
    # Google API keys (broad per app_secrets.py:22).
    (re.compile(r"AI[a-zA-Z0-9_-]{30,}"), "[REDACTED:GOOGLE_KEY]"),
    # Generic OpenAI-style keys (after sk-ant- so it does not eat them).
    (re.compile(r"sk-[A-Za-z0-9_-]{20,}"), "[REDACTED:OPENAI_KEY]"),
]

# Bearer tokens: keep the scheme, redact the credential.
_BEARER = re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}")

# PEM PRIVATE KEY blocks (any -----BEGIN ... PRIVATE KEY----- ... END block).
# DOTALL so the body spanning newlines is matched and dropped whole.
_PEM = re.compile(
    r"-----BEGIN[^-]*PRIVATE KEY-----.*?-----END[^-]*PRIVATE KEY-----",
    re.DOTALL,
)

# AWS secret access key: 40-char base64-ish token. Anchored to a key hint so
# it does not nuke arbitrary 40-char strings. We look for an aws-secret style
# assignment and redact the value.
_AWS_SECRET_ASSIGN = re.compile(
    r"(?i)(aws_secret_access_key|aws_secret)\s*[=:]\s*[\"']?[A-Za-z0-9/+=]{40}[\"']?"
)

# Secret assignments: keep the key, redact the value. Mirrors the bash privacy
# guard at autonomy/run.sh:9047, extended to tolerate JSON / YAML-quoted forms.
#
# Three shapes are covered by one pattern:
#   bare        DB_PASSWORD=hunter2          DB_PASSWORD: hunter2
#   JSON-quoted "db_password": "hunter2"     "token":"abc"
#   single-quote 'client_secret': 'abc'
#
# Group layout:
#   1 -> optional opening quote around the key (" or ' or none); a backref
#        forces the closing quote to match so we never key off a stray quote.
#   2 -> the key itself (must contain a secret keyword, case-insensitive).
#   3 -> the separator run (= or :, with surrounding whitespace).
#   4 -> the value, either a fully-quoted string or a bare non-space run.
#
# The leading \b (placed AFTER the optional opening quote, BEFORE the key
# word-chars) anchors each attempt to a word boundary. Without it, the greedy
# [A-Za-z0-9_]* prefix would restart at every offset inside a long
# word-character run, making the scan O(n^2) (a ReDoS / proof-generator DoS on
# large diffs). With it the scan is linear.
_ENV_ASSIGN = re.compile(
    r"(?i)"
    r"([\"']?)"                          # 1: optional opening quote
    r"\b"                                # anchor: keeps the scan linear
    r"([A-Za-z0-9_]*"
    r"(?:PASSPHRASE|PASS_PHRASE|PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE_KEY"
    r"|AWS_SECRET_ACCESS_KEY|AWS_SECRET|DB_PASS|CREDENTIAL|CLIENT_SECRET"
    r"|ACCESS_TOKEN|REFRESH_TOKEN|AUTH(?!ORIZATION))"
    # AUTH(?!ORIZATION): match auth / auth_token / oauth keys but NOT the HTTP
    # "Authorization: Bearer <tok>" header, which the Bearer rule owns (it keeps
    # the scheme word). "authorization_token" still matches via the TOKEN branch.
    r"[A-Za-z0-9_]*)"                    # 2: key
    r"\1"                                # matching closing quote
    r"(\s*[=:]\s*)"                      # 3: separator
    r"(\"[^\"]*\"|'[^']*'|\S+)"          # 4: quoted-or-bare value
)


def _env_assign_sub(m):
    """Redact a secret assignment value, preserving key, separator and quotes.

    Quoted values keep their surrounding quotes (so "k": "v" -> "k": "[REDACTED]"
    stays valid JSON/YAML); bare values are replaced wholesale.
    """
    open_q, key, sep, val = m.group(1), m.group(2), m.group(3), m.group(4)
    if val and val[0] in "\"'" and len(val) >= 2 and val[-1] == val[0]:
        q = val[0]
        return open_q + key + open_q + sep + q + "[REDACTED]" + q
    return open_q + key + open_q + sep + "[REDACTED]"


# Connection-string / URI credentials: scheme://user:PASSWORD@host -> redact
# the password component for ANY scheme, keeping scheme/user/host intact.
# The leading \b anchors each attempt; the negated classes ([^\s:/@] etc.) make
# each segment a single linear pass with no nested quantifier overlap.
#   1 -> scheme://user:    2 -> password    3 -> @
# Covers postgres://, mongodb://, redis:// (empty user), amqp://, https://, etc.
# A URL with no "user:pass@" credential (https://host/path) does not match.
# The password class is [^\s@]+ (stops only at the closing @) so passwords that
# contain "/" (e.g. postgres://user:p/ss@host) are still fully captured.
_URI_CREDENTIAL = re.compile(
    r"\b([A-Za-z][A-Za-z0-9+.\-]*://[^\s:/@]*:)([^\s@]+)(@)"
)

# Absolute user home paths -> ~ . Applied to every string (paths, diffs,
# brief, summaries). Windows form handled separately to keep the backslash
# class readable.
_UNIX_HOME = re.compile(r"/(?:Users|home)/[^/\s\"']+")
_WIN_HOME = re.compile(r"[Cc]:\\Users\\[^\\\s\"']+")


def _redact_paths(s):
    """Collapse absolute user paths. Returns (new_string, count)."""
    count = 0

    def _unix_sub(m):
        nonlocal count
        count += 1
        matched = m.group(0)
        home = _CTX["home"]
        repo_root = _CTX["repo_root"]
        # Prefer repo-relative when the path is inside a known repo root.
        # Note: m only captured /Users/<n> (no trailing path), so we cannot
        # reconstruct the full path here. We collapse the home prefix to ~ and
        # leave the remainder (handled by the caller operating on the whole
        # string is not possible per-match, so ~ is the safe generic result).
        if home and matched == home:
            return "~"
        if repo_root and matched == repo_root:
            return "."
        return "~"

    def _win_sub(m):
        nonlocal count
        count += 1
        return "~"

    # First collapse a full $HOME / repo_root prefix anywhere in the string,
    # which preserves the trailing path component (e.g. ~/git/x).
    home = _CTX["home"]
    repo_root = _CTX["repo_root"]
    if repo_root and repo_root in s:
        n = s.count(repo_root)
        s = s.replace(repo_root, ".")
        count += n
    if home and home in s:
        n = s.count(home)
        s = s.replace(home, "~")
        count += n

    s, n1 = _UNIX_HOME.subn(_unix_sub, s)
    s, n2 = _WIN_HOME.subn(_win_sub, s)
    return s, count


def _redact_value(s):
    """Redact a single string. Returns (new_string, redactions_count).

    Internal: counts every individual redaction (multiple secrets in one
    string each increment the count) via re.subn.
    """
    if not isinstance(s, str) or not s:
        return s, 0

    total = 0

    # PEM blocks first: drop the whole block before any token-level rule can
    # partially match inside it.
    s, n = _PEM.subn("[REDACTED:PRIVATE_KEY]", s)
    total += n

    # AWS secret assignments (typed) before generic env-assign so the value
    # is labelled rather than reduced to a generic [REDACTED].
    s, n = _AWS_SECRET_ASSIGN.subn(
        lambda m: m.group(1) + "=[REDACTED:AWS_SECRET]", s
    )
    total += n

    # Token patterns (ordered most-specific-first).
    for pat, repl in _PATTERNS:
        s, n = pat.subn(repl, s)
        total += n

    # Bearer tokens (keep scheme).
    s, n = _BEARER.subn(r"\1[REDACTED]", s)
    total += n

    # Connection-string / URI credentials: scheme://user:PASSWORD@ -> redact
    # the password. Runs before the generic env-assign so the "scheme://user:"
    # prefix is consumed and the assign rule does not double-process it.
    s, n = _URI_CREDENTIAL.subn(r"\1[REDACTED]\3", s)
    total += n

    # Secret assignments (bare, JSON-quoted, YAML-quoted): keep key, redact value.
    s, n = _ENV_ASSIGN.subn(_env_assign_sub, s)
    total += n

    # Absolute user paths.
    s, n = _redact_paths(s)
    total += n

    return s, total


def redact_value(s):
    """Public: redact a single string, returning only the redacted string."""
    out, _ = _redact_value(s)
    return out


def redact_tree(obj):
    """Recursively redact every string in a JSON-like structure.

    Recurses both dict KEYS and dict VALUES, list items, and nested
    structures. Returns (new_object, total_redactions_count).
    """
    if isinstance(obj, str):
        return _redact_value(obj)

    if isinstance(obj, dict):
        out = {}
        total = 0
        for k, v in obj.items():
            new_k, ck = (k, 0)
            if isinstance(k, str):
                new_k, ck = _redact_value(k)
            new_v, cv = redact_tree(v)
            out[new_k] = new_v
            total += ck + cv
        return out, total

    if isinstance(obj, (list, tuple)):
        out = []
        total = 0
        for item in obj:
            new_item, c = redact_tree(item)
            out.append(new_item)
            total += c
        return out, total

    # int, float, bool, None: nothing to redact.
    return obj, 0
