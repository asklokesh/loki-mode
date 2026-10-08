#!/usr/bin/env bash
# CP-04 (docs/v10/CONTROL-PLANE.md): control plane wiring, end to end.
# Frozen installs, the control-plane tests as one bun process, the UI + server build, then the Wall check:
# `loki control serve` on an ephemeral port, `loki control backfill` of the CP-00 corpus, GET /v1/runs
# returns the corpus run count and GET / returns the built app. The server is stopped by recorded PID.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not installed"
    exit 0
fi
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"

T="$(mktemp -d "${TMPDIR:-/tmp}/cp-test.XXXXXX")"
SERVER_PID=""
HEALTH_PID=""
cleanup() {
    if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
    if [ -n "$HEALTH_PID" ]; then kill "$HEALTH_PID" 2>/dev/null || true; fi
    rm -rf -- "$T"
}
trap cleanup EXIT

# run_to <seconds> <cmd...>: bounded with timeout -k when available.
run_to() {
    local secs="$1"; shift
    if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" -k 10 "$secs" "$@"; else "$@"; fi
}
t() { # t <pass label> <fail label> <test cmd...>
    local pass="$1" fail="$2"; shift 2
    if "$@"; then ok "$pass"; else bad "$fail"; fi
}
step() { # step <label> <seconds> <cmd...>
    local label="$1" secs="$2"; shift 2
    if run_to "$secs" "$@" >"$T/step.log" 2>&1; then ok "$label"; else bad "$label"; tail -20 "$T/step.log"; fi
}

# Static guard: every value import from loki-ts/src in the control-plane source, including dynamic import(),
# several imports on one line, and the transitive value-import closure of loki-ts files, must be a COPY source.
cp_guard() { python3 - "$1" <<'PY'
import os, re, sys
repo = sys.argv[1]
src = os.path.join(repo, "packages/control-plane/src")
copied = set()
for line in open(os.path.join(repo, "docker", "Dockerfile.control-plane")):
    parts = line.split()
    if parts and parts[0].upper() == "COPY":
        args = [p for p in parts[1:] if not p.startswith("--")]
        copied.update(os.path.normpath(a) for a in args[:-1])
# Static (import|export ... from "x"), bare import "x", and dynamic import("x"); several per line.
pat = re.compile(r'(?:^|[;\n])\s*(?:import|export)(\s+type)?\b[^;]*?\bfrom\s*["\']([^"\']+)["\']|(?:^|[;\n])\s*import\s*["\']([^"\']+)["\']|\bimport\s*\(\s*["\']([^"\']+)["\']\s*\)')
def resolve(d, spec):
    base = os.path.normpath(os.path.join(d, spec))
    for c in (base, re.sub(r"\.js$", ".ts", base), base + ".ts", os.path.join(base, "index.ts")):
        if os.path.isfile(c):
            return os.path.relpath(c, repo)
    return os.path.relpath(base, repo)
def value_specs(p):
    for m in pat.finditer(open(p).read()):
        if m.group(1):
            continue
        spec = m.group(2) or m.group(3) or m.group(4)
        if spec and spec.startswith("."):
            yield spec
need = set()
queue = []
for d, _, files in os.walk(src):
    for f in files:
        if f.endswith((".ts", ".tsx")):
            queue.append(os.path.join(d, f))
seen = set()
while queue:
    p = queue.pop()
    for spec in value_specs(p):
        rel = resolve(os.path.dirname(p), spec)
        if not rel.startswith("loki-ts/src/") or rel in need:
            continue
        need.add(rel)
        full = os.path.join(repo, rel)
        if os.path.isfile(full) and full not in seen:
            seen.add(full)
            queue.append(full)
for r in sorted(need):
    if r not in copied:
        print(r)
if not need:
    print("NO-IMPORTS-FOUND")
PY
}
MISSING="$(cp_guard "$REPO")"
t "Dockerfile.control-plane COPYs every loki-ts/src value import" "Dockerfile.control-plane lacks COPY for: $(echo "$MISSING" | tr '\n' ' ')" [ -z "$MISSING" ]

