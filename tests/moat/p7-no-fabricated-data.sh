#!/usr/bin/env bash
export LOKI_DASHBOARD_ALLOWED_HOSTS=testserver,test  # TestClient Host; keeps default allowlist strict
# Case functions are dispatched by name through run_case (SC2329), and the
# embedded sed/python/node programs carry literal dollar signs (SC2016).
# shellcheck disable=SC2329,SC2016
# Moat property P7: no fabricated data.
#
# "Every console panel is backed by a real endpoint. Cost is never shown as $0
# when it is unmeasured." (docs/LOKI-10-BUILD-PROMPT.md, section 2, item 7)
#
# Cases (IDs are permanent):
#   P7.webapp-client-routes-exist     every web-app client path resolves to a
#                                     real route in web-app/server.py
#   P7.dashboard-client-routes-exist  every /api/ path in dashboard-ui source
#                                     resolves to a real route in dashboard/server.py
#   P7.no-sample-data-panels          no production page reaches a panel that
#                                     falls back to hardcoded or generated sample
#                                     data, no Math.random() feeds a metric, and
#                                     no metric prop is fed a hardcoded number
#   P7.unmeasured-cost-never-zero     no cost rendering path turns an unmeasured
#                                     (null/undefined) cost into 0 or "$0.00",
#                                     and the budget, cost-timeline and fleet
#                                     endpoints send null (not 0) for spend
#                                     nobody measured, per run and in totals,
#                                     flag a partly measured run as partial,
#                                     and the context, token-economics,
#                                     learning and gate readers (and the
#                                     web-app session status and memory
#                                     readers) send null or [] until something
#                                     was measured
#
# Contract (tests/moat): one "CASE <ID> PASS|FAIL <text>" stdout line per case,
# diagnostics on stderr, exit 0 whenever the script ran to completion. A missing
# prerequisite is a FAIL, never a skip. Every "nothing found" result is paired
# with a positive control proving the same probe finds the bad case.
#
# The cost case's server leg starts the real dashboard app in-process
# (fastapi TestClient, which needs httpx; requirements-test.txt has both).
#
# SOURCE, NEVER THE BUNDLE. dashboard/static/index.html is the built bundle and
# is never scanned: a bundle scan measures the last build, not the code.
#
# ROUTES ARE MATCHED, NOT GREPPED. Both route cases import the real FastAPI
# app and ask its own router whether each client path reaches a route, the same
# on every FastAPI version; every included router must be proven mounted or the
# case fails naming it (see match-routes.py). Client paths are parsed with the
# TypeScript AST (the typescript package the web-app already depends on), never
# with a line regex.
#
# Prerequisites: python3 with fastapi (the route tables), node, and
# web-app/node_modules/typescript or dashboard-ui/node_modules/typescript
# inside THIS checkout (npm ci in web-app provides it). The two static-scan
# cases need only python3.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true
export LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false PYTHONDONTWRITEBYTECODE=1

MOAT_TMP="$(mktemp -d)" || { echo "p7: mktemp failed" >&2; exit 1; }
MOAT_TMP="$(cd "$MOAT_TMP" && pwd -P)"
MOAT_MAIN_PID=$$
moat_cleanup() {
    # Only the top-level shell removes the directory, never a subshell.
    [ "${BASHPID:-$$}" = "$MOAT_MAIN_PID" ] || return 0
    rm -rf -- "$MOAT_TMP"
}
trap moat_cleanup EXIT

diag() { printf 'p7: %s\n' "$*" >&2; }

# FastAPI app imports run with HOME inside the run directory, so an import-time
# write can never touch the operator's ~/.loki. PYTHONUSERBASE keeps a user-site
# fastapi importable after HOME moves.
MOAT_USERBASE="$(python3 -m site --user-base 2>/dev/null || true)"
mkdir -p "$MOAT_TMP/home"
py_server() { HOME="$MOAT_TMP/home" PYTHONUSERBASE="$MOAT_USERBASE" python3 "$@"; }

# ---------------------------------------------------------------------------
# Shared helpers written once into the run directory.
# ---------------------------------------------------------------------------

# Strip JS/TS/HTML comments while preserving line numbers. A comment explaining
# a banned pattern must not trip the ban (MetricsPage.tsx mentions Math.random
# in a comment and is a known-good file).
cat > "$MOAT_TMP/moatlib.py" <<'PY'
import os, re

BLOCK = re.compile(r'(?:(?<=^)|(?<=[\s{(;,=]))/\*.*?\*/', re.S | re.M)
LINE = re.compile(r'(^|[\s;{}(),])//[^\n]*', re.M)
HTML = re.compile(r'<!--.*?-->', re.S)

def _blank(m):
    return re.sub(r'[^\n]', ' ', m.group(0))

def strip_comments(src, html=False):
    if html:
        src = HTML.sub(_blank, src)
    src = BLOCK.sub(_blank, src)
    return LINE.sub(lambda m: m.group(1), src)

SKIP = re.compile(r'(\.test\.|\.spec\.|__tests__|\.check\.mjs$|/test/|/tests/)')

def walk(root, exts):
    out = []
    if os.path.isfile(root):
        return [root]
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in ('node_modules', 'dist', 'build')]
        for f in files:
            p = os.path.join(d, f)
            if f.endswith(exts) and not SKIP.search(p):
                out.append(p)
    return sorted(out)

def read(p):
    with open(p, encoding='utf-8', errors='replace') as fh:
        return fh.read()
PY

# ---------------------------------------------------------------------------
# Route contract helpers (AST extractor + route-table matcher).
# ---------------------------------------------------------------------------

# Extract every string, template and "+" chain that contains an /api path.
# Interpolations become {p}; a same-file const is inlined when it resolves to a
# literal (MAGIC_API = `${MOUNT_BASE}/api/magic`). A trailing interpolation glued
# to a segment ("/api/projects${query}") is dropped ONLY when it is provably a
# "?"-prefixed-or-empty query suffix; anything else is UNRESOLVED and fails the
# case -- truncating an unknown suffix could hide the exact drift we hunt.
cat > "$MOAT_TMP/extract-api.mjs" <<'JS'
import fs from 'node:fs';
const [tsPath, ...rest] = process.argv.slice(2);
// `--list FILE` reads one path per line, so paths never pass through word splitting.
const files = rest[0] === '--list' ? fs.readFileSync(rest[1], 'utf8').split('\n').filter(Boolean) : rest;
const ts = (await import(tsPath)).default;
const calls = [], unresolved = [], helpers = [];
const VERB = { _get: 'GET', _post: 'POST', _put: 'PUT', _delete: 'DELETE', _patch: 'PATCH',
  get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH' };
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS
    : file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const inlined = new Set();
  // Lexical lookup: the nearest enclosing block that declares the name wins, a
  // same-named parameter shadows it. `query` is redeclared in many methods, so a
  // file-wide name map would be ambiguous exactly where it matters.
  function lookup(id, wantFn) {
    for (let a = id.parent; a; a = a.parent) {
      if (!wantFn && ts.isFunctionLike(a) && a.parameters
          && a.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text)) return null;
      const stmts = (ts.isBlock(a) || ts.isSourceFile(a) || ts.isModuleBlock(a) || ts.isCaseClause(a)
        || ts.isDefaultClause(a)) ? a.statements : null;
      if (!stmts) continue;
      for (const s of stmts) {
        if (wantFn && ts.isFunctionDeclaration(s) && s.name && s.name.text === id.text) return s;
        if (!wantFn && ts.isVariableStatement(s)) for (const d of s.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === id.text) return d.initializer || null;
      }
    }
    return null;
  }
  const constInit = (id) => lookup(id, false);
  const isPlus = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
  const hasApi = (parts) => parts.some((p) => p.lit !== undefined && p.lit.includes('/api'));
  function resolve(n, depth) {
    if (ts.isParenthesizedExpression(n)) return resolve(n.expression, depth);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [{ lit: n.text }];
    if (ts.isTemplateExpression(n)) {
      const out = [{ lit: n.head.text }];
      for (const s of n.templateSpans) { out.push(...interp(s.expression, depth)); out.push({ lit: s.literal.text }); }
      return out;
    }
    if (isPlus(n)) return [...resolve(n.left, depth), ...resolve(n.right, depth)];
    return interp(n, depth);
  }
  function interp(e, depth) {
    if (ts.isIdentifier(e) && depth < 3) {
      let init = constInit(e);
      if (init && ts.isBinaryExpression(init) && (init.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) init = init.right;
      if (init) { const r = resolve(init, depth + 1); if (hasApi(r)) { inlined.add(e.text); return r; } }
    }
    return [{ expr: e }];
  }
  function queryish(e) {
    if (ts.isParenthesizedExpression(e)) return queryish(e.expression);
    if (ts.isIdentifier(e)) { const i = constInit(e); return i ? queryish(i) : false; }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      // A same-file helper qualifies only when EVERY return is a query suffix.
      const fn = lookup(e.expression, true);
      if (!fn || !fn.body) return false;
      const rets = [];
      (function r(n) { if (ts.isReturnStatement(n)) rets.push(n); if (!ts.isFunctionLike(n)) ts.forEachChild(n, r); })(fn.body);
      return rets.length > 0 && rets.every((s) => s.expression && queryish(s.expression));
    }
    if (!ts.isConditionalExpression(e)) return false;
    const t = resolve(e.whenTrue, 3), f = resolve(e.whenFalse, 3);
    const empty = f.length === 1 && f[0].lit === '';
    return empty && t.length > 0 && t[0].lit !== undefined && t[0].lit.startsWith('?');
  }
  function methodOf(n) {
    let top = n;
    while (top.parent && ts.isParenthesizedExpression(top.parent)) top = top.parent;
    const c = top.parent;
    if (!c || !ts.isCallExpression(c) || c.arguments[0] !== top) return '*';
    const name = ts.isIdentifier(c.expression) ? c.expression.text
      : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : '';
    if (VERB[name]) return VERB[name];
    if (name !== 'fetch') return '*';
    const o = c.arguments[1];
    if (!o) return 'GET';
    if (!ts.isObjectLiteralExpression(o)) return '*';
    for (const pr of o.properties) {
      if (ts.isPropertyAssignment(pr) && pr.name.getText(sf) === 'method')
        return (ts.isStringLiteral(pr.initializer) || ts.isNoSubstitutionTemplateLiteral(pr.initializer))
          ? pr.initializer.text.toUpperCase() : '*';
    }
    return 'GET';
  }
  function visit(n) {
    const strish = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) || isPlus(n);
    const nested = n.parent && (isPlus(n.parent) || ts.isTemplateSpan(n.parent)
      || (ts.isParenthesizedExpression(n.parent) && n.parent.parent && isPlus(n.parent.parent)));
    if (strish && !nested && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent)
        && !ts.isLiteralTypeNode(n.parent)) {
      const parts = resolve(n, 0);
      let joined = '', exprAt = [];
      for (const p of parts) { if (p.lit !== undefined) joined += p.lit; else { exprAt.push([joined.length, p.expr]); joined += '{p}'; } }
      const m = /\/api(?=\/|\?|$|\{p\})/.exec(joined);
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const where = `${file}:${line}`;
      const decl = n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : null;
      const declOr = n.parent && ts.isBinaryExpression(n.parent) && n.parent.parent
        && ts.isVariableDeclaration(n.parent.parent) && ts.isIdentifier(n.parent.parent.name) ? n.parent.parent.name.text : null;
      const baseName = decl || declOr;
      if (m) {
        let path = joined.slice(m.index); const offset = m.index;
        const q = path.indexOf('?'); if (q >= 0) path = path.slice(0, q);
        path = path.replace(/\/+$/, '');
        let bad = null, helper = false;
        if (/^\/api(\{p\}|\/\{p\})?$/.test(path)) helper = true;   // generic request helper: `${API_BASE}${path}`
        const trail = /([^/])\{p\}$/.exec(path);
        if (!helper && trail) {
          const pos = offset + path.length - 3;
          const hit = exprAt.find(([at]) => at === pos);
          if (hit && queryish(hit[1])) path = path.slice(0, -3);
          else bad = 'trailing interpolation glued to a segment is not a provable query suffix';
        }
        if (!helper && !bad) for (const seg of path.split('/')) if (seg.includes('{p}') && seg !== '{p}') bad = `segment '${seg}' is partially interpolated`;
        cands.push({ where, path, bad, helper, baseName, raw: joined.slice(0, 120), method: methodOf(n) });
      }
    }
    ts.forEachChild(n, visit);
  }
  const cands = [];
  visit(sf);
  // A const that was inlined into another /api path is a base URL, not a call
  // (MAGIC_API = `${MOUNT_BASE}/api/magic`). A const used directly, e.g.
  // `const url = '/api/status'; fetch(url)`, was never inlined and IS checked.
  for (const c of cands) {
    if (c.baseName && inlined.has(c.baseName)) continue;
    if (c.helper) helpers.push(c.where);
    else if (c.bad) unresolved.push({ where: c.where, raw: c.raw, why: c.bad });
    else calls.push({ where: c.where, path: c.path, method: c.method });
  }
}
console.log(JSON.stringify({ files: files.length, captured: calls.length, calls, unresolved, helpers }));
JS

# Match extracted calls against a FastAPI app with the app's OWN matcher
# (Starlette's public route.matches(scope)), never by walking app.routes as a
# table. app.routes is a framework detail: FastAPI >= 0.141 stores an included
# router as ONE lazy wrapper, so a table walk saw zero /api/v2 routes on a clean
# requirements-test.txt install while every one of them served (BACKLOG 27/29;
# tests/dashboard/test_router_mounts_diagnostic.py). Client {p} segments are
# sent as "1". Method '*' means the extractor could not see the verb (a URL
# built into a variable), so only the path is checked.
#
# Every router the server includes must have MOUNTED: each is imported directly
# and each of its own routes must be reachable, or the matcher refuses (exit 2)
# and names the cause. An optional router that failed to import or mount is a
# named failure, never a smaller route count. ROUTES is counted from top-level
# /api routes plus each router's own routes, so it is the same on every host.
# Extra argv entries (the positive control only) name files defining a
# `router` that must be mounted.
cat > "$MOAT_TMP/match-routes.py" <<'PY'
import importlib, importlib.util, json, os, re, sys
repo, modspec, calls_json, extra = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
sys.path.insert(0, repo)
if modspec == 'dashboard':
    from dashboard import server
    expected = ['dashboard.api_v2', 'dashboard.api_operator']
else:
    sys.path.insert(0, os.path.join(repo, 'web-app'))
    import server
    expected = []
from fastapi import APIRouter
from starlette.routing import Match

# Only /api routes and path-less wrappers (the lazy included router) are asked,
# so the SPA catch-all and the /lab mount can never vouch for an /api path.
cands = [r for r in server.app.routes if getattr(r, 'path', None) is None or r.path.startswith('/api')]

def scope(path, method, kind='http'):
    return {'type': kind, 'path': path, 'root_path': '', 'method': method, 'headers': [], 'query_string': b''}

def reach(path, method):
    """'full', 'partial' (the path exists for other methods only) or None."""
    best = None
    for m in (['GET'] if method == '*' else [method] + (['GET'] if method == 'HEAD' else [])):
        for r in cands:
            got = r.matches(scope(path, m))[0]
            if got == Match.FULL:
                return 'full'
            if got == Match.PARTIAL:
                best = 'partial'
    if any(r.matches(scope(path, 'GET', 'websocket'))[0] == Match.FULL for r in cands):
        return 'full'
    return 'full' if (method == '*' and best) else best

concrete = lambda p: re.sub(r'\{[^}]*\}', '1', p)
key = lambda r: (r.path.rstrip('/') or '/', frozenset(getattr(r, 'methods', None) or {'WS'}))
table = {key(r) for r in server.app.routes if (getattr(r, 'path', None) or '').startswith('/api')}

routers = []
for name in expected:
    try:
        routers.append((name, importlib.import_module(name).router))
    except Exception as exc:
        print(f'FATAL router {name} failed to import ({type(exc).__name__}: {exc}); the server cannot have mounted its routes')
        sys.exit(2)
for f in extra:
    spec = importlib.util.spec_from_file_location('moat_ctl_router', f)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    routers.append((f, mod.router))
seen = {id(r) for _, r in routers}
routers += [(f'server.{k}', v) for k, v in sorted(vars(server).items()) if isinstance(v, APIRouter) and id(v) not in seen]
for name, router in routers:
    own = [r for r in router.routes if getattr(r, 'path', None)]
    if not own:
        print(f'FATAL router {name} has no routes; nothing to prove mounted')
        sys.exit(2)
    lost = [r.path for r in own if any(reach(concrete(r.path), m) != 'full' for m in (getattr(r, 'methods', None) or ['GET']))]
    if lost:
        print(f'FATAL router {name}: {len(lost)} of {len(own)} routes are not reachable on the app, so it did not mount (first: {lost[0]})')
        sys.exit(2)
    table |= {key(r) for r in own}
if not table:
    print('FATAL zero /api routes found; the comparison would be vacuous')
    sys.exit(2)

data = json.load(open(calls_json))
drift = []
for call in data['calls']:
    path, method = call['path'], call['method']
    got = reach(concrete(path), method)
    if got is None:
        drift.append(f"{call['where']} {method} {path} -> NO ROUTE")
    elif got == 'partial':
        drift.append(f"{call['where']} {method} {path} -> route exists, but not for {method}")
print(f'ROUTES {len(table)} (routers proven mounted: {len(routers)})')
for d in drift:
    print('DRIFT ' + d)
sys.exit(1 if drift else 0)
PY

# Resolve the typescript module from THIS checkout only (never a sibling tree).
find_typescript() {
    local d
    for d in web-app dashboard-ui; do
        if [ -f "$REPO_ROOT/$d/node_modules/typescript/lib/typescript.js" ]; then
            printf '%s\n' "$REPO_ROOT/$d/node_modules/typescript/lib/typescript.js"
            return 0
        fi
    done
    return 1
}

# Common prerequisite gate for the two route cases. Prints a reason on failure.
route_prereqs() {
    command -v node >/dev/null 2>&1 || { echo "prerequisite missing: node"; return 1; }
    command -v python3 >/dev/null 2>&1 || { echo "prerequisite missing: python3"; return 1; }
    py_server -c 'import fastapi' >/dev/null 2>&1 || { echo "prerequisite missing: python fastapi"; return 1; }
    find_typescript >/dev/null || { echo "prerequisite missing: typescript (npm ci in web-app or dashboard-ui of this checkout)"; return 1; }
    return 0
}

# Run the extractor and matcher; echo "PASS|..." or "FAIL|...". Args:
#   $1 label  $2 server module (dashboard|webapp)  $3 file with one source path per line
extract_and_match() {
    local label="$1" mod="$2" list="$3" ts out rc captured unres nfiles
    nfiles="$(grep -c . "$list")"
    ts="$(find_typescript)"
    out="$MOAT_TMP/$label.calls.json"
    if ! node "$MOAT_TMP/extract-api.mjs" "$ts" --list "$list" > "$out" 2> "$MOAT_TMP/$label.extract.err"; then
        echo "FAIL|extractor crashed: $(head -c 200 "$MOAT_TMP/$label.extract.err" | tr '\n' ' ')"
        return 0
    fi
    captured="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["captured"])' "$out" 2>/dev/null)"
    unres="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d["unresolved"])); [print("  unresolved", u["where"], u["why"], u["raw"], file=sys.stderr) for u in d["unresolved"]]' "$out")"
    diag "$label: captured ${captured:-0} /api calls, ${unres:-?} unresolved"
    case "${captured:-0}" in ''|0) echo "FAIL|zero /api calls captured from $nfiles files; the check would be vacuous"; return 0 ;; esac
    rc=0
    ( cd "$MOAT_TMP" && py_server "$MOAT_TMP/match-routes.py" "$REPO_ROOT" "$mod" "$out" ) \
        > "$MOAT_TMP/$label.match.txt" 2> "$MOAT_TMP/$label.match.err" || rc=$?
    sed 's/^/  /' "$MOAT_TMP/$label.match.txt" >&2
    case "$rc" in
        0) ;;
        1) echo "FAIL|$(grep -c '^DRIFT' "$MOAT_TMP/$label.match.txt") client path(s) have no matching route: $(grep '^DRIFT' "$MOAT_TMP/$label.match.txt" | head -3 | sed 's/^DRIFT //; s#'"$REPO_ROOT"'/##' | tr '\n' ';')"; return 0 ;;
        *) echo "FAIL|route matcher refused (rc=$rc): $(tail -c 200 "$MOAT_TMP/$label.match.err" "$MOAT_TMP/$label.match.txt" | tr '\n' ' ')"; return 0 ;;
    esac
    if [ "${unres:-1}" != "0" ]; then
        echo "FAIL|$unres client path(s) could not be resolved statically (listed on stderr); refusing to under-report"
        return 0
    fi
    echo "PASS|$captured calls resolved"
}

# Positive control shared by both route cases: a known construct set must be
# extracted exactly, an unknown suffix must be UNRESOLVED, a made-up path must
# be flagged and a real path accepted by the SAME matcher.
route_control() {
    local mod="$1" real="$2" ts ctl got
    ts="$(find_typescript)"
    ctl="$MOAT_TMP/ctl-$mod"
    mkdir -p "$ctl"
    cat > "$ctl/good.js" <<'JS'
const API = `${base}/api/magic`;
async function a(api, id, base) {
  await api._get('/api/status');
  await fetch(base + '/api/notifications/' + encodeURIComponent(id) + '/acknowledge', { method: 'POST' });
  await fetch(`${API}/components/${id}/debate`, { method: 'POST' });
  const query = id ? `?status=${id}` : '';
  await api._get(`/api/projects${query}`);
}
JS
    printf '%s\n' 'async function b(api, foo) { await api._get(`/api/x${foo}`); }' > "$ctl/bad.js"
    node "$MOAT_TMP/extract-api.mjs" "$ts" "$ctl/good.js" > "$ctl/good.json" 2>/dev/null || { echo "extractor crashed on the control file"; return 1; }
    got="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print(" ".join(sorted(c["method"]+":"+c["path"] for c in d["calls"])), "unresolved=%d" % len(d["unresolved"]))' "$ctl/good.json")"
    if [ "$got" != "GET:/api/projects GET:/api/status POST:/api/magic/components/{p}/debate POST:/api/notifications/{p}/acknowledge unresolved=0" ]; then
        echo "extractor control mismatch: got '$got'"; return 1
    fi
    node "$MOAT_TMP/extract-api.mjs" "$ts" "$ctl/bad.js" > "$ctl/bad.json" 2>/dev/null || { echo "extractor crashed on the bad control"; return 1; }
    got="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["unresolved"]))' "$ctl/bad.json")"
    [ "$got" = "1" ] || { echo "extractor control: an unknown glued suffix was not reported unresolved (got $got)"; return 1; }
    printf '{"calls":[{"where":"ctl:1","path":"%s","method":"GET"}]}' "$real" > "$ctl/real.json"
    printf '{"calls":[{"where":"ctl:2","path":"/api/moat-made-up-route-7f3a","method":"GET"}]}' > "$ctl/fake.json"
    ( cd "$MOAT_TMP" && py_server "$MOAT_TMP/match-routes.py" "$REPO_ROOT" "$mod" "$ctl/real.json" ) > "$ctl/real.out" 2>&1 \
        || { echo "matcher control: real path $real was not accepted: $(grep -m1 -E '^(FATAL|DRIFT)' "$ctl/real.out" || tail -c 160 "$ctl/real.out")"; return 1; }
    local frc=0
    ( cd "$MOAT_TMP" && py_server "$MOAT_TMP/match-routes.py" "$REPO_ROOT" "$mod" "$ctl/fake.json" ) >/dev/null 2>&1 || frc=$?
    [ "$frc" = "1" ] || { echo "matcher control: a made-up path was not flagged (rc=$frc)"; return 1; }
    # A router the app never included must be a named refusal, not a pass.
    printf '%s\n' 'from fastapi import APIRouter' "router = APIRouter(prefix='/api/moat-ctl-unmounted-7f3a')" \
        "router.add_api_route('/x', lambda: {}, methods=['GET'])" > "$ctl/unmounted_router.py"
    frc=0
    ( cd "$MOAT_TMP" && py_server "$MOAT_TMP/match-routes.py" "$REPO_ROOT" "$mod" "$ctl/real.json" "$ctl/unmounted_router.py" ) \
        > "$ctl/unmounted.out" 2>&1 || frc=$?
    { [ "$frc" = "2" ] && grep -q 'did not mount' "$ctl/unmounted.out"; } \
        || { echo "matcher control: an unmounted router was not refused by name (rc=$frc)"; return 1; }
    return 0
}

# ---------------------------------------------------------------------------
# P7.webapp-client-routes-exist
# ---------------------------------------------------------------------------
case_webapp_routes() {
    local why ex mt rc
    why="$(route_prereqs)" || { echo "FAIL|$why"; return 0; }
    why="$(route_control webapp /api/sessions/history)" || { echo "FAIL|positive control failed: $why"; return 0; }

    # Part 1: the existing fetchJSON guard helpers, run in place from the repo.
    # Both helpers resolve their own repo root dynamically (import.meta.url /
    # __file__), so invoking them directly from $REPO_ROOT already measures
    # this tree; no copy or literal-rewrite is needed (or possible, since
    # neither file has a hardcoded root left to rewrite).
    ex="$REPO_ROOT/tests/lib-extract-client-paths.mjs"; mt="$REPO_ROOT/tests/lib-match-client-routes.py"
    [ -f "$ex" ] && [ -f "$mt" ] \
        || { echo "FAIL|prerequisite missing: tests/lib-extract-client-paths.mjs or tests/lib-match-client-routes.py"; return 0; }
    rc=0
    ( cd "$MOAT_TMP" && node "$ex" > "$MOAT_TMP/fetchjson.json" 2> "$MOAT_TMP/fetchjson.err" ) || rc=$?
    [ "$rc" = 0 ] || { echo "FAIL|existing client.ts extractor failed: $(head -c 160 "$MOAT_TMP/fetchjson.err" | tr '\n' ' ')"; return 0; }
    rc=0
    ( cd "$MOAT_TMP" && py_server "$mt" "$MOAT_TMP/fetchjson.json" ) > "$MOAT_TMP/fetchjson.match" 2>&1 || rc=$?
    sed 's/^/  /' "$MOAT_TMP/fetchjson.match" >&2
    grep -aqE 'server /api routes: [1-9]' "$MOAT_TMP/fetchjson.match" \
        || { echo "FAIL|existing matcher read no web-app routes (rc=$rc); the comparison was vacuous"; return 0; }
    case "$rc" in
        0) ;;
        1) echo "FAIL|client.ts fetchJSON paths drifted: $(grep -E '^ +client.ts:' "$MOAT_TMP/fetchjson.match" | head -3 | tr -s ' ' | tr '\n' ';')"; return 0 ;;
        *) echo "FAIL|existing matcher refused (rc=$rc): $(tail -c 160 "$MOAT_TMP/fetchjson.match" | tr '\n' ' ')"; return 0 ;;
    esac

    # Part 2: literal /api paths and raw fetch calls anywhere in web-app/src
    # (MagicPage, the chat stream URL, preview URLs) that fetchJSON never sees.
    python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import moatlib; print("\n".join(moatlib.walk(sys.argv[2], (".ts", ".tsx"))))' \
        "$MOAT_TMP" "$REPO_ROOT/web-app/src" > "$MOAT_TMP/webapp.files"
    extract_and_match webapp-literals webapp "$MOAT_TMP/webapp.files"
}

# ---------------------------------------------------------------------------
# P7.dashboard-client-routes-exist
# ---------------------------------------------------------------------------
case_dashboard_routes() {
    local why
    why="$(route_prereqs)" || { echo "FAIL|$why"; return 0; }
    [ -f "$REPO_ROOT/dashboard-ui/core/loki-api-client.js" ] \
        || { echo "FAIL|dashboard-ui/core/loki-api-client.js missing; nothing to measure"; return 0; }
    why="$(route_control dashboard /api/status)" || { echo "FAIL|positive control failed: $why"; return 0; }
    python3 -c '
import sys; sys.path.insert(0, sys.argv[1]); import moatlib
fs = moatlib.walk(sys.argv[2], (".js", ".mjs")) + moatlib.walk(sys.argv[3], (".js", ".mjs"))
print("\n".join(fs))' "$MOAT_TMP" "$REPO_ROOT/dashboard-ui/core" "$REPO_ROOT/dashboard-ui/components" > "$MOAT_TMP/dashboard.files"
    grep -q 'dashboard-ui/core/loki-api-client.js$' "$MOAT_TMP/dashboard.files" \
        || { echo "FAIL|loki-api-client.js was not in the scanned file list; the check would miss the main client"; return 0; }
    extract_and_match dashboard dashboard "$MOAT_TMP/dashboard.files"
}

# ---------------------------------------------------------------------------
# P7.no-sample-data-panels
# ---------------------------------------------------------------------------
# Five rules, all on comment-stripped source:
#   1. A component with a sample fallback (`x || generateSample*()`,
#      `x || SAMPLE_*`, `x ?? sampleFoo`) must not be reachable from a routed
#      page (web-app/src/pages/*, App.tsx) through the JSX mount graph. Passing a
#      data prop does NOT exempt it: the fallback still renders fake data the
#      moment that prop is empty. Passes once the panel is unmounted or its
#      fallback is deleted (a backed panel renders an empty/unmeasured state).
#   2. No reachable JSX prop is fed a SAMPLE_* constant or sample generator.
#   3. No Math.random() feeds a metric-named field (uses, rating, tokens, cost,
#      count, total, score, ...). Confetti, skeleton widths and ids are fine.
#   4. No reachable JSX prop with a metric name (gatePassRate, testCoverage,
#      qualityScore, totalTokens, linesGenerated, lintErrors, ...) is fed a
#      numeric literal or a ternary of two numeric literals. That is a number
#      nobody measured, rendered as a reading (`gatePassRate={0.8}`,
#      `testCoverage={i > 2 ? 60 : 20}`); an unmeasured value is null and the
#      component says so. Layout props (size, thickness) are not metric names.
#   5. No sample, mock, demo, fake or dummy source is assigned, returned, fed
#      to a JSX prop or used as initial state with no `||`/`??` in front, and no
#      useState starts from a generate*() function. These are the unconditional
#      forms rule 1 cannot see: `this._phases = this._getDemoData()` in a catch
#      block (the old cost waterfall) and `useState(generateOverviewCards)` (the
#      old admin overview). A name counts when a camelCase word is Sample, Mock,
#      Demo, Fake or Dummy (Mockup does not); is/has/should/can/show flags are
#      not data sources. Like rule 3 it applies to every web-app source file,
#      reachable or not: a hook or helper returning demo rows is not a JSX tag,
#      so the mount graph cannot see it.
# Rules 6-9 read the WHOLE file with a bracket matcher, never one line at a
# time: every fabrication they target spans lines. Like rules 3 and 5 they apply
# to every web-app source file and every dashboard-ui file, reachable or not.
#   6. No array of literal rows is passed to a set*() setter or useState()
#      (anywhere in the argument list, not only as the first argument), or
#      appears anywhere in a catch body (`catch {`, `.catch(() => {...})`), or
#      is an operand of `||`/`??`, or is either branch of a ternary whose OTHER
#      branch is not also a literal, or is the right-hand side of `this._x =`
#      or of a local that later flows into a setter/useState/`this.y =` (at
#      declaration, `const/let/var x = [rows]`, OR a later bare reassignment
#      `x = [rows]` after x was already declared), or is
#      the argument of Array.of() or the first argument of Array.from(). A row
#      is literal when every value is a string, number, boolean, null, a
#      `new Date(...)`/`Date.now()` expression, `as const`, or a nested literal
#      array/object. The Teams page seeded every team's Activity tab with four
#      invented rows in a fetch-less effect, and swapped in a sample team and
#      sample audit rows whenever a request failed; this is that shape.
#      `setStats([{ label: 'Stars', value: stars }])` reads a variable and is
#      not literal. A named module-level table (DEFAULT_PERMISSIONS, COLUMNS,
#      GALLERY, TABS, DEFAULT_PROVIDERS) is a negative control even when it
#      seeds useState, and a timer callback (setTimeout/setInterval/etc.) is
#      never treated as a setter. Also covers the literal hiding one level
#      deeper: a same-file `function`/arrow/function-expression helper
#      (including a `useCallback`-wrapped arrow) whose body `return`s literal
#      rows, called (directly or through a local) into the same setter/
#      useState/`this.x =` sink (BACKLOG 125 B-7; e.g.
#      `function getRows(d){ if(!d) return [{...}]; return d; }
#      setRows(getRows(d))`, which no call-site-only arm above can see). The
#      sink match itself tolerates a spread element, a nested call inside the
#      sink's own argument, and a trailing method call chained after the sink
#      call (`setRowsX([...buildRows(records)])`,
#      `setRowsX(buildRows(normalize(records)))`,
#      `setRowsX(buildRows(records).slice())`), since it scans the whole
#      balanced argument span for the helper's name rather than a single
#      non-nested-paren regex. See the ponytail comment above
#      whole_file_findings() for the shapes this rule still cannot see.
#   7. No binding NAMED sample, mock, demo, fake, dummy or placeholder (bare,
#      camelCase or SAMPLE_-style) is bound to an array or object literal. A
#      string placeholder is input-hint copy and is not flagged.
#   8. No invented stats: a `||`/`??` fallback to an object literal whose
#      metric-named key (uses, rating, stars, downloads, count, total, score,
#      ...) holds a number (`TEMPLATE_STATS[f] || { uses: 500, rating: 4.5 }`),
#      and no lookup table of two or more entries whose values are objects made
#      only of metric-named numeric literals (the TEMPLATE_STATS table itself).
#   9. No zero fallback is fed straight into a number formatter:
#      `(x ?? 0).toLocaleString()`, `(x || 0).toFixed(1)`,
#      `x?.toLocaleString() || 0`, `formatPercent(x || 0)`. That renders an
#      unmeasured value as a measured 0; the fix renders "--" for null.
# dashboard-ui web components are all shipped in the bundle, so rules 1, 3 and
# 5-9 apply to every dashboard-ui component file directly.
cat > "$MOAT_TMP/sample-panels.py" <<'PY'
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import moatlib
webapp_src, dash_dirs = sys.argv[1], sys.argv[2:]
FALLBACK = re.compile(r'(?:\|\||\?\?)\s*(?:generate\w*?(?:Sample|Mock|Demo|Fake)\w*\s*\(|(?:SAMPLE|MOCK|DEMO|FAKE)_[A-Z0-9_]+\b|(?:sample|mock|demo|fake)[A-Z]\w*\b)')
PROP = re.compile(r'\w+=\{\s*(?:(?:SAMPLE|MOCK|DEMO|FAKE)_[A-Z0-9_]+|generate\w*?(?:Sample|Mock|Demo|Fake)\w*\s*\()')
METRIC = re.compile(r'\b\w*(?:uses|count|rating|tokens|cost|percent|total|score|requests|views|downloads|stars|spend|revenue)\w*\b\s*(?::|=(?!=))[^;,]*Math\.random', re.I)
NUM = r'-?\d+(?:\.\d+)?'
HARDPROP = re.compile(r'\b(?:\w*(?:Rate|Coverage|Score|Tokens|Cost|Percent|Percentage|Passing|Generated|Modified|Usage|Spend|Confidence|Errors|Complexity)'
                      r'|rate|coverage|score|tokens|cost|percent|percentage|confidence)=\{\s*(?:' + NUM + r'|[^{}?]*\?\s*' + NUM + r'\s*:\s*' + NUM + r')\s*\}')
