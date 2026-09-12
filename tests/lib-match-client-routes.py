import json, re, subprocess, sys, os

REPO = "/Users/lokesh/git/lokimode-anthropic"
WEBAPP = os.path.join(REPO, "web-app")

# --- server side: READ THE ROUTE TABLE, never regex source text -------------
sys.path.insert(0, WEBAPP)
_cwd = os.getcwd(); os.chdir(WEBAPP)
try:
    import server
finally:
    os.chdir(_cwd)

routes = []
for r in server.app.routes:
    p = getattr(r, "path", None)
    if not p or not p.startswith("/api"):
        continue
    m = getattr(r, "methods", None)      # APIWebSocketRoute has none
    routes.append((p, set(m) if m else {"WS"}))

if not routes:
    print("FATAL: zero /api routes extracted; the measurement is absent, not clean")
    sys.exit(2)

# FastAPI {param} -> the same {p} placeholder the client extractor emits.
def norm(p):
    return re.sub(r"\{[^}]*\}", "{p}", p)

server_set = {}
for p, methods in routes:
    server_set.setdefault(norm(p), set()).update(methods)

# --- client side ------------------------------------------------------------
client = json.load(open(sys.argv[1]))
if client["captured"] == 0:
    print("FATAL: zero client calls captured; vacuous run")
    sys.exit(2)
if client["unresolved"]:
    print(f"FATAL: {client['unresolved']} client path(s) unresolvable; refusing to under-report")
    sys.exit(2)

BASE = "/api"   # fetchJSON prefixes /api (client.ts:5 derives base from origin)
drift = []
for c in client["calls"]:
    if c["method"] is None:
        print(f"FATAL: client.ts:{c['line']} has a non-literal HTTP method")
        sys.exit(2)
    raw = c["path"].split("?")[0].rstrip("/")
    # Every segment must be fully literal or exactly {p}. No truncation.
    for seg in raw.split("/"):
        if "{p}" in seg and seg != "{p}":
            print(f"FATAL: client.ts:{c['line']} segment '{seg}' is partially interpolated")
            sys.exit(2)
    full = BASE + raw
    have = server_set.get(full)
    if have is None:
        drift.append((c["line"], c["method"], full, "NO ROUTE"))
    elif c["method"] not in have and "WS" not in have:
        drift.append((c["line"], c["method"], full, f"route exists but methods={sorted(have)}"))

print(f"  client calls checked: {client['captured']}   server /api routes: {len(server_set)}")
if drift:
    print(f"\n  DRIFT ({len(drift)}):")
    for line, method, path, why in sorted(drift):
        print(f"    client.ts:{line:<5} {method:<6} {path}   -> {why}")
    sys.exit(1)
print("  every client path resolves to a real route")
