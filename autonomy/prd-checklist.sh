#!/usr/bin/env bash
#===============================================================================
# PRD Checklist Module (v5.44.0)
#
# Manages PRD requirement tracking and automated verification. Creates a
# structured checklist from PRD analysis, verifies items on a configurable
# interval, and provides status summaries for prompt injection and council.
#
# Functions:
#   checklist_init(prd_path)    - Initialize checklist during DISCOVERY phase
#   checklist_should_verify()   - Check if verification should run this iteration
#   checklist_verify()          - Run verification checks via checklist-verify.py
#   checklist_summary()         - One-line summary for prompt injection
#   checklist_as_evidence()     - Formatted output for council evidence file
#
# Environment Variables:
#   LOKI_CHECKLIST_INTERVAL     - Verify every N iterations (default: 5)
#   LOKI_CHECKLIST_TIMEOUT      - Timeout per check in seconds (default: 30)
#   LOKI_CHECKLIST_ENABLED      - Enable/disable checklist (default: true)
#
# Data:
#   .loki/checklist/checklist.json          - Full checklist with verification
#   .loki/checklist/verification-results.json - Summary of last verification
#
# Usage:
#   source autonomy/prd-checklist.sh
#   checklist_init "$prd_path"
#   if checklist_should_verify; then checklist_verify; fi
#   checklist_summary
#
#===============================================================================

# Configuration
CHECKLIST_ENABLED=${LOKI_CHECKLIST_ENABLED:-true}
CHECKLIST_INTERVAL=${LOKI_CHECKLIST_INTERVAL:-5}
# Normalize the interval. This is sourced into run.sh which runs under
# `set -uo pipefail`, and CHECKLIST_INTERVAL flows into a modulo at
# checklist_should_verify (current_iteration % CHECKLIST_INTERVAL).
# A non-numeric value (e.g. "abc") would be treated as an unbound variable
# name by arithmetic expansion and abort the host loop; an empty value would
# cause a divide-by-zero. The old `[ ... -le 0 ] 2>/dev/null` guard only
# caught numeric <=0 (the `[` error on non-numeric was swallowed and the bad
# value retained). The case below rejects empty and any non-digit input first
# (pure string match, never errors), then the arithmetic test is safe.
case "$CHECKLIST_INTERVAL" in
    ''|*[!0-9]*) CHECKLIST_INTERVAL=5 ;;   # empty or non-digit -> default
esac
# Guard against zero interval (division by zero in modulo); value is all-digits.
if [ "$CHECKLIST_INTERVAL" -le 0 ]; then
    CHECKLIST_INTERVAL=5
fi
CHECKLIST_TIMEOUT=${LOKI_CHECKLIST_TIMEOUT:-30}
# Normalize the timeout. It does not flow into arithmetic (only passed as a
# --timeout CLI arg to checklist-verify.py at line ~650), so it cannot crash
# the loop, but the same flawed `[ ... -le 0 ] 2>/dev/null` guard would retain
# a non-numeric value and hand garbage to the downstream tool. Normalize it the
# same way for robustness.
case "$CHECKLIST_TIMEOUT" in
    ''|*[!0-9]*) CHECKLIST_TIMEOUT=30 ;;   # empty or non-digit -> default
esac
# Guard against zero timeout; value is all-digits.
if [ "$CHECKLIST_TIMEOUT" -le 0 ]; then
    CHECKLIST_TIMEOUT=30
fi

# Internal state
CHECKLIST_DIR=""
CHECKLIST_FILE=""
CHECKLIST_RESULTS_FILE=""
CHECKLIST_LAST_VERIFY_ITERATION=0
# Path to the spec/PRD that drove this checklist. Used by the acceptance-oracle
# triangulation (checklist_oracle_triangulate) to compare what the spec ASSERTS
# against actual codebase reality. Empty in codebase-analysis mode (no PRD).
CHECKLIST_PRD_PATH=""

# Acceptance-oracle triangulation toggle (default-on, opt-out).
CHECKLIST_ORACLE_ENABLED=${LOKI_CHECKLIST_ORACLE:-1}

#===============================================================================
# Initialization
#===============================================================================

checklist_init() {
    local prd_path="${1:-}"

    if [ "$CHECKLIST_ENABLED" != "true" ]; then
        return 0
    fi

    CHECKLIST_DIR=".loki/checklist"
    CHECKLIST_FILE="${CHECKLIST_DIR}/checklist.json"
    CHECKLIST_RESULTS_FILE="${CHECKLIST_DIR}/verification-results.json"

    mkdir -p "$CHECKLIST_DIR"

    # Remember the spec path so verify-time triangulation can read what the spec
    # asserts. Only store a real, readable file (codebase-analysis mode has none).
    if [ -n "$prd_path" ] && [ -f "$prd_path" ]; then
        CHECKLIST_PRD_PATH="$prd_path"
        log_info "PRD checklist initialized for: $prd_path"
    fi

    return 0
}

#===============================================================================
# Acceptance-Oracle Triangulation (P2-3)
#===============================================================================
# The PRD checklist derives acceptance criteria from the SPEC alone. That is a
# single oracle: if the spec is wrong, every check can pass while the product is
# wrong. This function adds a SECOND independent oracle -- actual codebase
# reality -- and triangulates the two:
#
#   (1) spec      : what the PRD/spec ASSERTS (e.g. "uses PostgreSQL")
#   (2) reality   : what the codebase actually wires (deps + import/usage signals)
#
# When the spec asserts a stack the codebase CONTRADICTS (reality shows a
# DIFFERENT, mutually-exclusive choice and NOT the spec's), we EMIT A FINDING
# rather than silently letting the spec win. The finding is written to
# .loki/checklist/oracle-findings.json and surfaced to the completion council via
# checklist_as_evidence(), and a best-effort trust event is recorded.
#
# Honest scope (source-grounded triangulation, rank-2 backlog):
#   IMPLEMENTED, four legs, each an independent oracle against source reality:
#     (1) DATASTORE conflict -- spec names DB X but the codebase wires a
#         DIFFERENT mutually-exclusive DB Y and NOT X. Highest-signal, zero-FP:
#         choices are mutually exclusive with unambiguous dependency markers.
#     (2) HTTP ROUTE grounding -- every endpoint the spec NAMES must map to a
#         real route/handler discovered in source. Fires High ONLY when source
#         yields a recognizable route set AND a specific spec endpoint is
#         provably absent from it. If ZERO routes parse out of source we
#         fail-open (no finding): un-parsed framework syntax must never read as
#         "route missing". Path params are normalized across frameworks
#         (/orders/:id ~ /orders/{id} ~ /orders/<id>).
#     (3) PUBLIC API SYMBOL existence -- symbols the spec names as public API are
#         verified to EXIST via the LSP proxy (mcp.lsp_proxy --check-symbols,
#         the same one-shot contract as the LSP-diagnostics gate), NOT via an
#         LLM-authored grep. When no language server is reachable this leg is
#         INCONCLUSIVE (fail-open, never a fabricated pass or false High).
#     (4) DOMAIN INVARIANT -- >=1 high-value invariant enforced deterministically.
#         First invariant: plaintext-password-store detection (a password column
#         / field persisted without a hash function anywhere near it). Fires High
#         only on positive evidence of storage-without-hashing.
#
#   DEFERRED (documented follow-up, NOT faked): additional stack axes (web
#   framework, language runtime) and further domain invariants (money-not-float,
#   PII-encryption). These need a broader catalog plus per-language AST-aware
#   detection to stay zero-FP; left out of this slice.
#
# Non-conflict cases that must NOT fire (guarded + tested):
#   - spec asserts DB X, codebase has nothing wired yet (greenfield): ABSENT is
#     not a contradiction -> no finding.
#   - spec asserts DB X, codebase wires DB X: agreement -> no finding.
#   - spec asserts nothing about a datastore: no spec oracle -> no finding.
#   - spec names an endpoint that DOES exist in source -> no finding.
#   - source has NO parseable routes at all (greenfield / unknown framework) ->
#     route leg fails open, no finding.
#   - no language server on PATH -> symbol leg inconclusive, no finding.
#   - passwords stored WITH a hash near them -> invariant leg does not fire.
#
# Opt-out: LOKI_CHECKLIST_ORACLE=0 (default on). When off, this is a no-op.