ID = r'((?:this\.)?[A-Za-z_$][\w$]*)'
ASSIGN = re.compile(r'(?:(?<![=!<>+\-*/%&|^?])=(?![=>])\s*\{?|\breturn\b)\s*(?:\(\s*\)\s*=>\s*)?' + ID)
STATE = re.compile(r'\buseState\s*(?:<[^()]*?>)?\s*\(\s*(?:\(\s*\)\s*=>\s*)?' + ID)
DEMO = re.compile(r'(?:^|[a-z\d_$])(?:Sample|Mock|Demo|Fake|Dummy)(?![a-z])|^_*(?:sample|mock|demo|fake|dummy)(?=[A-Z_\d])|^_*(?:SAMPLE|MOCK|DEMO|FAKE|DUMMY)_')
FLAG = re.compile(r'^_*(?:is|has|should|can|show)[A-Z]')
GEN = re.compile(r'^_*generate[A-Z]')
def demo_lines(s):
    hits = set()
    for rx, gen in ((ASSIGN, False), (STATE, True)):
        for m in rx.finditer(s):
            name = re.sub(r'^this\.', '', m.group(1))
            if not FLAG.search(name) and (DEMO.search(name) or (gen and GEN.search(name))):
                hits.add(s.count('\n', 0, m.start(1)) + 1)
    return sorted(hits)

# --- rules 6-9: whole-file, bracket-matched --------------------------------
OPEN = {'(': ')', '[': ']', '{': '}'}
def skip_quoted(s, i):
    """s[i] is a quote or backtick; return the index of its closing quote."""
    q, j = s[i], i + 1
    while j < len(s):
        c = s[j]
        if c == '\\':
            j += 2; continue
        if c == q:
            return j
        if q == '`' and s.startswith('${', j):
            k = close_of(s, j + 1)
            if k < 0:
                return len(s)
            j = k
        j += 1
    return len(s)
def close_of(s, i):
    """s[i] opens ( [ or {; return the index of its closer, or -1."""
    stack, j = [OPEN[s[i]]], i + 1
    while j < len(s):
        c = s[j]
        if c in '\'"`':
            j = skip_quoted(s, j)
        elif c in OPEN:
            stack.append(OPEN[c])
        elif c in ')]}':
            if stack.pop() != c:
                return -1
            if not stack:
                return j
        j += 1
    return -1
def split_top(s):
    """Split on commas that are not inside brackets or strings."""
    parts, depth, cur, j = [], 0, 0, 0
    while j < len(s):
        c = s[j]
        if c in '\'"`':
            j = skip_quoted(s, j)
        elif c in OPEN:
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ',' and depth == 0:
            parts.append(s[cur:j]); cur = j + 1
        j += 1
    parts.append(s[cur:])
    return [p.strip() for p in parts if p.strip()]
def top_colon(s):
    j = 0
    while j < len(s):
        c = s[j]
        if c in '\'"`':
            j = skip_quoted(s, j)
        elif c in OPEN:
            k = close_of(s, j)
            if k < 0:
                return -1
            j = k
        elif c == ':':
            return j
        j += 1
    return -1
LIT_WORDS = {'new', 'Date', 'now', 'toISOString', 'toString', 'getTime', 'toLocaleString',
             'toLocaleDateString', 'toLocaleTimeString', 'true', 'false', 'null', 'undefined'}
STR = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\$])*`")
NUMLIT = re.compile(r'(?<![\w$])\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?')
def is_literal(v):
    """True when v is data typed in by hand: no variable, call or spread in it."""
    v = re.sub(r'\s+as\s+const\s*$', '', v.strip())
    if not v or v.startswith('...'):
        return False
    if v[0] in '[{' and close_of(v, 0) == len(v) - 1:
        parts = split_top(v[1:-1])
        if v[0] == '[':
            return all(is_literal(p) for p in parts)
        for p in parts:
            k = top_colon(p)
            if p.startswith('...') or k < 0 or not is_literal(p[k + 1:]):
                return False
        return True
    t = NUMLIT.sub('0', STR.sub('0', v))
    if re.search(r'[`\[\]{}]|=>', t):
        return False
    return all(w in LIT_WORDS for w in re.findall(r'[A-Za-z_$][\w$]*', t))
def literal_rows(arr):
    """arr is an array literal's text; True when it holds object rows, all literal."""
    parts = split_top(arr[1:-1])
    return any(p.startswith('{') for p in parts) and all(is_literal(p) for p in parts)
# ABSENT/is_exempting_sibling: shared with S-30 (BACKLOG 125 B-6)'s ternary-
# against-null fix. Defined here (rather than only at the pre-existing TERNARY
# call sites S-30 owns) so this arm's own null-ternary handling routes through
# the SAME predicate instead of growing a second, divergently-named copy of
# the same exclusion -- see the MODULE_TABLE_FALLBACK ponytail/dedup note
# above. Written to match S-30's own helper as of this writing, but S-30 is
# still in rework and its final shape is not locked yet, so this is NOT an
# unconditional "delete the duplicate on merge": whichever helper S-30 ships
# wins if S-30 merges second, and whoever resolves that merge should diff the
# two definitions rather than assume byte-identity.
#
# S-30/BACKLOG 125 B-6 second half: null/undefined/'' closed only half the
# bypass class. is_literal() is ALSO true for false/0/{}/true (LIT_WORDS and
# the empty-array/empty-object literal arms both accept them), so each one
# could still stand in for the "real" branch of a ternary and exempt a
# fabricated-rows table on the other side (`loading ? false : BACKUP_ROWS`).
# None of the four carries actual row data, so none may exempt -- ABSENT
# rejects them as exact tokens only (the regex is fully anchored), never as a
# substring: `10` (contains "0") and `{ ready: true }` (contains "true", not
# empty) are genuine literals and must keep exempting, pinned by
# NearAbsentLiteralSiblingHonest.tsx.
#
# Rework (Tech Lead review of 0a897a91, CONCERN): the exact-string `\{\}`
# match missed any empty object carrying internal whitespace (`{ }`, a
# multi-line `{\n}`) -- same bypass, one formatter away. Emptiness is now
# checked structurally (split_top of the brace interior, the same helper
# is_literal() itself uses to parse object literals) instead of by string
# shape. The review's second, advisory finding (zero-valued numeric
# spellings other than bare `0` -- `0.0`, `-0`, `00`, `0e0` -- also exempting)
# is fixed the same way: evaluate the literal instead of listing spellings.
ABSENT = re.compile(r"^(?:null|undefined|''|\"\"|true|false)$")
ZERO_NUM = re.compile(r'^[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?$')
def is_exempting_sibling(v):
    """True when v is a genuine data-shaped literal for the both-branches-
    literal ternary exemption: is_literal() minus the bare absence/sentinel
    markers (null/undefined/''/""/true/false), any empty object literal
    (regardless of internal whitespace), and any zero-valued numeric literal
    (regardless of spelling)."""
    v = re.sub(r'\s+as\s+const\s*$', '', v.strip())
    if not is_literal(v) or ABSENT.match(v):
        return False
    if v[:1] == '{' and close_of(v, 0) == len(v) - 1 and not split_top(v[1:-1]):
        return False
    if ZERO_NUM.match(v):
        try:
            if float(v.replace('_', '')) == 0:
                return False
        except ValueError:
            pass
    return True
line_of = lambda s, i: s.count('\n', 0, i) + 1
# E-131 (BACKLOG 146): BRACKET_SINK also treats a computed/bracket-indexed call
# on a global-ish receiver (`window[sinkName](rows)`, `this[key](rows)`) as a
# sink. Receiver-restricted (window/globalThis/self/this) so an ordinary
# `handlers[kind](x)` or `items[i](x)` call is not swept in.
# PO-P7-SINKS-1 (E-138): OPT_CALL lets every sink head accept an optional call
# (`setRows?.([...])`, `window[k]?.(rows)`) and an optional receiver access
# (`globalThis?.[k]`), which a bare `\s*(?=[(<])` lookahead never matched.
OPT_CALL = r'(?:\?\.\s*)?'
BRACKET_SINK = r'(?:window|globalThis|self|this)\s*' + OPT_CALL + r'\[[^\]\n]+\]'
# One-hop sink aliases (`const push = setRows; push(rows)`, `const emit =
# window[k]; emit(rows)`): SINK_ALIAS_DECL finds a plain rename of a sink, and
# the sink regexes are rebuilt per file with the alias names appended (see
# alias_alt/whole_file_findings). One hop only: an alias of an alias is not
# followed. File-wide by name, like every other flow check here, so an alias
# name reused for something else elsewhere in the same file is also treated as
# the sink (over-flag only when that other use is fed literal rows).
SINK_ALIAS_DECL = re.compile(r'\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=;{}]*)?=(?![=>])\s*'
                             r'(set[A-Z]\w*|useState|' + BRACKET_SINK + r')\s*(?=[;\n,)}]|$)')
def sink_alias_alt(s):
    """Regex alternation (leading `|`, or empty) matching the names bound by a
    one-hop rename of a sink in s. A timer (`const later = setTimeout`) is not a
    data sink and is never aliased."""
    names = sorted({m.group(1) for m in SINK_ALIAS_DECL.finditer(s)
                    if not TIMER_RENAME.match(m.group(2))})
    if not names:
        return ''
    return r'|(?<![\w$.])(?:' + '|'.join(re.escape(n) for n in names) + r')\b'
TIMER_RENAME = re.compile(r'^(?:setTimeout|setInterval|setImmediate|setAttribute|setItem|setProperty)$')
def make_setter(alias_alt):
    return re.compile(r'\b(set[A-Z]\w*|useState|' + BRACKET_SINK + alias_alt + r')\s*' + OPT_CALL + r'(?=[(<])')
SETTER = make_setter('')
CATCH = re.compile(r'\bcatch\s*(?:\([^()]*\))?\s*\{|\.catch\s*\(')
ARRAY_CTX = re.compile(r'(?:[=(,:?\[|&]|\breturn)\s*$')
def expr_end(s):
    """Index one past the end of the expression at the start of s: up to the
    first top-level `,`, `;`, or an unmatched closing bracket. Used to isolate
    a ternary's `:` branch, which has no closing delimiter of its own."""
    j = 0
    while j < len(s):
        c = s[j]
        if c in '\'"`':
            j = skip_quoted(s, j)
        elif c in OPEN:
            k = close_of(s, j)
            if k < 0:
                return j
            j = k
        elif c in ')]},;':
            return j
        j += 1
    return j
def ternary_colon_of(s, q):
    """s[q] is a bare `?` (a ternary, never `?.`/`??`). Return the index of its
    matching `:`, scanning forward and skipping quotes and bracket spans, and
    counting nested bare `?` so a nested ternary's `:` is not mistaken for the
    outer one. -1 if the expression ends (`,`/`;`/an unmatched closer) first."""
    depth, j = 0, q + 1
    while j < len(s):
        c = s[j]
        if c in '\'"`':
            j = skip_quoted(s, j)
        elif c in OPEN:
            k = close_of(s, j)
            if k < 0:
                return -1
            j = k
        elif c in ')]},;':
            return -1
        elif c == '?' and s[j:j + 2] not in ('?.', '??'):
            depth += 1
        elif c == ':':
            if depth == 0:
                return j
            depth -= 1
        j += 1
    return -1
# Rule 6 extension. Each targets one specific place a literal row array can
# hide as a fallback or return value, per the round-4 reviewer's fix:
#   FALLBACK_ARR: an operand of `||` or `??` (never `?.`, which these two
#     tokens cannot form).
#   TERNARY: either branch of `a ? x : y`, checked below with ternary_colon_of.
#     A branch is flagged only when it is a literal-rows array AND THE OTHER
#     BRANCH IS NOT ALSO A LITERAL (is_literal, reused as-is): choosing
#     between live data and typed-in rows is the fallback shape rule 6 targets
#     (`entries.length ? entries.filter(...) : [invented rows]`); choosing
#     between two literals (`provider === 'claude' ? [{value:'',label:
#     'Account default'}, ...] : []`) is static UI config the same as a
#     module-level options table, even when one side is the empty-array
#     placeholder.
#   ASSIGN_ARR: `this._x = [rows]` (unconditional: `this.` never occurs at
#     module scope, so every hit is inside a method) or `const/let/var x =
#     [rows]` where x later flows into state: passed to a non-timer set*()/
#     useState(), or assigned to `this.y`. Skipped when the declaration starts
#     at column 0 (the same module-level convention the DEF regex below relies
#     on): a named module-level table (DEFAULT_PROVIDERS, DEFAULT_PERMISSIONS,
#     COLUMNS, GALLERY, TABS) is a negative control even when it seeds
#     useState, matching how the reviewer scoped this arm to "a local".
#   REASSIGN_ARR (BACKLOG 125 B-1): a bare `x = [rows]` occurring AFTER x's own
#     declaration, not only at `const/let/var x = [rows]` (DECL_ARR's site).
#     `let rows = data; if (!rows.length) rows = [invented rows]; setRows(rows);`
#     reassigns rows to a fabricated fallback inside a guard, with no `const/
#     let/var` at that point, so DECL_ARR never fires. Reuses the identical
#     FLOWS_TO_STATE_TMPL flow check DECL_ARR uses, so the sink-detection is not
#     reimplemented, only the "where can the array literal appear" site is
#     widened. Excludes `this.x =`/`obj.x =` (own lookbehind; THIS_ARR already
#     owns `this.`), `==`/`===`/`=>`, and the declaration site itself.
#   MODULE_TABLE_FALLBACK: closes one instance of the gap below (BACKLOG 125
#     B-5). A column-0 `const NAME = [rows]` is a negative control for
#     ASSIGN_ARR (a named module-level table is normally static UI config), but
#     that same exemption let a fabricated table through when NAME is later
#     used as the value-arm of `x || NAME` / `x ?? NAME` or of a ternary,
#     because FALLBACK_ARR and TERNARY above only look at the literal array
#     written inline, never at a name that resolves to one. This arm resolves
#     NAME back to its module-level initializer and applies the SAME
#     literal_rows() test FALLBACK_ARR/TERNARY already apply inline, so a
#     `FALLBACK_ROWS`/`DEFAULT_ROWS`/`BACKUP_DATA`-named table is caught by
#     STRUCTURE (module-level literal array of object rows, used as a
#     fallback), never by NAME -- rules 5 and 7's keyword list is not involved.
#     Two SEPARATE rules apply to a `||`/`??`/ternary operand naming a table,
#     and they intentionally accept different things:
#     (a) DETECTION (does this operand carry the table's fabricated rows
#     forward, so the fallback/ternary itself should be flagged): a bare
#     `NAME`, or NAME followed by a CHAIN of zero or more array-returning
#     calls (`.slice(...)`, `.concat(...)`, `.filter(...)`, `.map(...)`,
#     `.flat(...)`, `.flatMap(...)`, `.sort(...)`, `.reverse(...)`,
#     `.toSorted(...)`, `.toReversed(...)`), each argument list matched by ITS
#     OWN balanced parens (chain_end/resolves_to_table_read) so an arrow-
#     function argument (`.filter((r) => r.ok)`) or a multi-call chain
#     (`.slice(0).reverse()`) both resolve all the way through -- an ADDITIVE
#     or unbounded derivation (`NAME.concat(...)`, an open-ended
#     `NAME.slice(k)`) DOES count as "carries the table's data" here and gets
#     flagged; this is deliberately broader than (b) below. A scalar/element
#     read (`.length`, `.find(...)`, a bare `[<int>]`) is NOT an array-
#     returning call and stops the chain, so the whole operand is left
#     unresolved rather than misread as "table used as a fallback".
#     (b) THE TERNARY SIBLING EXEMPTION (is_narrowing_self_derivation, used
#     only to decide whether the OTHER branch of a ternary is also exempt):
#     far narrower, an ALLOWLIST of exactly two BOUNDED NARROWING shapes,
#     `NAME.slice(<int>, <int>)` (both indices required) and `NAME[<int>]`.
#     `NAME.concat(...)` and an open-ended `.slice(k)` do NOT qualify here,
#     even though they DO qualify for (a): picking how much of one static
#     list to show (ChangelogWidget's `RECENT_CHANGES.slice(0, 2)`) is UI
#     truncation, but appending to it or copying it whole is not "just a
#     narrower read of the same list". The other branch of a ternary is
#     exempted when it is also a literal (`[rows]`, excluding
#     null/undefined/''/"" -- an absent value is not "also a literal table",
#     matching S-30/BACKLOG 125 B-6's is_exempting_sibling) or also resolves
#     to a module-level literal table, mirroring the advisorOpts/two-table
#     negative control, OR when it is one of these two bounded narrowing
#     reads of the SAME table the flagged branch names.
#   ponytail: three structural gaps this arm cannot see, all pre-existing at
#   HEAD: a render-local literal list fed straight to .map() with no setter in
#   between (TABS/filters/severities-style UI config has the same shape); an
#   UNNAMED module-level table that seeds useState (DEFAULT_PROVIDERS is named
#   and column-0, so it is caught by the exemption instead, but a fabricated
#   table would read identically); and a ternary whose OTHER branch is also a
#   literal (`cond ? [rows] : []`, the advisorOpts shape) -- is_literal cannot
#   tell typed-in fabricated rows from a typed-in options list by structure
#   alone, and a content heuristic (flag rows shaped like activity/audit
#   entries) is a keyword list a future case will break. Rules 5 and 7 still
#   catch a sample/mock/demo/fake/placeholder NAME in any of these. Upgrade
#   only if review finds a real instance, not preemptively. The
#   module-level-table object-fallback case (rule 8's shape, but via a named
#   table instead of an inline literal) is closed below too, reusing rule 8's
#   own STAT_KEY/NUMVAL test on the resolved initializer.
#   Additional named ceilings from the S-29 rework (BACKLOG 125 B-5, 2/2
#   CONCERN closed): an ALIAS of a fabricated table (`const X = FALLBACK_ROWS;
#   ... rows || X`) is not resolved back to FALLBACK_ROWS -- only the
#   originally-declared name is in module_tables, never a second binding that
#   copies the reference; `Array.from(TABLE)` and `structuredClone(TABLE)`
#   read the whole table exactly like a bare reference, but are NOT CAUGHT:
#   the operand `Array.from(TABLE)`/`structuredClone(TABLE)` does not start
#   with the table's own name (it starts with `Array`/`structuredClone`), so
#   resolves_to_table_read never matches it at all, and it is scanned as its
#   own (non-table) operand, which for a bare call expression with no
#   array/object literal in it currently finds nothing; a same-file wrapper
#   function that returns a table unchanged (`function getBackup() { return
#   FALLBACK_ROWS; }`) is invisible to a purely lexical/regex scanner; and a
#   deliberately narrow one from resolves_to_table_read's DETECTION side
#   (never widen this to close it -- see the two-rule split above): reading
#   exactly ONE fabricated row back out of a table (`TABLE[i]`, `TABLE.find(
#   ...)`, `TABLE.at(i)`) is NOT caught, matching the honest
#   ElementIndexReadHonest/FindReadHonest shapes -- a single invented row
#   rendered on its own is the same class of gap as the useState-seed and
#   render-local-.map() gaps below, not a new one this rework should close
#   preemptively. Two more from the two-rule split's own narrowness, real
#   today, both failing LOUD (a P7 FAIL on this file) rather than silently:
#   the ternary SIBLING exemption (is_narrowing_self_derivation) accepts only
#   `.slice(a, b)`/`[i]`, so `showAll ? T : T.filter(p => !p.archived)` is
#   FLAGGED even though it is an honest narrowing-by-filter of the same
#   table, not a live-vs-fabricated choice; and DETECTION's own chain walk
#   will flag an HONEST config table used behind an array-returning method
#   (`selected ?? TABS.map(t => t.id)`) exactly the same as a fabricated one,
#   since table_is_fabricated_rows is structural, never content-aware beyond
#   "is every row hand-typed". Neither is exercised anywhere in the real repo
#   today (moat run confirms P7 clean on this arm); upgrade the sibling
#   allowlist or add a config-table carve-out only if review finds a real
#   instance, matching the standing rule above.
#   ponytail: one more named ceiling from round 6 (BACKLOG 125 B-5), found
#   while probing for the same class and confirmed PRE-EXISTING (reproduces
#   unchanged on the round-5 commit too, not introduced by round 6): the
#   ||/?? finder's TERMINATOR check accepts a bare closing `)` as a valid
#   operand boundary without checking what ENCLOSES that paren. `(x ||
#   TABLE) && other`, `(x || TABLE) ? a : b`, and `(rows ?? TABLE).length`
#   all wrongly FLAG, because the `)` that closes the outer grouping paren
#   (opened before the operand even starts) satisfies TERMINATOR the same
#   way a `)` that closes the table's OWN wrapping paren would -- but here
#   the group is then used as a condition (`&&`/`?`) or read as a scalar
#   (`.length`), so TABLE's data never reaches the sink in any of the three,
#   confirmed via `node -e`. Closing this needs a quote-safe closer-to-opener
#   map plus a call-vs-grouping-paren distinction plus keyword handling
#   (`return (x || T) && other` groups, `if (x || T) something` conditions) --
#   AST territory, not a regex patch; a regex fix here is exactly how round 7
#   would start. Upgrade only alongside the TS-AST rewrite already flagged
#   below (`# Upgrade to the TS AST if a multi-line fallback is ever found by
#   review`), not as another regex patch on top of six rounds of them.
#   ponytail: the helper-return arm below (BACKLOG 125 B-7) has its own
#   ceilings.
#   False-negative only:
#   - it only follows a SAME-FILE helper, never one imported from another
#     module;
#   - a class method (BACKLOG 144, METHOD_HEAD) counts only when its head
#     starts a line and it is called as `this.name(...)`; a `#private` method,
#     a getter, or a call through another reference (`self.name()`) is not
#     seen;
#   - a return whose literal is built across an intermediate local inside the
#     helper (`const rows = [...]; return rows;`) is not seen, since only a
#     literal directly after `return` is checked;
#   - a `function`/function-expression head's return-type annotation
#     containing a brace (`function getRows(d): { rows: Row[] } {`) would
#     misplace the body opener onto the type instead of the real body (arrow
#     heads are unaffected: HELPER_ARROW_TAIL spans any return type, braces
#     included, before looking for the body);
#   - the two-hop local-variable form's flow check (HELPER_LOCAL_DECL_TMPL ->
#     FLOWS_TO_STATE_TMPL) only recognizes a plain or `await`ed direct call as
#     the local's initializer, not a chained/wrapped call
#     (`const rows = getRows(d).slice(); setRows(rows);`);
#   - a useMemo-bound value is not this arm either. (A useMemo-bound
#     name is a VALUE, never itself called later as name(args), so it cannot
#     use this arm's call-site-registration machinery. The separate
#     DECL_USEMEMO arm below covers ONLY the case where useMemo's own factory
#     returns a literal directly, e.g. `useMemo(() => [...], deps)`. It does
#     NOT cover `useMemo(() => helperCall(), deps)` -- a factory that calls
#     ANOTHER already-registered fabricator rather than returning a literal
#     itself -- since DECL_USEMEMO only inspects the factory body for a direct
#     literal return, not a call expression. That composed form is a real,
#     currently-undetected gap; see BACKLOG 147.)
#   Can in principle over-flag (not false-negative only):
#   - both the sink-span search and the two-hop local-variable hop
#     (`const rows = getRows(d); setRows(rows)`) search the WHOLE FILE by
#     name, not by lexical scope (the same file-wide, not scope-aware, search
#     DECL_ARR itself already uses for its own local-flows-to-state check), so
#     a fabricating helper in one component and an unrelated same-named
#     setter call in a different component could in principle be credited to
#     each other;
#   - `literal_rows` cannot distinguish a fabricated data row from a real
#     static options/config list, so a helper like
#     `function getDefaultFilters() { return [{ id: 'all', label: 'All' }]; }`
#     feeding `useState(getDefaultFilters)` would be flagged even though it is
#     honest UI config, not fabricated data. This arm deliberately has NO
#     column-0 module-scope exemption like DECL_ARR's MODULE_DECL skip: the
#     reported bypass itself is written at column 0
#     (`function getRows(d){...} setRows(getRows(d));`), so a column-0 skip
#     here would silently reopen the exact bug this arm exists to close;
#   - a return nested inside a callback INSIDE the helper body IS excluded via
#     NESTED_FN_HEAD when that callback is an untyped `function`/arrow
#     (`function loadRows(d){ const cols = () => { return [{...}]; }; return
#     d.rows; }` correctly returns clean), but NESTED_FN_HEAD does not
#     recognize a TYPED nested function head (`function cols(): Col[] {`) or
#     object-method shorthand (`{ cols() { return [...]; } }`); in both of
#     those two forms the inner callback's return is (wrongly) credited to the
#     outer helper, which then gets flagged even though its own return is
#     real data;
#   - the sink-span search matches the helper's name followed by `(` ANYWHERE
#     in a sink's balanced argument span, including inside an unrelated
#     nested closure that happens to also call a same-named function; this is
#     the same file-wide-by-name trade-off as the point above, deliberately
#     accepted for the same reason (a scope-aware rewrite is a bigger change
#     than this bug fix warrants without a real instance to justify it).
#   None of these false-positive vectors has a known instance in this
#   codebase today (the real-scan diff before/after this arm is empty).
#   Upgrade only on a real instance, not preemptively.
FALLBACK_ARR = re.compile(r'(?:\|\||\?\?)\s*\[')
TIMER_LIKE = re.compile(r'^(?:setTimeout|setInterval|setImmediate|setAttribute|setItem|setProperty)$')
ARRAY_OF = re.compile(r'\bArray\.(of|from)\s*\(')
MODULE_DECL = re.compile(r'^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s', re.M)
DECL_ARR = re.compile(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]*)?=(?![=>])\s*\[')
DECL_MODULE_INIT = re.compile(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]*)?=(?![=>])\s*([\[{])')
THIS_ARR = re.compile(r'\bthis\.([A-Za-z_$][\w$]*)\s*(?::[^=;{}]*)?=(?![=>])\s*\[')
# BACKLOG 125 B-1: a bare REASSIGNMENT after declaration (`let rows = data;`
# ... later ... `rows = [...]`), which DECL_ARR cannot see because there is no
# `const/let/var` at that point. `(?<![\w$.])` excludes `obj.rows =`/`this.rows
# =` (THIS_ARR already owns the `this.` case) and a compound assignment
# (`+=`); `=(?![=>])` excludes `==`, `===` and `=>` the same as DECL_ARR.
REASSIGN_ARR = re.compile(r'(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*\[')
DECL_KEYWORD = re.compile(r'\b(?:const|let|var)\s*$')
# BACKLOG 125 B-2 (S-28): a default value on a destructured binding (`const {
# rows = [rows] } = data;`) or a function parameter (`function load(rows =
# [rows]) {}`) is neither DECL_ARR's declaration site nor a bare reassignment,
# so it reached no arm at all when the name never flows to a setter -- the
# shape in both board examples, which have no body at all. Unconditional, like
# FALLBACK_ARR: gated only by add_rows/literal_rows, no flow check, since a
# default value never needs to reach a sink to already be fabricated content.
# Matches name = [ right after the opener of a destructuring/parameter list:
# {, ( or ,. is_block_open below rejects the one shape that is genuinely
# ambiguous: `{` also opens a code BLOCK (`if (...) { rows = [x]; }`), and
# that reassignment must keep REASSIGN_ARR's own message, not this one's --
# decided by the last non-whitespace token before the `{`: ')' or '>' (from
# `=>`) means a block, anything else (const/let/var, '(', ',', start of file)
# means a pattern. Placed ahead of REASSIGN_ARR below so add_rows' span-dedupe
# lets this arm's message win when a default also happens to flow to a setter
# (S-27's own board note on this exact overlap).
DEFAULT_ARR = re.compile(r'[{(,]\s*([A-Za-z_$][\w$]*)\s*=(?![=>])\s*\[')
def is_block_open(s, i):
    """s[i] is '{'; True when the last non-whitespace token before it is ')'
    or '>' (from '=>'), the two ways a code block opens rather than a
    destructuring pattern."""
    j = i - 1
    while j >= 0 and s[j].isspace():
        j -= 1
    return j >= 0 and s[j] in ')>'
def make_flows_tmpl(alias_alt):
    return (r'\b(?:set[A-Z]\w*|useState|' + BRACKET_SINK + alias_alt + r')\s*' + OPT_CALL + r'(?:<[^()]*?>)?\s*\(\s*(?:\(\s*\)\s*=>\s*)?'
            r'{name}\s*[,)]|\bthis\.\w+\s*=\s*{name}\b')
FLOWS_TO_STATE_TMPL = make_flows_tmpl('')
# Rule 6, function-return extension (BACKLOG 125 B-7): `function getRows(d){
# if(!d) return [{...}]; return d; } setRows(getRows(d))` has no literal array
# at the call site, so every arm above (which all look at the call site)
# misses it. This arm looks inside same-file helper bodies instead: a
# function/arrow/function-expression (including a useCallback-wrapped arrow)
# whose body RETURNs a literal-rows array marks that name as a fabricating
# helper, and a later call `name(...)` feeding the same sink template as
# DECL_ARR (a setter/useState, `this.x =`, or a local that flows into one) is
# flagged. `close_of` on the head's own `(` (not a `[^)]*` regex) so a
# parameter default `(d = {})` does not truncate the params span early.
#
# HELPER_HEAD alternatives, in order: `function name(`; `const/let/var name =
# function(`; `const/let/var name = (params) =>` (parenthesized, 0+ params);
# `const/let/var name = param =>` (bare single param, no parens); and
# `const/let/var name = useCallback(` / `React.useCallback(`, whose own first
# argument is itself a nested function/arrow head (handled the same as a
# direct assignment once matched, since the callback body is what fabricates,
# not the useCallback() wrapper). No `let`/`var` exclusion: unlike DECL_ARR's
# MODULE_DECL column-0 skip (a *data* exemption for a named config table),
# there is no equivalent "this let/var is honest config" signal for a
# *helper*, so `let`/`var` heads are covered identically to `const`.
# useMemo is deliberately NOT one of this arm's alternatives: a useMemo-bound
# name is a VALUE (the memoized result itself), never itself called later as
# `name(args)` the way this arm's call-site registration
# (HELPER_CALL_SINK_HEAD / HELPER_LOCAL_DECL_TMPL, both of which search for
# `name(`) requires. `const rows = useMemo(() => [...], deps); setRows(rows);`
# is a DIFFERENT shape from this arm's `function getRows(d){...}
# setRows(getRows(d))`: rows is a plain local flowing to a sink, the same
# shape DECL_ARR's own FLOWS_TO_STATE_TMPL check already handles for `const
# rows = [...]` -- so a useMemo factory returning literal rows is handled by
# the separate DECL_USEMEMO arm below, which feeds that check directly,
# never by registering `useMemo` itself as a fabricator name here. (An
# earlier version of this comment claimed the useMemo case was "already the
# ordinary DECL_ARR/rule-5 shape" without an arm making that true; it was not
# caught by any rule until DECL_USEMEMO was added -- see BACKLOG 125 B-7
# rework.)
HELPER_HEAD = re.compile(r'\b(?:export\s+(?:default\s+)?)?(?:async\s+)?'
                          r'(?:function\s+([A-Za-z_$][\w$]*)\s*\('
                          r'|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\('
                          r'|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\('
                          # useCallback/React.useCallback MUST be tried before
                          # the generic bare-param alternative below: both
                          # start with "const NAME = <identifier>", and
                          # alternation is ordered, so a bare-param attempt
                          # tried first would consume "useCallback" itself as
                          # if it were the bare param name (then correctly
                          # fail its own `=>` check and be skipped entirely,
                          # silently losing the whole useCallback fixture).
                          r'|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?useCallback\s*(?:<[^()]*?>)?\s*\('
                          r'|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?=[A-Za-z_$]))')
# A bare single-param arrow head (`param => {...}`, HELPER_HEAD's 4th
# alternative) has no `(` for close_of to span, so its own params-end is the
# identifier's own end, not a paren match; BARE_PARAM below finds that
# identifier's end directly from the match position instead of close_of.
BARE_PARAM = re.compile(r'\s*([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>')
# BACKLOG 144 (S-180): a class-method helper head, `_getRows() {` / `async
# load(d): Row[] {` at the start of a line, called later as `this.name(...)`
# (never a bare `name(...)`, so its call-site prefix differs; see
# METHOD_CALL_PRE). Statement keywords that also take `(...) {` are excluded
# by the lookahead; the body `{` right after the params is required below, so
# a plain call statement (`setRows(x);`) never registers.
METHOD_HEAD = re.compile(r'^[ \t]*(?:(?:static|async|public|private|protected|override)\s+)*'
                         r'(?!(?:if|for|while|switch|catch|with|function|return|await|typeof|new|super)\b)'
                         r'([A-Za-z_$][\w$]*)\s*\(', re.M)
METHOD_CALL_PRE = r'\bthis\.'
HELPER_CALL_PRE = r'(?:(?<![\w$.])|(?<=\.\.\.))'
HELPER_ARROW_TAIL = re.compile(r'\s*(?::[^=]*)?=>\s*')
# A `function`/function-expression head's own non-brace TypeScript return type
# (`function getRows(d): Row[] {`, `: Promise<Row[]>`): skipped so body_start
# lands on the real `{`, not on the type's leading `:`. A brace-containing
# return type (`: { rows: Row[] }`) DOES match, via the lookahead on the
# type's own opening `{`: body_start then lands on the type's brace, not the
# function's, so `close_of` spans the type instead of the real body, no
# `return` is found inside it, and the helper is silently skipped. That stays
# a false-negative-only miss (documented below), same outcome as before this
# fix, just reached via a different, still-wrong body_start.
HELPER_RETURN_TYPE = re.compile(r'\s*:[^={;]*(?=\{)')
RETURN_ARR = re.compile(r'\breturn\s*\[')
# A return inside a NESTED function/arrow body belongs to that inner callback,
# not to the outer helper being checked (`function loadRows(d){ const cols =
# () => { return [{...}]; }; return d.rows; }` returns real data; the literal
# never reaches loadRows's own caller). Matches a nested `function(...) {`,
# `(...) => {` or a bare-param arrow `x => {`; only the block-body form needs
# excluding, since a concise `=> [...]` is itself an array literal, not a
# `return`, and is out of scope for this exclusion.
NESTED_FN_HEAD = re.compile(r'\bfunction\b[^{}();]*\([^()]*\)\s*\{'
                             r'|\([^()]*\)\s*(?::[^=]*)?=>\s*\{'
                             r'|\b[A-Za-z_$][\w$]*\s*=>\s*\{')
# Sink match: rather than a single non-nested-paren regex for the call's own
# argument list (which cannot span a nested call, and cannot see a spread
# element or a trailing chained method call), find the sink's own balanced
# argument span with close_of and search inside it for the helper's name
# followed by `(`, anywhere in that span. This one change covers all three
# CONCERN-reported sink gaps at once: `setRowsX([...buildRows(records)])` (a
# spread element ahead of the call), `setRowsX(buildRows(normalize(records)))`
# (a nested call wrapping the fabricating call), and
# `setRowsX(buildRows(records).slice())` (a trailing method call chained after
# the sink call: the call to `name(` is still found inside the span
# regardless of what follows it). The lookbehind excludes a plain member
# access (`obj.getRows(`) or a substring match (`rebuildRows(`), but must NOT
# exclude a spread's three dots (`[...getRows(...)]`): `(?:(?<![\w$.])|
# (?<=\.\.\.))` reads as "not preceded by a word char or a single dot, UNLESS
# the three characters immediately before are exactly '...'".
def make_helper_sink_head(alias_alt):
    return re.compile(r'\b(?:set[A-Z]\w*|useState|' + BRACKET_SINK + alias_alt + r')\s*' + OPT_CALL + r'(?:<[^()]*?>)?\s*\(')
HELPER_CALL_SINK_HEAD = make_helper_sink_head('')
# PO-P7-SINKS-1 (E-138): a local that FORWARDS a fabricator's result rather
# than binding the bare call: `const rows = useMemo(() => normalize(getRows(d)),
# deps)`, `const rows = [...getRows(d)]`, `const all = getRows(d).slice()`.
# local_init_end isolates the initializer expression; the fabricator call must
# appear in it and not only as a scalar read (`getRows(d).length`, `[0]`,
# `.find(...)`), which carries no rows forward.
LOCAL_INIT_DECL = re.compile(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]*)?=(?![=>])\s*')
SCALAR_READ = re.compile(r'\s*(?:\?\.|\.)\s*(?:length|size|find|findIndex|some|every|includes|indexOf|join|at|reduce)\b|\s*\[')
NEXT_NONSPACE = re.compile(r'\s*(\S)')
def local_init_end(s, a):
    """Index one past the initializer expression starting at s[a]: up to the
    first top-level `,`, `;` or unmatched closer, or a newline that does not
    continue the expression (an ASI-style statement end)."""
    j = a
    while j < len(s):
        c = s[j]
        if c in '\'"`':
            j = skip_quoted(s, j)
        elif c in OPEN:
            k = close_of(s, j)
            if k < 0:
                return j
            j = k
        elif c in ')]},;':
            return j
        elif c == '\n':
            nx = NEXT_NONSPACE.match(s, j + 1)
            prev = s[a:j].rstrip()[-1:]
            if not (nx and (nx.group(1) in '.?:|&' or prev == '' or prev in '=?:|&(>+,')):
                return j
        j += 1
    return j
def forwards_call(init, call_re):
    """True when init contains a call matching call_re (its `(` is the match's
    last char) that is not just a scalar read of the result."""
    for m in re.finditer(call_re, init):
        close = close_of(init, m.end() - 1)
        tail = init[close + 1:close + 40] if close >= 0 else ''
        if not SCALAR_READ.match(tail):
            return True
    return False
HELPER_CALL_IN_SPAN_TMPL = r'{pre}{name}\s*\('
# useState's lazy-initializer form passes the bare function reference, never
# calling it at the sink at all (`useState(getRows)`, React calls it once on
# mount): the called-form template above can never match this, since there is
# no `(` after the name at the sink. Sink-span-scoped (not whole-file) so a
# same-named setter call elsewhere cannot falsely satisfy a different helper.
HELPER_BARE_REF_IN_SPAN_TMPL = r'{pre}{name}\s*[,)]'
# The two-hop form: `const rows = getRows(d); setRows(rows);` -- the literal
# never appears at the sink call at all (the sink is fed a bare local), so
# HELPER_CALL_SINK_HEAD's span search cannot see it either; this is the same
# "capture the intermediate local, then re-check FLOWS_TO_STATE_TMPL on it"
# shape DECL_ARR itself already can't need (DECL_ARR's own literal sits right
# at the local's declaration). `(?:await\s+)?` covers `const rows = await
# getRows();`.
# E-128 (BACKLOG 147): the optional USEMEMO_CALL_PRE also accepts a useMemo
# factory whose body is just a call to the fabricator (`useMemo(() => name(d),
# deps)` concise, or `useMemo(() => { return name(d); }, deps)` block), so the
# memo-bound local is credited exactly like a directly-called one.
USEMEMO_CALL_PRE = r'(?:(?:React\.)?useMemo\s*(?:<[^()]*?>)?\s*\(\s*\(\s*\)\s*=>\s*(?:\{{\s*return\s+)?)?'
HELPER_LOCAL_DECL_TMPL = r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{{}}]*)?=(?![=>])\s*(?:await\s+)?' + USEMEMO_CALL_PRE + r'{pre}{name}\s*\('
# useMemo extension (BACKLOG 125 B-7 rework, mainstream React idiom): `const
# rows = useMemo(() => [...fabricated rows...], deps); setRows(rows);` is
# caught by NO rule without this arm. It is NOT the HELPER_HEAD shape: `rows`
# here is a VALUE (the memoized result), never itself called later as
# `rows(args)` the way a useCallback-wrapped function is, so it cannot use
# HELPER_HEAD's call-site-registration machinery (HELPER_CALL_SINK_HEAD /
# HELPER_LOCAL_DECL_TMPL both search for `name(`, which a useMemo binding
# never satisfies). Instead `rows` is a plain local flowing to a sink -- the
# exact shape DECL_ARR already handles for `const rows = [...]` -- so this arm
# only locates the useMemo factory's own literal-rows body (reusing
# literal_return_span, the same helper-body literal check HELPER_HEAD uses)
# and then, on a hit, re-checks MODULE_DECL/FLOWS_TO_STATE_TMPL on `rows`
# exactly the way DECL_ARR's own loop does, rather than treating `useMemo`
# itself as a fabricator name. Matches `const/let/var NAME = useMemo(` or
# `React.useMemo(`; the factory (useMemo's first argument) is then located the
# same way HELPER_HEAD locates a bare `(...) =>`/bare-param arrow body:
# concise (`=> [...]`) and block (`=> { ... return [...]; }`) forms are both
# handled via literal_return_span, which already covers both shapes.
DECL_USEMEMO = re.compile(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]*)?=(?![=>])\s*'
                           r'(?:React\.)?useMemo\s*(?:<[^()]*?>)?\s*\(')
