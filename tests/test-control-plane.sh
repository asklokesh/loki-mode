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

# Structural guard (FC-32): never compare a hand-kept COPY list to the import graph. Stage exactly what the
# build stage of Dockerfile.control-plane COPYs (honoring WORKDIR and the relative/absolute destinations) into a
# scratch root, then run the real server bundle step there. A new import the Dockerfile does not deliver makes
# `bun build` fail to resolve it; a Dockerfile that copies the source tree needs no list edit. This is the
# docker-less equivalent of `docker build`; docker is not required.
stage_build() { # stage_build <repo> <stage-dir>: prints bun build output; rc 0 only if both bundles build
    local repo="$1" stage="$2"
    python3 - "$repo" "$stage" <<'PY' || return 1
import os, shutil, sys
repo, stage = sys.argv[1], sys.argv[2]
workdir, in_build = "/", False
def dest_path(d):
    d = d if d.startswith("/") else os.path.join(workdir, d)
    return os.path.normpath(stage + os.path.normpath(d))
for line in open(os.path.join(repo, "Dockerfile.control-plane")):
    parts = line.split()
    if not parts:
        continue
    op = parts[0].upper()
    if op == "FROM":
        if in_build:
            break
        in_build = True
    elif op == "WORKDIR" and in_build:
        workdir = parts[1]
    elif op == "COPY" and in_build:
        args = [a for a in parts[1:] if not a.startswith("--")]
        srcs, dst = args[:-1], args[-1]
        dp = dest_path(dst)
        for src in srcs:
            sp = os.path.join(repo, src)
            if not os.path.exists(sp):
                print("COPY source missing: " + src); sys.exit(1)
            if os.path.isdir(sp):
                shutil.copytree(sp, dp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("node_modules", "dist", "*.log"))
            else:
                os.makedirs(dp if dst.endswith("/") else os.path.dirname(dp), exist_ok=True)
                shutil.copy(sp, dp)
PY
    # Frozen deps are installed by the real step above; reuse them rather than reinstalling per fixture.
    ln -s "$REPO/packages/control-plane/node_modules" "$stage/src/packages/control-plane/node_modules" 2>/dev/null || true
    ( cd "$stage/src/packages/control-plane" || exit 1
      bun build src/server/serve.ts --target=bun --outfile dist/server.js \
          && bun build src/ask/tools_server.ts --target=bun --outfile dist/ask-tools-server.js )
}
step "install control-plane (frozen)" 120 bash -c "cd '$REPO/packages/control-plane' && bun install --frozen-lockfile"

# The real Dockerfile: bundle the server from exactly what it COPYs. No list to maintain.
SD="$T/stage-real"; mkdir -p "$SD"
if stage_build "$REPO" "$SD" >"$T/stage-real.log" 2>&1; then ok "server bundles from exactly what Dockerfile.control-plane COPYs"; else bad "server bundle from Dockerfile COPY set failed"; tail -15 "$T/stage-real.log"; fi

# Red-first fixtures (FC-32). mkrepo: a scratch repo with the real control plane + loki-ts/src + Dockerfile.
mkrepo() { # mkrepo <name>
    local d="$T/gfx/$1"
    mkdir -p "$d"
    tar -C "$REPO" --exclude node_modules --exclude dist -cf - packages/control-plane loki-ts/src schemas Dockerfile.control-plane | tar -C "$d" -xf -
    echo "$d"
}
# Legacy model: the hand-kept per-file COPY list this guard replaced.
legacy_dockerfile() { # legacy_dockerfile <dockerfile>: swap the tree COPY for the old list
    local f="$1"
    grep -v '^COPY loki-ts/src/ ' "$f" >"$f.tmp"
    awk -v list="$REPO/tests/fixtures/cp04-legacy-copy-list.txt" '/^COPY schemas\// { while ((getline l < list) > 0) print l } { print }' "$f.tmp" >"$f"
    rm -f "$f.tmp"
}
plant_import() { # plant_import <repo> <spec>: a brand new loki-ts file reached through redact.ts
    printf 'export const fc32Fresh = 1;\n' >"$1/loki-ts/src/util/fc32_fresh.ts"
    printf 'import { fc32Fresh } from "%s";\nexport const fc32Use = fc32Fresh;\n' "$2" >>"$1/loki-ts/src/util/redact.ts"
}
FX="$(mkrepo legacy-sanity)"; legacy_dockerfile "$FX/Dockerfile.control-plane"
if stage_build "$FX" "$T/stage-legacy-sanity" >"$T/s1.log" 2>&1; then ok "legacy list model bundles the unmodified tree (fixture sanity)"; else bad "legacy fixture sanity failed"; tail -10 "$T/s1.log"; fi
FX="$(mkrepo legacy-plant)"; legacy_dockerfile "$FX/Dockerfile.control-plane"; plant_import "$FX" "./fc32_fresh.ts"
if stage_build "$FX" "$T/stage-legacy-plant" >"$T/s2.log" 2>&1; then bad "legacy list model absorbed a new import with no list edit (should need one)"; else ok "RED-FIRST: a new loki-ts import breaks the legacy hand-kept list until a COPY line is added"; fi
FX="$(mkrepo tree-plant)"; plant_import "$FX" "./fc32_fresh.ts"
if stage_build "$FX" "$T/stage-tree-plant" >"$T/s3.log" 2>&1; then ok "tree COPY absorbs a new loki-ts import with no Dockerfile edit"; else bad "tree COPY failed on a new import"; tail -10 "$T/s3.log"; fi
FX="$(mkrepo tree-missing)"; plant_import "$FX" "./fc32_does_not_exist.ts"
if stage_build "$FX" "$T/stage-tree-missing" >"$T/s4.log" 2>&1; then bad "bundle stayed green with a missing import target"; else ok "bundle goes red when an import target is really missing"; fi
FX="$(mkrepo no-copy)"; grep -v '^COPY loki-ts/src/ ' "$FX/Dockerfile.control-plane" >"$FX/Dockerfile.tmp"; mv "$FX/Dockerfile.tmp" "$FX/Dockerfile.control-plane"
if stage_build "$FX" "$T/stage-no-copy" >"$T/s5.log" 2>&1; then bad "bundle stayed green with the loki-ts COPY deleted"; else ok "bundle goes red when the Dockerfile stops copying loki-ts/src"; fi
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