# Emit oracle findings JSON for the current project. Pure detection in python3
# (env-var inputs only, never positional args inside the heredoc), so the bash
# wrapper just decides whether anything was written.
checklist_oracle_triangulate() {
    if [ "$CHECKLIST_ORACLE_ENABLED" != "1" ]; then
        return 0
    fi

    # Need a spec oracle to triangulate against. No spec -> nothing to do.
    if [ -z "$CHECKLIST_PRD_PATH" ] || [ ! -f "$CHECKLIST_PRD_PATH" ]; then
        return 0
    fi

    local findings_file="${CHECKLIST_DIR:-".loki/checklist"}/oracle-findings.json"
    local project_dir
    project_dir="$(pwd)"

    # Loki install dir (where the `mcp` package lives) so the symbol leg can shell
    # out to `python3 -m mcp.lsp_proxy` with the correct import path. This file is
    # autonomy/prd-checklist.sh, so the install root is its parent's parent. When
    # sourced by run.sh, LOKI_ORIGINAL_PROJECT_DIR already points there; prefer it.
    local oracle_install_dir="${LOKI_ORIGINAL_PROJECT_DIR:-}"
    if [ -z "$oracle_install_dir" ]; then
        oracle_install_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
    fi

    # Feed the detector to python3 via a quoted heredoc (delimiter in quotes) so
    # bash performs NO interpolation: no dollar-digit footgun, no quote-escaping
    # hazards. Keep the heredoc outside command substitution for macOS Bash 3.2.
    # All inputs arrive through _ORACLE_* env vars.
    local status_token="NOOP"
    local status_file=""
    local status_tmp_root="${TMPDIR:-/tmp}"
    if status_file="$(mktemp "${status_tmp_root%/}/loki-oracle-status.XXXXXX" 2>/dev/null)"; then
        if _ORACLE_SPEC="$CHECKLIST_PRD_PATH" \
           _ORACLE_OUT="$findings_file" \
           _ORACLE_PROJECT="$project_dir" \
           _ORACLE_INSTALL_DIR="$oracle_install_dir" \
           python3 - > "$status_file" 2>/dev/null <<'ORACLE_PY'
import json, os, re, sys, tempfile, glob

spec_path = os.environ["_ORACLE_SPEC"]
out_path = os.environ["_ORACLE_OUT"]
project = os.environ["_ORACLE_PROJECT"]

# --- Datastore catalog: canonical name -> (spec regex, reality dependency/usage
# markers). Choices are mutually exclusive enough that a different one being
# wired while the spec names another is a genuine contradiction. ---
DATASTORES = {
    "postgresql": {
        "spec": r"(?i)\b(postgres(?:ql)?|psql)\b",
        # python deps / node deps / connection markers
        "deps": [r"(?i)\bpsycopg2?\b", r"(?i)\basyncpg\b",
                 r'(?i)"pg"\s*:', r"(?i)\bpg-promise\b", r"(?i)\bpostgres\b",
                 r"(?i)\bsequelize\b.*postgres", r"(?i)postgresql://"],
    },
    "mysql": {
        "spec": r"(?i)\b(mysql|mariadb)\b",
        "deps": [r"(?i)\bpymysql\b", r"(?i)\bmysqlclient\b",
                 r'(?i)"mysql2?"\s*:', r"(?i)mysql://"],
    },
    "mongodb": {
        "spec": r"(?i)\b(mongo(?:db)?)\b",
        "deps": [r"(?i)\bpymongo\b", r"(?i)\bmongoengine\b", r"(?i)\bmotor\b",
                 r'(?i)"mongoose"\s*:', r'(?i)"mongodb"\s*:', r"(?i)mongodb(?:\+srv)?://"],
    },
    "sqlite": {
        "spec": r"(?i)\bsqlite\b",
        "deps": [r"(?i)\bsqlite3\b", r"(?i)\baiosqlite\b",
                 r'(?i)"better-sqlite3"\s*:', r"(?i)sqlite://"],
    },
    "redis": {
        "spec": r"(?i)\bredis\b",
        "deps": [r"(?i)\bredis\b", r"(?i)\bioredis\b", r"(?i)redis://"],
    },
    "dynamodb": {
        "spec": r"(?i)\bdynamo(?:db)?\b",
        "deps": [r"(?i)\bboto3\b.*dynamo", r"(?i)dynamodb", r'(?i)"@aws-sdk/client-dynamodb"'],
    },
}

# Datastores that are caches/secondary by nature: their presence alongside a
# primary DB is NOT a contradiction (apps routinely use both). Treat them as
# spec-only signals but never as the "reality contradicts" side.
SECONDARY = {"redis"}

def read_text(path, limit=400000):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read(limit)
    except Exception:
        return ""

spec_text = read_text(spec_path)
if not spec_text.strip():
    print("NOOP")
    sys.exit(0)

# --- Spec oracle: which datastores does the spec ASSERT? ---
spec_asserts = set()
for name, cfg in DATASTORES.items():
    if re.search(cfg["spec"], spec_text):
        spec_asserts.add(name)

# If the spec names exactly one PRIMARY datastore, we can triangulate it. If it
# names several primaries, the spec itself is ambiguous about the datastore;
# triangulation of "the" choice is unsound, so skip (spec-interrogation owns
# spec-internal ambiguity, not this oracle). spec_db is None when there is no
# single primary datastore to triangulate -- the datastore leg then contributes
# nothing, but the route/symbol/invariant legs below still run.
spec_primary = sorted(spec_asserts - SECONDARY)
spec_db = spec_primary[0] if len(spec_primary) == 1 else None

# --- Reality oracle: scan a bounded set of dependency/lock/source manifests for
# datastore markers. We scan manifests first (highest signal, lowest noise). ---
MANIFEST_GLOBS = [
    "package.json", "requirements.txt", "requirements/*.txt", "pyproject.toml",
    "Pipfile", "poetry.lock", "go.mod", "Gemfile", "pom.xml", "build.gradle",
    "composer.json", "Cargo.toml",
    ".env.example", ".env.sample", "docker-compose.yml", "docker-compose.yaml",
]
SKIP_DIRS = {".git", "node_modules", ".loki", "__pycache__", ".venv", "venv",
             "dist", "build", ".next", "vendor"}

manifest_text_parts = []
for pat in MANIFEST_GLOBS:
    for p in glob.glob(os.path.join(project, pat)):
        if os.path.isfile(p):
            manifest_text_parts.append(read_text(p, 200000))
manifest_text = "\n".join(manifest_text_parts)

# Light source scan for connection-string usage as a secondary reality signal,
# bounded to a small number of files to stay fast and avoid scanning artifacts.
def source_scan_hit(markers, cap_files=400):
    seen = 0
    for root, dirs, files in os.walk(project):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if not fn.endswith((".py", ".js", ".ts", ".tsx", ".jsx", ".go",
                                ".rb", ".java", ".rs", ".php", ".env")):
                continue
            seen += 1
            if seen > cap_files:
                return False
            txt = read_text(os.path.join(root, fn), 80000)
            for m in markers:
                if re.search(m, txt):
                    return True
    return False

def reality_has(name):
    cfg = DATASTORES[name]
    for m in cfg["deps"]:
        if re.search(m, manifest_text):
            return True
    # Only fall back to a source scan for the cheap connection-string style
    # markers (URLs); dependency-name markers belong in manifests.
    url_markers = [m for m in cfg["deps"] if "://" in m]
    if url_markers and source_scan_hit(url_markers):
        return True
    return False

reality_dbs = set()
for name in DATASTORES:
    if name in SECONDARY:
        continue
    if reality_has(name):
        reality_dbs.add(name)

findings = []

# --- Leg 1: DATASTORE conflict ---
# Conflict iff: spec asserts spec_db, AND reality shows a DIFFERENT primary db,
# AND reality does NOT also show the spec db. Absent reality (greenfield) and
# agreement both yield no finding. Skipped entirely when the spec names no single
# primary datastore (spec_db is None).
contradicting = sorted(d for d in reality_dbs if d != spec_db) if spec_db else []
if spec_db and contradicting and spec_db not in reality_dbs:
    findings.append({
        "id": "oracle-datastore-conflict",
        "dimension": "spec_vs_reality",
        "axis": "datastore",
        "severity": "high",
        "spec_asserts": spec_db,
        "codebase_reality": contradicting,
        "title": "Spec asserts %s but codebase wires %s" % (
            spec_db, ", ".join(contradicting)),
        "detail": ("The spec/PRD names %s as the datastore, but the codebase "
                   "dependencies/usage indicate %s is wired and %s is not. "
                   "Acceptance criteria derived from the spec alone would pass "
                   "against the wrong datastore. Resolve which oracle is correct "
                   "(update the spec or the implementation) before completion."
                   % (spec_db, ", ".join(contradicting), spec_db)),
    })

# ===========================================================================
# Leg 2: HTTP ROUTE grounding -- spec endpoints must map to real handlers.
# ===========================================================================
# Same finding shape as oracle-datastore-conflict (dimension=spec_vs_reality,
# severity=high). FP-avoidance: this leg fires on ABSENCE, which is more FP-prone
# than the datastore contradiction. Two hard guards keep it zero-FP:
#   (a) only run when source yields a RECOGNIZABLE route set (>=1 real route);
#       zero parsed routes -> greenfield / unknown framework -> fail-open.
#   (b) normalize path params across frameworks so /orders/:id, /orders/{id} and
#       /orders/<id> all compare equal; only a genuinely absent path fires.

# Normalize an HTTP path for cross-framework comparison: lowercase, strip a
# trailing slash, collapse any param segment (:id, {id}, <id>, <int:id>) to "*".
# Trailing sentence punctuation is stripped per-segment so a spec path written
# mid-prose ("GET /healthz.") normalizes identically to the source "/healthz".
_param_seg = re.compile(r"^(:[^/]+|\{[^/}]+\}|<[^/>]+>)$")
# Strip ONLY sentence punctuation prose glues onto a path. Deliberately EXCLUDES
# the param close characters } > ) ] so that "{id}." -> "{id}" (still a param),
# never "{id" (broken). Quotes/backticks are stripped (markdown code spans).
_trailing_punct = ".,;:!?'\"`"
def norm_path(p):
    p = p.strip().strip('"').strip("'").strip("`")
    # keep only the path portion (drop querystring / trailing text)
    p = p.split("?")[0].split("#")[0]
    if not p.startswith("/"):
        return None
    segs = [s for s in p.split("/") if s != ""]
    out = []
    for s in segs:
        # strip trailing sentence punctuation ("/healthz." -> "healthz",
        # "{id}." -> "{id}") without touching a param's close brace.
        s = s.rstrip(_trailing_punct)
        if not s:
            continue
        out.append("*" if _param_seg.match(s) else s.lower())
    return "/" + "/".join(out)

# Spec endpoints: match METHOD + PATH pairs the spec explicitly names, e.g.
# "GET /orders", "POST /users/{id}". Requiring a leading HTTP verb keeps this
# from grabbing arbitrary slashes in prose (file paths, URLs).
SPEC_ENDPOINT_RE = re.compile(
    r"(?i)\b(GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9_\-/:{}<>*.]*)")
spec_endpoints = set()
for m in SPEC_ENDPOINT_RE.finditer(spec_text):
    np = norm_path(m.group(2))
    if np:
        spec_endpoints.add(np)

# Discover real routes in source across common web frameworks. Each pattern
# captures the path string literal. We scan the same bounded source set as the
# datastore leg (SKIP_DIRS, cap files) to stay fast.
ROUTE_PATTERNS = [
    # express / fastify / koa-router / node: app.get("/x"), router.post('/x')
    re.compile(r"""(?i)\b(?:app|router|route|api|server|fastify)\s*\.\s*(?:get|post|put|patch|delete|all|route)\s*\(\s*['"`]([^'"`]+)['"`]"""),
    # flask: @app.route("/x"), @bp.route('/x')
    re.compile(r"""(?i)@\s*\w+\.route\s*\(\s*['"]([^'"]+)['"]"""),
    # fastapi / starlette: @app.get("/x"), @router.post('/x')
    re.compile(r"""(?i)@\s*\w+\.(?:get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]"""),
    # django path()/re_path()/url(): path("orders/", ...)  (may be relative)
    re.compile(r"""(?i)\b(?:re_)?path\s*\(\s*r?['"]([^'"]*)['"]"""),
    re.compile(r"""(?i)\burl\s*\(\s*r?['"]\^?([^'"$]*)['"]"""),
    # spring / jax-rs annotations: @GetMapping("/x") @RequestMapping("/x") @Path("/x")
    re.compile(r"""(?i)@(?:Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]"""),
    re.compile(r"""(?i)@Path\s*\(\s*['"]([^'"]+)['"]"""),
    # go: mux.HandleFunc("/x", ...), r.Get("/x", ...), e.GET("/x", ...)
    re.compile(r"""(?i)\.\s*(?:HandleFunc|Handle|Get|Post|Put|Patch|Delete|GET|POST|PUT|PATCH|DELETE)\s*\(\s*['"]([^'"]+)['"]"""),
    # ruby on rails routes.rb: get "/x", post 'x'
    re.compile(r"""(?i)^\s*(?:get|post|put|patch|delete)\s+['"]([^'"]+)['"]"""),
]
SOURCE_EXTS = (".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".go",
               ".rb", ".java", ".kt", ".php", ".rs")

def discover_routes(cap_files=800):
    found = set()
    seen = 0
    for root, dirs, files in os.walk(project):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if not (fn.endswith(SOURCE_EXTS) or fn == "routes.rb" or fn == "urls.py"):
                continue
            seen += 1
            if seen > cap_files:
                break
            txt = read_text(os.path.join(root, fn), 120000)
            for pat in ROUTE_PATTERNS:
                for mm in pat.finditer(txt):
                    raw = mm.group(1)
                    if not raw:
                        continue
                    # django paths are often relative ("orders/"); normalize by
                    # prefixing a slash so they compare on the same axis.
                    cand = raw if raw.startswith("/") else "/" + raw
                    np = norm_path(cand)
                    if np:
                        found.add(np)
        else:
            continue
        break
    return found

if spec_endpoints:
    real_routes = discover_routes()
    # Guard (a): only fire when source yields a recognizable route set. Zero
    # discovered routes means we could not parse this framework -> fail-open.
    if real_routes:
        missing = sorted(e for e in spec_endpoints if e not in real_routes)
        if missing:
            findings.append({
                "id": "oracle-route-missing",
                "dimension": "spec_vs_reality",
                "axis": "http_route",
                "severity": "high",
                "spec_asserts": missing,
                "codebase_reality": sorted(real_routes)[:20],
                "title": "Spec names endpoint(s) with no handler in source: %s" % (
                    ", ".join(missing)),
                "detail": ("The spec/PRD names the HTTP endpoint(s) %s, but no "
                           "matching route/handler was discovered in the codebase "
                           "(source declares %d route(s), none matching after path-"
                           "param normalization). Acceptance criteria derived from "
                           "the spec alone would pass while the endpoint is not "
                           "actually served. Wire the handler or correct the spec "
                           "before completion."
                           % (", ".join(missing), len(real_routes))),
            })

# ===========================================================================
# Leg 4: DOMAIN INVARIANT -- plaintext password storage detection.
# ===========================================================================
# Deterministic, positive-evidence-only: fire High only when source shows a
# password value being PERSISTED (assigned into a stored record / column / insert)
# with NO hashing function anywhere nearby. Presence of a known hash primitive in
# the same file suppresses the finding (the app hashes -> not plaintext).
HASH_MARKERS = re.compile(
    r"(?i)\b(bcrypt|scrypt|argon2|argon2id|pbkdf2|"
    r"passlib|hashpw|generate_password_hash|password_hash|"
    r"crypto\.(?:pbkdf2|scrypt)|sha256_crypt|make_password)\b")
# A password being written into a persisted structure. Kept tight to avoid FPs:
# require the word "password" (NOT password_hash / hashed_password / passwordHash)
# as an assigned key/column/value, near a persistence verb or a column decl.
# The negative lookahead/behind on _hash / hashed_ is what keeps hashed-password
# code (the correct case) from tripping the leg.
PW_STORE_RE = re.compile(
    r"(?i)("
    r"(?<!_)(?<!hashed_)password(?!_hash)(?!_digest)\s*[:=]\s*[^\n,;)]+|"   # password = value
    r"['\"](?<!_)password(?!_hash)['\"]\s*:\s*[^\n,}]+|"                    # "password": value
    r"(?<!_)password(?!_hash)\s+(?:VARCHAR|TEXT|CHAR|STRING)\b|"           # SQL column decl
    r"\.\s*(?<!_)password(?!_hash)\s*=\s*[^\n;]+|"                          # obj.password = value
    r"INSERT\s+INTO[^;]*?\(\s*[^)]*\bpassword\b[^)]*\)|"                   # INSERT (... password ...)
    r"CREATE\s+TABLE[^;]*?\bpassword\b"                                     # CREATE TABLE ... password
    r")")
PERSIST_VERB = re.compile(
    r"(?i)\b(INSERT\s+INTO|\.save\(|\.create\(|\.insert\(|"
    r"session\.add\(|db\.|repository\.|\.execute\(|CREATE\s+TABLE|"
    r"VALUES\s*\()")

def detect_plaintext_password(cap_files=800):
    seen = 0
    for root, dirs, files in os.walk(project):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if not (fn.endswith(SOURCE_EXTS) or fn.endswith(".sql")):
                continue
            seen += 1
            if seen > cap_files:
                return None
            path = os.path.join(root, fn)
            txt = read_text(path, 120000)
            if not PW_STORE_RE.search(txt):
                continue
            # Suppress when the same file hashes passwords (positive evidence the
            # app is not storing plaintext).
            if HASH_MARKERS.search(txt):
                continue
            # Require a persistence signal in the same file so we only flag
            # STORED passwords, not e.g. a login form field or a request parse.
            if PERSIST_VERB.search(txt):
                rel = os.path.relpath(path, project)
                return rel
    return None

# Only run the invariant when the spec is about something that stores passwords
# (auth / users / login / register / credential). This keeps the leg from
# scanning unrelated projects and firing on incidental matches.
if re.search(r"(?i)\b(password|auth|login|register|credential|sign[\s-]?up|user account)\b", spec_text):
    pw_file = detect_plaintext_password()
    if pw_file:
        findings.append({
            "id": "oracle-invariant-plaintext-password",
            "dimension": "domain_invariant",
            "axis": "auth_password_hashing",
            "severity": "high",
            "spec_asserts": "passwords stored securely (hashed)",
            "codebase_reality": [pw_file],
            "title": "Password appears stored without hashing in %s" % pw_file,
            "detail": ("Source in %s persists a password value with no hashing "
                       "primitive (bcrypt/scrypt/argon2/pbkdf2/passlib/...) present "
                       "in that file. Storing plaintext (or reversibly-encrypted) "
                       "passwords is a domain-invariant violation the spec's prose "
                       "acceptance checks would not catch. Hash passwords before "
                       "persistence."
                       % pw_file),
        })

# ===========================================================================
# Leg 3: PUBLIC API SYMBOL existence via the LSP proxy (NOT LLM grep).
# ===========================================================================
# The spec may name public API symbols ("exports parseConfig", "public function
# createOrder"). We verify each EXISTS in the workspace via the LSP proxy's
# one-shot --check-symbols subcommand (same cwd/--root contract as the LSP-
# diagnostics quality gate). This is deterministic ground truth, not an LLM
# guessing from the same prose. HONEST DEGRADATION: when no language server is
# reachable, the probe returns available=false and every verdict is null; we
# record the leg as INCONCLUSIVE and emit NO finding (never a fabricated pass,
# never a false High). Symbols with a definite exists=false verdict -> High.
symbol_leg = {"ran": False, "available": None, "checked": [], "missing": []}

# Extract candidate public-API symbol names the spec explicitly calls out. We
# require an anchoring keyword so we only probe names the spec asserts as public
# API, not every identifier in prose.
SPEC_SYMBOL_RE = re.compile(
    r"(?i)\b(?:public|export(?:s|ed)?|expose[sd]?|api|function|method|class|endpoint symbol)\b"
    r"[^\n`]*?`?\b([A-Za-z_][A-Za-z0-9_]{2,})`?\s*\(")
spec_symbols = []
for m in SPEC_SYMBOL_RE.finditer(spec_text):
    nm = m.group(1)
    if nm and nm.lower() not in ("the", "this", "that", "public", "export", "function", "method", "class") and nm not in spec_symbols:
        spec_symbols.append(nm)
spec_symbols = spec_symbols[:25]  # bound the probe

if spec_symbols:
    install_dir = os.environ.get("_ORACLE_INSTALL_DIR", "")
    # Only attempt the probe when we know the loki install dir (so `-m
    # mcp.lsp_proxy` imports). Without it we cannot reach the proxy -> honest
    # inconclusive, no finding.
    if install_dir and os.path.isdir(os.path.join(install_dir, "mcp")):
        import subprocess
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "mcp.lsp_proxy",
                 "--check-symbols", "--root", project],
                input="\n".join(spec_symbols),
                cwd=install_dir,
                capture_output=True, text=True, timeout=90,
            )
            probe = json.loads((proc.stdout or "").strip().splitlines()[-1]) if proc.stdout.strip() else {}
        except Exception:
            probe = {}
        symbol_leg["available"] = bool(probe.get("available"))
        symbol_leg["ran"] = True
        res = probe.get("results", {}) or {}
        symbol_leg["checked"] = sorted(res.keys())
        if symbol_leg["available"]:
            # Only a DEFINITE exists=false (not null) is a miss.
            miss = sorted(k for k, v in res.items() if v is False)
            symbol_leg["missing"] = miss
            if miss:
                findings.append({
                    "id": "oracle-symbol-missing",
                    "dimension": "spec_vs_reality",
                    "axis": "public_api_symbol",
                    "severity": "high",
                    "spec_asserts": miss,
                    "codebase_reality": "symbol(s) not found by LSP workspace search",
                    "title": "Spec names public API symbol(s) the LSP cannot find: %s" % (
                        ", ".join(miss)),
                    "detail": ("The spec/PRD names %s as public API, but the LSP "
                               "workspace symbol search (ground truth, not an LLM "
                               "grep) reports they do not exist. Acceptance criteria "
                               "derived from the spec alone would pass against a "
                               "missing symbol. Implement the symbol or correct the "
                               "spec before completion."
                               % ", ".join(miss)),
                })