# Guard self-tests: each fixture tree must report the uncopied file. Type-only imports stay ignored.
mkfx() { # mkfx <name>: fresh fake repo with a Dockerfile copying only loki-ts/src/a.ts
    local d="$T/gfx/$1"
    mkdir -p "$d/packages/control-plane/src" "$d/loki-ts/src" "$d/docker"
    printf 'COPY loki-ts/src/a.ts /src/loki-ts/src/\n' >"$d/docker/Dockerfile.control-plane"
    printf 'export const a = 1;\n' >"$d/loki-ts/src/a.ts"
    printf 'export const x = 1;\nexport type T = number;\n' >"$d/loki-ts/src/x.ts"
    echo "$d"
}
FX="$(mkfx dyn)"
printf 'const m = await import("../../../loki-ts/src/x.ts");\n' >"$FX/packages/control-plane/src/d.ts"
t "guard catches dynamic import()" "guard missed dynamic import()" [ "$(cp_guard "$FX")" = "loki-ts/src/x.ts" ]
FX="$(mkfx two)"
printf 'import { a } from "../../../loki-ts/src/a.ts"; import { x } from "../../../loki-ts/src/x.ts";\n' >"$FX/packages/control-plane/src/d.ts"
t "guard catches a second import on one line" "guard missed second import on one line" [ "$(cp_guard "$FX")" = "loki-ts/src/x.ts" ]
FX="$(mkfx chain)"
printf 'import { a } from "../../../loki-ts/src/a.ts";\n' >"$FX/packages/control-plane/src/d.ts"
printf 'import { x } from "./x.ts";\nexport const a = x;\n' >"$FX/loki-ts/src/a.ts"
t "guard catches transitive loki-ts value import" "guard missed transitive loki-ts value import" [ "$(cp_guard "$FX")" = "loki-ts/src/x.ts" ]
FX="$(mkfx typeonly)"
printf 'import { a } from "../../../loki-ts/src/a.ts";\n' >"$FX/packages/control-plane/src/d.ts"
printf 'import type { T } from "./x.ts";\nexport const a: T = 1;\n' >"$FX/loki-ts/src/a.ts"
t "guard ignores type-only imports" "guard flagged a type-only import" [ -z "$(cp_guard "$FX")" ]
FX="$T/gfx/mut"
mkdir -p "$FX/packages/control-plane" "$FX/loki-ts" "$FX/docker"
cp -R "$REPO/packages/control-plane/src" "$FX/packages/control-plane/src"
cp -R "$REPO/loki-ts/src" "$FX/loki-ts/src"
grep -v 'util/redact.ts' "$REPO/docker/Dockerfile.control-plane" >"$FX/docker/Dockerfile.control-plane"
t "guard goes red when a real COPY line is deleted" "guard stayed green with a COPY line deleted" [ "$(cp_guard "$FX")" = "loki-ts/src/util/redact.ts" ]

step "install control-plane (frozen)" 120 bash -c "cd '$REPO/packages/control-plane' && bun install --frozen-lockfile"
step "install control-plane ui (frozen)" 120 bash -c "cd '$REPO/packages/control-plane/ui' && bun install --frozen-lockfile"
step "install loki-ts (frozen)" 120 bash -c "cd '$REPO/loki-ts' && bun install --frozen-lockfile"
# Run from the package so its bunfig.toml applies (it ignores the Playwright
# specs under test/e2e; from the repo root bun loads them and they throw).
step "control-plane tests pass as one bun process" 180 bash -c "cd '$REPO/packages/control-plane' && LOKI_NO_BROWSER=1 bun test ./test/"
step "ui typecheck + build and server bundle" 180 bash -c "cd '$REPO/packages/control-plane' && bun run build:all"

t "ui/dist/index.html built" "ui/dist/index.html missing" [ -f "$REPO/packages/control-plane/ui/dist/index.html" ]
t "dist/server.js bundled" "dist/server.js missing" [ -f "$REPO/packages/control-plane/dist/server.js" ]

# --- Wall check ---------------------------------------------------------------------------------------------------
LOKI="$REPO/bin/loki"
mkdir -p "$T/repo/.loki" "$T/home"
cp -R "$REPO/packages/control-plane/test/fixtures/runs" "$T/repo/.loki/runs"
WANT="$(grep -o '"run_count": *[0-9]*' "$REPO/packages/control-plane/test/fixtures/EXPECTED.json" | grep -o '[0-9]*$')"
loki_env() { env -i HOME="$T/home" PATH="$PATH" LOKI_TELEMETRY_DISABLED=1 LOKI_NO_BROWSER=1 "$@"; }

OUT="$(loki_env LOKI_CONTROL=0 "$LOKI" control serve 2>&1)"
t "LOKI_CONTROL=0 serve prints one off line" "off serve output: $OUT" [ "$OUT" = "loki control is off (LOKI_CONTROL=0). Unset it to turn the Control Plane back on." ]

