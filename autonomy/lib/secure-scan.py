#!/usr/bin/env python3
"""Secure-by-default scan engine for Loki Mode (Loop 4, secure-by-default gate).

A standalone, high-precision scanner for a SMALL set of known-bad security
patterns in a generated app. The entire value of this scanner is precision: a
security gate that cries wolf is worse than none, because false positives turn
into friction and users learn to ignore it. So every rule here is written to
fire on the genuinely dangerous pattern AND to stay silent on the safe
equivalent. When in doubt we do NOT flag (a missed finding is a known, accepted
tradeoff for v1 trust; we never invent one).

The scanner is honest by construction:
  - It never claims an app is "secure". It reports "N known-bad patterns found"
    (or zero). Absence of these specific findings is not a guarantee of safety.
  - Each finding carries an actionable fix: what is wrong, where (file:line),
    and how to fix it.
  - It scans only text files and skips binaries, vendored trees (node_modules,
    .git, vendor, bundled dist of dependencies) and oversized files, so it is
    cheap and deterministic.

The five v1 rules (see internal/LOOP4-SECURE-BY-DEFAULT-PLAN.md):
  1. private-key-committed   (HIGH)   a PEM private-key block in any text file
  2. secret-in-client-file   (HIGH)   a real secret literal in a browser-served file
  3. world-open-datastore    (HIGH)   a literal world-open datastore rule
  4. debug-in-prod           (MEDIUM) a debug flag enabled in a production-config file
  5. cors-wildcard-credentials (MEDIUM) ACAO * together with ACAC true

CLI (mirrors dashboard/audit.py / proof-verify.py shim style):
    python3 autonomy/lib/secure-scan.py <target_dir> [--json]
  Prints a JSON result:
    {
      "rules_version": "1.0",
      "findings": [
        {"rule","file","line","severity","message","fix"}, ...
      ],
      "summary": {"total": N, "by_severity": {"HIGH": h, "MEDIUM": m}}
    }
  Exit codes:
    0  no findings
    1  one or more findings
    2  bad input (target dir missing / unreadable)
"""

import json
import os
import re
import sys

RULES_VERSION = "1.0"

# --- scan limits -----------------------------------------------------------
# Cap per-file size so a giant generated bundle cannot stall the gate. 2 MiB is
# generous for source/config; real secrets live in small files and large minified
# vendor bundles are skipped anyway via SKIP_DIRS / extension filtering.
MAX_FILE_BYTES = 2 * 1024 * 1024

# Directories we never descend into: VCS metadata, installed dependencies, and
# vendored/build trees that are not the user's own authored code. Flagging a
# dependency's example key is pure noise.
SKIP_DIRS = {
    ".git", "node_modules", "vendor", "bower_components",
    ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".tox", ".idea", ".vscode", ".gradle", ".terraform",
    "site-packages", ".next", ".nuxt", ".cache",
}

# Extensions that are unambiguously binary; reading them as text is wasted work
# and the regexes are meaningless against them.
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
    ".pdf", ".zip", ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac",
    ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".class",
    ".jar", ".war", ".pyc", ".pyo", ".wasm", ".db", ".sqlite", ".sqlite3",
}

# Web roots: a file under one of these directories is shipped to the browser.
# We match a path COMPONENT equal to one of these so "src/public/app.js" counts
# but "publication.js" does not.
WEB_ROOT_COMPONENTS = {"public", "static", "dist", "www", "build", "assets"}

# Client-side source extensions. A .html is always browser-served; .js / .mjs /
# .jsx / .ts(x) are browser-served only when they ALSO sit under a web root
# (server-side Node code is also .js and we must not flag a key in a server file
# here -- rule 1 covers PEM keys anywhere, but rule 2 is specifically about the
# leak-to-browser surface).
CLIENT_ALWAYS_EXT = {".html", ".htm"}
CLIENT_IF_WEBROOT_EXT = {".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"}


# ---------------------------------------------------------------------------
# rule 1: private key committed
# ---------------------------------------------------------------------------
# A PEM private-key header is real key material. The false-positive rate is
# near zero: the literal "-----BEGIN ... PRIVATE KEY-----" framing does not
# occur in normal source except in actual keys (or a deliberate test fixture,
# which is exactly what should be flagged anyway).
_PEM_PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"
)