result = {
    "version": 2,
    "spec_path": spec_path,
    "spec_datastore": spec_db,
    "reality_datastores": sorted(reality_dbs),
    "spec_endpoints": sorted(spec_endpoints),
    "spec_symbols": spec_symbols,
    "symbol_leg": symbol_leg,
    "findings": findings,
    "deferred": [
        "additional domain invariants (money-not-float, PII-encryption)",
        "additional stack axes (web framework, language runtime)",
    ],
}

# Always write the result so evidence/council can read both findings AND a clean
# "checked, no conflict" record (honest: absence of a finding is itself signal).
d = os.path.dirname(out_path) or "."
os.makedirs(d, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(result, f, indent=2)
    f.write("\n")
os.replace(tmp, out_path)

if findings:
    print("CONFLICT %d" % len(findings))
else:
    print("CLEAN")
ORACLE_PY
        then
            IFS= read -r status_token < "$status_file" || status_token="NOOP"
            [ -n "$status_token" ] || status_token="NOOP"
        fi
        rm -f "$status_file" 2>/dev/null || true
    fi

    # Honest logging + best-effort trust event on a real conflict only.
    local tok rest
    read -r tok rest <<< "$status_token"
    case "$tok" in
        CONFLICT)
            log_warn "[checklist] acceptance-oracle conflict: spec disagrees with codebase reality (${rest:-1} finding(s)); see ${findings_file}"
            if type record_trust_event_bash &>/dev/null; then
                record_trust_event_bash "oracle_conflict" \
                    "dimension=spec_vs_reality" \
                    "axis=datastore" \
                    "findings=${rest:-1}" \
                    >/dev/null 2>&1 || true
            fi
            ;;
    esac

    return 0
}