DEMO_NAME = re.compile(r'(?:\b(?:const|let|var)\s+|\bthis\.)([A-Za-z_$][\w$]*)\s*(?::[^=;]*?)?=(?![=>])\s*([\[{])')
BARE = re.compile(r'^_*(?:sample|mock|demo|fake|dummy|placeholder)s?$|^_*placeholder(?=[A-Z_\d])|^_*PLACEHOLDER_', re.I)
STAT_KEY = re.compile(r'^["\']?(?:uses|usage|rating|ratings|stars|forks|downloads|installs|views|users|builds|runs|count|total|score|percent|tokens|cost|spend|revenue|reviews|likes|confidence|coverage)["\']?$', re.I)
NUMVAL = re.compile(r'^-?\d[\d_]*(?:\.\d+)?$')
ZERO_FMT = re.compile(r'(?:\|\||\?\?)\s*0\s*\)\s*\.\s*(?:toLocaleString|toFixed)\s*\('
                      r'|\.\s*(?:toLocaleString|toFixed)\s*\([^()]*\)\s*\|\|\s*0(?![\w.])'
                      r'|\b_?format\w*\s*\([^(),]*(?:\|\||\?\?)\s*0\s*[,)]')
def obj_pairs(o):
    out = []
    for p in split_top(o[1:-1]):
        k = top_colon(p)
        if k < 0:
            return None
        out.append((p[:k].strip(), p[k + 1:].strip()))
    return out