# ---------------------------------------------------------------------------
# rule 2: secret literal in a browser-served file
# ---------------------------------------------------------------------------
# Known-prefix secret shapes. These prefixes are vendor-issued and have a fixed
# alphabet/length, so matching them is high precision (unlike generic entropy
# heuristics, which are FP-prone and deliberately NOT used here).
_SECRET_PATTERNS = [
    # AWS access key id
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    # OpenAI-style secret key (sk- followed by >=20 url-safe chars)
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    # GitHub personal access token (classic): ghp_ + 36 chars
    ("github-pat", re.compile(r"\bghp_[A-Za-z0-9]{36}\b")),
    # Google API key: AIza + 35 url-safe chars
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    # Slack bot token: xoxb- + token body
    ("slack-bot-token", re.compile(r"\bxoxb-[0-9A-Za-z-]{10,}\b")),
]

# Placeholder / example markers. If the matched secret (or its surrounding
# token) is an obvious placeholder, do NOT flag it. This is the core
# false-positive guard for rule 2: docs, .env.example files and templates are
# full of fake keys and flagging them is exactly the cry-wolf failure mode.
_PLACEHOLDER_TOKENS = (
    "xxxx", "your-key", "your_key", "yourkey", "example", "examplekey",
    "changeme", "change-me", "placeholder", "redacted", "dummy", "sample",
    "test-key", "testkey", "fake", "todo", "replace", "insert",
)
_PLACEHOLDER_RE = re.compile(r"<[^>]+>|\{\{[^}]+\}\}|\$\{[^}]+\}")


def _is_placeholder_secret(secret):
    """True if the matched secret literal is an obvious placeholder, not a real
    credential. Conservative: only the well-known fake markers, plus an
    all-same-character body (e.g. AKIAXXXXXXXXXXXXXXXX or all zeros)."""
    low = secret.lower()
    for tok in _PLACEHOLDER_TOKENS:
        if tok in low:
            return True
    # strip the known prefix so we examine just the secret body
    body = secret
    for prefix in ("akia", "sk-", "ghp_", "aiza", "xoxb-"):
        if low.startswith(prefix):
            body = secret[len(prefix):]
            break
    if body:
        # all-identical character (XXXX..., 0000..., AAAA...) => placeholder
        if len(set(body.lower())) <= 1:
            return True
        # mostly x or 0 (a common redaction style) => placeholder
        filler = sum(1 for c in body.lower() if c in "x0")
        if filler >= max(1, int(len(body) * 0.8)):
            return True
    return False


def _markup_wraps_match(line, start, end):
    """True only if a template placeholder (<...>, {{...}}, ${...}) CONTAINS the
    matched secret span [start,end) -- i.e. the value itself is templated, like
    key="${SECRET}" or "<YOUR_KEY>". This must NOT suppress a real secret that
    merely shares a line with an unrelated tag (e.g. an HTML <script>/<meta>
    element with a baked-in key), which the old whole-line check wrongly hid."""
    for mm in _PLACEHOLDER_RE.finditer(line):
        if mm.start() <= start and mm.end() >= end:
            return True
    return False


def _is_browser_served(rel_path):
    """True if a file at rel_path is shipped to the browser.

    .html is always browser-served. Client-script extensions count only when a
    path component is a known web root, so a server-side foo.js does not trip
    rule 2 (a server file leaking a key to the browser is the thing we are
    detecting; a key in server-only code is a different, non-client concern)."""
    ext = os.path.splitext(rel_path)[1].lower()
    if ext in CLIENT_ALWAYS_EXT:
        return True
    if ext in CLIENT_IF_WEBROOT_EXT:
        parts = {p.lower() for p in rel_path.replace("\\", "/").split("/")}
        return bool(parts & WEB_ROOT_COMPONENTS)
    return False


