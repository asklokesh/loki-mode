#!/usr/bin/env bash
# P12-48 (D99 item 7): `loki backup` / `loki restore` of the dashboard state dir.
#   T1 round trip is byte-equal (audit chain still verifies after restore)
#   T2 restore refuses to overwrite a non-empty state dir without --force, and
#      --force keeps the old state aside
#   T3 a tampered archive is refused and nothing is written
#   T4 a missing sidecar (no --sha256) is refused
#   T5 an archive carrying an extra, unmanifested file is refused
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="${LOKI_BIN:-$REPO_ROOT/autonomy/loki}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# shellcheck disable=SC1091
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
_OWN_TMP=0
if [ -z "${LOKI_RUN_TMP:-}" ]; then loki_run_tmp_create || exit 1; _OWN_TMP=1; fi
_tmp_done() { [ "$_OWN_TMP" = 1 ] && loki_run_tmp_cleanup; return 0; }
trap _tmp_done EXIT

W="$LOKI_RUN_TMP/w"
mkdir -p "$W/state/audit" "$W/state/sub"
export LOKI_NO_BROWSER=1

# Fixture state: a real audit chain (via log_event) plus a binary file.
PY=$(command -v python3.12 || command -v python3)
LOKI_DASHBOARD_STATE_DIR="$W/state" HOME="$W/home" "$PY" - "$REPO_ROOT" "$W/state/audit" <<'PYEOF'
import sys, pathlib
sys.path.insert(0, sys.argv[1])
from dashboard import audit
audit.AUDIT_DIR = pathlib.Path(sys.argv[2])
for i in range(4):
    audit.log_event("backup.fixture", "t", resource_id=str(i))
PYEOF
head -c 2048 /dev/urandom > "$W/state/sub/blob.bin"
printf 'cfg\n' > "$W/state/config.json"
printf '123\n' > "$W/state/dashboard.pid"

tree_sum() { (cd "$1" && find . -type f ! -name '*.pid' | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "$f"; done); }

A="$W/b.tar.gz"
if bash "$LOKI" backup --dir "$W/state" --out "$A" >/dev/null 2>&1 && [ -s "$A" ] && [ -s "$A.sha256" ]; then
    ok "backup wrote archive and sidecar"
else
    bad "backup failed"
fi

echo "T1 round trip"
if bash "$LOKI" restore "$A" --dir "$W/restored" >/dev/null 2>&1 \
   && [ "$(tree_sum "$W/state")" = "$(tree_sum "$W/restored")" ] \
   && [ ! -e "$W/restored/LOKI-BACKUP-MANIFEST" ]; then
    ok "restore is byte-equal to the source (pid file excluded)"
else
    bad "round trip differs"
fi
if "$PY" "$REPO_ROOT/dashboard/audit.py" verify "$W/restored/audit" >/dev/null 2>&1; then
    ok "restored audit chain verifies"
else
    bad "restored audit chain does not verify"
fi

echo "T2 overwrite protection"
printf 'precious\n' > "$W/restored/keep.txt"
if bash "$LOKI" restore "$A" --dir "$W/restored" >/dev/null 2>&1; then
    bad "restore overwrote a non-empty dir without --force"
elif [ -f "$W/restored/keep.txt" ]; then
    ok "restore refused without --force and left state intact"
else
    bad "refusal damaged existing state"
fi
if bash "$LOKI" restore "$A" --dir "$W/restored" --force >/dev/null 2>&1 \
   && [ ! -e "$W/restored/keep.txt" ] \
   && ls "$W"/restored.pre-restore.*/keep.txt >/dev/null 2>&1; then
    ok "--force replaces and keeps the old state aside"
else
    bad "--force path wrong"
fi

echo "T3 tampered archive"
T="$W/t.tar.gz"
cp "$A" "$T"; cp "$A.sha256" "$T.sha256"
printf 'x' >> "$T"
if bash "$LOKI" restore "$T" --dir "$W/never1" >/dev/null 2>&1; then
    bad "tampered archive was restored"
elif [ ! -e "$W/never1" ]; then
    ok "tampered archive refused, nothing written"
else
    bad "tampered archive left a directory behind"
fi

echo "T4 missing sidecar"
cp "$A" "$W/nosidecar.tar.gz"
if bash "$LOKI" restore "$W/nosidecar.tar.gz" --dir "$W/never2" >/dev/null 2>&1; then
    bad "unverified restore accepted"
else
    ok "no sidecar and no --sha256 is refused"
fi
EXPECT="$(awk '{print $1}' "$A.sha256")"
if bash "$LOKI" restore "$W/nosidecar.tar.gz" --dir "$W/ok2" --sha256 "$EXPECT" >/dev/null 2>&1; then
    ok "--sha256 supplies the digest when no sidecar exists"
else
    bad "--sha256 restore failed"
fi

echo "T5 unmanifested file with a re-signed archive"
X="$W/x"
mkdir -p "$X"
tar -xzf "$A" -C "$X"
printf 'smuggled\n' > "$X/extra.txt"
tar -czf "$W/extra.tar.gz" -C "$X" .
shasum -a 256 "$W/extra.tar.gz" | awk -v n=extra.tar.gz '{print $1 "  " n}' > "$W/extra.tar.gz.sha256"
if bash "$LOKI" restore "$W/extra.tar.gz" --dir "$W/never3" >/dev/null 2>&1; then
    bad "archive with unmanifested file was restored"
else
    ok "unmanifested file rejected even with a matching digest"
fi
printf 'tampered\n' > "$X/config.json"
rm -f "$X/extra.txt"
tar -czf "$W/edit.tar.gz" -C "$X" .
shasum -a 256 "$W/edit.tar.gz" | awk -v n=edit.tar.gz '{print $1 "  " n}' > "$W/edit.tar.gz.sha256"
if bash "$LOKI" restore "$W/edit.tar.gz" --dir "$W/never4" >/dev/null 2>&1; then
    bad "edited file restored despite manifest"
else
    ok "edited file rejected by manifest even with a matching digest"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