def whole_file_findings(s):
    """(line, message) for rules 6-9; nested arrays inside a hit are not re-reported."""
    out, spans = [], []
    # PO-P7-SINKS-1 (E-138): rebind the three sink regexes for this file so a
    # one-hop sink alias (`const push = setRows`) is a sink everywhere they are
    # used below.
    alias_alt = sink_alias_alt(s)
    SETTER = make_setter(alias_alt)
    FLOWS_TO_STATE_TMPL = make_flows_tmpl(alias_alt)
    HELPER_CALL_SINK_HEAD = make_helper_sink_head(alias_alt)
    # Built once, up front, so the FALLBACK_ARR/TERNARY inline-array checks
    # below (not only the later module-table-fallback block) can resolve a
    # `[...NAME]` spread element back to a known column-0 table's own
    # fabrication status (BACKLOG 125 B-5 rework, reviewer 1 finding 4:
    # `rows || [...BACKUP_ROWS3]` -- a spread inside a literal array failed
    # plain is_literal() and was silently skipped).
    module_tables = {}
    for m in DECL_MODULE_INIT.finditer(s):
        name, opener = m.group(1), m.group(2)
        line_start = s.rfind('\n', 0, m.start()) + 1
        if not MODULE_DECL.match(s, line_start):
            continue
        j = close_of(s, m.end() - 1)
        if j < 0:
            continue
        module_tables[name] = (opener, m.end() - 1, j)

    # name_alt/chain_end/TERMINATOR/table_operand_end/resolves_to_table_read
    # are defined here, unconditionally and BEFORE literal_rows_resolved
    # (moved up from their original home inside the `if module_tables:`
    # block much further below, which runs AFTER the FALLBACK_ARR/TERNARY
    # spread-element loops that call literal_rows_resolved -- at the time
    # those loops ran, table_operand_end did not exist yet, so
    # literal_rows_resolved's spread-element check (`p[3:].strip() in
    # module_tables`) was a bare exact-string match with no chain-walk or
    # paren-peel at all: `[...BACKUP_ROWS.slice(0)]`, `[...BACKUP_ROWS.filter
    # (r => r.ok)]` and even a bare `[...(BACKUP_ROWS)]` (no chain, just
    # parens) all failed to resolve and were silently skipped -- the exact
    # "spelling of the read defeats detection" class this whole arm exists to
    # close, just at the spread-element site instead of the bare-operand one.
    # name_alt is `never matches anything` (an alternation with no branches
    # is invalid re syntax) when module_tables is empty, so callers below
    # must still treat "no match" as "not a table read", which they already
    # do (a None/False return), so this degrades safely to a no-op.
    name_alt = '|'.join(re.escape(n) for n in sorted(module_tables, key=len, reverse=True)) if module_tables else r'(?!)'
    # After the name, the REST of the operand must still carry the
    # table's row data, not merely read a scalar or one element out of it
    # -- `PERMS.length`, `TABS[0]`, `OPTS.find(o => o.on)` all resolve to
    # a NUMBER, ONE ROW or ONE ROW-OR-UNDEFINED, never the fabricated
    # array, and must not read as "the table used as a fallback". A
    # WALKER (not a single regex) consumes zero or more `.method(...)`/
    # `?.method(...)` calls whose method name is array-returning
    # (ARRAY_METHODS), each with its own BALANCED parens via close_of --
    # a single `[^()]*` class inside one regex cannot express "balanced",
    # so it silently stopped at the first nested `(` in an arrow-function
    # argument (`.filter((r) => r.ok)`) or after the first call in a
    # chain (`.slice(0).reverse()`), UNDER-matching and leaving both
    # shapes unresolved -- reviewer-class bypass, the same "spelling of
    # the read defeats detection" this whole arm exists to close.
    # `[<int>]` deliberately does NOT chain-walk here: a bare index read
    # (`sel || TABS[0]`) is picking ONE row, honest and common (the same
    # reasoning FindReadHonest/ElementIndexReadHonest use for `.find()`/
    # `[i].x`), so `[<int>]` is NOT accepted by this walker at all -- it
    # only ever exempts as a bounded NARROWING inside
    # is_narrowing_self_derivation (the ternary-sibling test), never as a
    # "the operand carries the table's data" read here. A scalar/property
    # suffix (`.length`, `?.length`, `.find(...)`, a mismatched longer
    # identifier like `PERMSET`) does not chain-walk either, so text like
    # `PERMS.length` or `PERMSET` never resolves to a table at all.
    ARRAY_METHODS = frozenset((
        'slice', 'concat', 'filter', 'map', 'flat', 'flatMap',
        'sort', 'reverse', 'toSorted', 'toReversed',
    ))
    CHAIN_CALL = re.compile(r'\s*(\??\.)\s*([A-Za-z_$][\w$]*)\s*\(')
    def chain_end(t, i):
        """t[i:] follows a resolved table name. Consume zero or more
        `.method(...)`/`?.method(...)` calls whose method is array-
        returning, each argument list matched by its own balanced-paren
        span (close_of), and return the index just past the LAST such
        call (i itself if there is none). Returns -1 the first time a
        call name is NOT in ARRAY_METHODS -- that call could return
        anything (a scalar, one row, undefined), so the walk stops and
        the caller must treat the whole operand as unresolved, never as
        "resolves to the table only up to here"."""
        while True:
            m = CHAIN_CALL.match(t, i)
            if not m:
                return i
            if m.group(2) not in ARRAY_METHODS:
                return -1
            paren = m.end() - 1
            j = close_of(t, paren)
            if j < 0:
                return -1
            i = j + 1
    # TERMINATOR: an operand ends at end-of-string, a closing
    # bracket/brace/paren/comma/semicolon/colon, or another `||`/`??`
    # (logical-OR/nullish continuation) -- an ALLOWLIST of terminators, not a
    # blacklist of what must not follow. Defined here (before
    # table_operand_end) because table_operand_end applies this SAME boundary
    # test to the text INSIDE a leading paren group, not only to the
    # top-level operand after it -- so `(BACKUP_ROWS || other)` and
    # `(BACKUP_ROWS ?? y)` resolve the inner `BACKUP_ROWS` exactly as the
    # unparenthesized `rows || BACKUP_ROWS || other` form already does
    # (hitting `||`/`??` is a valid boundary at any nesting depth, not just
    # at the outermost one), while `(BACKUP_ROWS).length` and `(BACKUP_ROWS
    # as Row[]).length` still do NOT resolve, because `.` is not in
    # TERMINATOR and chain_end returns unchanged there.
    #
    # `&&` and a bare `?` (ternary-condition continuation) are DELIBERATELY
    # NOT terminators here (round 6 fix, BACKLOG 125 B-5): `x || TABLE &&
    # other` evaluates to `other` whenever TABLE is a non-empty array
    # (always truthy) -- TABLE is used only as a boolean CONDITION and its
    # own data never reaches the sink. Likewise `x || TABLE ? a : b`
    # evaluates to `a`/`b`, never to TABLE. Confirmed against real JS
    # operator precedence via `node -e`. Accepting `&&`/`?` as boundaries
    # here (as an earlier round did) let this site wrongly resolve TABLE as
    # "the fallback value" when it is only ever a condition -- a false
    # positive on the bare (unparenthesized) form; `x || (TABLE && other)`
    # already stayed clean because the paren wraps the whole condition
    # expression and table_operand_end's paren branch never even reaches
    # this regex for it. This is the ONLY call site that reads TERMINATOR
    # (`table_operand_end`'s own paren branch uses the narrower INNER_TERM,
    # defined below, precisely because `&&`/bare-`?`/`,` inside parens carry
    # this same condition-not-value distinction), so narrowing it here does
    # not affect the paren-peel path at all.
    #
    # CAST_SKIP: an optional ` as Type` consumed BEFORE the boundary check,
    # not itself a terminator alternative -- round 6 fix, same finding as
    # the `&&`/bare-`?` one above, reached through a different spelling.
    # `\bas\b` used to sit directly in TERMINATOR's alternation, so `x ||
    # TABLE as Row[] && other` (an inline cast in front of `&&`) matched
    # `as` as if it were itself the boundary, right after TABLE, and never
    # even looked at the `&&` that followed the cast -- the exact same
    # condition-not-value false positive as the uncast form, and its FN
    # twin (`live ? live : TABLE as Row[] || other`, which never reached a
    # boundary at all under the old TERMINATOR because nothing there
    # accepted `as ... ||`) both confirmed via `node -e`. Skipping the cast
    # FIRST, then checking the real character after it, fixes both: `as
    # Row[]` is consumed, landing on `&&`/`?` (correctly rejected, not a
    # boundary) or `||`/`??`/end-of-string/`)`/etc (correctly accepted).
    # Known ceiling: only a SINGLE level of `<...>` generic nesting is
    # matched (`Record<string, X>` works; `Map<string, Record<string, X>>`
    # does not, since `[^<>]*` cannot see past its own inner `<`/`>`) -- an
    # actual nested generic falls back to not resolving as a cast at all,
    # never to mis-resolving one, so this is a missed-detection ceiling, not
    # a false-positive risk.
    # [ \t]*, not \s*: \s* also matches a NEWLINE, so it would swallow a
    # missing-semicolon line break and let `$` match nothing right after
    # it (there is no re.M flag here) -- `const data = rows || BACKUP_Q`
    # on its own line, with more code below and no semicolon, would then
    # resolve as "ends the operand" when it does not. The explicit
    # `\r?\n(?!\s*(?:\??\.|\[))` alternative treats a newline as a
    # terminator ONLY when nothing that continues the chain follows it
    # (a bare newline ends the operand; `\n  .slice(0)` continues it, so
    # chain_end must get the chance to consume that line first).
    # CAST_SKIP's type shape is deliberately PRECISE (identifier, optional
    # `[]` array-suffix repeats, optional single-level `<...>` generic), not
    # a loose character class: an earlier draft used
    # `[\w$.\[\]<>, ]*` (a bag of "characters a type might contain"), and its
    # own greedy `]`/`)`/`,`/`:` characters overlap with the terminator
    # alternation right after it -- on `TBL as Row[] && other`, the
    # backtracking engine gave back one character at a time from the loose
    # class until the terminator alternation's `[)\]},;:]` branch could
    # match the CLOSING `]` OF THE TYPE ITSELF (`Row[]`'s own bracket), so
    # the match ended right there and never even looked at `&&` -- silently
    # re-introducing the exact FP this cast-skip exists to close. The
    # precise shape has nothing left to give back that the terminator
    # alternation could also match, so it cannot happen here.
    CAST_SKIP = r'(?:\s+as\s+[\w$]+(?:\[\])*(?:<[^<>]*>)?)?'
    TERMINATOR = re.compile(CAST_SKIP + r'[ \t]*(?:[)\]},;:]|\|\||\?\?|\r?\n(?!\s*(?:\??\.|\[))|$)')
    def table_operand_end(t, i):
        """t[i:] is the start of an operand that may name a table. Returns
        (name, end) when it resolves to a known table plus a trailing
        chain of zero or more array-returning calls, or None.

        Handles a LEADING balanced paren group (via close_of, the same
        walker used everywhere else in this arm) transparently, at any
        depth -- `(BACKUP_ROWS)`, `(BACKUP_ROWS as Row[])`,
        `((BACKUP_ROWS))`, `(BACKUP_ROWS as Row[]).slice(1)`,
        `(BACKUP_ROWS || other)` (see TERMINATOR's docstring note just
        above) all resolve to BACKUP_ROWS. This replaces two earlier,
        INCONSISTENT paren checks: unwrap()'s `close_of(t, 0) == len(t) -
        1` (required the paren to close at the very LAST character of
        the whole branch, so a trailing chain after the closer --
        `(BACKUP_ROWS as Row[]).slice(1)` -- left the string still
        wrapped and unmatched: an undetected bypass of exactly the
        evasion this arm exists to close) and the ||/?? site's
        leading-parens prefix capture (consumed leading `(` characters
        but never confirmed where they closed, so TERMINATOR's bare `)`
        alternative could match the FIRST `)` it found -- which might
        close an unrelated outer/sibling paren, not the one the prefix
        opened -- wrongly treating `(PERMS).length` as "operand ends
        here" and flagging an honest scalar read). Recursion (rather
        than one non-recursive peel) handles `((NAME))` and lets an `as
        Type` sit inside any nesting depth, not just the outermost one.

        The INNER content of a paren group is accepted only when it reaches
        an INNER_TERM boundary (end-of-string, or another `||`/`??`) --
        deliberately NARROWER than TERMINATOR, and NOT simply reused: inside
        parens, `&&`, a bare ternary `?`, and `,` do not mean "the table IS
        the value" the way they do (as valid boundaries) at the top-level
        operand position. `(T && x)` evaluates to `x`, not T, whenever T is a
        non-empty array (always truthy); `(T ? a : b)` uses T only as a
        CONDITION, never as the value; `(T, x)` (the comma operator)
        evaluates to `x`. Accepting any of those as "the paren group
        resolves to T" would be a false positive with T merely mentioned,
        not read as a fallback value. `e >= 0` is checked explicitly first,
        since re.match clamps a negative pos to 0 and would otherwise read a
        chain_end() failure (-1) as "matches at the start"."""
        if t[i:i + 1] == '(':
            k = close_of(t, i)
            if k < 0:
                return None
            inner = t[i + 1:k].strip()
            # Strip a trailing `as Type` INSIDE this paren layer (`(BACKUP_ROWS
            # as Row[])`'s inner text is `BACKUP_ROWS as Row[]`) before
            # recursing -- this is separate from resolves_to_table_read's own
            # top-level strip, which only ever sees a trailing `as Type` with
            # no enclosing parens at all (`BACKUP_ROWS as Row[]`, no wrapper).
            # Both are needed: dropping this one breaks every `(NAME as
            # Type)` paren form, dropping that one breaks the bare-cast form.
            inner = re.sub(r'\s+as\s+[\w$][\w$.\[\]<>, ]*$', '', inner).strip()
            inner_res = table_operand_end(inner, 0)
            if not inner_res:
                return None
            iname, iend = inner_res
            if iend < 0 or not INNER_TERM.match(inner, iend):
                return None
            return iname, chain_end(t, k + 1)
        m = re.match(r'^(' + name_alt + r')(?![\w$])', t[i:])
        if not m:
            return None
        return m.group(1), chain_end(t, i + m.end())
    # Only `||`/`??` (or end-of-string) let the INNER content of a paren
    # group resolve to the table -- see table_operand_end's own docstring for
    # why this must NOT be the same, broader TERMINATOR used at the top-level
    # operand position. CAST_SKIP (round 6 fix, shared with TERMINATOR) lets
    # an inline ` as Type` sit BEFORE the `||`/`??`/end-of-string boundary
    # here too: `(TABLE as Row[] || other)`'s inner text is `TABLE as Row[]
    # || other`, and without CAST_SKIP the `as` would sit directly in front
    # of `iend` with nothing to consume it, so INNER_TERM never matched and
    # this whole paren form was invisible even though TABLE's data reaches
    # the sink identically to the uncast `(TABLE || other)` -- confirmed via
    # `node -e` (a TypeScript `as` cast is erased at runtime). The line 1104
    # end-anchored `as` strip above still runs first and remains correct for
    # the pure `(TABLE as Row[])` case (nothing follows the cast); it is now
    # redundant with CAST_SKIP for that exact shape but not for this one,
    # so both stay.
    INNER_TERM = re.compile(CAST_SKIP + r'\s*(?:\|\||\?\?|$)')
    def resolves_to_table_read(text):
        """True when text is a known table name -- optionally wrapped in
        a balanced paren group at any nesting depth -- followed by a chain
        of zero or more array-returning calls and then either NOTHING else or
        a trailing `||`/`??` continuation (the resolved end must land at
        len(text) or at an INNER_TERM boundary, after stripping one trailing
        `as <Type>` first) -- the broad "does this operand carry the table's
        data" test used at the ||/?? and ternary match sites, and (as of this
        rework) the spread-element check inside literal_rows_resolved below
        too. The trailing `as Type` strip happens HERE, once, on the WHOLE
        input text, rather than inside table_operand_end's paren branch
        only: `live ? live : BACKUP_ROWS as Row[]` (no parens at all, a bare
        cast) is valid TypeScript and must resolve the same way `live ? live
        : (BACKUP_ROWS as Row[])` does -- stripping only inside the paren
        branch would silently stop catching the unparenthesized cast form, a
        real regression this rework's own restructuring introduced and
        caught via matrix testing before it shipped.

        INNER_TERM (not TERMINATOR) is the right boundary here, matching
        table_operand_end's own paren-branch reasoning (round 6 fix,
        BACKLOG 125 B-5): `live ? live : TABLE || other` (a BARE table name,
        no wrapping parens at all, as the whole colon branch) previously
        required end == len(text) exactly, so it never resolved -- even
        though `live ? live : (TABLE || other)` (the identical expression
        wrapped in one extra pair of parens) already did, via
        table_operand_end's own recursive paren-peel landing on this same
        INNER_TERM. TABLE's data reaches the sink identically in both forms
        (confirmed via `node -e` against real JS semantics: when `live` is
        falsy, the result is TABLE's own array whenever TABLE is truthy, or
        `other` otherwise -- either way TABLE CAN reach the sink), so both
        forms must resolve the same way; the bare form was an undetected
        paren/no-paren asymmetry, the same bug class as every earlier round
        here. `&&` and a bare `?` deliberately stay OUT of the boundary
        (TABLE used only as a condition never exposes its own data -- see
        TERMINATOR's docstring for the twin false-positive this class
        caused at the ||/?? finder site). Returns the matched name or
        None."""
        text = re.sub(r'\s+as\s+[\w$][\w$.\[\]<>, ]*$', '', text.strip()).strip()
        res = table_operand_end(text, 0)
        if not res:
            return None
        name, end = res
        if end < 0:
            return None
        return name if end == len(text) or INNER_TERM.match(text, end) else None

    def table_is_fabricated_rows(name):
        opener, i, j = module_tables[name]
        return opener == '[' and literal_rows(s[i:j + 1])

    def literal_rows_resolved(arr):
        """Like literal_rows(arr), but a spread element that names a known
        column-0 table (`[...FALLBACK_ROWS]`, `[...FALLBACK_ROWS, extra]` --
        `extra` itself must still be a plain literal element for the array to
        qualify, exactly like any other element in literal_rows()) resolves
        to THAT table's own fabrication status instead of failing
        is_literal() outright and being silently skipped: every element must
        be a hand-typed literal OR a spread of a column-0 table whose OWN
        content is fabricated rows (table_is_fabricated_rows -- the same
        structural test MODULE_TABLE_FALLBACK already applies to a bare
        `x || NAME`). This is purely structural, by table CONTENT, never by
        NAME containing sample/mock/demo/fake/placeholder: `x || [...
        DEFAULT_PROVIDERS]` DOES qualify (and is flagged) exactly because
        DEFAULT_PROVIDERS' own rows are hand-typed literals, the identical
        reasoning a bare `x || DEFAULT_PROVIDERS` already uses.
        This function MUST stay gated to the fallback/ternary call sites
        below (via add_rows(..., spread=True)), never applied at every
        add_rows call site: doing so unconditionally would ALSO fire inside
        the useState/setter/catch/decl arms, wrongly flagging the ordinary,
        non-fallback shape `useState([...DEFAULT_PROVIDERS])` (a named
        module-level table is a negative control when it seeds useState,
        spread or not, matching the existing ASSIGN_ARR/DECL_ARR exemption
        for a bare `useState(DEFAULT_PROVIDERS)`). See
        DefaultProvidersSpreadHonest.tsx below, the fixture pinning this. The
        distinction is NOT about whether the table is honest -- it is about
        whether the call
        site is itself a fallback/ternary carrying live-vs-static-data
        semantics, which useState-seeding is not.

        The spread operand (`p[3:]`) is resolved through resolves_to_table_read,
        never by a bare `name in module_tables` exact-string match: the exact
        match required the spread element to be JUST the name (`[...TABLE]`)
        with nothing else, so `[...TABLE.slice(0)]`, `[...TABLE.filter(r =>
        r.ok)]` and even a bare `[...(TABLE)]` (parens, no chain at all) all
        failed to resolve and were silently treated as "not a spread of a
        known table" -- invisible to this whole arm, the same paren/chain
        bypass class table_operand_end exists to close at the bare-operand
        ||/?? and ternary sites, just reachable here through a spread element
        instead. resolves_to_table_read applies the identical paren-peel and
        array-returning chain-walk to the spread operand's text."""
        parts = split_top(arr[1:-1])
        if not any(p.startswith('{') or p.startswith('...') for p in parts):
            return False
        for p in parts:
            if p.startswith('...'):
                name = resolves_to_table_read(p[3:].strip())
                if not (name and table_is_fabricated_rows(name)):
                    return False
            elif not is_literal(p):
                return False
        return True
    def add_rows(i, msg, spread=False):
        j = close_of(s, i)
        if j < 0 or any(a <= i <= b for a, b in spans):
            return
        if literal_rows(s[i:j + 1]) or (spread and literal_rows_resolved(s[i:j + 1])):
            spans.append((i, j)); out.append((line_of(s, i), msg))
    def add_rows_call(i, j, msg):
        """Like add_rows, but (i, j) is a paren span already known to be
        closed (Array.of(...)), so it is checked as-is instead of re-deriving
        j from s[i]. literal_rows() strips one char each side regardless of
        bracket kind, so a paren span works the same as a bracket span."""
        if any(a <= i <= b for a, b in spans):
            return
        if literal_rows(s[i:j + 1]):
            spans.append((i, j)); out.append((line_of(s, i), msg))
    for m in SETTER.finditer(s):
        i = m.end()
        if s[i] == '<':
            depth = 0
            while i < len(s):
                depth += {'<': 1, '>': -1}.get(s[i], 0) if s[i - 1:i + 1] != '=>' else 0
                i += 1
                if depth == 0:
                    break
        i = len(s) - len(s[i:].lstrip())
        if i >= len(s) or s[i] != '(':
            continue
        arg = s[i + 1:]
        lazy = re.match(r'\s*\(\s*\)\s*=>\s*', arg)
        k = i + 1 + (lazy.end() if lazy else len(arg) - len(arg.lstrip()))
        if k < len(s) and s[k] == '[':
            add_rows(k, f'literal sample rows passed to {m.group(1)}()')
    for m in CATCH.finditer(s):
        b = m.end() - 1
        e = close_of(s, b)
        if e < 0:
            continue
        for k in range(b + 1, e):
            if s[k] == '[' and ARRAY_CTX.search(s[max(b, k - 40):k]):
                add_rows(k, 'literal sample rows assigned in a catch block')
    for m in DEMO_NAME.finditer(s):
        name = m.group(1)
        if FLAG.search(name) or not (BARE.search(name) or DEMO.search(name)):
            continue
        out.append((line_of(s, m.start(1)), f"'{name}' binds sample/mock/demo/fake/placeholder literal data"))
    for m in re.finditer(r'(?:\|\||\?\?)\s*\{', s):
        i = m.end() - 1
        j = close_of(s, i)
        pairs = obj_pairs(s[i:j + 1]) if j > 0 else None
        if pairs and any(STAT_KEY.match(k) and NUMVAL.match(v) for k, v in pairs):
            out.append((line_of(s, i), 'invented stats: constant metric fallback'))
    for m in re.finditer(r'=\s*\{', s):
        i = m.end() - 1
        j = close_of(s, i)
        pairs = obj_pairs(s[i:j + 1]) if j > 0 else None
        if not pairs or len(pairs) < 2:
            continue
        rows = [obj_pairs(v) if v.startswith('{') and close_of(v, 0) == len(v) - 1 else None for _, v in pairs]
        if all(r and all(STAT_KEY.match(k) and NUMVAL.match(v) for k, v in r) for r in rows):
            out.append((line_of(s, i), 'invented stats lookup table'))
    for m in ZERO_FMT.finditer(s):
        out.append((line_of(s, m.start()), 'unmeasured value rendered as zero (zero fallback fed to a formatter)'))
    # --- rule 6 extension: literal rows anywhere a fallback/assignment/call
    #     argument can hold them, not only at a setter's first argument or in a
    #     catch body. Added after the arms above so their messages and spans
    #     win the dedupe in add_rows() when both match the same array.
    for m in FALLBACK_ARR.finditer(s):
        add_rows(m.end() - 1, 'literal sample rows used as a ||/?? fallback', spread=True)
    for m in re.finditer(r'(?<!\?)\?(?![.?:])', s):
        c = ternary_colon_of(s, m.start())
        if c < 0:
            continue
        q_raw = s[m.end():c]
        q_branch = q_raw.strip()
        e = m.end() + len(q_raw) - len(q_raw.lstrip())
        colon_raw = s[c + 1:]
        colon_branch_strip = colon_raw.lstrip()
        cstart = c + 1 + (len(colon_raw) - len(colon_branch_strip))
        if e < len(s) and s[e] == '[' and not is_literal(colon_raw[:expr_end(colon_raw)]):
            add_rows(e, 'literal sample rows in a ternary branch', spread=True)
        if cstart < len(s) and s[cstart] == '[' and not is_literal(q_branch):
            add_rows(cstart, 'literal sample rows in a ternary branch', spread=True)
    for m in DECL_ARR.finditer(s):
        name = m.group(1)
        line_start = s.rfind('\n', 0, m.start()) + 1
        if MODULE_DECL.match(s, line_start):
            continue  # named module-level table (DEFAULT_PROVIDERS et al.), a negative control
        if re.search(FLOWS_TO_STATE_TMPL.format(name=re.escape(name)), s):
            add_rows(m.end() - 1, 'literal sample rows assigned to ' + name)
    # --- module-level table used as a ||/??/ternary fallback (BACKLOG 125 B-5)
    # The ASSIGN_ARR exemption above treats every column-0 `const NAME = [...]`
    # as static UI config. That is right for a table that is just referenced
    # (DEFAULT_PROVIDERS passed to useState), but a table used as the FALLBACK
    # arm of `x || NAME` / `x ?? NAME` or a ternary is structurally identical to
    # the inline `x || [rows]` / `a ? x : [rows]` shapes FALLBACK_ARR and
    # TERNARY already flag -- only the literal moved behind a name. Resolve
    # each column-0 name to its initializer and apply the SAME literal-rows (or,
    # for an object, rule 8's invented-stats) test the inline arms use, so
    # catching this never depends on the name containing sample/mock/demo/fake/
    # placeholder: a `FALLBACK_ROWS`/`DEFAULT_ROWS`/`BACKUP_DATA` table is
    # caught the same way a `SAMPLE_ROWS` one already is.
    # (module_tables and table_is_fabricated_rows are built once, at the top
    # of whole_file_findings, and reused here -- see the comment there.)

    # A bounded narrowing read: `NAME.slice(<start>, <end>)` (BOTH indices
    # required -- a one-argument `.slice(k)` is a full, unbounded copy from k
    # to the end, the exact defensive-copy shape this must NOT exempt) or
    # `NAME[<int>]`, anchored end to end (fullmatch). An allowlist, not a
    # blacklist on `.concat`/spread: a blacklist would still miss
    # `.map(() => fake)` or `.flat()`, so only these two provably-narrowing
    # shapes qualify. Reviewer 1's four bypasses were exactly the shapes a
    # prefix-test-plus-blacklist missed (`.concat()`, an open-ended
    # `.slice(k)`, `[...NAME]`); this allowlist has no additive or unbounded
    # member to miss. BOTH slice indices are required for exactly this
    # reason: an optional end index would silently re-admit `.slice(k)` as
    # "narrowing", though it has no end index and a two-argument
    # `.slice(start, end)` is the only bounded form -- see
    # UnboundedSliceFallback.tsx below, the fixture pinning this.
    NARROW_SUFFIX = re.compile(
        r'^\.slice\(\s*-?\d+\s*,\s*-?\d+\s*\)$'
        r'|^\[\s*-?\d+\s*\]$'
    )
    def is_narrowing_self_derivation(branch, name):
        """True when branch is exactly `name` followed by one bounded
        narrowing suffix (`RECENT_CHANGES.slice(0, 2)`, `TABLE[0]`) -- never a
        bare prefix test, so `NAME.concat(...)`, `NAME.slice(k)` (no end
        index) and any other suffix are NOT self-derivation and fall through
        to being scanned as their own fallback/ternary operand."""
        b = branch.strip()
        if b == name:
            return True
        if not (b.startswith(name) and len(b) > len(name)):
            return False
        return bool(NARROW_SUFFIX.match(b[len(name):]))

    def resolved_is_literal(branch, other_name=None):
        """Like is_exempting_sibling(branch) (S-30's null/undefined/''-excluding
        literal test, not bare is_literal -- so this arm never reintroduces
        S-30's exact ternary-against-null bypass at its OWN new call site), but
        a bare reference to a known column-0 table counts as literal too
        (mirrors advisorOpts: choosing between two static tables is UI config,
        not a live-vs-fabricated fallback), and so does a BOUNDED NARROWING
        read of the SAME table the other branch names (`expanded ?
        RECENT_CHANGES : RECENT_CHANGES.slice(0, 2)` picks how much of one
        static list to show, never a live-vs-fabricated fallback) -- an
        additive or unbounded derivation of that same table does NOT qualify
        here, matching is_narrowing_self_derivation exactly."""
        b = branch.strip()
        if b in module_tables:
            return True
        if other_name and is_narrowing_self_derivation(b, other_name):
            return True
        return is_exempting_sibling(b)

    def table_is_invented_stats(name):
        opener, i, j = module_tables[name]
        if opener != '{':
            return False
        pairs = obj_pairs(s[i:j + 1])
        if pairs and any(STAT_KEY.match(k) and NUMVAL.match(v) for k, v in pairs):
            return True
        if pairs and len(pairs) >= 2:
            rows = [obj_pairs(v) if v.startswith('{') and close_of(v, 0) == len(v) - 1 else None for _, v in pairs]
            if all(r and all(STAT_KEY.match(k) and NUMVAL.match(v) for k, v in r) for r in rows):
                return True
        return False

    def flag_table_fallback(name, where):
        if name not in module_tables or any(a <= where <= b for a, b in spans):
            return
        if table_is_fabricated_rows(name):
            spans.append((where, where))
            out.append((line_of(s, where), f"module-level table '{name}' (fabricated rows) used as a fallback"))
        elif table_is_invented_stats(name):
            spans.append((where, where))
            out.append((line_of(s, where), f"module-level table '{name}' (invented stats) used as a fallback"))

    if module_tables:
        # name_alt/ARRAY_METHODS/CHAIN_CALL/chain_end/TERMINATOR/
        # table_operand_end/resolves_to_table_read now live above,
        # right after module_tables is built -- see the comment there for why
        # (literal_rows_resolved's spread-element check needs them too, and
        # runs before this `if module_tables:` block).
        def unwrap(text):
            """Strip one layer of surrounding parens and a trailing
            `as <Type>`, so `(BACKUP_ROWS)` and `(BACKUP_ROWS as Row[])`
            resolve to the table the same as a bare `BACKUP_ROWS` -- reviewer-
            class bypass: parenthesizing or type-asserting a fallback operand
            must not be a way to dodge detection. Only ONE layer: matches
            is_literal's own `as const` handling in spirit, and a
            double-wrapped `((NAME))` is already vanishingly unlikely. NOTE:
            resolves_to_table_read/table_operand_end do their OWN, fully
            recursive paren-peel and are called on the RAW branch text below,
            NEVER on this function's output (a trailing chain after the
            paren, e.g. `(BACKUP_X as Row[]).slice(1)`, is exactly the shape
            unwrap() alone cannot handle -- see table_operand_end's
            docstring). unwrap()'s own output feeds only resolved_is_literal
            (is_literal()/is_narrowing_self_derivation) on the OTHER,
            non-table-resolved ternary branch, which never chain-walks and
            only needs ONE paren layer stripped."""
            t = text.strip()
            t = re.sub(r'\s+as\s+[\w$][\w$.\[\]<>, ]*$', '', t).strip()
            if t[:1] == '(' and close_of(t, 0) == len(t) - 1:
                t = t[1:-1].strip()
                t = re.sub(r'\s+as\s+[\w$][\w$.\[\]<>, ]*$', '', t).strip()
            return t
        # `||`/`??` operand: find every occurrence of a known table name right
        # after the operator, optionally wrapped in a balanced paren group
        # and/or `as Type`-asserted at any nesting depth (table_operand_end,
        # shared with the ternary site below), walk any trailing call chain
        # with chain_end, and resolve to the table ONLY when that chain lands
        # exactly on an operand boundary -- end of string, a closing
        # bracket/brace/paren/comma/semicolon, or another `||`/`??`/`&&`/`?`
        # (ternary/logical continuation). This is an ALLOWLIST of
        # terminators, not a blacklist of what must not follow.
        #
        # table_operand_end (not a `(\(*)` prefix regex) owns the paren
        # handling: it calls close_of to find exactly where a leading `(`
        # closes, so TERMINATOR is only ever asked to match at the position
        # right after that SAME paren's own closer (or right after the bare
        # name/chain, when there is no leading paren at all) -- never at some
        # earlier, unrelated `)` that happens to appear first in the source.
        # The old `(\(*)` capture consumed leading `(` characters but never
        # confirmed where they closed, so a bare `)` anywhere later (TERMINATOR's
        # own `)` alternative) could match the wrong closer: `(PERMS).length`
        # wrongly resolved as "PERMS, operand ends at the `)`", silently
        # ignoring the `.length` that follows it -- a false positive on
        # exactly the honest scalar-read shape ScalarLengthReadHonest already
        # covers unparenthesized. table_operand_end closes that gap by construction:
        # a trailing chain after the paren closer, if any, is walked by
        # chain_end from the true closer position, and if chain_end lands on
        # `.length`/`[0]` (a scalar/element read, not an array-returning
        # call), it returns unchanged and TERMINATOR then correctly refuses
        # to match at that non-boundary position -- the same two-guard
        # reasoning below, now applied consistently whether or not a paren
        # wraps the name.
        #
        # Two independent guards, each sufficient alone, still reject
        # `PERMS.length`/`PERMS?.length`/`PERMSET`: the inline name-boundary
        # lookahead `(?![\w$])` inside table_operand_end never lets `PERMS`
        # match as a prefix of the longer identifier `PERMSET` in the first
        # place; and even where the name DOES match cleanly (`PERMS.length`,
        # `PERMS?.length`), chain_end sees `.`/`?.` with no following `(`, so
        # it returns i UNCHANGED (not -1 -- there is no call to reject, only
        # nothing to consume), and TERMINATOR then refuses to match at that
        # position because the character right there is `.`/`?`, not a
        # boundary. `rows ?? BACKUP_X.filter((r) => r.ok)`,
        # `rows ?? BACKUP_Y.slice(0).reverse()`, and their parenthesized/cast
        # forms (`rows ?? (BACKUP_X as Table[]).filter(...)`) all resolve,
        # because chain_end's balanced-paren walk consumes the whole call
        # (arrow function body and all) and any chained second call in turn,
        # landing exactly on the closing `)`/`;` that TERMINATOR accepts.
        # [ \t]*, not \s*: \s* also matches a NEWLINE, so it would swallow a
        # missing-semicolon line break and let `$` match nothing right after
        # it (there is no re.M flag here) -- `const data = rows || BACKUP_Q`
        # on its own line, with more code below and no semicolon, would then
        # resolve as "ends the operand" when it does not. The explicit
        # `\r?\n(?!\s*(?:\??\.|\[))` alternative treats a newline as a
        # terminator ONLY when nothing that continues the chain follows it
        # (a bare newline ends the operand; `\n  .slice(0)` continues it, so
        # chain_end must get the chance to consume that line first). Defined
        # once, above table_operand_end -- see that regex's own docstring
        # comment there for why table_operand_end needs it too.
        # The prefilter's leading-paren group is `(?:\(\s*)*`, not a bare
        # `\(*`: it only has to land ON one of the parens wrapping the name
        # (table_operand_end does the real resolution from there), but a bare
        # `\(*` requires the name immediately after the last `(` with no
        # whitespace, so a Prettier-formatted multi-line cast --
        # `rows ?? (\n  BACKUP_ROWS\n).slice(1)` -- never matched this regex
        # at all and was invisible to this site regardless of what
        # table_operand_end could resolve. `\s*` after each `(` (matches a
        # newline too, unlike TERMINATOR's `[ \t]*` -- there is no operand
        # boundary concern here, only "find a position to start resolving
        # from") fixes that without changing what table_operand_end itself
        # accepts or rejects.
        for m in re.finditer(r'(?:\|\||\?\?)\s*((?:\(\s*)*)(' + name_alt + r')', s):
            start = m.start(1) if m.group(1) else m.start(2)
            res = table_operand_end(s, start)
            if not res:
                continue
            name, end = res
            if end < 0 or not TERMINATOR.match(s, end):
                continue
            flag_table_fallback(name, start)
        for m in re.finditer(r'(?<!\?)\?(?![.?:])', s):
            c = ternary_colon_of(s, m.start())
            if c < 0:
                continue
            q_raw = s[m.end():c]
            q_branch = unwrap(q_raw)
            colon_raw = s[c + 1:]
            colon_branch_strip = colon_raw.lstrip()
            colon_branch = unwrap(colon_branch_strip[:expr_end(colon_branch_strip)])
            cstart = c + 1 + (len(colon_raw) - len(colon_branch_strip))
            q_off = m.end() + (len(q_raw) - len(q_raw.lstrip()))
            # Resolve each branch back to a table name even with a trailing
            # array-returning call chain (`live ? live : BACKUP_ROWS2.slice(0)`,
            # `live ? live : BACKUP_X.filter((r) => r.ok)` -- reviewer 1's
            # bypass of the old `^NAME$`-only match, and the round-3 chain gap),
            # a leading balanced paren group and/or `as Type` at any nesting
            # depth (table_operand_end, shared with the ||/?? site above --
            # `live ? live : (BACKUP_X as Row[]).slice(1)` resolves the same
            # way `rows ?? (BACKUP_X as Row[]).slice(1)` does) -- but NOT a
            # scalar/element read (`live ? live : TABS[0]`, `live ? live :
            # TABS.length`, `live ? live : (TABS).length`), which
            # resolves_to_table_read rejects because table_operand_end cannot
            # reach the end of the (already extracted, whole) branch text.
            #
            # resolves_to_table_read is called on the RAW branch text
            # (q_branch_raw/colon_branch_raw, only trailing-whitespace
            # stripped by q_raw/colon_raw's own extraction), NEVER on
            # unwrap()'s output: unwrap() peels a paren layer only when it
            # closes at the very LAST character of the branch, so it cannot
            # by itself handle a trailing chain after the paren -- exactly
            # the shape table_operand_end's own recursive peel exists to
            # handle. Routing resolves_to_table_read's input through unwrap()
            # first would make the ternary site accept fewer paren shapes
            # than the ||/?? site (a cross-site divergence), since unwrap()
            # would sometimes leave the string still wrapped and
            # table_operand_end would then see a REDUNDANT but harmless outer
            # `(`; routing it around unwrap() entirely keeps both sites
            # calling table_operand_end on equivalent (paren-including) text.
            # unwrap()'s output (q_branch/colon_branch) is still used for
            # resolved_is_literal below, which never chain-walks and only
            # needs ONE paren layer stripped for its own is_literal()/
            # is_narrowing_self_derivation checks on the OTHER branch.
            # is_narrowing_self_derivation still decides, inside
            # resolved_is_literal, whether a SUFFIXED form on the OTHER
            # branch is exempt; here we only need to find which table the
            # flagged branch names. q_off/cstart still point at the RAW
            # (unstripped) offsets, since that is where the finding is
            # reported and where flag_table_fallback's span-dedupe operates.
            q_name = resolves_to_table_read(q_raw.strip())
            if q_name and not resolved_is_literal(colon_branch, q_name):
                flag_table_fallback(q_name, q_off)
            colon_name = resolves_to_table_read(colon_branch_strip[:expr_end(colon_branch_strip)].strip())
            if colon_name and not resolved_is_literal(q_branch, colon_name):
                flag_table_fallback(colon_name, cstart)
    for m in DEFAULT_ARR.finditer(s):
        opener_i = m.start()
        if s[opener_i] == '{' and is_block_open(s, opener_i):
            continue  # a code block's `{ name = [...] }`, not a destructuring default
        add_rows(m.end() - 1, 'literal sample rows as a default value for ' + m.group(1))
    for m in THIS_ARR.finditer(s):
        add_rows(m.end() - 1, 'literal sample rows assigned to this.' + m.group(1))
    for m in REASSIGN_ARR.finditer(s):
        name = m.group(1)
        if DECL_KEYWORD.search(s, 0, m.start(1)):
            continue  # a declaration site: DECL_ARR already owns `const/let/var x = [`
        if re.search(FLOWS_TO_STATE_TMPL.format(name=re.escape(name)), s):
            add_rows(m.end() - 1, 'literal sample rows reassigned to ' + name)
    for m in SETTER.finditer(s):
        i = m.end()
        if i < len(s) and s[i] == '<':
            depth = 0
            while i < len(s):
                depth += {'<': 1, '>': -1}.get(s[i], 0) if s[i - 1:i + 1] != '=>' else 0
                i += 1
                if depth == 0:
                    break
        i = len(s) - len(s[i:].lstrip())
        if i >= len(s) or s[i] != '(' or TIMER_LIKE.match(m.group(1)):
            continue
        j = close_of(s, i)
        if j < 0:
            continue
        for k in range(i + 1, j):
            if s[k] == '[':
                add_rows(k, f'literal sample rows in the {m.group(1)}() argument list')
    for m in ARRAY_OF.finditer(s):
        p = m.end() - 1
        j = close_of(s, p)
        if j < 0:
            continue
        if m.group(1) == 'of':
            add_rows_call(p, j, 'literal sample rows via Array.of()')
        else:
            arg0 = split_top(s[p + 1:j])
            if arg0 and arg0[0].startswith('['):
                add_rows(p + 1 + s[p + 1:j].index('['), 'literal sample rows via Array.from()')
    # --- Array.from({length:N}, generator) fabrication bypass (BACKLOG 125 B-8) -
    # the arm above only sees a literal FIRST argument, so a generator callback
    # that fabricates static string fields per row (`(_, i) => ({ id: i,
    # action: 'Deployed', user: 'Admin' })`) was invisible. Scoped narrowly:
    #   - arg0 must be exactly `{ length: N }` (a real iterable argument, e.g.
    #     `Array.from(items, ...)`, is untouched -- that is real iteration, not
    #     invented rows).
    #   - arg1 must be a concise-body arrow returning an object literal.
    #   - the arrow's own parameters (the index, conventionally `i`) are
    #     substituted with `0` before reusing is_literal, since an index is a
    #     counter, not invented data -- `(_, i) => ({ id: i })` stays GREEN.
    #   - at least one field must still be a literal STRING after that
    #     substitution: the fabrication signal this arm targets (an
    #     index/derived-only row has none and stays GREEN).
    # ponytail: does not see [...Array(n)].map, new Array(n).fill().map,
    # Array.from({length:n}).map((_, i) => ({...})) (the chained form), a
    # typed param list (`(_: unknown, i: number) =>`, since ARROW_HEAD has no
    # `:` in its class), `{ length }` shorthand (obj_pairs returns None with
    # no colon), block-bodied `=> { return {...} }` callbacks, function
    # callbacks, or a templated id (`` `row-${i}` ``, already rejected by
    # is_literal's backtick-`${` check). Upgrade only if review finds a real
    # instance.
    ARROW_HEAD = re.compile(r'^\(?\s*([\w$,\s]*)\s*\)?\s*=>\s*')
    # BACKLOG 145 (S-198): a nested generator's row can use an OUTER
    # generator's index (`(_, r) => Array.from({length:2}, (_, c) => ({ id: r,
    # user: 'Admin' }))`), so every enclosing {length} generator's params are
    # counters too. First pass records each generator's (open, close, params,
    # body); the second checks each body with its own AND every enclosing
    # generator's params substituted.
    gens = []
    for m in ARRAY_OF.finditer(s):
        if m.group(1) != 'from':
            continue
        p = m.end() - 1
        j = close_of(s, p)
        if j < 0:
            continue
        args = split_top(s[p + 1:j])
        if len(args) != 2:
            continue
        arg0, arg1 = args[0].strip(), args[1].strip()
        pairs0 = obj_pairs(arg0) if arg0.startswith('{') and close_of(arg0, 0) == len(arg0) - 1 else None
        if pairs0 is None or [k for k, _ in pairs0] != ['length']:
            continue
        head = ARROW_HEAD.match(arg1)
        if not head:
            continue
        gens.append((p, j, {pn.strip() for pn in head.group(1).split(',') if pn.strip()},
                     arg1[head.end():].strip()))
    for p, j, own, body in gens:
        if not (body.startswith('(') and close_of(body, 0) == len(body) - 1):
            continue
        inner = body[1:-1].strip()
        if not inner.startswith('{'):
            continue
        params = set(own)
        for gp, gj, gparams, _ in gens:
            if gp < p and j <= gj:
                params |= gparams
        subbed = inner
        for pname in params:
            subbed = re.sub(r'(?<![\w$])' + re.escape(pname) + r'(?![\w$])', '0', subbed)
        if not is_literal(subbed):
            continue
        gen_pairs = obj_pairs(inner)
        if not gen_pairs or not any(STR.fullmatch(v.strip()) for _, v in gen_pairs):
            continue
        idx = s.index(inner, p)
        end = idx + len(inner) - 1
        if any(a <= idx <= b for a, b in spans):
            continue
        spans.append((idx, end))
        out.append((line_of(s, idx), 'fabricated static fields via Array.from() generator callback'))
    fabricators = {}
    def literal_return_span(body_start):
        """body_start points at a factory's own body: '[' for a concise arrow
        (`=> [...]`) or '{' for a block body. Returns the (i, j) span of the
        literal-rows array (the concise-arrow expression itself, or the
        block's own top-level `return [...]`) when one exists, else None. A
        nested function/arrow's own return is excluded via NESTED_FN_HEAD so a
        real factory with an inner callback that merely happens to return
        literal rows (config passed to a nested consumer, never reaching THIS
        factory's own caller/consumer) is not wrongly credited. Shared by the
        HELPER_HEAD arm (a factory later CALLED as name(args)) and the
        DECL_USEMEMO arm (a useMemo factory whose RESULT, never itself called
        again, is bound directly to a local) -- same literal-body shape, two
        different ways the factory's result reaches a sink."""
        body_start += len(s[body_start:]) - len(s[body_start:].lstrip())
        if body_start >= len(s):
            return None
        if s[body_start] == '[':
            body_end = close_of(s, body_start)
            if body_end > 0 and literal_rows(s[body_start:body_end + 1]):
                return (body_start, body_end)
            return None
        if s[body_start] != '{':
            return None
        body_end = close_of(s, body_start)
        if body_end < 0:
            return None
        body = s[body_start:body_end + 1]
        nested = []
        for nm in NESTED_FN_HEAD.finditer(body):
            nb = close_of(body, nm.end() - 1)
            if nb > 0:
                nested.append((nm.end() - 1, nb))
        for rm in RETURN_ARR.finditer(body):
            if any(a <= rm.start() <= b for a, b in nested):
                continue  # a nested function/arrow's own return; not this factory's
            arr_end = close_of(body, rm.end() - 1)
            if arr_end > 0 and literal_rows(body[rm.end() - 1:arr_end + 1]):
                return (body_start + rm.end() - 1, body_start + arr_end)
        return None
    def check_body_for_literal_return(name, decl_at, body_start):
        """Marks `name` a fabricator in fabricators (keyed so first-declaration
        wins, matching add_rows' dedupe-by-span convention elsewhere in this
        function) when literal_return_span finds a literal-rows return."""
        if literal_return_span(body_start) is not None:
            fabricators.setdefault(name, decl_at)
    for m in DECL_USEMEMO.finditer(s):
        # Locate the useMemo factory's own head, the same way HELPER_HEAD
        # locates a bare `(...) =>` / bare-param arrow: a parenthesized
        # (possibly zero-param) arrow, or a bare single-param arrow with no
        # parens. A `function(...) {}` factory is not attempted: useMemo's
        # factory is conventionally an arrow, and literal_return_span's
        # concise/block handling is keyed off the body start regardless of
        # which head form supplied it, so adding a function-expression head
        # here would be strictly additive if a real instance ever needs it.
        name = m.group(1)
        factory_start = m.end()
        paren_head = re.match(r'\s*\(', s[factory_start:])
        if paren_head:
            params = factory_start + paren_head.end() - 1
            params_end = close_of(s, params)
            if params_end < 0:
                continue
            arrow = HELPER_ARROW_TAIL.match(s, params_end + 1)
            if not arrow:
                continue
            body_start = arrow.end()
        else:
            bp = BARE_PARAM.match(s, factory_start)
            if not bp:
                continue
            body_start = bp.end()
        span = literal_return_span(body_start)
        if span is None:
            continue
        # From here on, `name` is treated exactly like a DECL_ARR hit: same
        # MODULE_DECL column-0 exemption, same FLOWS_TO_STATE_TMPL flow check,
        # same add_rows call on the literal array's own span (never on the
        # useMemo(...) call span) -- a useMemo-fabricated local is the same
        # "local flowing to a sink" shape as `const rows = [...]`, not a new
        # sink-registration shape of its own.
        line_start = s.rfind('\n', 0, m.start()) + 1
        if MODULE_DECL.match(s, line_start):
            continue  # named module-level table, a negative control (matches DECL_ARR)
        if re.search(FLOWS_TO_STATE_TMPL.format(name=re.escape(name)), s):
            add_rows(span[0], 'literal sample rows returned by a useMemo factory assigned to ' + name)
    for m in HELPER_HEAD.finditer(s):
        name = m.group(1) or m.group(2) or m.group(3) or m.group(4) or m.group(5)
        if not name:
            continue
        if m.group(5):
            # Bare single-param arrow (`const name = param => {...}`): no `(`
            # for close_of to span, so find the arrow directly from here.
            bp = BARE_PARAM.match(s, m.end() - 1)
            if not bp:
                continue
            check_body_for_literal_return(name, m.start(), bp.end())
            continue
        if m.group(4):
            # useCallback/React.useCallback-wrapped: the match consumed up to
            # and including the wrapper's OWN opening `(`; the wrapped
            # function/arrow head starts right there. Re-run HELPER_ARROW_TAIL/
            # a `function` head detection on that inner head the same way a
            # bare `const name = (...) => {...}` head would be, by locating the
            # inner head's own parameter list (parens, for `(params) =>` and
            # `function(params)`) or bare single param.
            inner_start = m.end()
            inner_bare = BARE_PARAM.match(s, inner_start)
            if inner_bare:
                check_body_for_literal_return(name, m.start(), inner_bare.end())
                continue
            fn_head = re.match(r'\s*function\s*\(', s[inner_start:])
            paren_head = re.match(r'\s*\(', s[inner_start:])
            if fn_head:
                inner_params = inner_start + fn_head.end() - 1
            elif paren_head:
                inner_params = inner_start + paren_head.end() - 1
            else:
                continue
            inner_params_end = close_of(s, inner_params)
            if inner_params_end < 0:
                continue
            arrow = HELPER_ARROW_TAIL.match(s, inner_params_end + 1)
            if fn_head:
                ws = len(s[inner_params_end + 1:]) - len(s[inner_params_end + 1:].lstrip())
                check_body_for_literal_return(name, m.start(), inner_params_end + 1 + ws)
            elif arrow:
                check_body_for_literal_return(name, m.start(), arrow.end())
            continue
        params_end = close_of(s, m.end() - 1)
        if params_end < 0:
            continue
        head_tail = s[params_end + 1:]
        if m.group(3):
            arrow = HELPER_ARROW_TAIL.match(head_tail)
            if not arrow:
                continue
            body_start = params_end + 1 + arrow.end()
        else:
            # A `function`/function-expression head can carry a non-brace
            # TypeScript return type (`function getRows(d): Row[] {`); skip
            # past it so body_start lands on the real `{`, never on the type's
            # leading `:` (a brace-containing return type such as
            # `: { rows: Row[] }` would still misplace the opener onto the
            # type, a known false-negative-only ceiling documented above).
            ann = HELPER_RETURN_TYPE.match(head_tail)
            if ann:
                body_start = params_end + 1 + ann.end()
            else:
                ws = len(head_tail) - len(head_tail.lstrip())
                body_start = params_end + 1 + ws
        check_body_for_literal_return(name, m.start(), body_start)
    helper_fabs = list(fabricators.items())
    fabricators.clear()
    for m in METHOD_HEAD.finditer(s):
        if DEMO.search(m.group(1)) or GEN.search(m.group(1)):
            continue  # rule 5's name check already reports it at the call site
        params_end = close_of(s, m.end() - 1)
        if params_end < 0:
            continue
        head_tail = s[params_end + 1:]
        ann = HELPER_RETURN_TYPE.match(head_tail)
        body_start = params_end + 1 + (ann.end() if ann else len(head_tail) - len(head_tail.lstrip()))
        if s[body_start:body_start + 1] == '{':
            check_body_for_literal_return(m.group(1), m.start(), body_start)
    candidates = [(n, d, HELPER_CALL_PRE) for n, d in helper_fabs] \
        + [(n, d, METHOD_CALL_PRE) for n, d in fabricators.items()]
    for name, decl_at, pre in candidates:
        name_re = re.escape(name)
        hit = None
        for sm in HELPER_CALL_SINK_HEAD.finditer(s):
            i = sm.end() - 1
            j = close_of(s, i)
            if j < 0:
                continue
            span = s[i:j + 1]
            if re.search(HELPER_CALL_IN_SPAN_TMPL.format(pre=pre, name=name_re), span) \
                    or re.search(HELPER_BARE_REF_IN_SPAN_TMPL.format(pre=pre, name=name_re), span):
                hit = sm
                break
        if not hit:
            hit = re.search(r'\bthis\.\w+\s*=\s*(?:await\s+)?' + pre + name_re + r'\s*\(', s)
        if not hit:
            for lm in re.finditer(HELPER_LOCAL_DECL_TMPL.format(pre=pre, name=name_re), s):
                local = lm.group(1)
                if re.search(FLOWS_TO_STATE_TMPL.format(name=re.escape(local)), s):
                    hit = lm
                    break
        if not hit:
            call_re = HELPER_CALL_IN_SPAN_TMPL.format(pre=pre, name=name_re)
            for lm in LOCAL_INIT_DECL.finditer(s):
                local = lm.group(1)
                init = s[lm.end():local_init_end(s, lm.end())]
                if forwards_call(init, call_re) \
                        and re.search(FLOWS_TO_STATE_TMPL.format(name=re.escape(local)), s):
                    hit = lm
                    break
        if hit:
            out.append((line_of(s, decl_at), f"'{name}' returns fabricated literal rows reaching a data sink"))
    return sorted(set(out))