# ---------------------------------------------------------------------------
# rule 3: world-open datastore (literal forms only)
# ---------------------------------------------------------------------------
# Firebase realtime/firestore rules granting unconditional read/write.
# Matches  ".write": true   /   ".read": true   (any whitespace, single or
# double quotes). This is the literal "anyone can read/write everything" rule.
# A rule whose value is a string expression (e.g. "auth != null") is NOT
# matched, because true is the only unconditional-open literal.
_FIREBASE_OPEN = re.compile(
    r"""['"]\.(?:read|write)['"]\s*:\s*true\b"""
)
# S3 / bucket ACL granting public access.
_S3_PUBLIC_ACL = re.compile(
    r"""['"]?(?:acl|ACL)['"]?\s*[:=]\s*['"](?:public-read|public-read-write)['"]"""
)
# AWS canned ACL constant used in CDK/SDK code. MUST be QUALIFIED by an AWS/S3
# context token so it does not fire on an app-domain identifier (e.g. an
# ACCESS_LEVELS enum, a Visibility enum, a permissions doc) that merely contains
# the words PUBLIC_READ. We require either a dotted SDK form
# (CannedAccessControl.PUBLIC_READ, BucketAccessControl.PUBLIC_READ,
# s3.X.PUBLIC_READ) or PUBLIC_READ adjacent to an s3/bucket/acl/canned token on
# the same match. Bare `PUBLIC_READ` (a common permission identifier) is ignored.
_S3_PUBLIC_ENUM = re.compile(
    r"""(?:
        (?:Canned[A-Za-z]*|BucketAccessControl|s3|S3)\s*\.\s*
            (?:[A-Za-z_]+\s*\.\s*)?PUBLIC_READ(?:_WRITE)?\b
      | \bPUBLIC_READ(?:_WRITE)?\b[^\n]{0,40}?\b(?:acl|ACL|[Bb]ucket|s3|S3|[Cc]anned)\b
      | \b(?:acl|ACL|[Bb]ucket|s3|S3|[Cc]anned)\b[^\n]{0,40}?\bPUBLIC_READ(?:_WRITE)?\b
    )""",
    re.VERBOSE,
)
# Lines that are pure comments/docs must never trigger rule 3 (a SECURITY.md or a
# code comment warning AGAINST PUBLIC_READ is not a vulnerability).
_COMMENT_OR_DOC_LINE = re.compile(r"""^\s*(?:#|//|\*|<!--|>)""")
# Supabase: an anon/public policy combined with RLS disabled. We require BOTH
# the explicit disable AND a public/anon grant in the same file to avoid
# flagging a legitimately RLS-disabled internal table.
_SUPABASE_RLS_DISABLE = re.compile(
    r"DISABLE\s+ROW\s+LEVEL\s+SECURITY", re.IGNORECASE
)
_SUPABASE_PUBLIC_GRANT = re.compile(
    r"\bTO\s+(?:anon|public)\b", re.IGNORECASE
)


# ---------------------------------------------------------------------------
# rule 4: debug enabled in production config
# ---------------------------------------------------------------------------
# Django settings DEBUG = True
_DJANGO_DEBUG = re.compile(r"^\s*DEBUG\s*=\s*True\b")
# Flask app.run(debug=True)
_FLASK_DEBUG = re.compile(r"\.run\s*\([^)]*\bdebug\s*=\s*True\b")
# FLASK_DEBUG / DEBUG env set to 1 / true (env-file or compose form)
_ENV_DEBUG = re.compile(
    r"^\s*(?:FLASK_DEBUG|DJANGO_DEBUG)\s*[:=]\s*['\"]?(?:1|true|True)\b"
)

# A file is treated as production config when its name/path marks it so. dev /
# test / local files are excluded: flagging DEBUG=True in settings_dev.py is the
# cry-wolf failure for rule 4.
_PROD_NAME_RE = re.compile(
    r"(?:^|/)(?:settings\.py|prod[._-]?[^/]*\.py|[^/]*\.production[^/]*|"
    r"settings[._-]?prod[^/]*\.py|production\.py)$",
    re.IGNORECASE,
)
_PROD_ENVFILE_RE = re.compile(r"(?:^|/)\.env\.production$", re.IGNORECASE)
_DEV_MARKER_RE = re.compile(
    r"(?:^|/|[._-])(?:dev|development|test|tests|local|staging|sample|example|"
    r"settings_dev|settings_local|settings_test)(?:[._/-]|$)",
    re.IGNORECASE,
)


