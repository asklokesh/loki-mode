#!/usr/bin/env bash
# loki edit --commit must commit an edit to a file that was untracked before the run,
# and must not commit an untracked file the edit left byte-identical.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")"
trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fails=$((fails+1)); }

mkdir -p "$T/bin" "$T/repo"
cat > "$T/bin/claude" <<'FAKE'
#!/usr/bin/env bash
echo "edited by fake" >> pre_untracked.txt
echo '{"result":"done","is_error":false,"total_cost_usd":0}'
FAKE
chmod +x "$T/bin/claude"

cd "$T/repo" || exit 1
git init -q .
git config user.name t
git config user.email t@t
echo base > tracked.txt
git add tracked.txt
git commit -q -m init
echo original > pre_untracked.txt
echo untouched > bystander.txt

# shellcheck source=/dev/null
source "$ROOT/autonomy/edit.sh"
PATH="$T/bin:$PATH" _cmd_edit_run --commit "touch the file" >"$T/out" 2>&1
rc=$?

if [ "$rc" -eq 0 ]; then ok "edit exits 0"; else bad "edit exit $rc"; cat "$T/out"; fi
committed="$(git show --name-only --pretty=format: HEAD)"
if echo "$committed" | grep -qx 'pre_untracked.txt'; then
    ok "modified pre-run untracked file committed"
else
    bad "modified pre-run untracked file not in commit (got: $committed)"
fi
if echo "$committed" | grep -qx 'bystander.txt'; then
    bad "byte-identical untracked file was committed"
else
    ok "byte-identical untracked file not committed"
fi

[ "$fails" -eq 0 ] || exit 1
echo "all passed"