# Echo the oracle findings as a formatted block for council evidence. Empty when
# no findings (or oracle disabled / not run).
checklist_oracle_evidence() {
    local findings_file="${CHECKLIST_DIR:-".loki/checklist"}/oracle-findings.json"
    if [ ! -f "$findings_file" ]; then
        return 0
    fi
    _ORACLE_OUT="$findings_file" python3 -c '
import json, os
try:
    with open(os.environ["_ORACLE_OUT"]) as f:
        data = json.load(f)
except Exception:
    raise SystemExit(0)
findings = data.get("findings", [])
if not findings:
    raise SystemExit(0)
print("")
print("### Acceptance-Oracle Triangulation (spec vs codebase reality)")
for fnd in findings:
    sev = str(fnd.get("severity", "high")).upper()
    print("  [FAIL] [%s] %s" % (sev, fnd.get("title", fnd.get("id", "?"))))
    detail = fnd.get("detail", "")
    if detail:
        print("         %s" % detail)
' 2>/dev/null || true
}

#===============================================================================
# Interval Control
#===============================================================================

checklist_should_verify() {
    # Returns 0 (true) if verification should run this iteration
    if [ "$CHECKLIST_ENABLED" != "true" ]; then
        return 1
    fi

    if [ ! -f "$CHECKLIST_FILE" ]; then
        return 1
    fi

    # Check iteration interval
    local current_iteration="${ITERATION_COUNT:-0}"
    # Defensive numeric guard: current_iteration feeds the modulo below, the
    # single choke point for both operands under `set -uo pipefail`. A
    # non-numeric value would be treated as an unbound variable name by
    # arithmetic expansion and abort the sourced host loop. ITERATION_COUNT is
    # loki-internal (lower risk than the env-driven interval), but normalize
    # here so the modulo can never crash. Pure string match, never errors.
    case "$current_iteration" in
        ''|*[!0-9]*) current_iteration=0 ;;   # empty or non-digit -> treat as 0
    esac
    if [ "$current_iteration" -eq 0 ]; then
        return 1
    fi

    if [ $((current_iteration % CHECKLIST_INTERVAL)) -ne 0 ]; then
        return 1
    fi

    # Don't verify same iteration twice
    if [ "$current_iteration" -eq "$CHECKLIST_LAST_VERIFY_ITERATION" ]; then
        return 1
    fi

    return 0
}

