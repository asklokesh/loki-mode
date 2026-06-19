#!/usr/bin/env python3
"""A3 test: checkpoint sync/hydrate using a LocalStore stand-in for the object store."""
import os
import sys
import tempfile
import shutil

# Resolve the repo root from THIS file's location (works on any CI runner; the
# hardcoded absolute path did not).
REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "autonomy", "lib"))

# Snapshot env so this test (which sets LOKI_DIR / LOKI_STORAGE_BACKEND / LOKI_RUN_ID
# to temp values) never leaks into the rest of the pytest session. A leaked LOKI_DIR
# pointing at a now-deleted temp dir was breaking test_lokistore's parity test under
# pytest collection order. Restored in the finally-equivalent at the end.
_ENV_SNAPSHOT = {k: os.environ.get(k) for k in
                 ("LOKI_DIR", "LOKI_STORAGE_BACKEND", "LOKI_RUN_ID",
                  "LOKI_STORAGE_BUCKET", "LOKI_STORAGE_PREFIX", "LOKI_STORAGE_REGION")}

def _restore_env():
    for k, v in _ENV_SNAPSHOT.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

from lokistore import build_store  # noqa: E402

passed = 0
failed = 0
def check(cond, msg):
    global passed, failed
    if cond:
        print(f"PASS: {msg}"); passed += 1
    else:
        print(f"FAIL: {msg}"); failed += 1

work = os.path.realpath(tempfile.mkdtemp(prefix="loki-a3-"))
local_loki = os.path.join(work, "project", ".loki")
remote_dir = os.path.join(work, "objectstore")  # stands in for S3/GCS bucket
os.makedirs(local_loki, exist_ok=True)
os.makedirs(remote_dir, exist_ok=True)

# Point the shim's local + remote resolution at our temp dirs.
os.environ["LOKI_DIR"] = local_loki
os.environ["LOKI_STORAGE_BACKEND"] = "s3"          # force non-local code path
os.environ["LOKI_RUN_ID"] = "run-test-123"

import checkpoint_sync as cs  # noqa: E402
# The module read _BACKEND at import; force it to the non-local value.
cs._BACKEND = "s3"

# Stand-in object store = a LocalStore rooted at remote_dir.
remote_store = build_store({"backend": "local", "base_dir": remote_dir})
cs._get_store = lambda: remote_store

# --- create a local checkpoint, then sync ---
cp_dir = os.path.join(local_loki, "state", "checkpoints", "cp-1-1700000000")
os.makedirs(cp_dir, exist_ok=True)
with open(os.path.join(cp_dir, "metadata.json"), "w") as f:
    f.write('{"id":"cp-1-1700000000","iteration":1}')
with open(os.path.join(cp_dir, "autonomy-state.json"), "w") as f:
    f.write('{"iterationCount":1,"status":"running"}')

rc = cs.cmd_sync()
check(rc == 0, "sync returns 0")
remote_keys = remote_store.list("runs/run-test-123/state/checkpoints/")
check(len(remote_keys) == 2, f"both checkpoint objects appear in the object store (got {len(remote_keys)})")
check("runs/run-test-123/state/checkpoints/cp-1-1700000000/metadata.json" in remote_keys,
      "metadata.json present under run-scoped key")

# --- wipe local volume (fresh pod), then hydrate ---
shutil.rmtree(os.path.join(local_loki, "state", "checkpoints"))
check(not os.path.exists(cp_dir), "local checkpoints wiped (simulated fresh pod)")

rc = cs.cmd_hydrate()
check(rc == 0, "hydrate returns 0")
check(os.path.exists(os.path.join(cp_dir, "metadata.json")),
      "metadata.json hydrated back to the local volume")
with open(os.path.join(cp_dir, "metadata.json")) as f:
    content = f.read()
check('"cp-1-1700000000"' in content, "hydrated metadata content is intact (resume would see it)")

# --- hydrate guard: non-empty local volume is NOT clobbered ---
with open(os.path.join(cp_dir, "metadata.json"), "w") as f:
    f.write('{"id":"LOCAL-WINS"}')
rc = cs.cmd_hydrate()
with open(os.path.join(cp_dir, "metadata.json")) as f:
    content = f.read()
check("LOCAL-WINS" in content, "hydrate does NOT overwrite a non-empty local volume")

# --- local backend is a no-op ---
cs._BACKEND = "local"
os.environ["LOKI_STORAGE_BACKEND"] = "local"
rc_sync = cs.cmd_sync()
rc_hyd = cs.cmd_hydrate()
check(rc_sync == 0 and rc_hyd == 0, "local backend: sync+hydrate are no-ops returning 0")

# --- LOW-3: hydrate path-traversal guard. A real object store (S3/GCS) allows
# arbitrary key strings INCLUDING ".." segments, so checkpoint_sync.py must
# defend its OWN dest construction. A LocalStore stand-in cannot model that
# (its put() rejects traversal keys), so use a minimal fake whose list()/get_to()
# honor a malicious key. The guard must skip it -- nothing written outside .loki/.
work2 = os.path.realpath(tempfile.mkdtemp(prefix="loki-a3-trav-"))
local2 = os.path.join(work2, "project", ".loki")
os.makedirs(local2, exist_ok=True)
os.environ["LOKI_DIR"] = local2
os.environ["LOKI_STORAGE_BACKEND"] = "s3"
os.environ["LOKI_RUN_ID"] = "run-trav"
cs._BACKEND = "s3"

class _FakeStore:
    """Stands in for a real object store that permits arbitrary key strings."""
    _keys = {
        "runs/run-trav/state/checkpoints/cp-x/ok.json": b'{"ok":1}',
        "runs/run-trav/state/checkpoints/../../../../escape.txt": b"PWNED",
    }
    def list(self, prefix=""):
        return [k for k in self._keys if k.startswith(prefix)]
    def get_to(self, key, dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(self._keys[key])

cs._get_store = lambda: _FakeStore()
escape_target = os.path.realpath(os.path.join(local2, "..", "..", "..", "..", "escape.txt"))
rc_t = cs.cmd_hydrate()
check(rc_t == 0, "traversal hydrate returns 0 (best-effort)")
check(os.path.exists(os.path.join(local2, "state", "checkpoints", "cp-x", "ok.json")),
      "benign key hydrated under .loki/")
check(not os.path.exists(escape_target),
      "malicious ../ key skipped -- nothing written outside .loki/")
shutil.rmtree(work2, ignore_errors=True)

shutil.rmtree(work, ignore_errors=True)
_restore_env()  # never leak temp LOKI_* into the rest of the pytest session
print(f"\nA3 RESULTS: {passed} passed, {failed} failed")
# Dual-mode: as a script (python3 tests/test-...py) exit non-zero on failure;
# under pytest discovery (pytest.ini python_files includes test-*.py) a bare
# module-level sys.exit() raises INTERNALERROR and breaks the whole pytest run,
# so only sys.exit when run directly. pytest still sees a real failure via the
# assert below (the checks already ran at module load).
if __name__ == "__main__":
    sys.exit(1 if failed else 0)
else:
    assert failed == 0, f"A3 object-store sync: {failed} check(s) failed"
