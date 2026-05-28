#!/usr/bin/env bash
# v7.7.25 test: /api/memory/consolidate and /api/memory/retrieve must run the
# REAL memory engine, not return hardcoded empty/zero stubs. Also asserts the
# bench tools are present in the npm tarball (tools/ packaging fix).
set -u

PY=$(command -v python3.12 || command -v python3)
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Test 1+2: the two endpoints return REAL data against a seeded temp store.
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os
sys.path.insert(0, '.')
tmp = tempfile.mkdtemp(prefix='loki-dash-ep-')
try:
    mem = os.path.join(tmp, '.loki', 'memory')
    os.makedirs(mem)
    from memory.storage import MemoryStorage
    from memory.schemas import EpisodeTrace
    st = MemoryStorage(mem)
    for i in range(6):
        t = EpisodeTrace.create(task_id=f"t{i}", agent="dev", phase="DEVELOPMENT",
                                goal=f"build a REST API with JWT auth variant {i}")
        t.outcome = "success"; t.files_modified = [f"api/m{i}.py"]
        st.save_episode(t)
    from dashboard import server
    server._active_project_dir = tmp
    from fastapi.testclient import TestClient
    c = TestClient(server.app)

    r = c.post("/api/memory/retrieve", json={"goal": "REST API authentication", "top_k": 3})
    retrieve_ok = (r.status_code == 200
                   and isinstance(r.json().get("results"), list)
                   and len(r.json()["results"]) >= 1)

    cc = c.post("/api/memory/consolidate?hours=168")
    body = cc.json()
    consolidate_ok = (cc.status_code == 200
                      and body.get("episodesProcessed", 0) >= 1)

    print("ENDPOINTS_OK" if (retrieve_ok and consolidate_ok)
          else f"ENDPOINTS_FAIL: retrieve={retrieve_ok}({r.status_code}) consolidate={consolidate_ok}({cc.status_code})")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "ENDPOINTS_OK" ]; then
    ok "/api/memory/{retrieve,consolidate} run the real engine (not stubs)"
else
    bad "memory endpoints: $RESULT"
fi

# Test 3: empty-goal retrieve returns a clean empty result (no crash).
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os
sys.path.insert(0, '.')
tmp = tempfile.mkdtemp(prefix='loki-dash-ep-')
try:
    os.makedirs(os.path.join(tmp, '.loki', 'memory'))
    from dashboard import server
    server._active_project_dir = tmp
    from fastapi.testclient import TestClient
    c = TestClient(server.app)
    r = c.post("/api/memory/retrieve", json={})
    print("EMPTY_OK" if (r.status_code == 200 and r.json().get("results") == []) else f"EMPTY_FAIL: {r.status_code} {r.text[:80]}")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "EMPTY_OK" ]; then ok "empty-goal retrieve returns clean [] (no crash)"; else bad "empty retrieve: $RESULT"; fi

# Test 4: bench tools ship in the npm tarball (tools/ packaging fix).
if npm pack --dry-run 2>&1 | grep -q "tools/bench_cross_project_lift.py" \
   && npm pack --dry-run 2>&1 | grep -q "tools/bench_memory_retrieval.py"; then
    ok "bench tools present in npm tarball (tools/ in package.json files)"
else
    bad "bench tools missing from npm tarball"
fi

# Test 5: both Dockerfiles COPY tools/ so Docker users get the benches too.
if grep -q "COPY .*tools/ ./tools/" Dockerfile \
   && grep -q "COPY .*tools/ ./tools/" Dockerfile.sandbox; then
    ok "Dockerfile + Dockerfile.sandbox COPY tools/"
else
    bad "a Dockerfile is missing COPY tools/"
fi

# Cleanup any stray tarball from --dry-run (none expected) and temp dirs
rm -f loki-mode-*.tgz 2>/dev/null
bash -c 'for d in /tmp/loki-dash-ep-*; do rm -rf "$d" 2>/dev/null; done'

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
