#!/usr/bin/env bash

# Prepare deterministic Node dependencies for Loki-owned verification gates.
# The model may produce a valid app without installing host dependencies because
# hosted previews use an isolated Docker volume. Verification must not mistake a
# missing host node_modules directory for an application defect.

loki_dependency_input_sha256() {
    local tree="$1"
    python3 - "$tree/package.json" "$tree/package-lock.json" <<'PYEOF'
import hashlib
import sys

digest = hashlib.sha256()
for path in sys.argv[1:]:
    with open(path, "rb") as handle:
        digest.update(handle.read())
        digest.update(b"\0")
print(digest.hexdigest())
PYEOF
}

loki_dependency_install_fingerprint() {
    local tree="$1"
    python3 - "$tree" <<'PYEOF'
import hashlib
import json
import os
import pathlib
import subprocess
import sys

tree = pathlib.Path(sys.argv[1])
hidden_lock = tree / "node_modules" / ".package-lock.json"
try:
    raw = hidden_lock.read_bytes()
    packages = json.loads(raw).get("packages")
    if not isinstance(packages, dict):
        raise ValueError("missing packages map")
    for name in packages:
        path = pathlib.PurePosixPath(name)
        if not name or path.is_absolute() or path.parts[0] != "node_modules" \
                or any(part in ("", ".", "..") for part in path.parts):
            raise ValueError("invalid installed package path")
        if not os.path.lexists(tree.joinpath(*path.parts)):
            raise ValueError("missing installed package")
    print("lock:" + hashlib.sha256(raw).hexdigest())
except FileNotFoundError:
    result = subprocess.run(
        ["npm", "ls", "--all", "--json"], cwd=tree,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
    )
    if result.returncode:
        raise SystemExit(1)
    listing = json.loads(result.stdout)
    canonical = json.dumps(listing, sort_keys=True, separators=(",", ":")).encode()
    print("tree:" + hashlib.sha256(canonical).hexdigest())
except (OSError, TypeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
PYEOF
}

loki_publish_dependency_marker() {
    local marker_file="$1" input_sha="$2" install_sha="$3" temporary
    temporary="$(mktemp "${marker_file}.tmp.XXXXXX")" || return 1
    if ! printf 'v1 %s %s\n' "$input_sha" "$install_sha" > "$temporary" \
        || ! mv -f "$temporary" "$marker_file"; then
        rm -f "$temporary" 2>/dev/null || true
        return 1
    fi
}

loki_write_dependency_setup_result() {
    local output="$1" status="$2" command="$3" exit_code="$4" input_sha="$5"
    _LOKI_DEP_OUT="$output" \
    _LOKI_DEP_STATUS="$status" \
    _LOKI_DEP_COMMAND="$command" \
    _LOKI_DEP_EXIT="$exit_code" \
    _LOKI_DEP_SHA="$input_sha" \
    python3 - <<'PYEOF'
import json
import os
import tempfile
from datetime import datetime, timezone

target = os.environ["_LOKI_DEP_OUT"]
raw_exit = os.environ.get("_LOKI_DEP_EXIT", "")
record = {
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": os.environ.get("_LOKI_DEP_STATUS", "failed"),
    "command": os.environ.get("_LOKI_DEP_COMMAND") or None,
    "exit_code": int(raw_exit) if raw_exit.isdigit() else None,
    "input_sha256": os.environ.get("_LOKI_DEP_SHA") or None,
    "lifecycle_scripts": "disabled",
}
directory = os.path.dirname(target)
os.makedirs(directory, exist_ok=True)
fd, temporary = tempfile.mkstemp(dir=directory, suffix=".json")
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2, sort_keys=True)
    handle.write("\n")
os.replace(temporary, target)
PYEOF
}