def _is_production_config(rel_path):
    """True if rel_path looks like a production config file (and NOT a dev/test
    one). The dev exclusion takes precedence: an explicitly dev-marked path is
    never production even if it also matches a prod pattern."""
    norm = rel_path.replace("\\", "/")
    base = os.path.basename(norm)
    if _DEV_MARKER_RE.search(norm):
        # settings.py itself is not dev-marked; but settings_dev.py is excluded
        return False
    if _PROD_ENVFILE_RE.search(norm):
        return True
    if _PROD_NAME_RE.search(norm):
        return True
    # bare settings.py (Django default prod settings module)
    if base.lower() == "settings.py":
        return True
    return False


# Rules 3 (world-open datastore) and 5 (CORS) are LITERAL-config rules: the
# patterns (".write": true, public-read, ACAO * + credentials) are only a
# vulnerability when they are ACTUAL configuration, never when they appear in
# prose, a docstring, a comment, or example text. Rather than try to strip every
# comment/string form out of arbitrary source (fragile, and an attacker can open
# a fake comment to mask a real finding -- a green-wash), we SCOPE these rules to:
#   (a) recognized config file types/names, OR
#   (b) a line that is itself a recognized config-call form (handled inline).
# A code file's docstring/comment is therefore never scanned for rules 3/5, and
# there is no block-tracking to evade. (rules 1/2/4 are unaffected and still scan
# everything: a private key or client secret is a leak in ANY file.)
_CONFIG_EXT = {
    ".json", ".yaml", ".yml", ".toml", ".tf", ".tfvars", ".hcl",
    ".conf", ".cfg", ".ini", ".rules", ".properties", ".env", ".sql",
}
_CONFIG_NAME_RE = re.compile(
    r"""(?:
        firebase\.json | firestore\.rules | database\.rules\.json
      | storage\.rules | \.firebaserc
      | nginx(?:\.conf)? | httpd\.conf | \.htaccess
      | cors[-_.]? | s3[-_.]?(?:policy|bucket)
      | serverless\.(?:yml|yaml) | vercel\.json | netlify\.toml
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def _is_config_context_file(rel_path):
    """True if the file is a configuration file (by extension or known name),
    where a literal datastore/CORS rule is real config rather than prose."""
    norm = rel_path.replace("\\", "/")
    base = os.path.basename(norm).lower()
    _, ext = os.path.splitext(base)
    if ext in _CONFIG_EXT:
        return True
    if _CONFIG_NAME_RE.search(base):
        return True
    return False


# Recognized config-CALL forms in code files: these ARE configuration even in a
# .js/.py/.ts source, so rules 3/5 still apply to a line matching one. Kept tight
# to avoid matching prose: a real cors() middleware call, an nginx add_header, an
# AWS SDK ACL assignment, a firebase database().setRules-style call.
_CONFIG_CALL_RE = re.compile(
    r"""(?:
        \bcors\s*\( | \badd_header\b | BucketAccessControl | CannedAccessControl
      | \bAccessControlAllow                       # camelCase header constant
      # hyphenated header in a real SETTER context (res.setHeader(...),
      # add_header, headers[...]=). NOT a bare `Header: value` colon form, which
      # also appears in prose/comments in code files; the bare colon form is only
      # trusted inside a real config FILE (handled by _file_is_config), never via
      # this code-line config-call path.
      | (?:setHeader|set_header|add_header|writeHead|headers?\s*\[)[^\n]{0,40}?Access-Control-Allow-(?:Origin|Credentials)
      | setRules\s*\( | \bacl\s*[:=]
    )""",
    re.IGNORECASE | re.VERBOSE,
)


# ---------------------------------------------------------------------------
# rule 5: CORS wildcard with credentials
# ---------------------------------------------------------------------------
# The dangerous combination is ACAO * AND ACAC true in the same config. A bare
# ACAO * (without credentials) is a common, intentional public-API setting and
# is NOT flagged. We require both signals in the same file.
# Accept the wildcard quoted ('*' / "*") OR bare (the raw nginx/apache header
# form `add_header Access-Control-Allow-Origin *;` and `... -Origin: *`). Widening
# to bare * cannot false-positive on its own: rule 5 only fires when ACAC true is
# ALSO present in the same file (a bare ACAO * without credentials stays allowed).
_ACAO_WILDCARD = re.compile(
    r"""Access-Control-Allow-Origin['"]?\s*[:=,]?\s*['"]?\*['"]?""",
    re.IGNORECASE,
)
# Code/framework forms of a wildcard origin: express/cors `origin: "*"` AND
# flask-cors `origins="*"` (plural, = separator). Either signals an any-origin
# CORS policy in code.
_ACAO_WILDCARD_CODE = re.compile(
    r"""\borigins?\s*[:=]\s*['"]\*['"]""",
    re.IGNORECASE,
)
_ACAC_TRUE = re.compile(
    r"""Access-Control-Allow-Credentials['"]?\s*[:=,]?\s*['"]?true['"]?""",
    re.IGNORECASE,
)
# Code/framework forms of credentials-enabled: express/cors `credentials: true`
# AND flask-cors `supports_credentials=True`.
_ACAC_TRUE_CODE = re.compile(
    r"""\b(?:credentials\s*[:=]\s*true|supports_credentials\s*=\s*true)\b""",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# file walking / reading
# ---------------------------------------------------------------------------

def _iter_files(target_dir):
    """Yield (abs_path, rel_path) for each candidate text file under target_dir,
    skipping VCS/dependency/build trees, binary extensions and oversized files."""
    for root, dirs, files in os.walk(target_dir):
        # prune skip dirs in place so os.walk never descends into them
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            ext = os.path.splitext(name)[1].lower()
            if ext in BINARY_EXT:
                continue
            abs_path = os.path.join(root, name)
            try:
                if os.path.islink(abs_path):
                    continue
                size = os.path.getsize(abs_path)
            except OSError:
                continue
            if size > MAX_FILE_BYTES:
                continue
            rel_path = os.path.relpath(abs_path, target_dir)
            yield abs_path, rel_path


def _read_lines(abs_path):
    """Read a file as text lines. Returns a list of (lineno, text) or None if the
    file is not decodable as UTF-8 text (treat as binary, skip)."""
    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            content = f.read()
    except (UnicodeDecodeError, OSError):
        return None
    # A NUL byte is the strongest binary signal that slipped past the extension
    # filter; skip such files.
    if "\x00" in content:
        return None
    return list(enumerate(content.splitlines(), start=1))


# ---------------------------------------------------------------------------
# per-file scanning
# ---------------------------------------------------------------------------

def _finding(rule, rel_path, line, severity, message, fix):
    return {
        "rule": rule,
        "file": rel_path,
        "line": line,
        "severity": severity,
        "message": message,
        "fix": fix,
    }


def _scan_file(rel_path, lines):
    """Return a list of findings for one file. `lines` is [(lineno, text), ...]."""
    findings = []
    browser_served = _is_browser_served(rel_path)
    prod_config = _is_production_config(rel_path)

    # rule 3 / rule 5 need whole-file context for the AND conditions.
    saw_rls_disable = None  # lineno of a DISABLE ROW LEVEL SECURITY
    saw_public_grant = False
    saw_acao_wildcard = None  # lineno
    saw_acac_true = False

    # Rules 3/5 (literal datastore/CORS config) are scoped to config CONTEXT, so a
    # docstring/comment/prose mention in a code or doc file is never scanned for
    # them (root-level precision; no fragile comment/block stripping to evade).
    _file_is_config = _is_config_context_file(rel_path)

    for lineno, text in lines:
        # --- rule 1: private key committed (any text file) ---------------
        if _PEM_PRIVATE_KEY.search(text):
            findings.append(_finding(
                "private-key-committed", rel_path, lineno, "HIGH",
                "A PEM private key block is present in this file.",
                "Remove the private key from the repo, rotate the key "
                "immediately (assume it is compromised), and load it at runtime "
                "from a secret manager or an untracked file referenced via "
                "environment variable.",
            ))

        # --- rule 2: secret literal in a browser-served file -------------
        if browser_served:
            for kind, pat in _SECRET_PATTERNS:
                for m in pat.finditer(text):
                    secret = m.group(0)
                    if _is_placeholder_secret(secret):
                        continue
                    # Suppress only when template markup WRAPS the matched secret
                    # (a templated/example value like key="<YOUR_KEY>"), NOT when
                    # any unrelated tag is elsewhere on the line. The old
                    # whole-line check let a real secret inside an HTML line with
                    # any tag (e.g. <script>var k="AKIA...";</script>) slip
                    # through silently -- the common HTML inline-secret leak.
                    if _markup_wraps_match(text, m.start(), m.end()):
                        continue
                    findings.append(_finding(
                        "secret-in-client-file", rel_path, lineno, "HIGH",
                        "A live %s appears in a file served to the browser; "
                        "anyone who loads the page can read it." % kind,
                        "Remove the secret from client code, rotate it, and move "
                        "the call that needs it to a server-side endpoint or a "
                        "build-time secret that is never shipped to the client.",
                    ))

        # Rules 3/5 fire ONLY in a real config context: a config file, OR a line
        # that is itself a recognized config-call form. This makes prose,
        # docstrings, comments, and example text in code/doc files invisible to
        # the literal rules at the ROOT (no comment/string stripping to get wrong,
        # no block-tracking to evade), while a real datastore/CORS misconfig in a
        # .json/.yaml/.conf or a cors()/add_header/ACL line still fires.
        # A config-call form makes a CODE line config-context -- but NOT if the
        # line is a comment (a comment "call cors() with origin * carefully" is
        # prose, not configuration; firing on it is cry-wolf). Config FILES are
        # config-context regardless (their lines are data, not prose). A line in a
        # config file that is a comment is also skipped via _COMMENT_OR_DOC_LINE.
        _rel_lower = rel_path.lower()
        _is_doc_file = _rel_lower.endswith((".md", ".mdx", ".rst", ".txt", ".adoc"))
        _line_is_comment = bool(_COMMENT_OR_DOC_LINE.match(text))
        # A config-call form makes a line config-context only in a non-doc,
        # non-comment line (a doc/comment mentioning a header name is prose).
        _config_call_line = (
            not _is_doc_file and not _line_is_comment
            and bool(_CONFIG_CALL_RE.search(text))
        )
        _config_ctx = (
            (_file_is_config and not _is_doc_file and not _line_is_comment)
            or _config_call_line
        )
        _rule3_skip = not _config_ctx

        # --- rule 3a: Firebase world-open rule ---------------------------
        if not _rule3_skip and _FIREBASE_OPEN.search(text):
            findings.append(_finding(
                "world-open-datastore", rel_path, lineno, "HIGH",
                "A Firebase rule grants unconditional public read/write "
                "(\".read\"/\".write\": true).",
                "Replace the literal true with an auth condition, for example "
                "\"auth != null\" or a per-document ownership check, so only "
                "authorized users can access the data.",
            ))
        # --- rule 3b: S3 / bucket public ACL -----------------------------
        if not _rule3_skip and (_S3_PUBLIC_ACL.search(text) or _S3_PUBLIC_ENUM.search(text)):
            findings.append(_finding(
                "world-open-datastore", rel_path, lineno, "HIGH",
                "A storage bucket is configured with a public-read(-write) ACL.",
                "Remove the public ACL, enable block-public-access on the "
                "bucket, and serve objects through signed URLs or an "
                "authenticated endpoint instead.",
            ))
        # --- rule 3c: Supabase RLS disabled (whole-file AND) -------------
        # Also config-context gated (skip comments/prose/doc files), consistent
        # with rules 3a/3b/5: an inline comment naming "DISABLE ROW LEVEL
        # SECURITY" is prose, not a live migration statement.
        if not _rule3_skip:
            if saw_rls_disable is None and _SUPABASE_RLS_DISABLE.search(text):
                saw_rls_disable = lineno
            if _SUPABASE_PUBLIC_GRANT.search(text):
                saw_public_grant = True

        # --- rule 4: debug in production config --------------------------
        if prod_config:
            if (_DJANGO_DEBUG.search(text) or _FLASK_DEBUG.search(text)
                    or _ENV_DEBUG.search(text)):
                findings.append(_finding(
                    "debug-in-prod", rel_path, lineno, "MEDIUM",
                    "Debug mode is enabled in a production configuration file; "
                    "debug mode leaks stack traces, settings and secrets to "
                    "users on error.",
                    "Set debug to False/0 for production (drive it from an "
                    "environment variable that defaults to off), and keep "
                    "debug-on only in dev/local config.",
                ))

        # --- rule 5: CORS wildcard + credentials (whole-file AND) --------
        # Skip prose/doc lines (_rule3_skip = comment-only line or .md/.rst/.txt
        # doc file): a README or comment WARNING about ACAO * + credentials is not
        # a misconfiguration. Same prose-vs-config principle as rule 3.
        if not _rule3_skip:
            if saw_acao_wildcard is None and (
                    _ACAO_WILDCARD.search(text) or _ACAO_WILDCARD_CODE.search(text)):
                saw_acao_wildcard = lineno
            if _ACAC_TRUE.search(text) or _ACAC_TRUE_CODE.search(text):
                saw_acac_true = True

    # whole-file rule 3c verdict
    if saw_rls_disable is not None and saw_public_grant:
        findings.append(_finding(
            "world-open-datastore", rel_path, saw_rls_disable, "HIGH",
            "Row Level Security is disabled while a public/anon grant exists, "
            "leaving the table world-accessible.",
            "Re-enable Row Level Security (ENABLE ROW LEVEL SECURITY) and write "
            "explicit policies that scope access to authenticated/authorized "
            "users instead of granting to anon/public.",
        ))

    # whole-file rule 5 verdict (the dangerous combo, not a bare wildcard)
    if saw_acao_wildcard is not None and saw_acac_true:
        findings.append(_finding(
            "cors-wildcard-credentials", rel_path, saw_acao_wildcard, "MEDIUM",
            "CORS allows any origin (*) AND allows credentials; this exposes "
            "authenticated responses to every website.",
            "Do not combine a wildcard origin with credentials. Echo back a "
            "specific allowlist of trusted origins when credentials are "
            "required, or drop Allow-Credentials if the endpoint is truly "
            "public.",
        ))

    return findings


# ---------------------------------------------------------------------------
# scan driver
# ---------------------------------------------------------------------------

def scan(target_dir):
    """Scan target_dir and return the result dict.

    Raises ValueError if target_dir is not a readable directory (the CLI maps
    that to exit code 2)."""
    if not os.path.isdir(target_dir):
        raise ValueError("not a directory: %s" % target_dir)

    findings = []
    for abs_path, rel_path in _iter_files(target_dir):
        lines = _read_lines(abs_path)
        if lines is None:
            continue
        findings.extend(_scan_file(rel_path, lines))

    # deterministic ordering: by file, then line, then rule
    findings.sort(key=lambda f: (f["file"], f["line"], f["rule"]))

    by_severity = {}
    for f in findings:
        by_severity[f["severity"]] = by_severity.get(f["severity"], 0) + 1

    return {
        "rules_version": RULES_VERSION,
        "findings": findings,
        "summary": {
            "total": len(findings),
            "by_severity": by_severity,
        },
    }


# ---------------------------------------------------------------------------
# CLI shim (mirrors dashboard/audit.py / proof-verify.py style)
# ---------------------------------------------------------------------------

def _cli(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # --json is accepted for symmetry with the other shims; output is always
    # JSON, so the flag is a no-op kept for a stable, predictable interface.
    args = [a for a in argv if a != "--json"]
    if not args or argv[0] in ("-h", "--help"):
        print(json.dumps(
            {"error": "usage: secure-scan.py <target_dir> [--json]"}))
        return 2
    target_dir = args[0]
    try:
        result = scan(target_dir)
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    except Exception as exc:  # defensive: never a traceback-as-UX
        print(json.dumps({"error": "scan failed: %s" % exc}))
        return 2
    print(json.dumps(result, indent=2))
    return 1 if result["summary"]["total"] > 0 else 0


if __name__ == "__main__":
    sys.exit(_cli())
