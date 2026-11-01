#!/usr/bin/env bash
# npm tarball contents: `npm pack --dry-run --json --ignore-scripts` (no lifecycle
# hooks, so nothing is built or rewritten). Asserts every package.json "files" entry
# resolves to something on disk (paths produced only at publish time are listed in
# BUILT_AT_PUBLISH), the runtime-critical entries are packed, and no test code,
# bytecode, cache directory or stale doc tree is packed.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. add "tests/test-server-json-current.sh" to package.json "files": the
#      forbidden-entry check must fail.
#   2. remove "tests/detect-mock-problems.sh" from package.json "files": the
#      required-entry check must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need npm
need python3
cd "$ROOT" || exit 2

echo "TEST: npm pack contents"

npm pack --dry-run --json --ignore-scripts > "$T/pack.json" 2> "$T/pack.err" \
    || { bad "npm pack --dry-run failed: $(head -3 "$T/pack.err")"; finish; exit $?; }

out="$(python3 -I - "$T/pack.json" "$ROOT" <<'PY'
import glob, json, os, re, sys
pack, root = sys.argv[1:3]
entries = [f["path"] for f in json.load(open(pack))[0]["files"]]
pkg = json.load(open(os.path.join(root, "package.json")))
os.chdir(root)

# Produced by `npm run prepublishOnly` in release.yml, absent from a source checkout.
BUILT_AT_PUBLISH = {
    "packages/control-plane/dist/server.js",
    "packages/control-plane/dist/ask-tools-server.js",
    "packages/control-plane/ui/dist/",
}

def res(label, ok, detail=""):
    print(("OK " if ok else "NO ") + label + ((" :: " + detail) if detail else ""))

missing = []
for f in pkg["files"]:
    if f in BUILT_AT_PUBLISH or f.startswith("!"):
        continue
    if any(c in f for c in "*?["):
        hit = glob.glob(f, recursive=True)
    else:
        hit = [f] if os.path.exists(f) else []
    if not hit:
        missing.append(f)
res("every package.json files entry resolves on disk", not missing, " ".join(missing))

required = [
    "bin/loki", "bin/loki-mode.js", "SKILL.md", "VERSION", "package.json",
    "loki-ts/dist/loki.js", "providers/model_catalog.json", "autonomy/run.sh", "autonomy/loki",
    "skills/fixtures/demo-receipt/receipt.json", "skills/fixtures/demo-receipt/pubkey.jwk",
    "web-app/dist/index.html", "benchmarks/seeded-defects/manifest.json",
    "scripts/verify-pr-sandbox.sh",
    "tests/detect-mock-problems.sh", "tests/detect-test-mutations.sh",
    "tests/detect-semantic-test-problems.sh", "tests/detect-invariant-violations.sh",
    "tests/detect-hallucinated-deps.sh",
]
have = set(entries)
absent = [r for r in required if r not in have]
res("required runtime entries are packed", not absent, " ".join(absent))

import subprocess
tracked = set(subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split("\n"))

forbidden = []
for e in entries:
    if e.endswith((".pyc", ".pyo")) or "__pycache__" in e:
        # An untracked cache file is local debris that prepack deletes at publish; a tracked one is a defect.
        if e in tracked:
            forbidden.append(e)
        continue
    if re.search(r"(^|/)tests?/", e) and not re.match(r"tests/detect-[a-z-]+\.sh$", e):
        forbidden.append(e); continue
    if re.search(r"(\.test\.|\.spec\.|_test\.)(js|ts|py)$", e) or re.search(r"(^|/)test_[^/]+\.py$", e):
        forbidden.append(e); continue
    if e.startswith(("docs/v11/", "docs/certification/", "eval/", "demo/", "examples/", "vscode-extension/", "node_modules/")):
        forbidden.append(e)
res("no test code, bytecode, cache or stale doc tree is packed", not forbidden, " ".join(forbidden[:8]))

size = json.load(open(pack))[0]["size"]
res("tarball is under 12 MB (%d bytes)" % size, size < 12 * 1024 * 1024)
PY
)"
printf '%s\n' "$out" | while IFS= read -r l; do
    case "$l" in
        "OK "*) ok "${l#OK }" ;;
        "NO "*) bad "${l#NO }" ;;
    esac
done
# the loop above runs in a subshell, so count again here for the exit status
nok="$(printf '%s\n' "$out" | grep -c '^OK ')"
nno="$(printf '%s\n' "$out" | grep -c '^NO ')"
_min_pass=$((_min_pass + nok)); _min_fail=$((_min_fail + nno))

finish