#===============================================================================
# Held-out Spec Eval Selection (v7.28.0)
#===============================================================================
# Anti-reward-hacking: deterministically reserve ~25% of checklist items as
# "held-out". Held-out item IDs are excluded from the prompt feed the build loop
# sees (checklist_summary and council_checklist_gate), so a cooperative build
# agent is not steered toward those specific acceptance checks. The completion
# council evaluates them at the ship gate (council_heldout_gate in
# completion-council.sh). Scope of the guarantee: this protects the prompt feed,
# not a sandbox. .loki/checklist/held-out.json is plain on-disk JSON, so a
# non-cooperative agent with filesystem tools can read the reservation directly.
#
# Selection is idempotent and reproducible: count = clamp(round(0.25*N), 1, 5)
# for N>=2 items; ordering by sha256 of each item's "id" (stable, not random).
# Small checklists (2 <= N < 4) reserve exactly 1 held-out item via the same
# sha256-rank selection (the clamp floor of 1 guarantees coverage), so a small
# spec's checklist is never fully gameable. N<2 is a no-op: holding out the only
# item of a 1-item checklist would leave nothing to verify against in the loop.
# Written once to .loki/checklist/held-out.json; never overwritten if present.
checklist_select_heldout() {
    local heldout_file="${CHECKLIST_DIR:-".loki/checklist"}/held-out.json"

    if [ ! -f "$CHECKLIST_FILE" ]; then
        return 0
    fi

    # The Python below handles all four cases and prints a single status token so
    # bash can log honestly and emit the right trust event:
    #   FRESH n           - no prior reservation, selected n (file written)
    #   IDEMPOTENT        - prior reservation fully valid vs current ids (no-op,
    #                       file untouched: preserves the idempotency case 1 tests)
    #   RESELECTED n      - prior reservation fully stale (zero ids survive); the
    #                       checklist regenerated, so we deterministically re-select
    #                       n items from the CURRENT checklist and overwrite
    #   PARTIAL kept=k dropped=d - some prior ids survived; we keep only survivors
    #   DUP_SKIP          - current checklist ids are not unique; the id-based
    #                       mechanism is unsound, so we reserve nothing (MEDIUM-2)
    #   NOOP              - n<2 with no prior file, or other no-write outcome
    # Honest caveat: re-selection or partial-survival after a regen can reserve
    # items the build loop already saw in earlier prompts (the hidden-from-loop
    # guarantee is best-effort once the checklist ids change mid-run).
    local status_token
    status_token=$(_CHECKLIST_FILE="$CHECKLIST_FILE" _HELDOUT_FILE="$heldout_file" python3 -c "
import json, os, sys, hashlib, tempfile

cl_path = os.environ['_CHECKLIST_FILE']
out_path = os.environ['_HELDOUT_FILE']
try:
    with open(cl_path) as f:
        data = json.load(f)
except Exception:
    print('NOOP')
    sys.exit(0)

# Collect all item ids in document order.
ids = []
for cat in data.get('categories', []):
    for item in cat.get('items', []):
        iid = item.get('id', '')
        if iid:
            ids.append(iid)

n = len(ids)
id_set = set(ids)

# MEDIUM-2: duplicate ids make the id-based hide/select mechanism unsound. Skip
# selection entirely (no reservation written) so a held-out id can never map to
# more than one item. Do NOT touch an existing reservation file here (a stale
# valid file left over from before a dup-introducing regen is handled by the
# council gate's STALE path; over-removing would be over-engineering).
if len(id_set) != n:
    print('DUP_SKIP')
    sys.exit(0)

def select_count(num_ids):
    c = round(0.25 * num_ids)
    if c < 1:
        c = 1
    if c > 5:
        c = 5
    return c

def fresh_selection():
    # Deterministic order: sort ids by sha256(id), take the first <count>.
    count = select_count(n)
    ranked = sorted(ids, key=lambda i: hashlib.sha256(i.encode('utf-8')).hexdigest())
    return sorted(ranked[:count])

def atomic_write(payload):
    d = os.path.dirname(out_path) or '.'
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        json.dump(payload, f, indent=2)
        f.write('\n')
    os.replace(tmp, out_path)

prior = None
if os.path.exists(out_path):
    try:
        with open(out_path) as f:
            prior = json.load(f)
    except Exception:
        prior = None

if prior is not None:
    prior_ids = [i for i in prior.get('held_out', []) if i]
    # A prior reservation of [] (e.g. an earlier n<2 run) is a valid no-op state;
    # keep it idempotent rather than re-selecting now that n may have grown.
    if not prior_ids:
        print('IDEMPOTENT')
        sys.exit(0)
    survivors = [i for i in prior_ids if i in id_set]
    if len(survivors) == len(prior_ids):
        # Fully valid against the current checklist: idempotent no-op.
        print('IDEMPOTENT')
        sys.exit(0)
    if not survivors:
        # Fully stale: the checklist regenerated and orphaned the reservation.
        # Deterministically re-select from the CURRENT checklist.
        if n < 2:
            # N<2: cannot hold out from a 1-item checklist (reserving the only
            # item leaves nothing to verify against). No-op write of an empty set.
            atomic_write({'held_out': [], 'total_items': n,
                          'note': 'n<2: no held-out reserved (re-selected after stale reservation)'})
            print('RESELECTED 0')
            sys.exit(0)
        held = fresh_selection()
        atomic_write({'held_out': held, 'total_items': n})
        print('RESELECTED %d' % len(held))
        sys.exit(0)
    # Partial survival: keep only the surviving ids (do not silently shrink).
    dropped = len(prior_ids) - len(survivors)
    payload = {'held_out': sorted(survivors), 'total_items': n}
    atomic_write(payload)
    print('PARTIAL kept=%d dropped=%d' % (len(survivors), dropped))
    sys.exit(0)

# No prior reservation: first selection.
if n < 2:
    # N<2 gate: a 1-item (or empty) checklist cannot meaningfully hold out an
    # item -- reserving the only item would leave nothing to verify against in
    # the build loop. Write an empty set so downstream reads stay well-formed.
    atomic_write({'held_out': [], 'total_items': n, 'note': 'n<2: no held-out reserved'})
    print('NOOP')
    sys.exit(0)
# For 2 <= N < 4, fresh_selection() reserves exactly 1 item (select_count clamps
# round(0.25*N) up to a floor of 1), so small specs are never fully gameable.

held = fresh_selection()
atomic_write({'held_out': held, 'total_items': n})
print('FRESH %d' % len(held))
" 2>/dev/null || echo "NOOP")

    # Honest logging + trust event on any stale repair (type-guarded).
    local tok rest
    read -r tok rest <<< "$status_token"
    case "$tok" in
        RESELECTED)
            log_warn "[checklist] held-out reservation stale (checklist regenerated); re-selected ${rest:-0} items"
            if type record_trust_event_bash &>/dev/null; then
                record_trust_event_bash "heldout_stale" \
                    "detail=reselected" \
                    "reselected=${rest:-0}" \
                    >/dev/null 2>&1 || true
            fi
            ;;
        PARTIAL)
            log_warn "[checklist] held-out reservation partially stale (checklist regenerated); $rest"
            if type record_trust_event_bash &>/dev/null; then
                record_trust_event_bash "heldout_stale" \
                    "detail=partial" \
                    "$rest" \
                    >/dev/null 2>&1 || true
            fi
            ;;
        DUP_SKIP)
            log_warn "[checklist] checklist ids are not unique; held-out selection skipped (id-based reservation is unsound with duplicate ids)"
            ;;
    esac

    return 0
}

