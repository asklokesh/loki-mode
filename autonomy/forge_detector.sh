#!/usr/bin/env bash
# autonomy/forge_detector.sh - Phase F-1 of Loki Forge.
#
# Reads the active spec (PRD or issue file) and runs forge.spec_detector
# to write .loki/forge/required.json. Then runs forge.provisioner to
# materialize whatever it can in F-1 (SQLite tables only). Idempotent.
#
# The autonomy/run.sh loop calls this between the Reason and Act phases
# of each RARV iteration. It returns 0 in all cases - never blocks the
# loop on forge failures, just surfaces them in .loki/forge/errors.log.

set -uo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
FORGE_DIR="$PROJECT_DIR/.loki/forge"
SPEC_PATH="${1:-${LOKI_PRD_PATH:-}}"

mkdir -p "$FORGE_DIR"

if ! command -v python3 >/dev/null 2>&1; then
    echo "[forge_detector] python3 not available; skipping" \
        >> "$FORGE_DIR/errors.log"
    exit 0
fi

# Find the Loki install root so we can put forge/ on PYTHONPATH even if
# the user is running from a different cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI_ROOT="$(dirname "$SCRIPT_DIR")"

LOKI_ROOT="$LOKI_ROOT" FORGE_DIR="$FORGE_DIR" SPEC_PATH="${SPEC_PATH:-}" \
    python3 <<'PY' 2>>"$FORGE_DIR/errors.log"
import json
import os
import sys

loki_root = os.environ["LOKI_ROOT"]
forge_dir = os.environ["FORGE_DIR"]
spec_path = os.environ.get("SPEC_PATH") or ""

sys.path.insert(0, loki_root)

try:
    from forge.spec_detector import detect_from_path, write_required_json
    from forge.provisioner import provision
except Exception as e:
    sys.stderr.write(f"[forge_detector] import failed: {e}\n")
    sys.exit(0)

# Detect.
req = detect_from_path(spec_path) if spec_path else None
if req is None:
    sys.exit(0)

write_required_json(req, forge_dir)

# Apply F-1 primitives (DB tables). Idempotent.
try:
    res = provision(req, forge_dir)
except Exception as e:
    sys.stderr.write(f"[forge_detector] provision failed: {e}\n")
    sys.exit(0)

# Surface result alongside the required.json for the dashboard + the
# next iteration's prompt to read.
with open(os.path.join(forge_dir, "last_provision.json"), "w", encoding="utf-8") as f:
    f.write(res.to_json())
    f.write("\n")
PY

exit 0
