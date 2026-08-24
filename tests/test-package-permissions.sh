#!/usr/bin/env bash
# npm artifacts must stay usable when packed from a restrictive checkout.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-package-permissions.XXXXXX")"
PRIVATE_PROBE="$REPO_ROOT/.packet368-private-probe"
PYCACHE_PROBE="$REPO_ROOT/events/__pycache__/packet368.cpython-999.pyc"
TRACKED_EXCLUDED="$REPO_ROOT/Dockerfile"
TRACKED_MODE="$(python3 -c 'import os,stat,sys; print(f"{stat.S_IMODE(os.stat(sys.argv[1]).st_mode):o}")' "$TRACKED_EXCLUDED")"
trap 'rm -rf "$WORK"; rm -f "$PRIVATE_PROBE"; rm -rf "$(dirname "$PYCACHE_PROBE")"; chmod "$TRACKED_MODE" "$TRACKED_EXCLUDED"' EXIT

printf 'must remain private\n' > "$PRIVATE_PROBE"
chmod 600 "$PRIVATE_PROBE"
chmod 600 "$TRACKED_EXCLUDED"
mkdir -p "$(dirname "$PYCACHE_PROBE")"
printf 'not a real bytecode file\n' > "$PYCACHE_PROBE"
chmod 600 "$PYCACHE_PROBE"

chmod 600 \
    "$REPO_ROOT/package.json" \
    "$REPO_ROOT/dashboard/server.py" \
    "$REPO_ROOT/loki-ts/dist/loki.js"
chmod 700 "$REPO_ROOT/bin/loki"

ROOT_TARBALL="$(cd "$REPO_ROOT" && npm pack --silent --pack-destination "$WORK" | tail -1)"
test -n "$ROOT_TARBALL"

chmod 600 \
    "$REPO_ROOT/sdk/typescript/package.json" \
    "$REPO_ROOT/sdk/typescript/dist/index.js" \
    "$REPO_ROOT/sdk/typescript/dist/index.d.ts" \
    "$REPO_ROOT/sdk/typescript/README.md"

SDK_TARBALL="$(cd "$REPO_ROOT/sdk/typescript" && npm pack --silent --pack-destination "$WORK" | tail -1)"
test -n "$SDK_TARBALL"

mkdir -p "$WORK/extracted-root" "$WORK/extracted-sdk"
tar xzf "$WORK/$ROOT_TARBALL" -C "$WORK/extracted-root"
tar xzf "$WORK/$SDK_TARBALL" -C "$WORK/extracted-sdk"
node "$WORK/extracted-root/package/tools/normalize-package-permissions.mjs" \
    "$WORK/extracted-root/package"
node "$WORK/extracted-sdk/package/scripts/normalize-package-permissions.mjs" \
    "$WORK/extracted-sdk/package"
echo "PASS: shipped normalizers run without Git metadata"

python3 - "$PRIVATE_PROBE" <<'PY'
import stat
import sys

mode = stat.S_IMODE(__import__('os').stat(sys.argv[1]).st_mode)
if mode != 0o600:
    raise SystemExit(f"untracked private file mode changed to {mode:04o}")
print("PASS: untracked private files are not made public")
PY

python3 - "$TRACKED_EXCLUDED" <<'PY'
import stat
import sys

mode = stat.S_IMODE(__import__('os').stat(sys.argv[1]).st_mode)
if mode != 0o600:
    raise SystemExit(f"excluded tracked file mode changed to {mode:04o}")
print("PASS: excluded tracked files are not normalized")
PY

python3 - "$WORK/$ROOT_TARBALL" "$WORK/$SDK_TARBALL" <<'PY'
import sys
import tarfile

failures = []

for artifact in sys.argv[1:]:
    with tarfile.open(artifact, "r:gz") as archive:
        for member in archive.getmembers():
            if "__pycache__" in member.name or member.name.endswith((".pyc", ".pyo")):
                failures.append(f"Python cache shipped: {artifact}:{member.name}")
            if member.isdir() and member.mode & 0o055 != 0o055:
                failures.append(
                    f"directory is not traversable: {artifact}:{member.name} ({member.mode:04o})"
                )
            elif member.isfile() and member.mode & 0o044 != 0o044:
                failures.append(
                    f"file is not readable: {artifact}:{member.name} ({member.mode:04o})"
                )

with tarfile.open(sys.argv[1], "r:gz") as root_archive:
    if any(member.name == "package/Dockerfile" for member in root_archive.getmembers()):
        failures.append("excluded tracked sentinel shipped in the root package")
    cli = root_archive.getmember("package/bin/loki")
    if cli.mode & 0o011 != 0o011:
        failures.append(
            f"CLI is not executable: {sys.argv[1]}:{cli.name} ({cli.mode:04o})"
        )

if failures:
    print("\n".join(failures), file=sys.stderr)
    raise SystemExit(1)

print("PASS: root and TypeScript SDK tarballs are group/other readable")
print("PASS: packaged CLI is group/other executable")
PY