# Echo held-out item IDs (one per line) to stdout. Empty when none reserved.
checklist_heldout_ids() {
    local heldout_file="${CHECKLIST_DIR:-".loki/checklist"}/held-out.json"
    if [ ! -f "$heldout_file" ]; then
        return 0
    fi
    _HELDOUT_FILE="$heldout_file" python3 -c "
import json, os
try:
    with open(os.environ['_HELDOUT_FILE']) as f:
        data = json.load(f)
    for i in data.get('held_out', []):
        print(i)
except Exception:
    pass
" 2>/dev/null || true
}

#===============================================================================
# Verification
#===============================================================================

checklist_verify() {
    if [ "$CHECKLIST_ENABLED" != "true" ]; then
        return 0
    fi

    if [ ! -f "$CHECKLIST_FILE" ]; then
        return 0
    fi

    # Held-out selection happens BEFORE the first verification so that the very
    # first verification-results.json summary already excludes held-out items.
    checklist_select_heldout

    # Acceptance-oracle triangulation: compare what the spec ASSERTS against
    # actual codebase reality and emit a finding on conflict. Runs at verify-time
    # (not init) so codebase reality actually exists by now even on a greenfield
    # build. Best-effort, default-on, never blocks verification itself.
    checklist_oracle_triangulate 2>/dev/null || true

    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local verify_script="${script_dir}/checklist-verify.py"

    if [ ! -f "$verify_script" ]; then
        log_warn "checklist-verify.py not found at $verify_script"
        return 0
    fi

    log_step "Running PRD checklist verification..."

    python3 "$verify_script" \
        --checklist "$CHECKLIST_FILE" \
        --timeout "$CHECKLIST_TIMEOUT" 2>/dev/null || true

    CHECKLIST_LAST_VERIFY_ITERATION="${ITERATION_COUNT:-0}"

    # Log result if available
    if [ -f "$CHECKLIST_RESULTS_FILE" ]; then
        local summary
        summary=$(checklist_summary 2>/dev/null || true)
        if [ -n "$summary" ]; then
            log_info "Checklist: $summary"
        fi
    fi

    return 0
}