DEF = re.compile(r'^(?:export\s+(?:default\s+)?)?(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*[:=])', re.M)
TAG = re.compile(r'<([A-Z]\w*)[\s/>]')
findings = []
files = moatlib.walk(webapp_src, ('.tsx', '.ts'))
if not files:
    print('FATAL no web-app source files found'); sys.exit(2)
src = {f: moatlib.strip_comments(moatlib.read(f)) for f in files}
defs = {}
for f, s in src.items():
    for m in DEF.finditer(s):
        defs.setdefault(m.group(1) or m.group(2), f)
def lines_matching(s, rx):
    return [i + 1 for i, l in enumerate(s.split('\n')) if rx.search(l)]
pages = [f for f in files if os.sep + 'pages' + os.sep in f or f.endswith(os.sep + 'App.tsx')]
if not pages:
    print('FATAL no routed pages found under ' + webapp_src); sys.exit(2)
reach = {}
queue = list(pages)
for p in pages:
    reach[p] = [os.path.basename(p)]
while queue:
    f = queue.pop(0)
    for name in sorted(set(TAG.findall(src[f]))):
        g = defs.get(name)
        if g and g not in reach:
            reach[g] = reach[f] + [name]
            queue.append(g)
rel = lambda f: os.path.relpath(f, os.path.dirname(webapp_src.rstrip('/')))
for f in sorted(reach):
    for ln in lines_matching(src[f], FALLBACK):
        findings.append(f'{rel(f)}:{ln} sample-data fallback reachable via {" > ".join(reach[f])}')
    for ln in lines_matching(src[f], PROP):
        findings.append(f'{rel(f)}:{ln} JSX prop fed sample data, reachable via {" > ".join(reach[f])}')
    # Whole file, so a ternary split across lines is still one prop (BACKLOG 107).
    for ln in sorted({line_of(src[f], m.start()) for m in HARDPROP.finditer(src[f])}):
        findings.append(f'{rel(f)}:{ln} hardcoded number presented as a measured metric, reachable via {" > ".join(reach[f])}')
for f in files:
    for ln in lines_matching(src[f], METRIC):
        findings.append(f'{rel(f)}:{ln} Math.random() feeds a rendered metric')
    for ln in demo_lines(src[f]):
        findings.append(f'{rel(f)}:{ln} demo/sample data assigned or used as state')
    for ln, msg in whole_file_findings(src[f]):
        findings.append(f'{rel(f)}:{ln} {msg}')
for d in dash_dirs:
    # A file root (build-standalone.js) is named from the repo root like a dir root.
    base = d.rstrip('/') if os.path.isdir(d) else os.path.dirname(d)
    drel = lambda f: os.path.relpath(f, os.path.dirname(os.path.dirname(base)))
    for f in moatlib.walk(d, ('.js', '.html')):
        # The built bundle is never evidence about source.
        if f.endswith(os.sep + 'static' + os.sep + 'index.html') or (os.sep + 'assets' + os.sep) in f:
            continue
        s = moatlib.strip_comments(moatlib.read(f), html=f.endswith('.html'))
        for ln in lines_matching(s, FALLBACK):
            findings.append(f'{drel(f)}:{ln} sample-data fallback in a shipped web component')
        for ln in lines_matching(s, METRIC):
            findings.append(f'{drel(f)}:{ln} Math.random() feeds a rendered metric')
        for ln in demo_lines(s):
            findings.append(f'{drel(f)}:{ln} demo/sample data assigned in a shipped web component')
        for ln, msg in whole_file_findings(s):
            findings.append(f'{drel(f)}:{ln} {msg} in a shipped web component')
print(f'SCANNED pages={len(pages)} reachable={len(reach)} files={len(files)}')
for f in sorted(reach):
    print('REACH ' + rel(f))
for x in findings:
    print('FINDING ' + x)
sys.exit(1 if findings else 0)
PY

