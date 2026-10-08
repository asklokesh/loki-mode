#!/usr/bin/env bash
# 132-E2: every web-app/*.py must ship in the npm package and the Docker image
# without a hand-maintained per-file list. package.json files[] and the
# docker/Dockerfile COPY must use a glob.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

cd "$REPO_ROOT" || exit 2

NEWMOD="$REPO_ROOT/web-app/zz_new.py"
cleanup() { rm -f -- "$NEWMOD"; }
trap cleanup EXIT

echo "T1 -- package.json files[] uses a glob for web-app python"
if python3 -I - <<'PY'
import json, sys
files = json.load(open("package.json"))["files"]
py = [f for f in files if f.startswith("web-app/") and f.endswith(".py")]
named = [f for f in py if "*" not in f]
globbed = [f for f in py if "*" in f]
sys.exit(0 if globbed and not named else 1)
PY
then ok "files[] has a web-app/*.py glob and no individually named module"
else bad "files[] names web-app python modules individually (or has no glob)"; fi

echo "T2 -- Dockerfile COPY uses a glob, not individual module names"
line="$(grep -n '^COPY .*web-app/.*requirements.txt' docker/Dockerfile | head -1)"
if [ -z "$line" ]; then
    bad "no Dockerfile COPY line for web-app python found"
elif printf '%s\n' "$line" | grep -q 'web-app/\*\.py' \
    && ! printf '%s\n' "$line" | grep -Eq 'web-app/[A-Za-z0-9_]+\.py'; then
    ok "COPY uses web-app/*.py"
else
    bad "COPY names modules individually: $line"
fi

echo "T3 -- npm pack lists every tracked web-app/*.py plus a new temp module"
printf '# temp module for 132-E2\n' >"$NEWMOD"
listing="$(timeout -k 5 120 npm pack --dry-run --json --ignore-scripts 2>/dev/null \
    | python3 -I -c 'import json,sys; [print(f["path"]) for f in json.load(sys.stdin)[0]["files"]]')"
rm -f -- "$NEWMOD"
missing=""
for f in $(git ls-files 'web-app/*.py' | grep -Ev '^web-app/.+/'); do
    printf '%s\n' "$listing" | grep -qx "$f" || missing="$missing $f"
done
if [ -z "$missing" ]; then ok "all tracked top-level web-app/*.py are in the pack list"
else bad "missing from pack list:$missing"; fi
if printf '%s\n' "$listing" | grep -qx 'web-app/zz_new.py'; then
    ok "untracked new module web-app/zz_new.py is packed (glob, not a list)"
else bad "web-app/zz_new.py not packed"; fi

echo
echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