#===============================================================================
# Summary (for prompt injection)
#===============================================================================

checklist_summary() {
    # Returns one-line summary string
    if [ ! -f "$CHECKLIST_RESULTS_FILE" ]; then
        echo ""
        return 0
    fi

    _CHECKLIST_RESULTS="$CHECKLIST_RESULTS_FILE" \
    _CHECKLIST_WAIVERS="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json" \
    _CHECKLIST_HELDOUT="${CHECKLIST_DIR:-".loki/checklist"}/held-out.json" \
    python3 -c "
import json, sys, os
try:
    fpath = os.environ.get('_CHECKLIST_RESULTS', '')
    data = json.load(open(fpath))

    # Load waivers
    waived_ids = set()
    waivers_path = os.environ.get('_CHECKLIST_WAIVERS', '')
    if waivers_path and os.path.exists(waivers_path):
        try:
            with open(waivers_path) as wf:
                wdata = json.load(wf)
            for w in wdata.get('waivers', []):
                if w.get('active', True):
                    waived_ids.add(w['item_id'])
        except Exception:
            pass

    # Load held-out item ids (v7.28.0). Held-out items are NEVER surfaced to the
    # build loop: they are fully excluded from the counts and the failing list so
    # the build agent cannot tune to them. The council evaluates them separately.
    heldout_ids = set()
    heldout_path = os.environ.get('_CHECKLIST_HELDOUT', '')
    if heldout_path and os.path.exists(heldout_path):
        try:
            with open(heldout_path) as hf:
                hdata = json.load(hf)
            heldout_ids = set(hdata.get('held_out', []))
        except Exception:
            pass

    # Count all checklist items first so we can detect the pathological case
    # where hiding would empty the summary on a non-empty checklist (MEDIUM-2).
    all_items = 0
    for cat in data.get('categories', []):
        all_items += len(cat.get('items', []))

    def compute(apply_heldout):
        total = verified = pending = failing = waived_count = 0
        failing_items = []
        for cat in data.get('categories', []):
            for item in cat.get('items', []):
                item_id = item.get('id', '')
                if apply_heldout and item_id in heldout_ids:
                    continue
                if item_id in waived_ids:
                    waived_count += 1
                    continue
                total += 1
                status = item.get('status')
                if status == 'verified':
                    verified += 1
                elif status == 'failing':
                    failing += 1
                    if item.get('priority') in ('critical', 'major'):
                        failing_items.append(item.get('title', item.get('id', '?')))
                else:
                    pending += 1
        return total, verified, pending, failing, waived_count, failing_items

    # Recompute counts over the VISIBLE (non-held-out) items so 'total' never
    # leaks the existence of held-out items. Waived items are excluded too.
    total, verified, pending, failing, waived_count, failing_items = compute(True)

    # MEDIUM-2 guard: if hiding held-out items would empty the summary while the
    # checklist itself is non-empty, fall back to showing all items (do not hide)
    # and warn. Returning an empty summary on a non-empty checklist reads as 'no
    # checklist' to the prompt feed, which is a worse failure than a small leak.
    if total == 0 and all_items > 0:
        print('held-out hiding would empty a non-empty checklist summary; showing all items', file=sys.stderr)
        total, verified, pending, failing, waived_count, failing_items = compute(False)

    if total == 0:
        print('')
    else:
        detail = ''
        if failing_items:
            detail = ' FAILING: ' + ', '.join(failing_items[:5])
        waived_str = f', {waived_count} waived' if waived_count > 0 else ''
        print(f'{verified}/{total} verified, {failing} failing{waived_str}, {pending} pending.{detail}')
except Exception:
    print('', file=sys.stderr)
" 2>/dev/null || echo ""
}

