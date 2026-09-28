#!/usr/bin/env bash
# Installs the pinned gitleaks v8.30.0 binary that .githooks/pre-push uses to
# scan changed eval/loki10 task fixtures before they reach main (E-86). CI
# pins the same version independently (.github/workflows/security-audit.yml).
# Idempotent: does nothing if the pinned binary is already present at the
# right version AND its sidecar checksum still matches (see below).
set -euo pipefail

GITLEAKS_VERSION="8.30.0"
INSTALL_DIR="$HOME/.local/share/loki/bin"
BIN_PATH="$INSTALL_DIR/gitleaks-${GITLEAKS_VERSION}"
SIDECAR_PATH="${BIN_PATH}.sha256"

# LOKI_GITLEAKS_BASE_URL lets a test point this at a fixture origin (e.g.
# file:///path/to/fixtures) instead of the real GitHub release. It changes
# WHERE bytes are fetched from, never whether they are trusted: extraction
# below is gated on the hardcoded per-platform hash regardless of origin, so
# a test fixture that doesn't match one of those hashes is refused exactly
# like a compromised real download would be.
_base_url="${LOKI_GITLEAKS_BASE_URL:-https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}}"

# Verify a file's sha256 against a hardcoded hex digest, portably (macOS ships
# shasum, not sha256sum; most Linux ships sha256sum, not shasum).
_sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# Checks the installed binary against its sidecar hash file, written at
# install time. `gitleaks version` alone only proves SOME binary at this path
# prints that string -- it says nothing about which bytes are actually there.
# ponytail: the sidecar catches corruption, a stale pre-sidecar install, and
# accidental shadowing (a different binary placed at this exact path without
# going through this script). It does NOT stop someone who already has write
# access to $INSTALL_DIR: they can overwrite BIN_PATH and its sidecar
# together. That is a different trust boundary (local write access to the
# install dir) than the one this rework closes (a compromised or mirrored
# DOWNLOAD origin serving a fake tarball+checksum pair). Upgrade path if the
# local-write threat matters: hardcode the binary's own sha256 per platform
# here too, the same way the tarball hash below is hardcoded, so the sidecar
# is never the only record of what "verified" means.
_installed_and_verified() {
    [[ -x "$BIN_PATH" ]] || return 1
    [[ -f "$SIDECAR_PATH" ]] || return 1
    local _recorded _actual
    _recorded="$(cat "$SIDECAR_PATH" 2>/dev/null || true)"
    [[ -n "$_recorded" ]] || return 1
    _actual="$(_sha256_of "$BIN_PATH")"
    [[ "$_actual" == "$_recorded" ]] || return 1
    [[ "$("$BIN_PATH" version 2>/dev/null)" == "$GITLEAKS_VERSION" ]] || return 1
    return 0
}

if _installed_and_verified; then
    echo "[install-gitleaks] already installed and sidecar-verified: $BIN_PATH"
    exit 0
fi

case "$(uname -s)" in
    Darwin) _os="darwin" ;;
    Linux) _os="linux" ;;
    *)
        echo "[install-gitleaks] unsupported OS: $(uname -s)" >&2
        exit 1
        ;;
esac
case "$(uname -m)" in
    arm64 | aarch64) _arch="arm64" ;;
    x86_64 | amd64) _arch="x64" ;;
    *)
        echo "[install-gitleaks] unsupported arch: $(uname -m)" >&2
        exit 1
        ;;
esac

_asset="gitleaks_${GITLEAKS_VERSION}_${_os}_${_arch}.tar.gz"

# Hardcoded per-platform sha256 for the official gitleaks v8.30.0 release
# assets, copied on 2026-09-28 from
# https://github.com/gitleaks/gitleaks/releases/download/v8.30.0/gitleaks_8.30.0_checksums.txt
# (the linux_x64 value matches the one independently pinned in
# .github/workflows/security-audit.yml around lines 266-272). Hardcoded, not
# fetched: a checksums.txt downloaded from the same origin as the tarball
# proves nothing -- an attacker (or a mirror, or a MITM) who can swap the
# tarball can swap that file too, and the install would "verify" a fake
# binary against a fake checksum it just downloaded. Only a value that ships
# in this script's own git history is an independent authority.
case "${_os}_${_arch}" in
    darwin_arm64) _expected="b251ab2bcd4cd8ba9e56ff37698c033ebf38582b477d21ebd86586d927cf87e7" ;;
    darwin_x64) _expected="ca221d012d247080c2f6f61f4b7a83bffa2453806b0c195c795bbe9a8c775ed5" ;;
    linux_arm64) _expected="b4cbbb6ddf7d1b2a603088cd03a4e3f7ce48ee7fd449b51f7de6ee2906f5fa2f" ;;
    linux_x64) _expected="79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e" ;;
    *)
        echo "[install-gitleaks] FAIL: no pinned checksum for ${_os}/${_arch} -- refusing to install" >&2
        exit 1
        ;;
esac

_tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-gitleaks.XXXXXX")"
trap 'rm -rf "$_tmp"' EXIT

echo "[install-gitleaks] downloading $_asset"
curl -sSfL -o "$_tmp/$_asset" "$_base_url/$_asset"

_actual="$(_sha256_of "$_tmp/$_asset")"

if [[ "$_actual" != "$_expected" ]]; then
    echo "[install-gitleaks] FAIL: checksum mismatch for $_asset -- refusing to extract" >&2
    echo "[install-gitleaks]   expected (pinned): $_expected" >&2
    echo "[install-gitleaks]   actual:            $_actual" >&2
    exit 1
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$_tmp/$_asset" -C "$_tmp" gitleaks
mv "$_tmp/gitleaks" "$BIN_PATH"
chmod +x "$BIN_PATH"

# Record the sidecar AFTER the file is in its final, executable place, so the
# hash that gets recorded is the hash of exactly what future runs will find
# and execute.
_sha256_of "$BIN_PATH" > "$SIDECAR_PATH"
chmod 600 "$SIDECAR_PATH"

echo "[install-gitleaks] installed $BIN_PATH ($("$BIN_PATH" version))"