loki_prepare_project_dependencies() {
    local tree="${TARGET_DIR:-.}"
    local quality_dir="$tree/.loki/quality"
    local state_dir="$tree/.loki/state"
    local result_file="$quality_dir/dependency-setup.json"
    local marker_file="$state_dir/dependency-input.sha256"
    local command_text="npm ci --ignore-scripts --no-audit --no-fund"
    mkdir -p "$quality_dir" "$state_dir" || return 1

    if [ ! -f "$tree/package.json" ]; then
        loki_write_dependency_setup_result "$result_file" \
            "not_applicable" "" "" ""
        return 0
    fi

    if [ ! -f "$tree/package-lock.json" ]; then
        loki_write_dependency_setup_result "$result_file" \
            "failed" "$command_text" "1" ""
        log_warn "Dependency setup requires package-lock.json for reproducible npm verification"
        return 1
    fi

    local input_sha
    input_sha="$(loki_dependency_input_sha256 "$tree" 2>/dev/null)" || input_sha=""
    if [ -z "$input_sha" ]; then
        loki_write_dependency_setup_result "$result_file" \
            "failed" "$command_text" "1" ""
        log_warn "Dependency setup could not fingerprint package.json and package-lock.json"
        return 1
    fi

    local marker_version marker_input_sha marker_install_fingerprint install_fingerprint
    if [ -f "$marker_file" ]; then
        read -r marker_version marker_input_sha marker_install_fingerprint < "$marker_file" || true
        if [ "$marker_version" = "v1" ] \
            && [ "$marker_input_sha" = "$input_sha" ] \
            && install_fingerprint="$(loki_dependency_install_fingerprint "$tree" 2>/dev/null)" \
            && [ "$marker_install_fingerprint" = "$install_fingerprint" ]; then
            loki_write_dependency_setup_result "$result_file" \
                "verified" "$command_text" "0" "$input_sha"
            log_info "Dependency setup: reusing the verified lockfile installation"
            return 0
        fi
    fi

    if ! rm -f "$marker_file"; then
        loki_write_dependency_setup_result "$result_file" \
            "failed" "$command_text" "1" "$input_sha"
        log_warn "Dependency setup could not invalidate its previous verification marker"
        return 1
    fi

    if ! command -v npm >/dev/null 2>&1; then
        loki_write_dependency_setup_result "$result_file" \
            "failed" "$command_text" "127" "$input_sha"
        log_warn "Dependency setup requires npm but npm is unavailable"
        return 1
    fi

    local setup_timeout="${LOKI_DEPENDENCY_SETUP_TIMEOUT:-60}"
    case "$setup_timeout" in
        ''|*[!0-9]*) setup_timeout=60 ;;
    esac
    [ "$setup_timeout" -gt 0 ] 2>/dev/null || setup_timeout=60

    local rc=0
    if type _loki_with_deadline >/dev/null 2>&1; then
        (cd "$tree" && LOKI_DEADLINE_IDLE_TIMEOUT=0 \
            _loki_with_deadline "$setup_timeout" npm ci \
                --ignore-scripts --no-audit --no-fund) || rc=$?
    else
        (cd "$tree" && npm ci --ignore-scripts --no-audit --no-fund) || rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
        loki_write_dependency_setup_result "$result_file" \
            "failed" "$command_text" "$rc" "$input_sha"
        log_warn "Dependency setup failed with exit $rc"
        return 1
    fi

    install_fingerprint="$(loki_dependency_install_fingerprint "$tree" 2>/dev/null)" \
        || install_fingerprint=""
    if [ -z "$install_fingerprint" ]; then
        loki_write_dependency_setup_result "$result_file" \
            "failed" "$command_text" "1" "$input_sha"
        log_warn "Dependency setup produced an incomplete npm installation"
        return 1
    fi
    if ! loki_publish_dependency_marker \
        "$marker_file" "$input_sha" "$install_fingerprint"; then
        loki_write_dependency_setup_result "$result_file" \
            "failed" "$command_text" "1" "$input_sha"
        log_warn "Dependency setup could not publish its verification marker"
        return 1
    fi
    loki_write_dependency_setup_result "$result_file" \
        "verified" "$command_text" "0" "$input_sha"
    log_info "Dependency setup: reproducible npm installation verified"
    return 0
}