#===============================================================================
# Council Evidence (for completion-council.sh)
#===============================================================================

checklist_as_evidence() {
    # Writes formatted checklist evidence to stdout for council consumption
    local evidence_file="${1:-}"

    if [ ! -f "$CHECKLIST_RESULTS_FILE" ]; then
        return 0
    fi

    {
        echo ""
        echo "## PRD Checklist Verification"
        echo ""

        _CHECKLIST_RESULTS="$CHECKLIST_RESULTS_FILE" python3 -c "
import json, os
try:
    data = json.load(open(os.environ['_CHECKLIST_RESULTS']))
    s = data.get('summary', {})
    print(f\"Summary: {s.get('verified',0)}/{s.get('total',0)} verified, {s.get('failing',0)} failing\")
    print()
    for cat in data.get('categories', []):
        print(f\"### {cat.get('name', 'Unknown')}\")
        for item in cat.get('items', []):
            status_icon = {'verified': '[PASS]', 'failing': '[FAIL]', 'pending': '[----]'}.get(item.get('status','pending'), '[----]')
            priority = item.get('priority', 'minor').upper()
            print(f\"  {status_icon} [{priority}] {item.get('title', item.get('id', '?'))}\")
        print()
except Exception:
    print('Checklist data unavailable')
" 2>/dev/null || echo "Checklist data unavailable"

        # Append acceptance-oracle triangulation findings (spec vs codebase
        # reality) so the completion council sees a spec-vs-reality conflict as
        # first-class evidence. Emits nothing when there are no findings.
        checklist_oracle_evidence
    } >> "${evidence_file:-/dev/stdout}"
}

#===============================================================================
# Waiver Support (Phase 4)
#===============================================================================

# Load waivers from .loki/checklist/waivers.json
# Returns waived item IDs (one per line) to stdout
checklist_waiver_load() {
    local waivers_file="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json"
    if [ ! -f "$waivers_file" ]; then
        return 0
    fi
    _WAIVERS_FILE="$waivers_file" python3 -c "
import json, sys, os
try:
    waivers_file = os.environ['_WAIVERS_FILE']
    with open(waivers_file) as f:
        waivers = json.load(f)
    for w in waivers.get('waivers', []):
        if w.get('active', True):
            print(w['item_id'])
except Exception:
    pass
" 2>/dev/null || true
}

# Add a waiver for a checklist item
# Usage: checklist_waiver_add <item_id> <reason> [waived_by]
checklist_waiver_add() {
    local item_id="${1:?item_id required}"
    local reason="${2:?reason required}"
    local waived_by="${3:-manual}"
    local waivers_file="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    _WAIVERS_FILE="$waivers_file" python3 -c "
import json, os, sys

waivers_file = os.environ['_WAIVERS_FILE']
item_id = sys.argv[1]
reason = sys.argv[2]
waived_by = sys.argv[3]
timestamp = sys.argv[4]

# Load existing or create new
waivers = {'waivers': []}
if os.path.exists(waivers_file):
    try:
        with open(waivers_file) as f:
            waivers = json.load(f)
    except (json.JSONDecodeError, IOError):
        pass

# Check for duplicate
for w in waivers.get('waivers', []):
    if w.get('item_id') == item_id and w.get('active', True):
        print(f'Waiver already exists for {item_id}')
        sys.exit(0)

# Add new waiver
waivers.setdefault('waivers', []).append({
    'item_id': item_id,
    'reason': reason,
    'waived_by': waived_by,
    'waived_at': timestamp,
    'active': True
})

# Atomic write
tmp = waivers_file + '.tmp'
with open(tmp, 'w') as f:
    json.dump(waivers, f, indent=2)
os.replace(tmp, waivers_file)
print(f'Waiver added for {item_id}')
" "$item_id" "$reason" "$waived_by" "$timestamp" 2>/dev/null
}

# Remove (deactivate) a waiver for a checklist item
# Usage: checklist_waiver_remove <item_id>
checklist_waiver_remove() {
    local item_id="${1:?item_id required}"
    local waivers_file="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json"

    if [ ! -f "$waivers_file" ]; then
        echo "No waivers file found"
        return 1
    fi

    _WAIVERS_FILE="$waivers_file" python3 -c "
import json, os, sys

waivers_file = os.environ['_WAIVERS_FILE']
item_id = sys.argv[1]

with open(waivers_file) as f:
    waivers = json.load(f)

found = False
for w in waivers.get('waivers', []):
    if w.get('item_id') == item_id and w.get('active', True):
        w['active'] = False
        found = True

if not found:
    print(f'No active waiver found for {item_id}')
    sys.exit(1)

tmp = waivers_file + '.tmp'
with open(tmp, 'w') as f:
    json.dump(waivers, f, indent=2)
os.replace(tmp, waivers_file)
print(f'Waiver removed for {item_id}')
" "$item_id" 2>/dev/null
}

# List all active waivers
checklist_waiver_list() {
    local waivers_file="${CHECKLIST_DIR:-".loki/checklist"}/waivers.json"

    if [ ! -f "$waivers_file" ]; then
        echo "No waivers configured"
        return 0
    fi

    _WAIVERS_FILE="$waivers_file" python3 -c "
import json, os
waivers_file = os.environ['_WAIVERS_FILE']
with open(waivers_file) as f:
    waivers = json.load(f)
active = [w for w in waivers.get('waivers', []) if w.get('active', True)]
if not active:
    print('No active waivers')
else:
    for w in active:
        print(f\"  {w['item_id']}: {w.get('reason', 'no reason')} (by {w.get('waived_by', 'unknown')} at {w.get('waived_at', '?')})\")
" 2>/dev/null
}