# Bash fallback (LOKI_LEGACY_BASH=1): same off switch as the bun route; without bun it names bun and exits nonzero.
OUT="$(loki_env LOKI_LEGACY_BASH=1 LOKI_CONTROL=0 "$LOKI" control serve 2>&1)"
t "legacy bash LOKI_CONTROL=0 prints the off line" "legacy off output: $OUT" [ "$OUT" = "loki control is off (LOKI_CONTROL=0). Unset it to turn the Control Plane back on." ]
NOBUN_PATH="/usr/bin:/bin"
if ! PATH="$NOBUN_PATH" command -v bun >/dev/null 2>&1; then
    OUT="$(env -i HOME="$T/home" PATH="$NOBUN_PATH" LOKI_TELEMETRY_DISABLED=1 LOKI_LEGACY_BASH=1 bash "$LOKI" control serve 2>&1)"
    RC=$?
    case "$OUT" in *"requires bun"*) NAMED=1 ;; *) NAMED=0 ;; esac
    t "legacy bash without bun names bun and exits nonzero" "legacy no-bun rc=$RC output: $OUT" [ "$RC" -ne 0 -a "$NAMED" = 1 ]
fi

# exec chain (subshell -> env -> bin/loki -> bun) keeps $! equal to the CLI pid
( exec env -i HOME="$T/home" PATH="$PATH" LOKI_TELEMETRY_DISABLED=1 LOKI_NO_BROWSER=1 LOKI_CONTROL=1 "$LOKI" control serve --port 0 --db "$T/control.db" >"$T/serve.log" 2>&1 ) &
SERVER_PID=$!
URL=""
for _ in $(seq 1 100); do
    URL="$(grep -o 'http://127.0.0.1:[0-9]*' "$T/serve.log" 2>/dev/null | head -1)"
    [ -n "$URL" ] && break
    sleep 0.1
done
if [ -z "$URL" ]; then
    bad "server did not start"; cat "$T/serve.log"
else
    ok "server listening on loopback ($URL)"
    HEALTH_PID="$(curl -fsS "$URL/health" | grep -o '"pid":[0-9]*' | grep -o '[0-9]*$')"
    BACKFILL="$(loki_env LOKI_CONTROL=1 LOKI_CONTROL_URL="$URL" "$LOKI" control backfill "$T/repo" 2>&1)"
    case "$BACKFILL" in *"0 failed"*) ok "backfill reported 0 failed" ;; *) bad "backfill: $BACKFILL" ;; esac
    GOT="$(curl -fsS "$URL/v1/runs?limit=1" | grep -o '"total":[0-9]*' | grep -o '[0-9]*$')"
    t "GET /v1/runs total = corpus run count ($WANT)" "GET /v1/runs total '$GOT', want '$WANT'" [ "$GOT" = "${WANT:?no run_count in EXPECTED.json}" ]
    CT="$(curl -sS -o "$T/index.html" -w '%{http_code} %{content_type}' "$URL/")"
    case "$CT" in "200 text/html"*) ok "GET / is 200 text/html" ;; *) bad "GET / returned: $CT" ;; esac
    t "GET / carries the app root" "GET / lacks the app root" grep -q 'id="root"' "$T/index.html"
    SPA="$(curl -sS -o /dev/null -w '%{http_code}' "$URL/runs/some/deep/link")"
    t "SPA fallback serves deep links" "SPA fallback returned $SPA" [ "$SPA" = "200" ]
    API404="$(curl -sS -o /dev/null -w '%{http_code}' "$URL/v1/nope")"
    t "unknown /v1 path is 404, not index.html" "/v1/nope returned $API404" [ "$API404" = "404" ]
    STATUS="$(loki_env LOKI_CONTROL=1 LOKI_CONTROL_URL="$URL" "$LOKI" control status 2>&1)"
    case "$STATUS" in *"$WANT runs"*) ok "status reports the run count" ;; *) bad "status: $STATUS" ;; esac
fi

# Stop by recorded PID only: the CLI first (it forwards SIGTERM), then the server pid it reported.
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
if [ -n "$HEALTH_PID" ]; then
    for _ in $(seq 1 20); do kill -0 "$HEALTH_PID" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$HEALTH_PID" 2>/dev/null; then
        bad "server pid $HEALTH_PID survived its parent"
        kill "$HEALTH_PID" 2>/dev/null || true
    else
        ok "server stopped with the CLI"
    fi
    HEALTH_PID=""
fi

echo "control plane: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
