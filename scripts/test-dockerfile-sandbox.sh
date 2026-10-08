#!/usr/bin/env bash
# test-dockerfile-sandbox.sh
#
# Smoke test for Dockerfile.sandbox: builds the image and runs `loki version`
# inside it. Asserts that the build succeeds and the resulting binary prints
# a version-like string.
#
# Intended to be invoked manually or from a future CI workflow. NOT wired
# into CI today (macos-latest GitHub runners do not have Docker by default
# and we explicitly skip rather than fail when docker is missing).
#
# Exit codes:
#   0  success (or skipped because docker is not available)
#   1  build failed
#   2  run produced unexpected output
#
# Cleanup: best-effort `docker rmi` on the test image, even on failure.

set -euo pipefail

IMAGE_TAG="loki-sandbox-test:local"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="${REPO_ROOT}/docker/Dockerfile.sandbox"

cleanup() {
  if command -v docker >/dev/null 2>&1; then
    docker rmi "${IMAGE_TAG}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --- Skip gracefully if docker is unavailable ---
if ! command -v docker >/dev/null 2>&1; then
  echo "WARN: docker not found on PATH; skipping Dockerfile.sandbox smoke test."
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "WARN: docker daemon not reachable; skipping Dockerfile.sandbox smoke test."
  exit 0
fi

# --- Verify Dockerfile.sandbox exists ---
if [ ! -f "${DOCKERFILE}" ]; then
  echo "ERROR: ${DOCKERFILE} not found." >&2
  exit 1
fi

echo "INFO: building ${IMAGE_TAG} from ${DOCKERFILE}..."
if ! docker build -f "${DOCKERFILE}" -t "${IMAGE_TAG}" "${REPO_ROOT}"; then
  echo "ERROR: docker build failed." >&2
  exit 1
fi

echo "INFO: running 'loki version' inside ${IMAGE_TAG}..."
OUTPUT="$(docker run --rm "${IMAGE_TAG}" loki version 2>&1)" || {
  echo "ERROR: 'loki version' exited non-zero. Output:" >&2
  echo "${OUTPUT}" >&2
  exit 2
}

echo "INFO: container output: ${OUTPUT}"

# Assert the output contains a version-like string (e.g. "v7.4.6" or "7.4.6").
if ! echo "${OUTPUT}" | grep -Eq 'v?[0-9]+\.[0-9]+\.[0-9]+'; then
  echo "ERROR: output did not contain a semver-like version string." >&2
  echo "       expected pattern: v?MAJOR.MINOR.PATCH" >&2
  exit 2
fi

echo "PASS: Dockerfile.sandbox builds and 'loki version' returns a valid version."
exit 0
