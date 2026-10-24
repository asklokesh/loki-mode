#!/usr/bin/env bash
# check_author.py context: spec and runner config reach the author, nothing else.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CA="$SCRIPT_DIR/../autonomy/lib/check_author.py"
T="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")"
trap 'rm -rf -- "$T"' EXIT
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

R="$T/repo"; mkdir -p "$R/src" "$R/tests/unit" "$R/tests/x" "$R/.hidden"
printf '# PRD\nSPEC_CANARY_1\n' > "$R/prd.md"
printf 'IMPL_CANARY_1\ndef greet(n): return n\n' > "$R/src/app.py"
printf 'IMPL_CANARY_2\n' > "$R/tests/test_app.py"
printf '[pytest]\nCFG_CANARY_1\n' > "$R/pytest.ini"
printf '{"name":"x"}\n' > "$R/package.json"
printf 'IMPL_SRC_VITEST\n' > "$R/src/vitest.config.ts"
printf 'IMPL_TESTS_JEST\n' > "$R/tests/x/jest.config.js"
printf 'IMPL_HIDDEN_PKG\n' > "$R/.hidden/package.json"
printf 'IMPL_UNTRACKED_TOML\n' > "$R/pyproject.toml"
git -C "$R" init -q
git -C "$R" add prd.md src/app.py tests/test_app.py pytest.ini package.json src/vitest.config.ts tests/x/jest.config.js .hidden/package.json

out="$T/a.json"; out2="$T/b.json"
python3 "$CA" context --spec "$R/prd.md" --repo "$R" > "$out"; rc=$?
[ "$rc" -eq 0 ] && ok "exit 0" || bad "exit $rc"
python3 "$CA" context --spec "$R/prd.md" --repo "$R" > "$out2"
cmp -s "$out" "$out2" && ok "deterministic" || bad "output differs between runs"

chk() { python3 - "$out" "$1" <<'PY'
import json, sys, hashlib
d = json.load(open(sys.argv[1])); paths = [i["path"] for i in d["inputs"]]
what = sys.argv[2]
if what == "keys": sys.exit(0 if set(d) == {"spec_sha256", "inputs", "prompt"} else 1)
if what == "spec": sys.exit(0 if "prd.md" in paths and "SPEC_CANARY_1" in d["prompt"] and d["spec_sha256"] == hashlib.sha256(b"# PRD\nSPEC_CANARY_1\n").hexdigest() else 1)
if what == "noimpl": sys.exit(0 if not any(p.startswith(("src/", "tests/")) for p in paths) and "IMPL_" not in d["prompt"] else 1)
if what == "cfg": sys.exit(0 if {"pytest.ini", "package.json"} <= set(paths) and not any(x in paths for x in ("src/vitest.config.ts", "tests/x/jest.config.js", ".hidden/package.json", "pyproject.toml")) and "CFG_CANARY_1" in d["prompt"] else 1)
if what == "hash": sys.exit(0 if all(len(i["sha256"]) == 64 for i in d["inputs"]) else 1)
sys.exit(1)
PY
}
chk keys && ok "output keys" || bad "output keys"
chk spec && ok "spec in inputs, prompt and hash" || bad "spec missing"
chk noimpl && ok "no implementation file or content" || bad "implementation leaked"
chk cfg && ok "runner config included" || bad "runner config missing"
chk hash && ok "every input hashed" || bad "input hash missing"
FS="$T/fsrepo"; mkdir -p "$FS"; printf 'S\n' > "$FS/prd.md"; printf 'x\n' > "$FS/package.json"
git -C "$FS" init -q; git -C "$FS" add prd.md package.json
printf '#!/bin/sh\ntouch "%s/FSMON_RAN"\nexit 0\n' "$T" > "$T/fsmon.sh"; chmod +x "$T/fsmon.sh"
git -C "$FS" config core.fsmonitor "$T/fsmon.sh"
python3 "$CA" context --spec "$FS/prd.md" --repo "$FS" >/dev/null 2>&1
[ ! -e "$T/FSMON_RAN" ] && ok "planted core.fsmonitor did not run" || bad "core.fsmonitor executed"
# GIT_DIR in the caller env must not redirect the listing at another repo.
NG="$T/nogit"; mkdir -p "$NG"; printf 'SPEC_CANARY_2\n' > "$NG/prd.md"; printf 'x\n' > "$NG/pytest.ini"
GIT_DIR="$R/.git" GIT_WORK_TREE="$R" python3 "$CA" context --spec "$NG/prd.md" --repo "$NG" > "$T/ng.json"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if [i["path"] for i in d["inputs"]]==["prd.md"] else 1)' "$T/ng.json" && ok "non-git repo fails closed (spec only)" || bad "non-git repo leaked files"
python3 "$CA" context --spec "$T/nope.md" --repo "$R" >/dev/null 2>&1; [ $? -ne 0 ] && ok "missing spec rejected" || bad "missing spec accepted"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