# Rules 6-9 control. The positives are the shipped fabrications VERBATIM (the
# Teams page and RBAC panel at 61af5915, the TEMPLATE_STATS table and fallback
# deleted in f63fae61, the zero-into-formatter lines from the learning and
# memory dashboards), each asserted at its exact line with an exact per-file
# finding count; the look-alikes must stay clean. Prints the reason and
# returns 1 on failure.
sample_rules_6_9_control() {
    local d="$1" out rc f want got
    mkdir -p "$d/src/pages" "$d/src/components" "$d/dash/components"
    printf '%s\n' 'export function P() { return <div />; }' > "$d/src/pages/P.tsx"
    # web-app/src/pages/TeamsPage.tsx:41-81 at 61af5915.
    cat > "$d/src/components/TeamsVerbatim.tsx" <<'TSX'
  // Load teams
  useEffect(() => {
    setLoading(true);
    api.getTeams()
      .then(data => {
        setTeams(data);
        if (data.length > 0 && !selectedTeam) {
          setSelectedTeam(data[0]);
        }
      })
      .catch(() => {
        // Use sample data when endpoint is not available
        const sample: TeamInfo[] = [
          {
            id: 'team-1',
            name: 'Engineering',
            created_at: new Date().toISOString(),
            members: [
              { id: 'm1', email: 'admin@example.com', name: 'Team Admin', role: 'admin' as const, joined_at: new Date().toISOString() },
              { id: 'm2', email: 'dev@example.com', name: 'Developer', role: 'editor' as const, joined_at: new Date().toISOString() },
              { id: 'm3', email: 'viewer@example.com', name: 'Viewer', role: 'viewer' as const, joined_at: new Date().toISOString() },
            ],
          },
        ];
        setTeams(sample);
        if (!selectedTeam) setSelectedTeam(sample[0]);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load activities
  useEffect(() => {
    if (!selectedTeam) return;
    setActivities([
      { id: 'a1', action: 'Created project "my-app"', user: 'Developer', timestamp: '2 hours ago' },
      { id: 'a2', action: 'Deployed to production', user: 'Team Admin', timestamp: '5 hours ago' },
      { id: 'a3', action: 'Invited viewer@example.com', user: 'Team Admin', timestamp: '1 day ago' },
      { id: 'a4', action: 'Updated RBAC settings', user: 'Team Admin', timestamp: '2 days ago' },
    ]);
  }, [selectedTeam]);
TSX
    # web-app/src/components/RBACPanel.tsx:302-317 at 61af5915.
    cat > "$d/src/components/RbacVerbatim.tsx" <<'TSX'
  // Load audit log
  useEffect(() => {
    if (activeSection !== 'audit') return;
    setAuditLoading(true);
    api.getAuditLog()
      .then(entries => setAuditEntries(entries))
      .catch(() => {
        // Use sample data when endpoint is not yet available
        setAuditEntries([
          { id: '1', action: 'member.invited', user: 'admin@example.com', target: 'dev@example.com', timestamp: new Date().toISOString(), details: 'Invited as editor' },
          { id: '2', action: 'role.created', user: 'admin@example.com', target: 'Deployer', timestamp: new Date(Date.now() - 3600000).toISOString() },
          { id: '3', action: 'project.created', user: 'editor@example.com', target: 'my-app', timestamp: new Date(Date.now() - 7200000).toISOString() },
        ]);
      })
      .finally(() => setAuditLoading(false));
  }, [activeSection, teamId]);
TSX
    # The TEMPLATE_STATS table and its fallback (TemplatesPage.tsx:77-98 and
    # :407 before f63fae61), then the same lookup with a constant fallback.
    cat > "$d/src/components/TemplateStats.tsx" <<'TSX'
const TEMPLATE_STATS: Record<string, { uses: number; rating: number }> = {
  'saas-starter.md': { uses: 2847, rating: 4.9 },
  'rest-api-auth.md': { uses: 1923, rating: 4.8 },
  'discord-bot.md': { uses: 1654, rating: 4.7 },
  'full-stack-demo.md': { uses: 1432, rating: 4.8 },
  'data-pipeline.md': { uses: 1198, rating: 4.6 },
  'cli-tool.md': { uses: 987, rating: 4.7 },
  'e-commerce.md': { uses: 2156, rating: 4.8 },
  'blog-platform.md': { uses: 1345, rating: 4.5 },
  'rest-api.md': { uses: 1567, rating: 4.6 },
  'slack-bot.md': { uses: 876, rating: 4.4 },
  'dashboard.md': { uses: 1789, rating: 4.7 },
  'web-scraper.md': { uses: 654, rating: 4.3 },
  'chrome-extension.md': { uses: 543, rating: 4.5 },
  'microservice.md': { uses: 1123, rating: 4.6 },
  'mobile-app.md': { uses: 932, rating: 4.4 },
  'game.md': { uses: 765, rating: 4.5 },
  'npm-library.md': { uses: 445, rating: 4.3 },
  'static-landing-page.md': { uses: 1876, rating: 4.6 },
  'simple-todo-app.md': { uses: 2345, rating: 4.7 },
  'ai-chatbot.md': { uses: 1234, rating: 4.8 },
};
            const stats = TEMPLATE_STATS[t.filename] || { uses: Math.floor(Math.random() * 800) + 100, rating: (Math.random() * 0.7 + 4.0).toFixed(1) };
            const stats = TEMPLATE_STATS[t.filename] || { uses: 500, rating: 4.5 };
TSX
    # Rule 9, one line each: web-app MetricsPanel.tsx:43 and the learning and
    # memory dashboards' token/confidence lines, plus a toFixed form.
    cat > "$d/src/components/ZeroFmt.tsx" <<'TSX'
export function Z({ metrics, e }) {
              {(metrics.tokens_used ?? 0).toLocaleString()}
                <span class="econ-value">${this._tokenEconomics.discoveryTokens?.toLocaleString() || 0}</span>
              ${this._formatPercent(this._metrics.avgConfidence || 0)}
  const d = (e.rate || 0).toFixed(1);
  return null; }
TSX
    # Rule 7: a binding NAMED sample/mock/demo/fake/placeholder holding literal data.
    cat > "$d/src/components/Named.tsx" <<'TSX'
export function N() {
  const sample = [{ id: 1, name: 'Engineering' }];
  const mockRows = { a: 1 };
  this._demoData = [];
  const PLACEHOLDER_USERS = [{ email: 'viewer@example.com' }];
  let fakeStats: Stats = { uses: 1 };
  return null; }
TSX
    # Honest look-alikes: a row reading a variable, an append, idle initial
    # state, an empty reset, a config fallback, a string placeholder, an error
    # path that renders no rows, a mapped response, a price table carrying a
    # label, a null-aware formatter, and a user message built from input.
    cat > "$d/src/components/HonestRows.tsx" <<'TSX'
export function H({ stars, x, opts, data }) {
  setStats([{ label: 'GitHub Stars', value: stars }]);
  setItems(prev => [...prev, x]);
  const [deploy] = useState({ vercel: { status: 'idle' }, netlify: { status: 'idle' } });
  setRows([]);
  const o = opts || { retries: 3, timeout: 30 };
  const placeholder = 'Search teams';
  try { load(); } catch { setRows([]); setError('Could not load teams'); }
  api.get().catch(() => { setError('failed'); setRows(data.map((r) => ({ id: r.id }))); });
  const RATES = { sonnet: { input: 3, output: 15, label: 'Sonnet' }, haiku: { input: 1, output: 5, label: 'Haiku' } };
  const t = x == null ? '--' : x.toLocaleString();
  const u = (x ?? null);
  setMessages(prev => [...prev, { role: 'user', content: x, at: new Date().toISOString() }]);
  return null; }
TSX
    # A shipped web component that fills its table with literal rows when the
    # read fails; flagged at the assignment (line 6).
    cat > "$d/dash/components/loki-audit-fallback.js" <<'JS'
export class LokiAuditFallback extends LokiElement {
  async _load() {
    try {
      this._entries = await this._api._get('/api/audit');
    } catch (err) {
      this._entries = [
        { user: 'admin@example.com', action: 'role.created', timestamp: new Date().toISOString() },
      ];
    }
  }
}
JS
    # Round-4 adversarial reviewer's three exact reproductions of the rule 6
    # gap (a fabrication in a ||/??, ternary or Array.of() fallback, none of
    # which is a setter's or useState's FIRST argument or inside a catch body):
    # the TeamsPage ternary, the cost-waterfall || fallback, and Array.of().
    cat > "$d/src/components/TernaryFallback.tsx" <<'TSX'
export function T({ entries, selectedTeam }) {
  useEffect(() => {
    setActivities(entries.length ? entries.filter(e => e.team_id === selectedTeam.id) : [{ id: 'a1', action: 'Deployed to production', user: 'Team Admin', timestamp: '2 hours ago' }, { id: 'a2', action: 'Invited viewer@example.com', user: 'Team Admin', timestamp: '1 day ago' }]);
  }, [entries, selectedTeam]);
  return null;
}
TSX
    cat > "$d/dash/components/loki-cost-waterfall-or.js" <<'JS'
export class LokiCostWaterfallOr extends LokiElement {
  async _loadData(data) {
    this._phases = data.phases || [{ name: 'build', cost_usd: 0.42, tokens: 18000 }, { name: 'test', cost_usd: 0.17, tokens: 7000 }];
  }
}
JS
    cat > "$d/src/components/ArrayOfFallback.tsx" <<'TSX'
export function A() {
  setActivities(Array.of({ id: 'a1', action: 'Deployed to production', user: 'Team Admin', timestamp: '2 hours ago' }));
  return null;
}
TSX
    # Extra positives for the rule 6 extension's other new shapes: a ternary
    # whose LITERAL branch is the `?` side (not just the `:` side above), a
    # local that flows into a plain setter, and the same flowing into a
    # generic useState<T>(name) form.
    cat > "$d/src/components/TernaryQBranch.tsx" <<'TSX'
export function TQ({ data }) {
  this._x = data.length ? [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }] : data;
  return null;
}
TSX
    cat > "$d/src/components/DeclFlowsToState.tsx" <<'TSX'
export function DF({ cond, data }) {
  const rows = cond ? data : [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
  setRows(rows);
  return null;
}
TSX
    cat > "$d/src/components/DeclGenericUseState.tsx" <<'TSX'
export function DG() {
  const items = [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
  const [x] = useState<Row[]>(items);
  return null;
}
TSX
    # Per-arm coverage positives: each of these is shaped so exactly one arm
    # can claim it (an earlier arm in scan order never reaches it), so
    # deleting that arm changes this control's result. Without these, THIS_ARR,
    # the setter-span "anywhere in the argument list" reach, and Array.from()
    # have no committed control at all, and a reviewer deleting any of them
    # would leave the suite green.
    cat > "$d/dash/components/ThisArrOnly.js" <<'JS'
export class ThisArrOnly extends LokiElement {
  _seed() {
    this._phases = [{ phase: 'build', cost_usd: 0.42, tokens: 18000 }];
  }
}
JS
    cat > "$d/src/components/SetterSpanOnly.tsx" <<'TSX'
export function SS({ prev }) {
  setActivities(prev.concat([{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }]));
  return null;
}
TSX
    cat > "$d/dash/components/ArrayFromOnly.js" <<'JS'
export class ArrayFromOnly extends LokiElement {
  _seed() {
    this._rows = Array.from([{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }]);
  }
}
JS
    cat > "$d/src/components/DeclPlainSetter.tsx" <<'TSX'
export function DP() {
  const rows = [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
  setRows(rows);
  return null;
}
TSX
    # The two FLOWS_TO_STATE_TMPL alternatives DeclPlainSetter and
    # DeclGenericUseState do not reach: a local reassigned to `this.y` instead
    # of passed to a setter, and the lazy useState(() => name) initializer form.
    cat > "$d/dash/components/ThisFlowOnly.js" <<'JS'
export class ThisFlowOnly extends LokiElement {
  _seed() {
    const rows = [{ phase: 'build', cost_usd: 0.42, tokens: 18000 }];
    this._phases = rows;
  }
}
JS
    cat > "$d/src/components/DeclLazyUseState.tsx" <<'TSX'
export function DL() {
  const items = [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
  const [x] = useState(() => items);
  return null;
}
TSX
    # BACKLOG 125 B-1: a bare reassignment AFTER declaration, not at `const/let/
    # var x = [`. DECL_ARR only ever matches the declaration site, so
    # `let rows = data;` followed by a later `rows = [...]` inside a guard was
    # invisible to every existing arm. The name flows to setRows() the same way
    # DECL_ARR's own fixtures prove flow, so REASSIGN_ARR reuses that same
    # FLOWS_TO_STATE_TMPL check rather than re-deriving "flows to a sink".
    cat > "$d/src/components/ReassignFallback.tsx" <<'TSX'
export function RF({ data }) {
  let rows = data;
  if (!rows.length) rows = [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
  setRows(rows);
  return null;
}
TSX
    # Negative control for the same shape: the reassignment builds an object
    # row from a real API response (a variable value, not a typed-in literal),
    # so REASSIGN_ARR's regex fires but literal_rows() must reject it because
    # `id: res.id` is not a literal value. Proves the arm gates on content, not
    # merely on the `name = [` shape.
    cat > "$d/src/components/ReassignHonest.tsx" <<'TSX'
export function RH({ data, res }) {
  let rows = data;
  if (!rows.length) rows = [{ id: res.id, action: res.action }];
  setRows(rows);
  return null;
}
TSX
    # BACKLOG 125 B-2 (S-28): a default value on a destructured binding or a
    # function parameter is neither DECL_ARR's declaration site nor a bare
    # reassignment, so it reached no arm at all -- exactly the board's own
    # example shapes, neither of which flows anywhere (no body at all). Its own
    # fixture and assertion block sit below, kept out of the shared want/count
    # lists other slices are editing concurrently in this same function.
    cat > "$d/src/components/DefaultValueFabricated.tsx" <<'TSX'
export function AT({ activities = [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }] }) {
  return <b>{activities.length}</b>;
}
export function load(rows = [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }]) {
  return rows.length;
}
TSX
    # Negative control: an empty-array default and a default built from a
    # variable (not a typed-in literal) must not fire -- proves the arm gates
    # on content via literal_rows(), not merely on the destructuring/parameter
    # `name = [` shape.
    cat > "$d/src/components/DefaultValueHonest.tsx" <<'TSX'
export function AH({ activities = [] }) {
  return <b>{activities.length}</b>;
}
export function loadH(rows = [{ id: res.id }]) {
  return rows.length;
}
TSX
    # Regression probe: a bare reassignment INSIDE a braced block
    # (`if (...) { rows = [...] }`) must keep REASSIGN_ARR's own "reassigned"
    # message, not this arm's "default value" one -- the one shape where a
    # destructuring pattern's `{` and a code block's `{` look identical up to
    # the name = [ text; is_block_open is what tells them apart.
    cat > "$d/src/components/BlockReassignProbe.tsx" <<'TSX'
export function BP({ data }) {
  let rows = data;
  if (!rows.length) { rows = [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }]; }
  setRows(rows);
  return null;
}
TSX
    # BACKLOG 125 B-5: a module-level named table used as a ||/ternary fallback
    # bypassed the ASSIGN_ARR module-level exemption as long as its name avoided
    # sample/mock/demo/fake/placeholder. FALLBACK_ROWS, DEFAULT_ROWS and
    # BACKUP_DATA are exactly such names; none matches rules 5/7's keyword list,
    # so this must be caught by structure (a module-level literal array of
    # object rows used as a fallback), not by name.
    cat > "$d/src/components/ModuleTableFallback.tsx" <<'TSX'
const FALLBACK_ROWS = [
  { id: 'a1', action: 'Deployed to production', user: 'Team Admin', timestamp: '2 hours ago' },
  { id: 'a2', action: 'Invited viewer@example.com', user: 'Team Admin', timestamp: '1 day ago' },
];

export function MF({ live }) {
  const data = live ? live : FALLBACK_ROWS;
  return <b>{data.length}</b>;
}
TSX
    cat > "$d/src/components/ModuleTableOrFallback.tsx" <<'TSX'
const BACKUP_DATA = [
  { id: 'a1', action: 'Deployed to production', user: 'Team Admin', timestamp: '2 hours ago' },
];

export function MO({ rows }) {
  const data = rows || BACKUP_DATA;
  return <b>{data.length}</b>;
}
TSX
    # BACKLOG 125 B-5 REWORK (S-29 2/2 CONCERN): reviewer 1's four live
    # bypasses of the first round's MODULE_TABLE_FALLBACK arm, each isolated
    # to exactly one gap so deleting any one fix flips exactly its own
    # fixture. Names avoid sample/mock/demo/fake/placeholder on purpose --
    # rules 5/7's keyword list must never be why these are caught.
    #   1. .concat() is additive, not a narrowing read: branch_derives_from's
    #      old bare prefix test wrongly treated it as "just resolves to the
    #      table" and skipped it entirely.
    cat > "$d/src/components/ConcatDerivedFallback.tsx" <<'TSX'
const RECENT = [
  { id: 'r1', name: 'Real Row' },
];

export function CC({ expanded }) {
  const data = expanded ? RECENT : RECENT.concat([{ id: 'f1', name: 'Invented Row' }]);
  return <b>{data.length}</b>;
}
TSX
    #   2. the old ||/?? regex's lookahead `(?!\s*[.\[(])` excluded ANY name
    #      followed by `.`, so a suffixed read never reached detection at all.
    cat > "$d/src/components/OrFallbackWithMethod.tsx" <<'TSX'
const BACKUP_ROWS = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function OM({ rows }) {
  const data = rows ?? BACKUP_ROWS.slice();
  return <b>{data.length}</b>;
}
TSX
    #   3. the ternary arm's old `^NAME$`-only match missed any suffix, so a
    #      defensive-copy `.slice(0)` on the fallback branch defeated it.
    cat > "$d/src/components/TernarySliceCopyFallback.tsx" <<'TSX'
const BACKUP_ROWS2 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function TS({ live }) {
  const data = live ? live : BACKUP_ROWS2.slice(0);
  return <b>{data.length}</b>;
}
TSX
    #   4. a spread element inside an array literal failed plain is_literal()
    #      (spread is never hand-typed data) and was silently skipped, even
    #      when the spread names a table that is itself fabricated rows.
    cat > "$d/src/components/SpreadOfTableFallback.tsx" <<'TSX'
const BACKUP_ROWS3 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function SO({ rows }) {
  const data = rows || [...BACKUP_ROWS3];
  return <b>{data.length}</b>;
}
TSX
    # Same gap (a spread of a fabricated table inside an array literal), but
    # at the TERNARY add_rows() call sites instead of the ||/?? one -- both
    # sites pass spread=True and must independently exercise it; without this
    # fixture, dropping spread=True from only the ternary calls would not be
    # caught by any RED here.
    cat > "$d/src/components/SpreadOfTableTernaryFallback.tsx" <<'TSX'
const BACKUP_ROWS3B = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function ST({ live }) {
  const data = live ? live : [...BACKUP_ROWS3B];
  return <b>{data.length}</b>;
}
TSX
    # Reviewer 2's null-ternary finding: this arm's OWN new resolved_is_literal
    # fell through to plain is_literal() for the null branch instead of
    # routing through is_exempting_sibling (S-30/BACKLOG 125 B-6's
    # null/undefined/''-excluding helper) -- a third live copy of S-30's exact
    # bug, at a new call site S-30 never touches.
    cat > "$d/src/components/NullTernaryTableFallback.tsx" <<'TSX'
const BACKUP_ROWS4 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function NU({ loading }) {
  const data = loading ? null : BACKUP_ROWS4;
  return <b>{data ? data.length : 0}</b>;
}
TSX
    # BACKLOG 125 B-5 REWORK ROUND 2: three more gaps, each in a fix that was
    # supposed to close a reviewer-1 bypass but left its own narrower version
    # of the same class open.
    #   1. NARROW_SUFFIX originally made .slice()'s end index OPTIONAL, so a
    #      one-argument `.slice(0)` (a full, unbounded defensive copy) wrongly
    #      counted as "bounded narrowing" and was exempted. Only a required
    #      two-argument slice may exempt; this one-argument form must still
    #      be caught as its own fallback operand.
    cat > "$d/src/components/UnboundedSliceFallback.tsx" <<'TSX'
const BACKUP_T = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function UT({ expanded }) {
  const data = expanded ? BACKUP_T : BACKUP_T.slice(0);
  return <b>{data.length}</b>;
}
TSX
    #   2. a `(`-wrapped or `as Type`-asserted fallback/ternary operand
    #      (`rows ?? (BACKUP_ROWS5)`) was not resolved to the table at all --
    #      the ||/?? regex required the name immediately after the operator,
    #      and the ternary branches were never unwrapped before matching.
    cat > "$d/src/components/ParenWrappedFallback.tsx" <<'TSX'
const BACKUP_ROWS5 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function PF({ rows }) {
  const data = rows ?? (BACKUP_ROWS5);
  return <b>{data.length}</b>;
}
TSX
    cat > "$d/src/components/ParenAsTernaryFallback.tsx" <<'TSX'
const BACKUP_ROWS6 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function PT({ live }) {
  const data = live ? live : (BACKUP_ROWS6 as Row[]);
  return <b>{data.length}</b>;
}
TSX
    #   3. a single-regex suffix match cannot express "balanced parens", so
    #      it under-matches an arrow-function call argument and a multi-call
    #      chain, leaving both unresolved. chain_end (a real walker, not a
    #      regex) fixes this.
    cat > "$d/src/components/ArrowFilterChainFallback.tsx" <<'TSX'
const BACKUP_X = [
  { id: 'b1', ok: true },
];

export function AF({ rows }) {
  const data = rows ?? BACKUP_X.filter((r) => r.ok);
  return <b>{data.length}</b>;
}
TSX
    cat > "$d/src/components/SliceReverseChainFallback.tsx" <<'TSX'
const BACKUP_Y = [
  { id: 'b1', ok: true },
];

export function SR({ rows }) {
  const data = rows ?? BACKUP_Y.slice(0).reverse();
  return <b>{data.length}</b>;
}
TSX
    cat > "$d/src/components/ArrowFilterChainTernaryFallback.tsx" <<'TSX'
const BACKUP_Z = [
  { id: 'b1', ok: true },
];

export function AT({ live }) {
  const data = live ? live : BACKUP_Z.filter((r) => r.ok);
  return <b>{data.length}</b>;
}
TSX
    #   4. TERMINATOR's original `\s*` also matches a newline, so a missing-
    #      semicolon fallback statement (ASI, valid JS) followed by more code
    #      on the next line falsely resolved as ending the operand right
    #      there. `[ \t]*` plus an explicit newline-terminator alternative
    #      (only when nothing that continues the chain follows the newline)
    #      fixes this without breaking a real multi-line `.slice(0)\n
    #      .reverse()` chain.
    cat > "$d/src/components/NewlineNoSemicolonFallback.tsx" <<'TSX'
const BACKUP_Q = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function NL({ rows }) {
  const data = rows || BACKUP_Q
  const other = 1
  return <b>{data.length}{other}</b>;
}
TSX
    # Negative control for the round-1 rework's own bug: the spread-of-table
    # resolution added to add_rows() was applied UNCONDITIONALLY (every call
    # site: useState/setter/catch/decl, not only the fallback/ternary sites),
    # so a spread of an HONEST named table (DEFAULT_PROVIDERS -- the same
    # shape as DefaultProvidersHonest.tsx above, just spread instead of
    # passed bare) was wrongly flagged. Fixed by gating the spread-resolution
    # on a `spread=True` flag passed only at FALLBACK_ARR and the two inline
    # ternary add_rows() call sites.
    cat > "$d/src/components/DefaultProvidersSpreadHonest.tsx" <<'TSX'
const DEFAULT_PROVIDERS2 = [
  { id: 'claude', name: 'Claude', secretKey: 'ANTHROPIC_API_KEY', model: 'claude-opus-4-7', fallbackOrder: 1, enabled: true },
];

export function SP() {
  const [providers] = useState([...DEFAULT_PROVIDERS2]);
  return providers;
}
TSX
    # Negative controls for resolves_to_table_read's DETECTION rule: a
    # scalar/element read off a column-0 table must NOT read as "table used
    # as a fallback" -- only a read that carries the table's actual row data
    # forward (a bare reference or a chain of array-returning calls) may.
    # `.length` is a number, `[0]`/`[0].id` is one row (or one field of it),
    # `.find(...)` is one row or undefined; none of these is "the fabricated
    # array", so all four must stay clean even though each names a table
    # whose OWN rows are fabricated.
    cat > "$d/src/components/ScalarLengthReadHonest.tsx" <<'TSX'
const PERMS = [
  { id: 'project.create', label: 'Create Projects', description: 'Create new projects' },
  { id: 'project.edit', label: 'Edit Projects', description: 'Modify project files and settings' },
];

export function PL({ count }) {
  const n = count || PERMS.length;
  return <b>{n}</b>;
}
TSX
    cat > "$d/src/components/ElementIndexReadHonest.tsx" <<'TSX'
const TABS2 = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

export function EI({ sel }) {
  const id = sel || TABS2[0].id;
  return <b>{id}</b>;
}
TSX
    # A BARE index read (no further .field access) is the same one-row read
    # as TABS2[0].id above and must stay just as clean: `[<int>]` is
    # deliberately excluded from resolves_to_table_read's DETECTION allowlist
    # entirely (it is a bounded-narrowing exemption ONLY, inside
    # is_narrowing_self_derivation, never a "carries the table's data" read).
    cat > "$d/src/components/BareIndexPickHonest.tsx" <<'TSX'
const TABS3 = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

export function IP({ sel }) {
  const active = sel || TABS3[0];
  return <b>{active.id}</b>;
}
TSX
    cat > "$d/src/components/FindReadHonest.tsx" <<'TSX'
const OPTS = [
  { id: 'a', on: true },
  { id: 'b', on: false },
];

export function FR({ pick }) {
  const d = pick ? pick : OPTS.find(o => o.on);
  return <b>{d}</b>;
}
TSX
    # Negative controls for the ||/?? match site: a DIFFERENT, longer
    # identifier that happens to start with a table's name must never be
    # mistaken for that table, and an optional-chained scalar read
    # (`?.length`) must stay just as clean as the plain `.length` read above
    # (`?.` is not a valid terminator; a bare `?` alone is, as the ternary
    # operator). PERMSET must share PERMS's exact name for this fixture to
    # test anything at all -- an unrelated table name here would pass
    # regardless of whether the boundary check exists, since a name match
    # never starts. Both the inline name-boundary lookahead (rejects PERMSET
    # from ever matching as PERMS) and the TERMINATOR check (rejects `.`/`?.`
    # right after a genuine match) independently refuse this fixture;
    # removing either ALONE leaves the other still catching it, only
    # removing BOTH flips this to a false positive.
    cat > "$d/src/components/DifferentIdentifierPrefixHonest.tsx" <<'TSX'
const PERMS = [
  { id: 'p1', label: 'A' },
];

export function DP({ x, PERMSET }) {
  const data = x || PERMSET;
  return <b>{data}</b>;
}
TSX
    cat > "$d/src/components/OptionalChainLengthHonest.tsx" <<'TSX'
const PERMS3 = [
  { id: 'p1', label: 'A' },
];

export function OC({ x }) {
  const data = x || PERMS3?.length;
  return <b>{data}</b>;
}
TSX
    # Rule 6, function-return extension (BACKLOG 125 B-7): the literal never
    # sits at the call site, only inside a same-file helper's own return, so
    # every arm above misses it. The reported bypass verbatim, at column 0
    # exactly as filed (no column-0 module-scope exemption exists for this
    # arm; see the ponytail comment above whole_file_findings()).
    cat > "$d/src/components/HelperReturnTaskVerbatim.tsx" <<'TSX'
function getRows(d) {
  if (!d) return [{id: 1, name: 'Sample User', action: 'Deployed'}];
  return d;
}
setRows(getRows(d));
TSX
    # Four more fixtures, one per HELPER_HEAD branch and sink form: the same
    # `function` declaration fed straight to a setter but inside a component
    # (not column 0), an arrow with a block body fed to useState, a function
    # expression fed to `this.x =` in a shipped web component, and the
    # two-hop form (`const rows = getRows(d); setRows(rows)`).
    cat > "$d/src/components/HelperReturnFnDecl.tsx" <<'TSX'
export function HF({ d }) {
  function getRows(d) {
    if (!d) return [{ id: 1, name: 'Sample User', action: 'Deployed' }];
    return d;
  }
  setRows(getRows(d));
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnArrow.tsx" <<'TSX'
export function HA({ d }) {
  const getRows = (d) => {
    if (!d) return [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  };
  const [rows] = useState(getRows(d));
  return null;
}
TSX
    cat > "$d/dash/components/HelperReturnThisSink.js" <<'JS'
export class HelperReturnThisSink extends LokiElement {
  _seed(data) {
    const getPhases = function (d) {
      if (!d) return [{ phase: 'build', cost_usd: 0.42, tokens: 18000 }];
      return d;
    };
    this._phases = getPhases(data);
  }
}
JS
    # A `function` declaration head carrying a non-brace TypeScript return
    # type (`function getRows(d): Row[] {`): without HELPER_RETURN_TYPE this
    # is a one-token bypass of the whole arm, since body_start would land on
    # the annotation's leading `:` and never find the real `{`.
    cat > "$d/src/components/HelperReturnTyped.tsx" <<'TSX'
export function HTY({ d }) {
  function getRows(d: Row[] | null): Row[] {
    if (!d) return [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  setRows(getRows(d));
  return null;
}
TSX
    # Per-alternative coverage for the sink-span search: an `await`ed call fed
    # to a setter (a plain call already covers the non-await setter form
    # above), an `await`ed call assigned to `this.x` (HelperReturnThisSink
    # above is a plain, non-await call and does not reach this alternative),
    # and a lazy bare-reference passed to useState (never called at the sink,
    # so no other fixture's call-site text can satisfy it).
    cat > "$d/src/components/HelperReturnAwaitSetter.tsx" <<'TSX'
export function HW() {
  async function getRows() {
    return [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
  }
  async function run() {
    setRows(await getRows());
  }
  run();
  return null;
}
TSX
    # BACKLOG 144 (S-180): a neutrally-named class-method helper, the card's
    # red shape verbatim, caught by METHOD_HEAD only. The honest twin returns
    # literal rows from a method that only feeds markup, and calls a
    # same-named method on ANOTHER object (`obj._cols()`) at a setter: neither
    # is `this.name(` reaching a sink.
    cat > "$d/dash/components/HelperReturnClassMethod.js" <<'JS'
export class HelperReturnClassMethod extends LokiElement {
  _getRows() { return [{id:1,user:'Admin'}]; }
  _load() {
    this._rows = this._getRows();
  }
}
JS
    cat > "$d/dash/components/HelperReturnClassMethodHonest.js" <<'JS'
export class HelperReturnClassMethodHonest extends LokiElement {
  _cols() {
    if (this._wide) { return [{ key: 'id', label: 'ID' }]; }
    return [{ key: 'name', label: 'Name' }];
  }
  render(obj) {
    setCols(obj._cols());
    return this._cols().map((c) => c.label).join('');
  }
}
JS
    cat > "$d/dash/components/HelperReturnAwaitThisSink.js" <<'JS'
export class HelperReturnAwaitThisSink extends LokiElement {
  async _seed() {
    async function getPhases() {
      return [{ phase: 'build', cost_usd: 0.42, tokens: 18000 }];
    }
    this._phases = await getPhases();
  }
}
JS
    cat > "$d/src/components/HelperReturnLazyRef.tsx" <<'TSX'
export function HLR() {
  function getRows() {
    return [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
  }
  const [rows] = useState(getRows);
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnTwoHop.tsx" <<'TSX'
export function HT({ d }) {
  function getRows(d) {
    if (!d) return [{ id: 1, name: 'Sample User', action: 'Deployed' }];
    return d;
  }
  const rows = getRows(d);
  setRows(rows);
  return null;
}
TSX
    # A concise arrow (`=> [...]`, no block body) hits the OTHER HELPER_HEAD
    # branch than the three fixtures above (body_start is '[' directly, never
    # '{'); without this fixture that branch has no committed control at all.
    cat > "$d/src/components/HelperReturnConcise.tsx" <<'TSX'
export function HC() {
  const getRows = () => [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
  setRows(getRows());
  return null;
}
TSX
    # CONCERN fix, sink side (3): a spread element inside a sink array
    # argument, a nested call wrapping the fabricating call, and a trailing
    # method call chained after the sink call. None of these fixtures'
    # fabricating helper is itself named sample/mock/demo/fake, so only the
    # new sink-span search (not rules 5/7's name check) can catch them.
    cat > "$d/src/components/HelperReturnSinkSpread.tsx" <<'TSX'
export function HSP({ records }) {
  function buildRowsX(r) {
    if (!r) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return r;
  }
  setRowsX([...buildRowsX(records)]);
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnSinkNestedCall.tsx" <<'TSX'
export function HSN({ records }) {
  function buildRowsX(r) {
    if (!r) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return r;
  }
  function normalizeX(r) {
    return r;
  }
  setRowsX(normalizeX(buildRowsX(records)));
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnSinkTrailingCall.tsx" <<'TSX'
export function HST({ records }) {
  function buildRowsX(r) {
    if (!r) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return r;
  }
  setRowsX(buildRowsX(records).slice());
  return null;
}
TSX
    # CONCERN fix, head side (3): a bare single-param arrow with no parens, a
    # `let` declaration (not `const`), and a `useCallback`-wrapped arrow (the
    # highest-value gap: a mainstream React idiom, and both dashboard-ui and
    # web-app use hooks extensively).
    cat > "$d/src/components/HelperReturnBareParamArrow.tsx" <<'TSX'
export function HBP({ records }) {
  const buildRowsY = records => {
    if (!records) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return records;
  };
  setRowsY(buildRowsY(records));
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnLetVar.tsx" <<'TSX'
export function HLV({ records }) {
  let buildRowsZ = (r) => {
    if (!r) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return r;
  };
  setRowsZ(buildRowsZ(records));
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnUseCallback.tsx" <<'TSX'
export function HUC({ records }) {
  const buildRowsW = useCallback((r) => {
    if (!r) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return r;
  }, []);
  setRowsW(buildRowsW(records));
  return null;
}
TSX
    # useCallback per-alternative coverage: a bare single-param arrow inside
    # useCallback (both new head branches at once), and the React.useCallback
    # qualified form.
    cat > "$d/src/components/HelperReturnUseCallbackBareParam.tsx" <<'TSX'
export function HUB({ records }) {
  const buildRowsV = useCallback(records => {
    if (!records) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return records;
  }, []);
  setRowsV(buildRowsV(records));
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnReactUseCallback.tsx" <<'TSX'
export function HRU({ records }) {
  const buildRowsU = React.useCallback((r) => {
    if (!r) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return r;
  }, []);
  setRowsU(buildRowsU(records));
  return null;
}
TSX
    # DECL_USEMEMO arm (BACKLOG 125 B-7 rework): a mainstream React idiom no
    # rule above can see, since `rows` here is a VALUE bound once at the
    # useMemo call, never itself called later as `rows(args)` the way every
    # HELPER_HEAD fixture above requires. Concise-arrow-body form.
    cat > "$d/src/components/UseMemoConciseFabricated.tsx" <<'TSX'
export function UMC({ deps }) {
  const rows = useMemo(() => [{ id: 1, name: 'Sample User', action: 'Deployed' }], [deps]);
  setRows(rows);
  return null;
}
TSX
    # Block-body form (`useMemo(() => { ... return [...]; }, deps)`), reusing
    # the same literal_return_span block-body path HELPER_HEAD's block-body
    # heads already use (RETURN_ARR + NESTED_FN_HEAD exclusion).
    cat > "$d/src/components/UseMemoBlockFabricated.tsx" <<'TSX'
export function UMB({ d, deps }) {
  const rows = useMemo(() => {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }, [deps]);
  setRows(rows);
  return null;
}
TSX
    # Honest look-alike: a useMemo computing a REAL derived value (a .filter()
    # call, not a literal-returning factory) must stay green -- confirms this
    # arm keys on literal_return_span, not merely on the presence of useMemo.
    cat > "$d/src/components/UseMemoDerivedHonest.tsx" <<'TSX'
export function UMD({ data, deps }) {
  const rows = useMemo(() => data.filter((x) => x.active), [deps]);
  setRows(rows);
  return null;
}
TSX
    # E-128 (BACKLOG 147): a useMemo factory that CALLS an already-registered
    # fabricator instead of returning a literal itself. DECL_USEMEMO cannot see
    # it (no literal in the factory body) and the memo-bound name is a value,
    # never called, so HELPER_HEAD's call-site machinery cannot either.
    cat > "$d/src/components/UseMemoCallsFabricator.tsx" <<'TSX'
export function UMF({ d, deps }) {
  function getRows(d) {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  const rows = useMemo(() => getRows(d), [deps]);
  setRows(rows);
  return null;
}
TSX
    cat > "$d/src/components/UseMemoBlockCallsFabricator.tsx" <<'TSX'
export function UMBF({ d, deps }) {
  const getRows = (d) => {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  };
  const rows = React.useMemo(() => {
    return getRows(d);
  }, [deps]);
  setRows(rows);
  return null;
}
TSX
    # Honest look-alikes: a useMemo calling a helper that returns REAL data; and
    # a useMemo calling a fabricating helper whose memoized value only renders
    # (never reaches a sink), so the sink gate stays load-bearing.
    cat > "$d/src/components/UseMemoCallsHonestHelper.tsx" <<'TSX'
export function UMH({ d, deps }) {
  function loadRows(d) {
    if (!d) return [];
    return d.rows;
  }
  const rows = useMemo(() => loadRows(d), [deps]);
  setRows(rows);
  return null;
}
TSX
    cat > "$d/src/components/UseMemoCallsFabricatorRenderOnly.tsx" <<'TSX'
export function UMR({ d, deps }) {
  function getRows(d) {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  const rows = useMemo(() => getRows(d), [deps]);
  return rows.map((r) => r.id);
}
TSX
    # E-131 (BACKLOG 146): a computed / bracket-indexed sink, which the literal
    # set[A-Z]/useState sink regex never matched.
    cat > "$d/src/components/BracketSinkFabricated.tsx" <<'TSX'
export function BSF({ sinkName }) {
  window[sinkName]([{ id: 1, name: 'Sample User', action: 'Deployed' }]);
  return null;
}
TSX
    cat > "$d/src/components/BracketSinkLocalFabricated.tsx" <<'TSX'
export function BSL({ sinkName }) {
  const rows = [{ id: 1, name: 'Sample User', action: 'Deployed' }];
  this[sinkName](rows);
  return null;
}
TSX
    cat > "$d/src/components/BracketSinkHelperFabricated.tsx" <<'TSX'
export function BSH({ sinkName, d }) {
  function getRows(d) {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  globalThis[sinkName](getRows(d));
  return null;
}
TSX
    # Honest look-alikes: a computed sink fed real data, an empty array, and a
    # bare (non-call) bracket read next to a literal.
    cat > "$d/src/components/BracketSinkHonest.tsx" <<'TSX'
export function BSN({ sinkName, data }) {
  window[sinkName](data.rows);
  window[sinkName]([]);
  const rows = data.items;
  this[sinkName](rows);
  const first = window[sinkName] ? 1 : 0;
  return first;
}
TSX
    # PO-P7-SINKS-1 (E-138): optional-call sinks and one-hop aliases. The three
    # sink heads (SETTER, FLOWS_TO_STATE_TMPL, HELPER_CALL_SINK_HEAD) required a
    # bare `(` after the sink name, so `setRows?.([...])` and
    # `window[k]?.(rows)` reached no arm, and a one-hop rename of a sink
    # (`const push = setRows; push([...])`) was invisible. Each form has a red
    # fixture (must be flagged exactly once) and a green look-alike (must stay
    # clean).
    cat > "$d/src/components/OptCallSinkFabricated.tsx" <<'TSX'
export function OCF({ setRows }) {
  setRows?.([{ id: 1, name: 'Sample User', action: 'Deployed' }]);
  return null;
}
TSX
    cat > "$d/src/components/OptCallSinkHelperFabricated.tsx" <<'TSX'
export function OCH({ d, setRows }) {
  function getRows(d) {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  setRows?.(getRows(d));
  return null;
}
TSX
    cat > "$d/src/components/OptCallSinkLocalFabricated.tsx" <<'TSX'
export function OCL({ setRows }) {
  const rows = [{ id: 1, name: 'Sample User', action: 'Deployed' }];
  setRows?.(rows);
  return null;
}
TSX
    cat > "$d/src/components/OptCallSinkHonest.tsx" <<'TSX'
export function OCN({ data, setRows, onPick }) {
  setRows?.(data.rows);
  setRows?.([]);
  const rows = data.items;
  setRows?.(rows);
  const first = data.rows?.[0];
  onPick?.([{ id: 1, name: 'Sample User' }]);
  return first;
}
TSX
    cat > "$d/src/components/BracketOptSinkFabricated.tsx" <<'TSX'
export function BOF({ sinkName }) {
  window[sinkName]?.([{ id: 1, name: 'Sample User', action: 'Deployed' }]);
  return null;
}
TSX
    cat > "$d/src/components/BracketOptSinkLocalFabricated.tsx" <<'TSX'
export function BOL({ sinkName }) {
  const rows = [{ id: 1, name: 'Sample User', action: 'Deployed' }];
  globalThis?.[sinkName]?.(rows);
  return null;
}
TSX
    cat > "$d/src/components/BracketOptSinkHonest.tsx" <<'TSX'
export function BON({ sinkName, data }) {
  window[sinkName]?.(data.rows);
  window[sinkName]?.([]);
  const rows = data.items;
  this[sinkName]?.(rows);
  const first = window[sinkName]?.name;
  const handlers = { a: 1 };
  handlers[sinkName]?.([{ id: 1, name: 'Sample User' }]);
  return first;
}
TSX
    cat > "$d/src/components/AliasSinkFabricated.tsx" <<'TSX'
export function ASF() {
  const push = setRows;
  push([{ id: 1, name: 'Sample User', action: 'Deployed' }]);
  return null;
}
TSX
    cat > "$d/src/components/AliasSinkOptCallFabricated.tsx" <<'TSX'
export function ASO({ setRows }) {
  const push = setRows;
  push?.([{ id: 1, name: 'Sample User', action: 'Deployed' }]);
  return null;
}
TSX
    cat > "$d/src/components/AliasSinkLocalFabricated.tsx" <<'TSX'
export function ASL() {
  const rows = [{ id: 1, name: 'Sample User', action: 'Deployed' }];
  const push = setRows;
  push(rows);
  return null;
}
TSX
    cat > "$d/src/components/AliasBracketSinkFabricated.tsx" <<'TSX'
export function ABF({ sinkName }) {
  const emit = window[sinkName];
  emit([{ id: 1, name: 'Sample User', action: 'Deployed' }]);
  return null;
}
TSX
    cat > "$d/src/components/AliasSinkHelperFabricated.tsx" <<'TSX'
export function ASH({ d }) {
  function getRows(d) {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  const push = setRows;
  push(getRows(d));
  return null;
}
TSX
    cat > "$d/src/components/AliasSinkHonest.tsx" <<'TSX'
export function ASN({ data, sinkName }) {
  const push = setRows;
  push(data.rows);
  push([]);
  const emit = window[sinkName];
  emit(data.items);
  const later = setTimeout;
  later(() => [{ id: 1, name: 'tick' }], 5);
  const fmt = formatRows;
  fmt([{ id: 1, name: 'Sample User' }]);
  return null;
}
TSX
    cat > "$d/src/components/MemoForwardNestedFabricated.tsx" <<'TSX'
export function MFN({ d, deps }) {
  function getRows(d) {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  const rows = useMemo(() => normalize(getRows(d)), [deps]);
  setRows(rows);
  return null;
}
TSX
    cat > "$d/src/components/MemoForwardChainFabricated.tsx" <<'TSX'
export function MFC({ d, deps }) {
  const getRows = (d) => {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  };
  const rows = React.useMemo(() => {
    const all = getRows(d).slice();
    return all;
  }, [deps]);
  setRows?.(rows);
  return null;
}
TSX
    cat > "$d/src/components/LocalForwardSpreadFabricated.tsx" <<'TSX'
export function LFS({ d }) {
  function getRows(d) {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  const rows = [...getRows(d)];
  setRows(rows);
  return null;
}
TSX
    cat > "$d/src/components/MemoForwardHonest.tsx" <<'TSX'
export function MFH({ d, deps }) {
  function getRows(d) {
    if (!d) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return d;
  }
  function loadRows(d) {
    if (!d) return [];
    return d.rows;
  }
  const real = useMemo(() => normalize(loadRows(d)), [deps]);
  setRows(real);
  const copy = [...loadRows(d)];
  setRows(copy);
  const count = useMemo(() => getRows(d).length, [deps]);
  const label = count > 1 ? 'many' : 'few';
  const shown = useMemo(() => normalize(getRows(d)), [deps]);
  return shown.map((r) => <i key={r.id}>{label}</i>);
}
TSX
    # Honest look-alikes for the same arm: an empty-array fallback (a genuine
    # "nothing yet" default), a real config/enum object return, a helper whose
    # fabricated return never reaches a sink (render-only .map() - this is
    # what makes the sink gate load-bearing rather than flagging every helper
    # that merely contains a literal-rows return), and a helper whose OWN
    # return is real data while a NESTED callback inside its body returns a
    # literal that never reaches the outer helper's caller (round-review
    # adversarial fixture for the arm's own known ceiling: RETURN_ARR must be
    # scoped to the helper's own top-level returns, not to the whole body
    # text, or this one goes red).
    cat > "$d/src/components/HelperReturnEmptyHonest.tsx" <<'TSX'
export function HE({ d }) {
  function getRows(d) {
    if (!d) return [];
    return d;
  }
  setRows(getRows(d));
  const getConfig = () => {
    return { retries: 3, timeout: 30 };
  };
  setConfig(getConfig());
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnRenderOnlyHonest.tsx" <<'TSX'
export function HR({ d }) {
  function getRows(d) {
    if (!d) return [{ id: 1, name: 'Sample User', action: 'Deployed' }];
    return d;
  }
  return getRows(d).map((r) => r.id);
}
TSX
    cat > "$d/src/components/HelperReturnNestedCallbackHonest.tsx" <<'TSX'
export function HNC({ api }) {
  function loadRows(d) {
    const cols = () => {
      return [{ key: 'id', label: 'ID' }];
    };
    void cols;
    return d.rows;
  }
  setRows(loadRows(api));
  return null;
}
TSX
    # CONCERN-fix honest look-alikes: a spread of REAL (non-literal) data, a
    # nested call whose OUTER helper returns real data (the nested call inside
    # the sink span belongs to an honest transform, not a fabricator), a
    # trailing method call on a real-data helper's result, a useCallback
    # helper returning REAL mapped data (not literal rows), and an
    # `obj.buildRowsY(` method-call collision that must not credit a same-named
    # plain function to an unrelated method call.
    cat > "$d/src/components/HelperReturnSinkSpreadHonest.tsx" <<'TSX'
export function HSPH({ records }) {
  function passThroughX(r) {
    return r;
  }
  setRowsX([...passThroughX(records)]);
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnSinkNestedCallHonest.tsx" <<'TSX'
export function HSNH({ records }) {
  function passThroughX(r) {
    return r;
  }
  function normalizeX(r) {
    return r;
  }
  setRowsX(normalizeX(passThroughX(records)));
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnSinkTrailingCallHonest.tsx" <<'TSX'
export function HSTH({ records }) {
  function passThroughX(r) {
    return r;
  }
  setRowsX(passThroughX(records).slice());
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnUseCallbackHonest.tsx" <<'TSX'
export function HUCH({ records }) {
  const mapRowsW = useCallback((r) => r.map((row) => ({ id: row.id })), []);
  setRowsW(mapRowsW(records));
  return null;
}
TSX
    cat > "$d/src/components/HelperReturnMethodCollisionHonest.tsx" <<'TSX'
export function HMC({ obj, records }) {
  function buildRowsY(r) {
    if (!r) return [{ id: 1, action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    return r;
  }
  void buildRowsY;
  setRowsY(obj.buildRowsY(records));
  return null;
}
TSX
    # Negative controls for the rule 6 extension: a ternary between two
    # literals (advisorOpts, real shape at loki-session-control.js:471), a
    # render-local literal list mapped straight into markup with no setter, a
    # named module-level table that seeds useState (DEFAULT_PROVIDERS, real
    # shape at SystemSettingsPage.tsx:69), the module-level config tables
    # named in the moat task (DEFAULT_PERMISSIONS, COLUMNS, GALLERY, verbatim
    # shapes from RBACPanel.tsx, Footer.tsx and ShowcasePage.tsx), and a
    # timer callback (never a React/state setter).
    cat > "$d/src/components/AdvisorOptsHonest.tsx" <<'TSX'
export function H({ provider }) {
  const advisorOpts = provider === 'claude' ? [
    { value: '', label: 'Account default' },
    { value: 'opus', label: 'Opus (stronger judge)' },
  ] : [];
  return null;
}
TSX
    cat > "$d/src/components/RenderLocalTabsHonest.tsx" <<'TSX'
export function R() {
  const tabs = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  return tabs.map((t) => t.id);
}
TSX
    cat > "$d/src/components/DefaultProvidersHonest.tsx" <<'TSX'
const DEFAULT_PROVIDERS = [
  { id: 'claude', name: 'Claude', secretKey: 'ANTHROPIC_API_KEY', model: 'claude-opus-4-7', fallbackOrder: 1, enabled: true },
];

export function S() {
  const [providers, setProviders] = useState(DEFAULT_PROVIDERS);
  return providers;
}
TSX
    cat > "$d/src/components/ModuleTablesHonest.tsx" <<'TSX'
const DEFAULT_PERMISSIONS = [
  { id: 'project.create', label: 'Create Projects', description: 'Create new projects' },
  { id: 'project.edit', label: 'Edit Projects', description: 'Modify project files and settings' },
];

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Features', to: '/' },
      { label: 'Templates', to: '/templates' },
    ],
  },
];

const GALLERY = [
  {
    title: 'SaaS Dashboard',
    description: 'Admin dashboard with user analytics, charts, and real-time data visualization.',
    techStack: ['React', 'Tailwind', 'Chart.js'],
    buildTime: '~25 min',
    gradient: 'from-[#553DE9] to-[#7B6BEF]',
    prompt: 'Build a SaaS admin dashboard',
  },
];

export function M() {
  return DEFAULT_PERMISSIONS.length + COLUMNS.length + GALLERY.length;
}
TSX
    cat > "$d/src/components/TimerHonest.tsx" <<'TSX'
export function TM() {
  setTimeout(() => {
    const x = [{ id: 'a1', action: 'Deployed', user: 'Admin', timestamp: 'now' }];
    void x;
  }, 0);
  return null;
}
TSX
    # BACKLOG 125 B-8 (S-32): Array.from({length:N}, generator) fabrication.
    # Positive: a generator callback inventing static string fields per row
    # (no sample/mock/demo/fake/placeholder name, not in a catch, no `[`
    # anywhere so the setter-span and Array.of()/Array.from()-literal-arg arms
    # cannot claim it -- only the new arm can).
    cat > "$d/src/components/ArrayFromGenFabricated.tsx" <<'TSX'
export function AG() {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, action: 'Deployed', user: 'Admin' }));
  return rows.length;
}
TSX
    # Negative look-alikes: bare index, derived-only fields (id only), a real
    # iterable source with a static tag (not a {length} generator, so out of
    # this arm's narrow scope), and a {length} generator reading real data by
    # index (no static string field, only a passthrough value).
    cat > "$d/src/components/ArrayFromGenHonest.tsx" <<'TSX'
export function AH({ items, data }) {
  const ids = Array.from({ length: 3 }, (_, i) => i);
  const idOnly = Array.from({ length: 3 }, (_, i) => ({ id: i }));
  const tagged = Array.from(items, (x) => ({ id: x.id, kind: 'row' }));
  const fromData = Array.from({ length: data.length }, (_, i) => ({ id: i, value: data[i] }));
  return ids.length + idOnly.length + tagged.length + fromData.length;
}
TSX
    # BACKLOG 145 (S-198): the inner row uses the OUTER generator's index, so
    # the arm must substitute enclosing params too. Line 2 is flagged; line 3
    # (both indices, no static string) stays clean, so the file has exactly 1.
    cat > "$d/src/components/ArrayFromGenNested.tsx" <<'TSX'
export function AN() {
  const grid = Array.from({ length: 2 }, (_, r) => Array.from({ length: 2 }, (_, c) => ({ id: r, user: 'Admin' })));
  const cells = Array.from({ length: 2 }, (_, r) => Array.from({ length: 2 }, (_, c) => ({ row: r, col: c })));
  return grid.length + cells.length;
}
TSX
    # BACKLOG 125 B-5 negative controls: a real named module-level table used
    # to pick how much of ITSELF to show (real shape at
    # web-app/src/components/ChangelogWidget.tsx:43) is UI truncation, not a
    # live-vs-fabricated fallback, and must stay clean; a named config-defaults
    # object used as a ||-fallback is the honest twin of HonestRows' inline
    # `opts || { retries: 3, timeout: 30 }` and must stay clean too.
    cat > "$d/src/components/ModuleTableSelfDerivedHonest.tsx" <<'TSX'
const RECENT_CHANGES = [
  { version: '1.0', date: 'x', features: ['a'] },
];

export function CW() {
  const [expanded] = useState(false);
  const visible = expanded ? RECENT_CHANGES : RECENT_CHANGES.slice(0, 2);
  return <b>{visible.length}</b>;
}
TSX
    cat > "$d/src/components/ModuleTableDefaultOptsHonest.tsx" <<'TSX'
const DEFAULT_OPTS = { retries: 3, timeout: 30 };

export function DO({ opts }) {
  const o = opts || DEFAULT_OPTS;
  return <b>{o.retries}</b>;
}
TSX
    # BACKLOG 125 B-5 REWORK ROUND 4 (S-29 2/2 CONCERN, confirmed finding):
    # unwrap() (the ternary-branch paren/`as Type` stripper) only peeled a
    # leading paren when its closer was the LAST character of the whole
    # branch text (`close_of(t, 0) == len(t) - 1`), so a parenthesized/cast
    # table reference followed by a chained method call slipped through
    # completely undetected: the branch stayed wrapped in `(...)`, never
    # matched as a bare table name, and never got a chance to chain-walk.
    # Both fixed by table_operand_end, a single recursive paren-peel shared
    # with the ||/?? site (see its own docstring for the mechanism).
    cat > "$d/src/components/ParenAsChainSliceFallback.tsx" <<'TSX'
const BACKUP_ROWS7 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function PP1({ live }) {
  const data = live ? live : (BACKUP_ROWS7 as Row[]).slice(1);
  return <b>{data.length}</b>;
}
TSX
    cat > "$d/src/components/ParenChainFilterFallback.tsx" <<'TSX'
const BACKUP_ROWS8 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function PP2({ live }) {
  const data = live ? live : (BACKUP_ROWS8).filter(r => r.ok);
  return <b>{data.length}</b>;
}
TSX
    # Companion false positive, same root cause: the ||/?? site's `(\(*)`
    # prefix capture never confirmed where the leading paren it consumed
    # actually CLOSED, so TERMINATOR's bare `)` alternative could match the
    # FIRST `)` anywhere later in the source -- wrongly treating a
    # parenthesized honest scalar/single-row read as "operand ends at this
    # `)`" and silently ignoring the `.length`/`[0]` that actually follows.
    # Unparenthesized siblings (ScalarLengthReadHonest, BareIndexPickHonest
    # above) were already clean; only wrapping them in parens triggered the
    # false positive. table_operand_end fixes this by finding the paren's
    # TRUE closer via close_of first, then handing chain_end the position
    # right after that closer -- `.length`/`[0]` there is a scalar/element
    # read, not an array-returning call, so chain_end returns unchanged and
    # TERMINATOR correctly refuses to match at that non-boundary position.
    cat > "$d/src/components/ParenScalarLengthReadHonest.tsx" <<'TSX'
const PERMS2 = [
  { id: 'project.create', label: 'Create Projects', description: 'Create new projects' },
];

export function PL2({ count }) {
  const n = count || (PERMS2).length;
  return <b>{n}</b>;
}
TSX
    cat > "$d/src/components/ParenBareIndexPickHonest.tsx" <<'TSX'
const TABS4 = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
];

export function IP2({ sel }) {
  const active = sel || (TABS4)[0];
  return <b>{active.id}</b>;
}
TSX
    # Same paren/chain gap, reached through a SPREAD element inside a
    # fallback/ternary array literal instead of a bare operand:
    # literal_rows_resolved's spread-element check (`[...NAME]`) did a bare
    # `p[3:].strip() in module_tables` exact-string match, no chain-walk or
    # paren-peel at all, so `[...TABLE.slice(0)]` and `[...TABLE.filter(...)]`
    # (and even a bare `[...(TABLE)]`, parens with no chain) all failed to
    # resolve and were silently skipped -- invisible to this arm. Fixed by
    # routing the spread operand through resolves_to_table_read, the same
    # function the ||/?? and ternary bare-operand sites already use.
    cat > "$d/src/components/SpreadChainSliceFallback.tsx" <<'TSX'
const BACKUP_ROWS9 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function SC1({ rows }) {
  const data = rows || [...BACKUP_ROWS9.slice(0)];
  return <b>{data.length}</b>;
}
TSX
    cat > "$d/src/components/SpreadChainSliceTernaryFallback.tsx" <<'TSX'
const BACKUP_ROWS10 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function SC2({ live }) {
  const data = live ? live : [...BACKUP_ROWS10.slice(0)];
  return <b>{data.length}</b>;
}
TSX
    # BACKLOG 125 B-5 REWORK ROUND 5: three self-found regressions from
    # ROUND 4's own restructuring (table_operand_end/resolves_to_table_read
    # split across two call sites), each isolated to exactly one gap.
    #   1. The ||/?? site's prefilter regex required the name IMMEDIATELY
    #      after the last `(` with no whitespace, so a Prettier-formatted
    #      multi-line cast was never even found by the prefilter, regardless
    #      of what table_operand_end could resolve once positioned.
    cat > "$d/src/components/PrettyMultilineCastFallback.tsx" <<'TSX'
const BACKUP_ROWS11 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function PM({ rows }) {
  const data = rows ?? (
    BACKUP_ROWS11
  ).slice(1);
  return <b>{data.length}</b>;
}
TSX
    #   2. table_operand_end's inner-paren check originally reused the SAME
    #      TERMINATOR the top-level operand uses, which also treats a bare
    #      `?`/`&&` as a boundary -- but inside a paren, hitting `||`/`??`
    #      IS the table becoming the value (`(T || other)` evaluates to T
    #      when T is a truthy non-empty array), while hitting `&&` or a bare
    #      ternary `?` inside parens means T is used as a CONDITION, and the
    #      whole group evaluates to something else entirely. This fixture
    #      pins the CATCH (nested ||): dropping the narrower INNER_TERM back
    #      to the broader TERMINATOR does not un-catch this one (both accept
    #      `||`), so it is paired with the honest-negative-control fixture
    #      below, which the broader TERMINATOR WOULD wrongly flag.
    cat > "$d/src/components/ParenNestedOrTernaryFallback.tsx" <<'TSX'
const BACKUP_ROWS12 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function PN({ live, other }) {
  const data = live ? live : (BACKUP_ROWS12 || other);
  return <b>{data}</b>;
}
TSX
    #   3. resolves_to_table_read's trailing `as Type` strip was moved to
    #      operate on the WHOLE input text (needed for a bare, unparenthesized
    #      cast: `live ? live : BACKUP_ROWS as Row[]`), but table_operand_end's
    #      own paren-inner branch needs ITS OWN separate strip on the inner
    #      text (`(BACKUP_ROWS as Row[])`'s inner is `BACKUP_ROWS as Row[]`,
    #      never seen at the top level at all since it is inside the parens);
    #      losing either one breaks exactly the cast form it alone covers.
    #      This fixture pins the bare (unparenthesized), no-chain cast form.
    cat > "$d/src/components/BareCastTernaryFallback.tsx" <<'TSX'
const BACKUP_ROWS13 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function BC({ live }) {
  const data = live ? live : BACKUP_ROWS13 as Row[];
  return <b>{data.length}</b>;
}
TSX
    # Honest negative control for round-5 fix 2: `(TABLE && other)` and
    # `(TABLE ? a : b)` never make TABLE the fallback VALUE -- `&&` and a bare
    # ternary `?` use TABLE only as a truthiness CONDITION inside the parens,
    # evaluating to `other`/`a`/`b` instead. Reusing the broader TERMINATOR
    # (which treats `&&`/bare `?` as boundaries, correctly, at the TOP-LEVEL
    # operand position) as the INNER-paren acceptance test as well would
    # wrongly flag this honest, non-fallback shape.
    cat > "$d/src/components/ParenAndConditionHonest.tsx" <<'TSX'
const PERMS4 = [
  { id: 'p1', label: 'A' },
];

export function PA({ x, other }) {
  const data = x || (PERMS4 && other);
  return <b>{data}</b>;
}
TSX
    # BACKLOG 125 B-5 REWORK ROUND 6: round 5's INNER_TERM-vs-TERMINATOR
    # distinction (fix 2 above) was applied ONLY inside table_operand_end's
    # paren-peel branch, not to the bare (unparenthesized) top-level operand
    # branch, an asymmetry with the paren case -- the same paren/bare
    # boundary-symmetry bug class as every earlier round here.
    #   1. False negative: `live ? live : TABLE || other` (bare, no wrapping
    #      parens around `TABLE || other` at all) was NOT caught, even though
    #      the identical expression wrapped in one extra pair of parens
    #      (`live ? live : (TABLE || other)`, ParenNestedOrTernaryFallback
    #      above) already was. Confirmed via `node -e`: when `live` is
    #      falsy, the result is TABLE's own array whenever TABLE is truthy,
    #      or `other` otherwise -- either way TABLE's data CAN reach the
    #      sink, identically to the already-caught paren-wrapped twin.
    cat > "$d/src/components/BareOrChainTernaryFallback.tsx" <<'TSX'
const BACKUP_ROWS14 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function BO({ live, other }) {
  const data = live ? live : BACKUP_ROWS14 || other;
  return <b>{data}</b>;
}
TSX
    cat > "$d/src/components/BareNullishChainTernaryFallback.tsx" <<'TSX'
const BACKUP_ROWS15 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function BN({ live, other }) {
  const data = live ? live : BACKUP_ROWS15 ?? other;
  return <b>{data}</b>;
}
TSX
    #   2. False positive, the mirror image: `x || TABLE && other` and
    #      `x || TABLE ? a : b` were WRONGLY flagged at the ||/?? finder
    #      site, which read TERMINATOR's `&&`/bare-`?` alternatives as valid
    #      operand boundaries -- but TABLE is used only as a boolean
    #      CONDITION here, and the expression evaluates to `other`/`a`/`b`,
    #      never to TABLE. Confirmed via `node -e` against real JS operator
    #      precedence. The paren-wrapped twin (ParenAndConditionHonest
    #      above) already stayed clean; only the bare form over-flagged.
    #      TERMINATOR no longer accepts `&&`/bare-`?` at all (round 6 fix).
    cat > "$d/src/components/BareOrAndConditionHonest.tsx" <<'TSX'
const PERMS5 = [
  { id: 'p1', label: 'A' },
];

export function PB({ x, other }) {
  const data = x || PERMS5 && other;
  return <b>{data}</b>;
}
TSX
    cat > "$d/src/components/BareOrTernaryConditionHonest.tsx" <<'TSX'
const PERMS6 = [
  { id: 'p1', label: 'A' },
];

export function PC({ x, a, b }) {
  const data = x || PERMS6 ? a : b;
  return <b>{data}</b>;
}
TSX
    #   3. The SAME false-positive/false-negative pair, reached through an
    #      inline `as Type` cast in front of the boundary: TERMINATOR used to
    #      accept a bare `\bas\b` as itself a terminator, so `x || TABLE as
    #      Row[] && other` matched "as" as the boundary and never even looked
    #      at the `&&` that followed -- the identical condition-not-value FP
    #      as fix 2, just spelled with a cast in the middle. CAST_SKIP
    #      (round 6) consumes the cast first, then checks the REAL character
    #      after it. Its own first draft used a loose character class that
    #      let the terminator alternation match the closing `]` of `Row[]`
    #      itself via backtracking; CAST_SKIP's final, precise type-shape
    #      regex has nothing left to give back, closing that reopening too.
    cat > "$d/src/components/BareOrCastAndConditionHonest.tsx" <<'TSX'
const PERMS7 = [
  { id: 'p1', label: 'A' },
];

export function PD({ x, other }) {
  const data = x || PERMS7 as Row[] && other;
  return <b>{data}</b>;
}
TSX
    cat > "$d/src/components/BareOrChainCastTernaryFallback.tsx" <<'TSX'
const BACKUP_ROWS16 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function BC2({ live, other }) {
  const data = live ? live : BACKUP_ROWS16 as Row[] || other;
  return <b>{data}</b>;
}
TSX
    # S-30/BACKLOG 125 B-6, second half: is_exempting_sibling()'s ABSENT set
    # excluded null/undefined/'' from the both-branches-literal exemption but
    # left false/0/{}/true in it, so is_literal() (true for every one of
    # them) still let each sentinel exempt a module-level fabricated-rows
    # table on the OTHER ternary branch -- the identical bypass class as the
    # null case, four more ways in. All four in one fixture, against the SAME
    # table, since flag_table_fallback dedupes by span (position), not by
    # table name, so each of the four independent ternaries is expected to
    # flag on its own line.
    cat > "$d/src/components/AbsentSiblingBypassFallback.tsx" <<'TSX'
const BACKUP_ROWS17 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function AB({ loading }) {
  const a = loading ? false : BACKUP_ROWS17;
  const b = loading ? 0 : BACKUP_ROWS17;
  const c = loading ? {} : BACKUP_ROWS17;
  const d = loading ? true : BACKUP_ROWS17;
  return <b>{(a || b || c || d) ? 1 : 0}</b>;
}
TSX
    # Paired honest fixture: the ABSENT expansion above is four exact tokens,
    # never a substring match. A non-zero number literal (`10`, contains "0"
    # but is not the exact token) and a non-empty object literal (`{ ready:
    # true }`, contains "true" but is not the bare `{}` sentinel) are genuine
    # data-shaped literals and must keep exempting, or the fix would have
    # overreached into flagging ordinary literal-vs-table choices.
    cat > "$d/src/components/NearAbsentLiteralSiblingHonest.tsx" <<'TSX'
const BACKUP_ROWS18 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function NA({ mode }) {
  const a = mode ? 10 : BACKUP_ROWS18;
  const b = mode ? BACKUP_ROWS18 : { ready: true };
  return <b>{a === b ? 1 : 0}</b>;
}
TSX
    # S-30 rework, finding #1 (Tech Lead review of 0a897a91, blocking CONCERN):
    # ABSENT matched the empty object only as the exact string "{}", so any
    # whitespace inside it (a formatter's `{ }`, or a multi-line `{\n}`) fell
    # through as a "genuine literal" and kept exempting a fabricated-rows
    # sibling -- the same bypass class this commit closes, one whitespace
    # variant wider. is_exempting_sibling now checks emptiness structurally
    # (split_top of the brace interior) instead of string-matching `\{\}`.
    cat > "$d/src/components/EmptyObjectWhitespaceSiblingBypassFallback.tsx" <<'TSX'
const BACKUP_ROWS19 = [
  { id: 'b1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function EOB({ loading }) {
  const a = loading ? { } : BACKUP_ROWS19;
  return <b>{a}</b>;
}
TSX
    # S-30 rework, finding #2 (same review, advisory fast-follow): the bare
    # digit `0` was the only zero-valued numeric spelling ABSENT rejected;
    # `0.0`, `-0`, `00` and `0e0` are equally zero and equally carry no row
    # data, so each still exempted a fabricated-rows sibling. Fixed by
    # evaluating any bare numeric literal and rejecting one that equals zero,
    # rather than listing spellings.
    cat > "$d/src/components/NumericZeroSpellingSiblingBypassFallback.tsx" <<'TSX'
const BACKUP_ROWS20 = [
  { id: 'c1', action: 'Deployed', user: 'Admin', timestamp: 'now' },
];

export function NZ({ mode }) {
  const a = mode ? 0.0 : BACKUP_ROWS20;
  const b = mode ? -0 : BACKUP_ROWS20;
  const c = mode ? 00 : BACKUP_ROWS20;
  const d = mode ? 0e0 : BACKUP_ROWS20;
  return <b>{(a || b || c || d) ? 1 : 0}</b>;
}
TSX
    rc=0; out="$(python3 "$MOAT_TMP/sample-panels.py" "$d/src" "$d/dash/components" 2>&1)" || rc=$?
    [ "$rc" = 1 ] || { echo "rules 6-9 scan exited $rc, want 1: $(tr '\n' ' ' <<<"$out" | head -c 200)"; return 1; }
    while IFS='|' read -r f want; do
        grep -q "^FINDING [a-z/]*$f $want" <<<"$out" \
            || { echo "missed $f $want: $(grep "^FINDING.*${f%%:*}" <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    done <<'EOF'
TeamsVerbatim.tsx:13|'sample' binds sample/mock/demo/fake/placeholder literal data
TeamsVerbatim.tsx:13|literal sample rows assigned in a catch block
TeamsVerbatim.tsx:35|literal sample rows passed to setActivities()
RbacVerbatim.tsx:9|literal sample rows passed to setAuditEntries()
TemplateStats.tsx:1|invented stats lookup table
TemplateStats.tsx:23|Math.random() feeds a rendered metric
TemplateStats.tsx:24|invented stats: constant metric fallback
ZeroFmt.tsx:2|unmeasured value rendered as zero
ZeroFmt.tsx:3|unmeasured value rendered as zero
ZeroFmt.tsx:4|unmeasured value rendered as zero
ZeroFmt.tsx:5|unmeasured value rendered as zero
Named.tsx:2|'sample' binds
Named.tsx:3|'mockRows' binds
Named.tsx:4|'_demoData' binds
Named.tsx:5|'PLACEHOLDER_USERS' binds
Named.tsx:6|'fakeStats' binds
loki-audit-fallback.js:6|literal sample rows assigned in a catch block
TernaryFallback.tsx:3|literal sample rows in a ternary branch
loki-cost-waterfall-or.js:3|literal sample rows used as a ||/?? fallback
ArrayOfFallback.tsx:2|literal sample rows via Array.of()
TernaryQBranch.tsx:2|literal sample rows in a ternary branch
DeclFlowsToState.tsx:2|literal sample rows in a ternary branch
DeclGenericUseState.tsx:2|literal sample rows assigned to items
ThisArrOnly.js:3|literal sample rows assigned to this._phases
SetterSpanOnly.tsx:2|literal sample rows in the setActivities() argument list
ArrayFromOnly.js:3|literal sample rows via Array.from()
DeclPlainSetter.tsx:2|literal sample rows assigned to rows
ThisFlowOnly.js:3|literal sample rows assigned to rows
DeclLazyUseState.tsx:2|literal sample rows assigned to items
ReassignFallback.tsx:3|literal sample rows reassigned to rows
ModuleTableFallback.tsx:7|module-level table 'FALLBACK_ROWS' (fabricated rows) used as a fallback
ModuleTableOrFallback.tsx:6|module-level table 'BACKUP_DATA' (fabricated rows) used as a fallback
ConcatDerivedFallback.tsx:6|module-level table 'RECENT' (fabricated rows) used as a fallback
OrFallbackWithMethod.tsx:6|module-level table 'BACKUP_ROWS' (fabricated rows) used as a fallback
TernarySliceCopyFallback.tsx:6|module-level table 'BACKUP_ROWS2' (fabricated rows) used as a fallback
SpreadOfTableFallback.tsx:6|literal sample rows used as a ||/?? fallback
SpreadOfTableTernaryFallback.tsx:6|literal sample rows in a ternary branch
NullTernaryTableFallback.tsx:6|module-level table 'BACKUP_ROWS4' (fabricated rows) used as a fallback
UnboundedSliceFallback.tsx:6|module-level table 'BACKUP_T' (fabricated rows) used as a fallback
ParenWrappedFallback.tsx:6|module-level table 'BACKUP_ROWS5' (fabricated rows) used as a fallback
ParenAsTernaryFallback.tsx:6|module-level table 'BACKUP_ROWS6' (fabricated rows) used as a fallback
ArrowFilterChainFallback.tsx:6|module-level table 'BACKUP_X' (fabricated rows) used as a fallback
SliceReverseChainFallback.tsx:6|module-level table 'BACKUP_Y' (fabricated rows) used as a fallback
ArrowFilterChainTernaryFallback.tsx:6|module-level table 'BACKUP_Z' (fabricated rows) used as a fallback
NewlineNoSemicolonFallback.tsx:6|module-level table 'BACKUP_Q' (fabricated rows) used as a fallback
ParenAsChainSliceFallback.tsx:6|module-level table 'BACKUP_ROWS7' (fabricated rows) used as a fallback
ParenChainFilterFallback.tsx:6|module-level table 'BACKUP_ROWS8' (fabricated rows) used as a fallback
SpreadChainSliceFallback.tsx:6|literal sample rows used as a ||/?? fallback
SpreadChainSliceTernaryFallback.tsx:6|literal sample rows in a ternary branch
PrettyMultilineCastFallback.tsx:6|module-level table 'BACKUP_ROWS11' (fabricated rows) used as a fallback
ParenNestedOrTernaryFallback.tsx:6|module-level table 'BACKUP_ROWS12' (fabricated rows) used as a fallback
BareCastTernaryFallback.tsx:6|module-level table 'BACKUP_ROWS13' (fabricated rows) used as a fallback
BareOrChainTernaryFallback.tsx:6|module-level table 'BACKUP_ROWS14' (fabricated rows) used as a fallback
BareNullishChainTernaryFallback.tsx:6|module-level table 'BACKUP_ROWS15' (fabricated rows) used as a fallback
BareOrChainCastTernaryFallback.tsx:6|module-level table 'BACKUP_ROWS16' (fabricated rows) used as a fallback
AbsentSiblingBypassFallback.tsx:6|module-level table 'BACKUP_ROWS17' (fabricated rows) used as a fallback
AbsentSiblingBypassFallback.tsx:7|module-level table 'BACKUP_ROWS17' (fabricated rows) used as a fallback
AbsentSiblingBypassFallback.tsx:8|module-level table 'BACKUP_ROWS17' (fabricated rows) used as a fallback
AbsentSiblingBypassFallback.tsx:9|module-level table 'BACKUP_ROWS17' (fabricated rows) used as a fallback
EmptyObjectWhitespaceSiblingBypassFallback.tsx:6|module-level table 'BACKUP_ROWS19' (fabricated rows) used as a fallback
NumericZeroSpellingSiblingBypassFallback.tsx:6|module-level table 'BACKUP_ROWS20' (fabricated rows) used as a fallback
NumericZeroSpellingSiblingBypassFallback.tsx:7|module-level table 'BACKUP_ROWS20' (fabricated rows) used as a fallback
NumericZeroSpellingSiblingBypassFallback.tsx:8|module-level table 'BACKUP_ROWS20' (fabricated rows) used as a fallback
NumericZeroSpellingSiblingBypassFallback.tsx:9|module-level table 'BACKUP_ROWS20' (fabricated rows) used as a fallback
HelperReturnTaskVerbatim.tsx:1|'getRows' returns fabricated literal rows reaching a data sink
HelperReturnFnDecl.tsx:2|'getRows' returns fabricated literal rows reaching a data sink
HelperReturnArrow.tsx:2|'getRows' returns fabricated literal rows reaching a data sink
HelperReturnThisSink.js:3|'getPhases' returns fabricated literal rows reaching a data sink
HelperReturnTwoHop.tsx:2|'getRows' returns fabricated literal rows reaching a data sink
HelperReturnConcise.tsx:2|'getRows' returns fabricated literal rows reaching a data sink
HelperReturnTyped.tsx:2|'getRows' returns fabricated literal rows reaching a data sink
HelperReturnAwaitSetter.tsx:2|'getRows' returns fabricated literal rows reaching a data sink
HelperReturnAwaitThisSink.js:3|'getPhases' returns fabricated literal rows reaching a data sink
HelperReturnClassMethod.js:2|'_getRows' returns fabricated literal rows reaching a data sink
HelperReturnLazyRef.tsx:2|'getRows' returns fabricated literal rows reaching a data sink
HelperReturnSinkSpread.tsx:2|'buildRowsX' returns fabricated literal rows reaching a data sink
HelperReturnSinkNestedCall.tsx:2|'buildRowsX' returns fabricated literal rows reaching a data sink
HelperReturnSinkTrailingCall.tsx:2|'buildRowsX' returns fabricated literal rows reaching a data sink
HelperReturnBareParamArrow.tsx:2|'buildRowsY' returns fabricated literal rows reaching a data sink
HelperReturnLetVar.tsx:2|'buildRowsZ' returns fabricated literal rows reaching a data sink
HelperReturnUseCallback.tsx:2|'buildRowsW' returns fabricated literal rows reaching a data sink
HelperReturnUseCallbackBareParam.tsx:2|'buildRowsV' returns fabricated literal rows reaching a data sink
HelperReturnReactUseCallback.tsx:2|'buildRowsU' returns fabricated literal rows reaching a data sink
UseMemoConciseFabricated.tsx:2|literal sample rows returned by a useMemo factory assigned to rows
UseMemoBlockFabricated.tsx:3|literal sample rows returned by a useMemo factory assigned to rows
EOF
    # Exact per-file counts: no extra finding anywhere, none on a look-alike.
    for want in TeamsVerbatim.tsx:3 RbacVerbatim.tsx:1 TemplateStats.tsx:3 ZeroFmt.tsx:4 Named.tsx:5 \
        loki-audit-fallback.js:1 HonestRows.tsx:0 P.tsx:0 \
        TernaryFallback.tsx:1 loki-cost-waterfall-or.js:1 ArrayOfFallback.tsx:1 \
        TernaryQBranch.tsx:1 DeclFlowsToState.tsx:1 DeclGenericUseState.tsx:1 \
        ThisArrOnly.js:1 SetterSpanOnly.tsx:1 ArrayFromOnly.js:1 DeclPlainSetter.tsx:1 \
        ThisFlowOnly.js:1 DeclLazyUseState.tsx:1 \
        ReassignFallback.tsx:1 ReassignHonest.tsx:0 \
        ModuleTableFallback.tsx:1 ModuleTableOrFallback.tsx:1 \
        ConcatDerivedFallback.tsx:1 OrFallbackWithMethod.tsx:1 TernarySliceCopyFallback.tsx:1 \
        SpreadOfTableFallback.tsx:1 NullTernaryTableFallback.tsx:1 \
        UnboundedSliceFallback.tsx:1 ParenWrappedFallback.tsx:1 ParenAsTernaryFallback.tsx:1 \
        SpreadOfTableTernaryFallback.tsx:1 \
        ArrowFilterChainFallback.tsx:1 SliceReverseChainFallback.tsx:1 ArrowFilterChainTernaryFallback.tsx:1 \
        NewlineNoSemicolonFallback.tsx:1 \
        ParenAsChainSliceFallback.tsx:1 ParenChainFilterFallback.tsx:1 \
        SpreadChainSliceFallback.tsx:1 SpreadChainSliceTernaryFallback.tsx:1 \
        PrettyMultilineCastFallback.tsx:1 ParenNestedOrTernaryFallback.tsx:1 \
        BareCastTernaryFallback.tsx:1 \
        BareOrChainTernaryFallback.tsx:1 BareNullishChainTernaryFallback.tsx:1 \
        BareOrChainCastTernaryFallback.tsx:1 \
        AbsentSiblingBypassFallback.tsx:4 NearAbsentLiteralSiblingHonest.tsx:0 \
        EmptyObjectWhitespaceSiblingBypassFallback.tsx:1 \
        NumericZeroSpellingSiblingBypassFallback.tsx:4 \
        DefaultProvidersSpreadHonest.tsx:0 \
        ScalarLengthReadHonest.tsx:0 ElementIndexReadHonest.tsx:0 FindReadHonest.tsx:0 \
        BareIndexPickHonest.tsx:0 DifferentIdentifierPrefixHonest.tsx:0 OptionalChainLengthHonest.tsx:0 \
        HelperReturnTaskVerbatim.tsx:1 \
        HelperReturnFnDecl.tsx:1 HelperReturnArrow.tsx:1 HelperReturnThisSink.js:1 HelperReturnTwoHop.tsx:1 \
        HelperReturnConcise.tsx:1 HelperReturnTyped.tsx:1 \
        HelperReturnAwaitSetter.tsx:1 HelperReturnAwaitThisSink.js:1 HelperReturnLazyRef.tsx:1 \
        HelperReturnClassMethod.js:1 HelperReturnClassMethodHonest.js:0 \
        HelperReturnSinkSpread.tsx:1 HelperReturnSinkNestedCall.tsx:1 HelperReturnSinkTrailingCall.tsx:1 \
        HelperReturnBareParamArrow.tsx:1 HelperReturnLetVar.tsx:1 HelperReturnUseCallback.tsx:1 \
        HelperReturnUseCallbackBareParam.tsx:1 HelperReturnReactUseCallback.tsx:1 \
        UseMemoConciseFabricated.tsx:1 UseMemoBlockFabricated.tsx:1 UseMemoDerivedHonest.tsx:0 \
        UseMemoCallsFabricator.tsx:1 UseMemoBlockCallsFabricator.tsx:1 UseMemoCallsHonestHelper.tsx:0 \
        UseMemoCallsFabricatorRenderOnly.tsx:0 \
        BracketSinkFabricated.tsx:1 BracketSinkLocalFabricated.tsx:1 BracketSinkHelperFabricated.tsx:1 \
        BracketSinkHonest.tsx:0 \
        OptCallSinkFabricated.tsx:1 OptCallSinkHelperFabricated.tsx:1 OptCallSinkLocalFabricated.tsx:1 \
        OptCallSinkHonest.tsx:0 \
        BracketOptSinkFabricated.tsx:1 BracketOptSinkLocalFabricated.tsx:1 BracketOptSinkHonest.tsx:0 \
        AliasSinkFabricated.tsx:1 AliasSinkOptCallFabricated.tsx:1 AliasSinkLocalFabricated.tsx:1 \
        AliasBracketSinkFabricated.tsx:1 AliasSinkHelperFabricated.tsx:1 AliasSinkHonest.tsx:0 \
        MemoForwardNestedFabricated.tsx:1 MemoForwardChainFabricated.tsx:1 LocalForwardSpreadFabricated.tsx:1 \
        MemoForwardHonest.tsx:0 \
        HelperReturnEmptyHonest.tsx:0 HelperReturnRenderOnlyHonest.tsx:0 HelperReturnNestedCallbackHonest.tsx:0 \
        HelperReturnSinkSpreadHonest.tsx:0 HelperReturnSinkNestedCallHonest.tsx:0 \
        HelperReturnSinkTrailingCallHonest.tsx:0 HelperReturnUseCallbackHonest.tsx:0 \
        HelperReturnMethodCollisionHonest.tsx:0 \
        AdvisorOptsHonest.tsx:0 RenderLocalTabsHonest.tsx:0 DefaultProvidersHonest.tsx:0 \
        ModuleTablesHonest.tsx:0 TimerHonest.tsx:0 \
        ModuleTableSelfDerivedHonest.tsx:0 ModuleTableDefaultOptsHonest.tsx:0 \
        ParenScalarLengthReadHonest.tsx:0 ParenBareIndexPickHonest.tsx:0 \
        ParenAndConditionHonest.tsx:0 \
        BareOrAndConditionHonest.tsx:0 BareOrTernaryConditionHonest.tsx:0 \
        BareOrCastAndConditionHonest.tsx:0; do
        f="${want%%:*}"
        got="$(grep -c "^FINDING [a-z/]*$f:" <<<"$out")"
        [ "$got" = "${want##*:}" ] \
            || { echo "$f has $got finding(s), want ${want##*:}: $(grep "^FINDING.*$f:" <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    done
    # BACKLOG 125 B-8 (S-32) own check, kept separate from the shared loops
    # above to stay additive against S-29/S-30/S-31 editing this same
    # function concurrently.
    grep -q "^FINDING [a-z/]*ArrayFromGenFabricated.tsx:2 fabricated static fields via Array.from() generator callback" <<<"$out" \
        || { echo "missed ArrayFromGenFabricated.tsx:2 fabricated static fields via Array.from() generator callback: $(grep '^FINDING.*ArrayFromGenFabricated' <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    grep -q "^FINDING [a-z/]*ArrayFromGenNested.tsx:2 fabricated static fields via Array.from() generator callback" <<<"$out" \
        || { echo "missed ArrayFromGenNested.tsx:2 (BACKLOG 145 nested generator): $(grep '^FINDING.*ArrayFromGenNested' <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    for want in ArrayFromGenFabricated.tsx:1 ArrayFromGenHonest.tsx:0 ArrayFromGenNested.tsx:1; do
        f="${want%%:*}"
        got="$(grep -c "^FINDING [a-z/]*$f:" <<<"$out")"
        [ "$got" = "${want##*:}" ] \
            || { echo "$f has $got finding(s), want ${want##*:}: $(grep "^FINDING.*$f:" <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    done
    # BACKLOG 125 B-2 (S-28) own check, kept separate from the shared loops
    # above to stay additive against concurrent slices editing this same
    # function. Two lines of DefaultValueFabricated.tsx must each be flagged
    # with the new "default value" message (never DECL_ARR's or REASSIGN_ARR's
    # wording, since neither arm can see a destructuring/parameter default);
    # DefaultValueHonest.tsx must be clean; BlockReassignProbe.tsx must keep
    # REASSIGN_ARR's own "reassigned" message, proving this new arm does not
    # cannibalize the shape it was placed ahead of.
    grep -q "^FINDING [a-z/]*DefaultValueFabricated.tsx:1 literal sample rows as a default value for activities" <<<"$out" \
        || { echo "missed DefaultValueFabricated.tsx:1 default value for activities: $(grep '^FINDING.*DefaultValueFabricated' <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    grep -q "^FINDING [a-z/]*DefaultValueFabricated.tsx:4 literal sample rows as a default value for rows" <<<"$out" \
        || { echo "missed DefaultValueFabricated.tsx:4 default value for rows: $(grep '^FINDING.*DefaultValueFabricated' <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    grep -q "^FINDING [a-z/]*BlockReassignProbe.tsx:3 literal sample rows reassigned to rows" <<<"$out" \
        || { echo "missed BlockReassignProbe.tsx:3 reassigned to rows: $(grep '^FINDING.*BlockReassignProbe' <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    for want in DefaultValueFabricated.tsx:2 DefaultValueHonest.tsx:0 BlockReassignProbe.tsx:1; do
        f="${want%%:*}"
        got="$(grep -c "^FINDING [a-z/]*$f:" <<<"$out")"
        [ "$got" = "${want##*:}" ] \
            || { echo "$f has $got finding(s), want ${want##*:}: $(grep "^FINDING.*$f:" <<<"$out" | tr '\n' ' ' | head -c 200)"; return 1; }
    done
    return 0
}

case_sample_panels() {
    command -v python3 >/dev/null 2>&1 || { echo "FAIL|prerequisite missing: python3"; return 0; }
    local ctl="$MOAT_TMP/sample-ctl" rc out why
    # Positive control: a page reaching a sample-fallback panel and a random
    # metric must both be flagged; confetti randomness must not be.
    mkdir -p "$ctl/src/pages" "$ctl/src/components" "$ctl/fixed/src/pages" "$ctl/fixed/src/components" "$ctl/dash/components"
    printf '%s\n' 'export function P() { return <div><Panel /><Stats /><Clean /><Gauge /><Plain /><Forms /><Honest /></div>; }' > "$ctl/src/pages/P.tsx"
    printf '%s\n' 'export function Panel({ data }) { const d = data || generateSampleData(); return <b>{d}</b>; }' > "$ctl/src/components/Panel.tsx"
    printf '%s\n' 'export function Stats() { const s = { uses: Math.floor(Math.random() * 10) }; return <i>{s.uses}</i>; }' > "$ctl/src/components/Stats.tsx"
    printf '%s\n' 'export function Clean() { const left = Math.random() * 100; return <i style={{ left }} />; }' > "$ctl/src/components/Clean.tsx"
    # Rule 4: a literal and a literal ternary, each on its own line so each is
    # flagged individually; a measured prop and layout numbers must not be.
    printf '%s\n' 'export function Gauge({ n }) { return <div>' '<Ring gatePassRate={0.8} size={28} />' \
        '<Ring testCoverage={n > 2 ? 60 : 20} /></div>; }' > "$ctl/src/components/Gauge.tsx"
    printf '%s\n' 'export function Plain({ rate }) { return <Ring gatePassRate={rate} size={28} thickness={4} />; }' > "$ctl/src/components/Plain.tsx"
    printf '%s\n' 'export function P() { return <div><Panel data={x} /><Gauge g={g} /></div>; }' > "$ctl/fixed/src/pages/P.tsx"
    printf '%s\n' 'export function Panel({ data }) { return <b>{data ?? null}</b>; }' > "$ctl/fixed/src/components/Panel.tsx"
    printf '%s\n' 'export function Gauge({ g }) { return g == null ? null : <Ring gatePassRate={g} size={28} />; }' > "$ctl/fixed/src/components/Gauge.tsx"
    # Rule 5: every unconditional form on its own line (lines 2-7), each
    # flagged individually; flags, hooks, Mockup names, id generators and
    # strings in Honest.tsx never are.
    printf '%s\n' 'export function Forms() {' \
        '  const [cards] = useState(generateOverviewCards);' \
        '  const [rows] = useState<Record<string, Row>>(() => generateRows(5));' \
        '  const [users] = useState(SAMPLE_USERS);' \
        '  try { phases = load(); } catch { phases = this._getDemoData(); }' \
        '  const t = demoTotals;' \
        '  return <T rows={mockRows} />; }' > "$ctl/src/components/Forms.tsx"
    # `sample` here is a parameter (a measured sample), never a literal: a
    # binding NAMED sample that holds literal data is rule 7's positive below.
    printf '%s\n' 'export function Honest() {' \
        '  const on = isDemoMode(); const [n] = useState(0); const m = InputMockup();' \
        "  const id = generateId(); const pick = (sample) => { const s = sample; return s; }; const k = 'mock_integrity';" \
        '  const [x] = useState(() => load()); const y = this._showMockBanner;' \
        '  return <T rows={rows} />; }' > "$ctl/src/components/Honest.tsx"
    rc=0; out="$(python3 "$MOAT_TMP/sample-panels.py" "$ctl/src" 2>&1)" || rc=$?
    if [ "$rc" != 1 ] || ! grep -q 'components/Panel.tsx:1 sample-data fallback' <<<"$out" \
        || ! grep -q 'components/Stats.tsx:1 Math.random' <<<"$out" || grep -q '^FINDING.*Clean.tsx' <<<"$out" \
        || ! grep -q 'components/Gauge.tsx:2 hardcoded number' <<<"$out" \
        || ! grep -q 'components/Gauge.tsx:3 hardcoded number' <<<"$out" || grep -q '^FINDING.*Plain.tsx' <<<"$out" \
        || grep -q '^FINDING.*Honest.tsx' <<<"$out"; then
        echo "FAIL|positive control failed (rc=$rc): $(grep -v '^REACH ' <<<"$out" | tr '\n' ' ' | head -c 200)"; return 0
    fi
    for n in 2 3 4 5 6 7; do
        grep -q "components/Forms.tsx:$n demo/sample data assigned" <<<"$out" \
            || { echo "FAIL|positive control: rule 5 missed Forms.tsx line $n: $(sed -n "${n}p" "$ctl/src/components/Forms.tsx")"; return 0; }
    done
    why="$(sample_rules_6_9_control "$ctl/r69")" || { echo "FAIL|positive control: $why"; return 0; }
    rc=0; out="$(python3 "$MOAT_TMP/sample-panels.py" "$ctl/fixed/src" 2>&1)" || rc=$?
    [ "$rc" = 0 ] || { echo "FAIL|control: a panel without a sample fallback was flagged: $(grep -v '^REACH ' <<<"$out" | tr '\n' ' ' | head -c 200)"; return 0; }
    # The cost waterfall's old failure path, verbatim: on a failed read it drew
    # a hardcoded $0.85/$3.20 breakdown as if it were this run. A shipped web
    # component carrying it must be flagged at the assignment (line 10).
    cat > "$ctl/dash/components/loki-cost-waterfall.js" <<'JS'
export class LokiCostWaterfall extends LokiElement {
  async _loadData() {
    const api = this._api;
    try {
      const data = await api._get('/api/v2/cost/breakdown');
      this._phases = data.phases || [];
    } catch {
      if (api !== this._api) return;
      if (this._phases.length === 0) {
        this._phases = this._getDemoData();
        this._budget = 10.00;
        this._totalCost = this._phases.reduce((sum, p) => sum + p.cost_usd, 0);
      }
    }
    this.render();
  }

  _getDemoData() {
    return [
      { phase: 'planning',  cost_usd: 0.85, tokens: 12400 },
      { phase: 'building',  cost_usd: 3.20, tokens: 68500 },
    ];
  }
}
JS
    rc=0; out="$(python3 "$MOAT_TMP/sample-panels.py" "$ctl/fixed/src" "$ctl/dash/components" 2>&1)" || rc=$?
    { [ "$rc" = 1 ] && grep -q '^FINDING dash/components/loki-cost-waterfall.js:10 demo/sample data assigned' <<<"$out" \
        && [ "$(grep -c '^FINDING' <<<"$out")" = 1 ]; } \
        || { echo "FAIL|positive control: the old waterfall catch-block demo fallback was not flagged exactly once (rc=$rc): $(grep '^FINDING' <<<"$out" | tr '\n' ' ' | head -c 200)"; return 0; }

    rc=0
    # The shell of the shipped dashboard (its inline script lives in
    # build-standalone.js) and the standalone cost/proofs/trust pages ship too.
    python3 "$MOAT_TMP/sample-panels.py" "$REPO_ROOT/web-app/src" \
        "$REPO_ROOT/dashboard-ui/components" "$REPO_ROOT/dashboard-ui/core" \
        "$REPO_ROOT/dashboard-ui/scripts/build-standalone.js" "$REPO_ROOT/dashboard/static" > "$MOAT_TMP/sample.txt" 2>&1 || rc=$?
    grep -v '^REACH ' "$MOAT_TMP/sample.txt" | sed 's/^/  /' >&2
    # The workspace is where rule 4's defect lived; a scan that never reached it
    # would pass without looking.
    if [ "$rc" -le 1 ] && ! grep -q '^REACH .*components/ProjectWorkspace.tsx$' "$MOAT_TMP/sample.txt"; then
        echo "FAIL|ProjectWorkspace.tsx is not in the reachable set; the scan would miss the workspace panels"; return 0
    fi
    case "$rc" in
        0) echo "PASS|$(grep '^SCANNED' "$MOAT_TMP/sample.txt")" ;;
        1) echo "FAIL|$(grep -c '^FINDING' "$MOAT_TMP/sample.txt") sample-data finding(s): $(grep '^FINDING' "$MOAT_TMP/sample.txt" | head -4 | sed 's/^FINDING //; s/ reachable via.*//' | tr '\n' ';')" ;;
        *) echo "FAIL|scanner refused (rc=$rc): $(tr '\n' ' ' < "$MOAT_TMP/sample.txt" | head -c 200)" ;;
    esac
}

# ---------------------------------------------------------------------------
# P7.unmeasured-cost-never-zero
# ---------------------------------------------------------------------------
# Flags, on comment-stripped lines:
#   A. a cost-named value defaulted to zero: `cost || 0`, `status?.cost ?? 0`,
#      `(run.cost_usd ?? 0).toFixed(2)` (identifier contains cost|usd|spend).
#      Uniform on purpose: a chart scale or accumulator that defaults a missing
#      cost to 0 is the same latent lie, and `?? null` plus a filter fixes it.
#   B. a "$0.00" literal returned from a null/undefined/NaN/falsy guard or as a
#      ternary else branch. `if (amount === 0) return '$0.00'` is a MEASURED
#      zero and is correct, so an exact-zero guard is not flagged.
# ponytail: line-level scan; a guard split across two lines is not seen.
# Upgrade to the TS AST if a multi-line fallback is ever found by review.
cat > "$MOAT_TMP/cost-zero.py" <<'PY'
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import moatlib
A = re.compile(r'[\w.?\]\[]*(?:cost|usd|spend)\w*\s*\)?\s*(?:\|\||\?\?)\s*0(?![\w.])', re.I)
ZLIT = re.compile(r'''['"`]\$0\.00['"`]''')
GUARD = re.compile(r'''==\s*null|===\s*null|==\s*undefined|===\s*undefined|isNaN|!\s*[\w(]|:\s*['"`]\$0\.00''')
hits, nfiles = [], 0
for root in sys.argv[1:]:
    for f in moatlib.walk(root, ('.js', '.mjs', '.ts', '.tsx', '.html')):
        # Built output is never evidence about source: skip the bundle and assets.
        if f.endswith(os.sep + 'static' + os.sep + 'index.html') or (os.sep + 'static' + os.sep + 'assets' + os.sep) in f:
            continue
        nfiles += 1
        s = moatlib.strip_comments(moatlib.read(f), html=f.endswith('.html'))
        for i, line in enumerate(s.split('\n'), 1):
            if A.search(line) or (ZLIT.search(line) and GUARD.search(line)):
                hits.append(f'{f}:{i}: {line.strip()[:110]}')
print(f'SCANNED {nfiles}')
for h in hits:
    print('HIT ' + h)
sys.exit(1 if hits else 0)
PY

# SERVER LEG. A client can only say "not recorded" if the server sends null: a
# budget reader that re-derives 0 from nothing makes every honest formatter
# above print "$0.00 of $10.00 used, 0.0%". One scenario per process (no module
# state carries over), LOKI_DIR resolved by the app's own resolver, a budget cap
# of $10, one efficiency record, per-run proofs, and a fleet registry of its own
# under the scenario directory (never the operator's ~/.loki):
#   unmeasured     no token or cost field    -> every budget field and the
#                                               by_phase/by_model token counts
#                                               null, status never
#                                               ok/warn/exceeded; two
#                                               proofs with usd null -> project
#                                               total null; fleet run cost and
#                                               fleet total null
#   measured       tokens + cost_usd 2.5     -> every field a positive number;
#                                               proof 2.5 -> total 2.5; fleet 2.5
#   measured-zero  tokens + cost_usd 0.0     -> spent/percent read 0, not null;
#                                               proof 0.0 -> total 0; fleet 0
#   mixed          as measured, plus a null  -> project total 2.5 marked
#                  proof and an unmeasured      partial; fleet runs 2.5 and
#                  second fleet project         null, fleet total 2.5 partial
# measured, measured-zero and mixed are the controls: a fix that nulls every
# zero, or that drops the measured runs from a mixed total, is as wrong.
# mixed also carries a second iteration that recorded nothing, so the current
# run total, the budget spend and /api/budget must each say partial there and
# nowhere else, and that iteration's tokens and model must read null.
# The same app is asked for four non-cost readings that used to be seeded as
# 0 / 0.0% / eight "pending" gate rows: /api/context, /api/memory/economics,
# /api/learning/metrics avgConfidence and /api/council/gate gates. They are
# null (or []) in every scenario except measured, which writes real readings
# and must read them back.
cat > "$MOAT_TMP/budget-null.py" <<'PY'
import json, numbers, os, sys
repo, loki, scenario = sys.argv[1:4]
sys.path.insert(0, repo)
os.environ.pop('LOKI_BUDGET_LIMIT', None)
os.environ['LOKI_DIR'] = loki
# mixed reads as measured for every budget field; only its totals differ.
kind = {'mixed': 'measured'}.get(scenario, scenario)
extra = {
    'unmeasured': {},
    'measured': {'input_tokens': 1000, 'output_tokens': 500, 'cost_usd': 2.5},
    'measured-zero': {'input_tokens': 9412, 'output_tokens': 11008, 'cost_usd': 0.0},
}[kind]
def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        json.dump(obj, fh)
rec = dict({'iteration': 1, 'model': 'sonnet', 'phase': 'build'}, **extra)
write(os.path.join(loki, 'metrics', 'efficiency', 'iteration-1.json'), rec)
write(os.path.join(loki, 'metrics', 'budget.json'), {'limit': 10})
if scenario == 'mixed':
    # A second iteration that recorded nothing (no tokens, cost or model): the
    # run's total and the budget spend become lower bounds.
    write(os.path.join(loki, 'metrics', 'efficiency', 'iteration-2.json'), {'iteration': 2, 'phase': 'build'})
if scenario == 'measured':
    # Readings for the non-cost unknowns, so their null assertions below have a
    # control that reads real numbers back through the same endpoints.
    write(os.path.join(loki, 'context', 'tracking.json'), {
        'session_id': 's1', 'updated_at': '2026-09-01T00:00:00Z',
        'current': {'input_tokens': 1000, 'output_tokens': 500, 'cache_read_tokens': 0,
                    'cache_creation_tokens': 0, 'total_tokens': 1500, 'context_window_pct': 42.5,
                    'estimated_cost_usd': 0.12},
        'compactions': [], 'per_iteration': [],
        'totals': {'total_input': 1000, 'total_output': 500, 'total_cost_usd': 0.12,
                   'compaction_count': 0, 'iterations_tracked': 1}})
    write(os.path.join(loki, 'memory', 'token_economics.json'), {
        'session_id': 's1', 'metrics': {'discovery_tokens': 1200, 'read_tokens': 800,
                                        'cache_hits': 7, 'cache_misses': 3}, 'savings_percent': 62.5})
    write(os.path.join(loki, 'learning', 'signals', 's1.json'), {'id': 's1', 'type': 'success', 'confidence': 0.8})
    write(os.path.join(loki, 'council', 'gate-block.json'),
          {'blocked': False, 'gates': [{'name': 'Test Suite', 'status': 'pass'}]})
# (proof run costs, want project_total_usd, want partial, fleet: want per-run
# costs sorted with None first, want fleet total, want fleet partial)
NULL = {'usd': None, 'available': False}
PLAN = {
    'unmeasured': ([NULL, NULL], None, False, [None], None, False),
    'measured': ([{'usd': 2.5, 'available': True}], 2.5, False, [2.5], 2.5, False),
    'measured-zero': ([{'usd': 0.0, 'available': True}], 0.0, False, [0.0], 0.0, False),
    'mixed': ([NULL, {'usd': 2.5, 'available': True}], 2.5, True, [None, 2.5], 2.5, True),
}[scenario]
for i, cost in enumerate(PLAN[0], 1):
    write(os.path.join(loki, 'proofs', f'run-{i}', 'proof.json'),
          {'run_id': f'run-{i}', 'generated_at': f'2026-09-0{i}T00:00:00Z', 'cost': cost})
from fastapi.testclient import TestClient
from dashboard import server, registry
home = os.path.dirname(loki)
registry.REGISTRY_DIR = type(registry.REGISTRY_DIR)(os.path.join(home, 'registry'))
registry.REGISTRY_FILE = registry.REGISTRY_DIR / 'projects.json'
registry.register_project(home, name='moat-p7')
if scenario == 'mixed':
    other = os.path.join(home, 'other')
    write(os.path.join(other, '.loki', 'metrics', 'efficiency', 'iteration-1.json'),
          {'iteration': 1, 'model': 'sonnet', 'phase': 'build'})
    registry.register_project(other, name='moat-p7-unmeasured')
client = TestClient(server.app, raise_server_exceptions=False)
got = {}
for path in ('/api/cost', '/api/budget', '/api/cost/timeline', '/api/fleet/runs', '/api/fleet/summary',
             '/api/context', '/api/memory/economics', '/api/learning/metrics', '/api/council/gate'):
    r = client.get(path)
    if r.status_code != 200:
        print(f'FATAL GET {path} -> HTTP {r.status_code}')
        sys.exit(2)
    got[path] = r.json()
# (label, endpoint, key path, reads 0 on a measured zero)
FIELDS = [
    ('/api/cost budget_used', '/api/cost', ['budget_used'], True),
    ('/api/cost budget_remaining', '/api/cost', ['budget_remaining'], False),
    ('/api/cost by_phase.build.input_tokens', '/api/cost', ['by_phase', 'build', 'input_tokens'], False),
    ('/api/cost by_model.sonnet.output_tokens', '/api/cost', ['by_model', 'sonnet', 'output_tokens'], False),
    ('/api/budget current_cost', '/api/budget', ['current_cost'], True),
    ('/api/budget remaining', '/api/budget', ['remaining'], False),
    ('/api/cost/timeline budget.used', '/api/cost/timeline', ['budget', 'used'], True),
    ('/api/cost/timeline budget.remaining', '/api/cost/timeline', ['budget', 'remaining'], False),
    ('/api/cost/timeline budget.percent_used', '/api/cost/timeline', ['budget', 'percent_used'], True),
    ('/api/cost/timeline iterations[0].cost_usd', '/api/cost/timeline', ['current_run', 'iterations', 0, 'cost_usd'], True),
]
MISSING = object()
def dig(d, keys):
    for k in keys:
        try:
            d = d[k]
        except (KeyError, IndexError, TypeError):
            return MISSING
    return d
def isnum(v):
    return isinstance(v, numbers.Real) and not isinstance(v, bool)
bad = []
for label, path, keys, zero in FIELDS:
    v = dig(got[path], keys)
    if v is MISSING:
        bad.append(f'{label} missing')
    elif kind == 'unmeasured' and v is not None:
        bad.append(f'{label} = {v!r}, want null')
    elif kind == 'measured' and not (isnum(v) and v > 0):
        bad.append(f'{label} = {v!r}, want a positive number')
    elif kind == 'measured-zero' and not (isnum(v) and (v == 0) == zero):
        bad.append(f'{label} = {v!r}, want {"0" if zero else "a positive number"}')
    elif kind not in ('unmeasured', 'measured', 'measured-zero'):
        bad.append(f'{label}: scenario {scenario!r} has no expectation')
status = dig(got['/api/cost/timeline'], ['budget', 'status'])
if kind == 'unmeasured' and status in ('ok', 'warn', 'exceeded', MISSING):
    bad.append(f'/api/cost/timeline budget.status = {status!r} claims a reading')
if kind != 'unmeasured' and status != 'ok':
    bad.append(f'/api/cost/timeline budget.status = {status!r}, want ok')
# Totals: exact value (null, 0 or a number) and an exact partial flag, which
# must be present: a mixed total that does not say "partial" reads as complete.
def same(v, want):
    if want is None:
        return v is None
    return isnum(v) and abs(v - want) < 1e-9
_, want_total, want_partial, want_runs, want_fleet, want_fleet_partial = PLAN
TOTALS = [
    ('/api/cost/timeline project_total_usd', dig(got['/api/cost/timeline'], ['project_total_usd']), want_total),
    ('/api/cost/timeline project_total_partial', dig(got['/api/cost/timeline'], ['project_total_partial']), want_partial),
    ('/api/fleet/summary total_cost_usd', dig(got['/api/fleet/summary'], ['total_cost_usd']), want_fleet),
    ('/api/fleet/summary total_cost_partial', dig(got['/api/fleet/summary'], ['total_cost_partial']), want_fleet_partial),
]
for label, v, want in TOTALS:
    if v is MISSING:
        bad.append(f'{label} missing')
    elif isinstance(want, bool):
        if v is not want:
            bad.append(f'{label} = {v!r}, want {want!r}')
    elif not same(v, want):
        bad.append(f'{label} = {v!r}, want {"null" if want is None else repr(want)}')
runs = got['/api/fleet/runs']
fleet = sorted((r.get('cost_usd', MISSING) for r in runs if isinstance(r, dict)),
               key=lambda v: (v is not None, v if isnum(v) else 0))
if len(fleet) != len(want_runs) or not all(same(v, w) for v, w in zip(fleet, want_runs)):
    bad.append(f'/api/fleet/runs cost_usd = {fleet!r}, want {want_runs!r}')
# Partial flags: some iterations recorded a cost and some did not (mixed only).
# A sum over them is a lower bound and must say so; a fully measured, a
# measured-zero and an unmeasured run are never partial.
want_part = scenario == 'mixed'
PARTS = [
    ('/api/cost/timeline current_run.partial', dig(got['/api/cost/timeline'], ['current_run', 'partial'])),
    ('/api/cost/timeline budget.partial', dig(got['/api/cost/timeline'], ['budget', 'partial'])),
    ('/api/budget partial', dig(got['/api/budget'], ['partial'])),
]
for label, v in PARTS:
    if v is MISSING:
        bad.append(f'{label} missing')
    elif v is not want_part:
        bad.append(f'{label} = {v!r}, want {want_part!r}')
# An iteration that recorded nothing has null tokens and no model, not 0 and
# not the pricing default "sonnet"; a measured iteration keeps its numbers.
its = dig(got['/api/cost/timeline'], ['current_run', 'iterations'])
its = its if isinstance(its, list) else []
blank = [it for it in its if isinstance(it, dict) and it.get('cost_usd') is None]
read = [it for it in its if isinstance(it, dict) and it.get('cost_usd') is not None]
for it in blank:
    for k in ('input_tokens', 'output_tokens'):
        if it.get(k) is not None:
            bad.append(f"/api/cost/timeline unmeasured iteration {it.get('iteration')} {k} = {it.get(k)!r}, want null")
    if it.get('iteration') == 2 and it.get('model') is not None:
        bad.append(f"/api/cost/timeline iteration 2 model = {it.get('model')!r}, want null (none recorded)")
if kind == 'measured' and not all(isnum(it.get('input_tokens')) and it['input_tokens'] > 0 for it in read):
    bad.append(f'/api/cost/timeline measured iteration tokens = {[it.get("input_tokens") for it in read]!r}, want positive')
if (scenario == 'mixed') != bool(blank) and kind != 'unmeasured':
    bad.append(f'/api/cost/timeline has {len(blank)} unmeasured iteration(s) in {scenario}')
# Non-cost unknowns on the same app: the context tracker, token economics,
# learning confidence and per-gate results. Only 'measured' wrote readings.
real = scenario == 'measured'
UNKNOWNS = [
    ('/api/context current.context_window_pct', ['current', 'context_window_pct'], 42.5),
    ('/api/context current.total_tokens', ['current', 'total_tokens'], 1500),
    ('/api/context current.estimated_cost_usd', ['current', 'estimated_cost_usd'], 0.12),
    ('/api/context totals.iterations_tracked', ['totals', 'iterations_tracked'], 1),
    ('/api/memory/economics total_tokens', ['total_tokens'], 2000),
    ('/api/memory/economics hit_rate', ['hit_rate'], 0.7),
    ('/api/memory/economics savings_percent', ['savings_percent'], 62.5),
    ('/api/learning/metrics avgConfidence', ['avgConfidence'], 0.8),
]
for label, keys, want in UNKNOWNS:
    v = dig(got[label.split(' ')[0]], keys)
    if v is MISSING:
        bad.append(f'{label} missing')
    elif not same(v, want if real else None):
        bad.append(f'{label} = {v!r}, want {want if real else "null"}')
gates = dig(got['/api/council/gate'], ['gates'])
if not isinstance(gates, list) or len(gates) != (1 if real else 0):
    bad.append(f'/api/council/gate gates = {gates!r}, want {"the one recorded gate" if real else "[] (no constant pending rows)"}')
print(f'CHECKED {len(FIELDS) + len(TOTALS) + len(PARTS) + len(UNKNOWNS) + 4} fields ({scenario})')
for b in bad:
    print('BAD ' + b)
sys.exit(1 if bad else 0)
PY

# WEB-APP LEG. The web-app's own status readers (GET /api/session/status, which
# the workspace and home cost/iteration tiles read, and /api/session/memory)
# seeded cost 0.0, iteration 0, complexity "standard", a 10-iteration cap and
# running_agents 0 before anything was recorded. Separate process: the web-app
# module is also named `server`. measured writes the state files the CLI writes
# and must read them back; unmeasured has none and must read null.
cat > "$MOAT_TMP/webapp-status.py" <<'PY'
import json, os, sys
repo, home, scenario = sys.argv[1:4]
os.environ.pop('LOKI_MAX_ITERATIONS', None)
sys.path.insert(0, os.path.join(repo, 'web-app'))
import server
from fastapi.testclient import TestClient
server.session.project_dir = home
loki = os.path.join(home, '.loki')
os.makedirs(loki, exist_ok=True)
if scenario == 'measured':
    with open(os.path.join(loki, 'dashboard-state.json'), 'w') as fh:
        json.dump({'phase': 'act', 'iteration': 3, 'complexity': 'simple',
                   'tasks': {'pending': 2, 'inProgress': 0},
                   'tokens': {'input': 1000, 'output': 500, 'cost_usd': 2.5}}, fh)
    with open(os.path.join(loki, 'autonomy-state.json'), 'w') as fh:
        json.dump({'maxIterations': 8}, fh)
client = TestClient(server.app, raise_server_exceptions=False)
got = {}
for path in ('/api/session/status', '/api/session/memory'):
    r = client.get(path)
    if r.status_code != 200:
        print(f'FATAL GET {path} -> HTTP {r.status_code}')
        sys.exit(2)
    got[path] = r.json()
st, mem = got['/api/session/status'], got['/api/session/memory']
real = {'iteration': 3, 'complexity': 'simple', 'pending_tasks': 2, 'max_iterations': 8, 'cost': 2.5}
bad = []
for k, want in real.items():
    v = st.get(k, 'MISSING')
    exp = want if scenario == 'measured' else None
    if v != exp or isinstance(v, bool):
        bad.append(f'/api/session/status {k} = {v!r}, want {exp!r}')
# Tracked by nothing in this server: unknown in every scenario.
if st.get('running_agents', 'MISSING') is not None:
    bad.append(f"/api/session/status running_agents = {st.get('running_agents', 'MISSING')!r}, want null")
if mem.get('total_tokens', 'MISSING') is not None:
    bad.append(f"/api/session/memory total_tokens = {mem.get('total_tokens', 'MISSING')!r}, want null")
print(f'CHECKED {len(real) + 2} web-app fields ({scenario})')
for b in bad:
    print('BAD ' + b)
sys.exit(1 if bad else 0)
PY

# Prints nothing and returns 0 on pass; prints the reason and returns 1 on fail.
cost_server_leg() {
    py_server -c 'import fastapi, httpx' >/dev/null 2>&1 \
        || { echo "prerequisite missing: python fastapi + httpx (the server leg drives the real app)"; return 1; }
    local sc d rc out
    # Controls first: a red unmeasured leg means something only once the same
    # probe has read real numbers back.
    for sc in measured measured-zero mixed unmeasured; do
        d="$MOAT_TMP/budget-$sc"
        mkdir -p "$d/.loki"
        rc=0
        out="$(cd "$d" && py_server "$MOAT_TMP/budget-null.py" "$REPO_ROOT" "$d/.loki" "$sc" 2> "$d/err")" || rc=$?
        printf '%s\n' "$out" | sed "s/^/  server[$sc] /" >&2
        grep -q '^CHECKED ' <<<"$out" \
            || { echo "server leg ($sc) did not run (rc=$rc): $(tail -c 200 "$d/err" | tr '\n' ' ') $(tr '\n' ' ' <<<"$out")"; return 1; }
        [ "$rc" = 0 ] \
            || { echo "server leg ($sc): $(grep '^BAD ' <<<"$out" | head -4 | sed 's/^BAD //' | tr '\n' ';')"; return 1; }
    done
    for sc in measured unmeasured; do
        d="$MOAT_TMP/webapp-$sc"
        mkdir -p "$d/proj"
        rc=0
        out="$(cd "$d" && py_server "$MOAT_TMP/webapp-status.py" "$REPO_ROOT" "$d/proj" "$sc" 2> "$d/err")" || rc=$?
        printf '%s\n' "$out" | sed "s/^/  webapp[$sc] /" >&2
        grep -q '^CHECKED ' <<<"$out" \
            || { echo "web-app leg ($sc) did not run (rc=$rc): $(tail -c 200 "$d/err" | tr '\n' ' ') $(tr '\n' ' ' <<<"$out")"; return 1; }
        [ "$rc" = 0 ] \
            || { echo "web-app leg ($sc): $(grep '^BAD ' <<<"$out" | head -4 | sed 's/^BAD //' | tr '\n' ';')"; return 1; }
    done
    return 0
}

case_cost_zero() {
    command -v python3 >/dev/null 2>&1 || { echo "FAIL|prerequisite missing: python3"; return 0; }
    local ctl="$MOAT_TMP/cost-ctl" n rc good f out
    mkdir -p "$ctl"
    # Positive control: every synthetic bad line flagged individually; the
    # measured-zero and not-recorded lines never flagged.
    n=0
    while IFS= read -r snippet; do
        n=$((n + 1))
        printf '%s\n' "$snippet" > "$ctl/bad$n.js"
        rc=0; python3 "$MOAT_TMP/cost-zero.py" "$ctl/bad$n.js" >/dev/null 2>&1 || rc=$?
        [ "$rc" = 1 ] || { echo "FAIL|positive control: synthetic bad line not flagged: $snippet"; return 0; }
    done <<'EOF'
const c = status.cost || 0;
const label = (run.cost_usd ?? 0).toFixed(2);
if (cost == null || isNaN(cost)) return '$0.00';
const s = total > 0 ? '$' + total.toFixed(2) : "$0.00";
if (!spend) return `$0.00`;
EOF
    [ "$n" = 5 ] || { echo "FAIL|positive control read $n of 5 synthetic lines"; return 0; }
    printf '%s\n' "if (amount === 0) return '\$0.00';" "if (v === null || v === undefined) return 'Not recorded';" \
        "// a cost || 0 here would lie" > "$ctl/good.js"
    rc=0; out="$(python3 "$MOAT_TMP/cost-zero.py" "$ctl/good.js" 2>&1)" || rc=$?
    [ "$rc" = 0 ] || { echo "FAIL|positive control: a correct line was flagged: $(grep '^HIT' <<<"$out" | head -1)"; return 0; }

    # Known-correct cost formatters (null -> "not recorded"/"unknown", measured
    # 0 -> "$0.00") must pass. Each is extracted by name so the control is the
    # formatter itself; each must still contain its required marker (a toFixed
    # call, or the null seeding), or the control is vacuous.
    good=0
    while IFS='|' read -r f fn need; do
        [ -f "$REPO_ROOT/$f" ] || { echo "FAIL|known-correct file missing: $f"; return 0; }
        python3 - "$REPO_ROOT/$f" "$fn" > "$ctl/known.js" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding='utf-8').read().split('\n')
start = next((i for i, l in enumerate(lines) if re.search(sys.argv[2], l)), None)
if start is None:
    sys.exit(3)
depth, out = 0, []
for l in lines[start:]:
    out.append(l)
    depth += l.count('{') - l.count('}')
    if depth <= 0 and '{' in ''.join(out):
        break
print('\n'.join(out))
PY
        grep -qE "$need" "$ctl/known.js" \
            || { echo "FAIL|known-correct code $fn not found in $f or lost its marker '$need'; control is vacuous"; return 0; }
        rc=0; out="$(python3 "$MOAT_TMP/cost-zero.py" "$ctl/known.js" 2>&1)" || rc=$?
        [ "$rc" = 0 ] || { echo "FAIL|known-correct formatter $f $fn flagged (probe too broad): $(grep '^HIT' <<<"$out" | head -1)"; return 0; }
        good=$((good + 1))
    done <<'EOF'
dashboard-ui/components/loki-context-tracker.js|_formatUSD\(amount\)|toFixed\(
dashboard-ui/components/loki-cost-dashboard.js|^  constructor\(\)|estimated_cost_usd: null
dashboard/static/cost.html|function fmtUsd\(|toFixed\(
web-app/src/pages/MetricsPage.tsx|function formatUsd\(|toFixed\(
dashboard-ui/core/loki-unified-styles.js|export function formatUSD\(|toFixed\(
EOF
    [ "$good" = 5 ] || { echo "FAIL|only $good of 5 known-correct formatters were checked"; return 0; }

    local srv="" srv_fail=""
    srv="$(cost_server_leg)" || srv_fail="${srv:-server leg failed with no reason}"

    rc=0
    python3 "$MOAT_TMP/cost-zero.py" "$REPO_ROOT/dashboard-ui/components" "$REPO_ROOT/dashboard-ui/core" \
        "$REPO_ROOT/web-app/src" "$REPO_ROOT/dashboard/static" > "$MOAT_TMP/cost.txt" 2>&1 || rc=$?
    sed "s#$REPO_ROOT/##; s/^/  /" "$MOAT_TMP/cost.txt" >&2
    case "$rc" in
        0) if [ -n "$srv_fail" ]; then echo "FAIL|$srv_fail"
           else echo "PASS|$(grep '^SCANNED' "$MOAT_TMP/cost.txt") files, $good known-correct files pass; /api/cost, /api/budget, /api/cost/timeline (budget and project total) and /api/fleet/runs + /api/fleet/summary send null for unmeasured spend, numbers for measured and measured-zero, a partial total and partial current run/budget for mixed; context, token economics, learning confidence, gate rows and web-app session status are null or empty until measured"; fi ;;
        1) echo "FAIL|$(grep -c '^HIT' "$MOAT_TMP/cost.txt") unmeasured-cost-as-zero site(s): $(grep '^HIT' "$MOAT_TMP/cost.txt" | sed "s#^HIT $REPO_ROOT/##; s/: .*//" | tr '\n' ' ')${srv_fail:+; $srv_fail}" ;;
        *) echo "FAIL|scanner refused (rc=$rc)${srv_fail:+; $srv_fail}" ;;
    esac
}

# ---------------------------------------------------------------------------
# Runner: exactly one CASE line per case, even when a case function dies.
# ---------------------------------------------------------------------------
EMITTED=""
run_case() {
    local id="$1" desc="$2" fn="$3" out rc status reason
    rc=0
    out="$("$fn")" || rc=$?
    out="${out##*$'\n'}"
    status="${out%%|*}"
    reason="${out#*|}"
    case "$status" in
        PASS|FAIL) ;;
        *) status=FAIL; reason="case crashed (rc=$rc, last output: ${out:0:120})" ;;
    esac
    # A function that printed PASS and then failed has not passed.
    if [ "$status" = PASS ] && [ "$rc" -ne 0 ]; then status=FAIL; reason="printed PASS but exited $rc: $reason"; fi
    reason="$(printf '%s' "$reason" | tr '\n\r' '  ')"
    if [ "$status" = PASS ]; then
        printf 'CASE %s PASS %s (%s)\n' "$id" "$desc" "$reason"
    else
        printf 'CASE %s FAIL %s: %s\n' "$id" "$desc" "$reason"
    fi
    EMITTED="$EMITTED $id"
}

START_S=$SECONDS
run_case P7.webapp-client-routes-exist "web-app client paths resolve to real web-app/server.py routes" case_webapp_routes
run_case P7.dashboard-client-routes-exist "dashboard-ui /api paths resolve to real dashboard/server.py routes" case_dashboard_routes
run_case P7.no-sample-data-panels "no production page reaches sample, random or hardcoded-metric data panels" case_sample_panels
run_case P7.unmeasured-cost-never-zero "no cost path, client or server, turns unmeasured cost into 0 or \$0.00" case_cost_zero

for id in P7.webapp-client-routes-exist P7.dashboard-client-routes-exist P7.no-sample-data-panels P7.unmeasured-cost-never-zero; do
    case " $EMITTED " in *" $id "*) ;; *) printf 'CASE %s FAIL runner did not emit this case\n' "$id" ;; esac
done
diag "runtime $((SECONDS - START_S))s"
exit 0
