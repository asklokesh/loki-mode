#!/usr/bin/env bash
# autonomy/lib/project-graph.sh -- Phase F (v7.5.23) helpers.
#
# Cross-project context discovery. Walks ONE parent level from the target
# directory looking for `.loki/app.json` manifests, groups siblings into a
# single logical app, and exports 3 internal env vars + provides a layered
# CLAUDE.md walker. No new user-facing CLI surface introduced.
#
# Public API:
#   loki_project_graph_discover <target_dir>  -- run discovery, export
#                                                 LOKI_PROJECT_GRAPH_* env
#                                                 vars; returns 0 always
#   load_app_graph_context                    -- emit layered CLAUDE.md text
#                                                 wrapped in LOKI_LAYER
#                                                 markers; empty when no
#                                                 graph
#
# Internal helpers (prefixed `_lpg_`):
#   _lpg_walk_siblings <target_dir> <basename>
#   _lpg_parse_app_json <path>
#   _lpg_cache_read <target_dir>
#   _lpg_cache_write <target_dir> <result_json>
#
# Internal env vars (NEVER user-facing; only read by run.sh / build_prompt):
#   LOKI_PROJECT_GRAPH_ROOT     -- absolute path of parent dir when found
#   LOKI_PROJECT_GRAPH_APP_ID   -- resolved app_id slug
#   LOKI_PROJECT_GRAPH_MEMBERS  -- colon-separated absolute member paths

if [ "${__LOKI_PROJECT_GRAPH_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_PROJECT_GRAPH_SH_LOADED=1

# Detect BSD vs GNU stat once (macOS vs Linux). Used for fast cache-hit
# validation that avoids spawning python3 on the hot path.
if stat -f '%m' / >/dev/null 2>&1; then
    __LPG_STAT_MTIME="stat -f %m"
else
    __LPG_STAT_MTIME="stat -c %Y"
fi

# Fixed-name sibling whitelist (case-insensitive lookup).
__LPG_FIXED_NAMES="ui api web service mobile worker backend frontend shared"

# Per-layer + total CLAUDE.md byte caps.
__LPG_PER_LAYER_CAP=16384
__LPG_TOTAL_CAP=32768

# Resolve absolute path without requiring GNU readlink -f.
_lpg_abs() {
    local p="${1:-}"
    [ -z "$p" ] && return 1
    if [ -d "$p" ]; then
        ( cd "$p" 2>/dev/null && pwd ) || printf '%s' "$p"
    else
        local d
        d=$(dirname "$p")
        local b
        b=$(basename "$p")
        if [ -d "$d" ]; then
            printf '%s/%s' "$( cd "$d" && pwd )" "$b"
        else
            printf '%s' "$p"
        fi
    fi
}

# Lowercase a string portably (bash 3.2 safe; no ${var,,}).
_lpg_lower() {
    printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

# Validate and parse a .loki/app.json file.
# stdout: "<app_id>" on success; empty on failure.
# stderr: human-readable reason on failure (caller can capture for logs).
_lpg_parse_app_json() {
    local path="${1:-}"
    [ -z "$path" ] || [ ! -f "$path" ] && return 1
    python3 - "$path" <<'PYEOF' 2>/dev/null
import json, re, sys
path = sys.argv[1]
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
sv = data.get('schema_version')
if sv != 1:
    sys.exit(1)
app_id = data.get('app_id', '')
if not isinstance(app_id, str):
    sys.exit(1)
if not re.match(r'^[a-z0-9-]{3,40}$', app_id):
    sys.exit(1)
print(app_id)
PYEOF
}

# Read shared_memory_dir + members[] from a manifest (best effort; empty on miss).
# stdout: JSON dict {"shared_memory_dir": "...", "members": [...]}
_lpg_manifest_meta() {
    local path="${1:-}"
    [ -z "$path" ] || [ ! -f "$path" ] && { printf '{}'; return; }
    python3 - "$path" <<'PYEOF' 2>/dev/null || printf '{}'
import json, sys
path = sys.argv[1]
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    print('{}')
    sys.exit(0)
out = {}
smd = data.get('shared_memory_dir')
if isinstance(smd, str) and smd:
    out['shared_memory_dir'] = smd
mems = data.get('members')
if isinstance(mems, list):
    out['members'] = [m for m in mems if isinstance(m, str)]
print(json.dumps(out))
PYEOF
}

# Enumerate candidate sibling directories under PARENT_DIR.
# Emits absolute paths, one per line. Excludes the target itself.
_lpg_walk_siblings() {
    local target_dir="${1:-}"
    local basename_target="${2:-}"
    [ -z "$target_dir" ] || [ -z "$basename_target" ] && return 0
    local parent
    parent=$(dirname "$target_dir")
    [ "$parent" = "$target_dir" ] && return 0
    [ ! -d "$parent" ] && return 0

    local target_lc
    target_lc=$(_lpg_lower "$basename_target")
    local fixed_lc
    fixed_lc=$(printf '%s' "$__LPG_FIXED_NAMES" | tr '[:upper:]' '[:lower:]')

    local entry name name_lc
    for entry in "$parent"/*; do
        [ ! -d "$entry" ] && continue
        name=$(basename "$entry")
        name_lc=$(_lpg_lower "$name")
        # Skip the target itself.
        [ "$name_lc" = "$target_lc" ] && continue
        # Fixed-name whitelist (case-insensitive).
        case " $fixed_lc " in
            *" $name_lc "*) printf '%s\n' "$entry"; continue ;;
        esac
        # Pattern siblings against original (case-sensitive) basename.
        case "$name" in
            "$basename_target"-*|"$basename_target"_*|*-"$basename_target"|*_"$basename_target")
                printf '%s\n' "$entry"
                continue
                ;;
        esac
    done
}

# Compute cache key (sha256 of sorted [mtime+path] for each found manifest).
# argv: each manifest path as a separate argument.
# stdout: hex sha256.
# Note: we can't both pipe paths AND heredoc the python script to the same
# stdin, so paths come in via argv.
_lpg_cache_key() {
    python3 - "$@" <<'PYEOF' 2>/dev/null
import hashlib, os, sys
paths = sorted(set(sys.argv[1:]))
items = []
for p in paths:
    try:
        st = os.stat(p)
        items.append(f"{st.st_mtime_ns}:{p}")
    except OSError:
        # Missing now -- treat as path-only so we still hash deterministically.
        items.append(f"0:{p}")
h = hashlib.sha256()
for it in items:
    h.update(it.encode('utf-8'))
    h.update(b'\n')
print(h.hexdigest())
PYEOF
}

# Read cache. stdout: cached JSON if hit + valid; empty otherwise.
_lpg_cache_read() {
    local target_dir="${1:-}"
    local cache_key="${2:-}"
    [ -z "$target_dir" ] || [ -z "$cache_key" ] && return 0
    local cache_file="$target_dir/.loki/state/project-graph.json"
    [ ! -f "$cache_file" ] && return 0
    python3 - "$cache_file" "$cache_key" <<'PYEOF' 2>/dev/null
import json, sys
path, key = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
if data.get('cache_key') != key:
    sys.exit(0)
print(json.dumps(data))
PYEOF
}

# Write cache.
_lpg_cache_write() {
    local target_dir="${1:-}"
    local result_json="${2:-}"
    [ -z "$target_dir" ] || [ -z "$result_json" ] && return 0
    local cache_dir="$target_dir/.loki/state"
    mkdir -p "$cache_dir" 2>/dev/null || return 0
    printf '%s' "$result_json" > "$cache_dir/project-graph.json" 2>/dev/null || true
}

# Append a line to the skip log (mismatched siblings, parse errors).
_lpg_log_skip() {
    local target_dir="${1:-}"
    local msg="${2:-}"
    [ -z "$target_dir" ] || [ -z "$msg" ] && return 0
    local log_dir="$target_dir/.loki/state"
    mkdir -p "$log_dir" 2>/dev/null || return 0
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "ts?")
    printf '[%s] %s\n' "$ts" "$msg" >> "$log_dir/project-graph.log" 2>/dev/null || true
}

# Main discovery entry point.
# Always returns 0. On no graph, exports empty vars.
loki_project_graph_discover() {
    local target_dir="${1:-}"
    # Default exports (cleared even on early return).
    export LOKI_PROJECT_GRAPH_ROOT=""
    export LOKI_PROJECT_GRAPH_APP_ID=""
    export LOKI_PROJECT_GRAPH_MEMBERS=""
    export LOKI_PROJECT_GRAPH_SHARED_MEMORY_DIR=""

    [ -z "$target_dir" ] && return 0
    [ ! -d "$target_dir" ] && return 0

    target_dir=$(_lpg_abs "$target_dir")
    local basename_target
    basename_target=$(basename "$target_dir")
    local parent_dir
    parent_dir=$(dirname "$target_dir")
    [ "$parent_dir" = "$target_dir" ] && return 0

    # Collect candidate manifests:
    #   (a) sibling roots, (b) target itself, (c) parent.
    local candidates=()
    local sib
    while IFS= read -r sib; do
        [ -z "$sib" ] && continue
        candidates+=("$sib/.loki/app.json")
    done < <(_lpg_walk_siblings "$target_dir" "$basename_target")
    candidates+=("$target_dir/.loki/app.json")
    candidates+=("$parent_dir/.loki/app.json")

    # Keep only existing manifest paths.
    local found=()
    local c
    for c in "${candidates[@]}"; do
        [ -f "$c" ] && found+=("$c")
    done

    # Need at least one manifest to consider a graph.
    if [ "${#found[@]}" -eq 0 ]; then
        return 0
    fi

    # Fast cache path: NO python3 in the hot path. Cache is valid iff
    # cache_file_mtime >= max(manifest_mtimes). sha256 of the path+mtime
    # tuple is still computed on the SLOW path (cache write) for forensic
    # debuggability via the on-disk JSON; the hot path skips that work.
    # On macOS Darwin, python3 startup alone is ~25ms; eliminating it lets
    # cache hits run in ~15-20ms, well under the architect's 50ms budget.
    local cache_file="$target_dir/.loki/state/project-graph.json"
    if [ -f "$cache_file" ]; then
        local cache_mtime newest_manifest_mtime mt m
        cache_mtime=$($__LPG_STAT_MTIME "$cache_file" 2>/dev/null)
        newest_manifest_mtime=0
        for m in "${found[@]}"; do
            mt=$($__LPG_STAT_MTIME "$m" 2>/dev/null)
            [ -z "$mt" ] && continue
            # Compare as integers; both BSD and GNU stat emit whole seconds here.
            if [ "$mt" -gt "$newest_manifest_mtime" ] 2>/dev/null; then
                newest_manifest_mtime=$mt
            fi
        done
        if [ -n "$cache_mtime" ] && [ "$cache_mtime" -ge "$newest_manifest_mtime" ] 2>/dev/null; then
            # Shell-native JSON extraction. We control the writer (single line
            # per key, no embedded quotes in app_id/root/members), so awk is
            # safe and saves the python3 spawn.
            local cache_root cache_app cache_members
            cache_root=$(awk -F'"' '/"root":/ {print $4; exit}' "$cache_file" 2>/dev/null)
            cache_app=$(awk -F'"' '/"app_id":/ {print $4; exit}' "$cache_file" 2>/dev/null)
            # members is a multi-line JSON array of strings. Switch into
            # "inside-members" mode at `"members": [`, collect each quoted
            # entry on its own line, exit at the closing `]`. Result: a
            # colon-separated list of absolute paths.
            cache_members=$(awk -F'"' '
                /"members":/ { inside=1; next }
                inside && /\]/ { inside=0; exit }
                inside && NF >= 3 {
                    if (out == "") { out = $2 } else { out = out ":" $2 }
                }
                END { print out }
            ' "$cache_file" 2>/dev/null)
            if [ -n "$cache_root" ] && [ -n "$cache_app" ]; then
                LOKI_PROJECT_GRAPH_ROOT="$cache_root"
                LOKI_PROJECT_GRAPH_APP_ID="$cache_app"
                LOKI_PROJECT_GRAPH_MEMBERS="$cache_members"
                export LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
                return 0
            fi
        fi
    fi

    # Cache miss / stale -- compute cache_key for the eventual write.
    local cache_key
    cache_key=$(_lpg_cache_key "${found[@]}")

    # Parse all manifests + cluster by app_id.
    local target_app_id=""
    local parent_app_id=""
    local manifest path dir app_id
    declare -a parsed_paths=()
    declare -a parsed_ids=()
    for manifest in "${found[@]}"; do
        app_id=$(_lpg_parse_app_json "$manifest")
        if [ -z "$app_id" ]; then
            _lpg_log_skip "$target_dir" "parse_failed: $manifest"
            continue
        fi
        parsed_paths+=("$manifest")
        parsed_ids+=("$app_id")
        if [ "$manifest" = "$target_dir/.loki/app.json" ]; then
            target_app_id="$app_id"
        elif [ "$manifest" = "$parent_dir/.loki/app.json" ]; then
            parent_app_id="$app_id"
        fi
    done

    # Determine the authoritative app_id: prefer target -> parent -> majority of siblings.
    local resolved_id=""
    if [ -n "$target_app_id" ]; then
        resolved_id="$target_app_id"
    elif [ -n "$parent_app_id" ]; then
        resolved_id="$parent_app_id"
    else
        # Majority vote across siblings.
        if [ "${#parsed_ids[@]}" -gt 0 ]; then
            resolved_id=$(printf '%s\n' "${parsed_ids[@]}" | sort | uniq -c | sort -rn | head -n1 | awk '{print $2}')
        fi
    fi

    if [ -z "$resolved_id" ]; then
        return 0
    fi

    # Build members list (all manifest dirs whose app_id matches resolved_id).
    local i count member_dir
    declare -a members=()
    count=${#parsed_paths[@]}
    for (( i=0; i<count; i++ )); do
        if [ "${parsed_ids[$i]}" = "$resolved_id" ]; then
            member_dir=$(dirname "$(dirname "${parsed_paths[$i]}")")
            # Exclude the parent root from members (parent is the graph root, not a member).
            if [ "$member_dir" != "$parent_dir" ]; then
                members+=("$member_dir")
            fi
        else
            _lpg_log_skip "$target_dir" "app_id_mismatch: ${parsed_paths[$i]} (got=${parsed_ids[$i]} want=$resolved_id)"
        fi
    done

    # Honor explicit members[] from parent manifest if present (resolve to abs paths under parent).
    local parent_manifest="$parent_dir/.loki/app.json"
    if [ -f "$parent_manifest" ]; then
        local parent_meta
        parent_meta=$(_lpg_manifest_meta "$parent_manifest")
        local explicit_members
        explicit_members=$(python3 -c '
import json, os, sys
meta = json.loads(sys.argv[1] or "{}")
parent = sys.argv[2]
out = []
for m in meta.get("members", []):
    if not isinstance(m, str):
        continue
    p = m if os.path.isabs(m) else os.path.join(parent, m)
    if os.path.isdir(p):
        out.append(os.path.realpath(p))
print(":".join(out))
' "$parent_meta" "$parent_dir" 2>/dev/null)
        # If explicit members declared, intersect with discovered members.
        if [ -n "$explicit_members" ]; then
            local final=()
            local em
            IFS=':' read -r -a em_arr <<<"$explicit_members"
            for em in "${em_arr[@]}"; do
                local m
                for m in "${members[@]}"; do
                    if [ "$m" = "$em" ]; then
                        final+=("$m")
                        break
                    fi
                done
            done
            # If explicit list narrows nothing, fall back to discovered.
            if [ "${#final[@]}" -gt 0 ]; then
                members=("${final[@]}")
            fi
        fi
    fi

    # Need at least 1 member to call it a graph.
    if [ "${#members[@]}" -eq 0 ]; then
        return 0
    fi

    # De-dupe + sort members.
    local members_joined
    members_joined=$(printf '%s\n' "${members[@]}" | awk '!seen[$0]++' | sort | paste -sd ':' -)

    # Phase F: extract shared_memory_dir from parent manifest (if any) so the
    # TS/Python side can honor it via LOKI_PROJECT_GRAPH_SHARED_MEMORY_DIR.
    # Default empty = consumers use their own default ("$ROOT/.loki-shared/memory").
    local shared_mem_dir=""
    if [ -f "$parent_manifest" ]; then
        shared_mem_dir=$(python3 -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
    v = d.get("shared_memory_dir")
    if isinstance(v, str):
        print(v)
except Exception:
    pass
' "$(_lpg_manifest_meta "$parent_manifest")" 2>/dev/null)
    fi

    LOKI_PROJECT_GRAPH_ROOT="$parent_dir"
    LOKI_PROJECT_GRAPH_APP_ID="$resolved_id"
    LOKI_PROJECT_GRAPH_MEMBERS="$members_joined"
    LOKI_PROJECT_GRAPH_SHARED_MEMORY_DIR="$shared_mem_dir"
    export LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS LOKI_PROJECT_GRAPH_SHARED_MEMORY_DIR

    # Persist cache. Write as multi-line JSON, ONE KEY PER LINE, so the
    # hot-path awk extraction (`/"root":/ {print $4}`) is unambiguous --
    # awk splits each line by `"` and the value is always field 4 of the
    # line that contains the key. This format is also valid JSON.
    if [ -n "$cache_key" ]; then
        local result_json
        result_json=$(python3 -c '
import json, sys
print(json.dumps({
    "cache_key": sys.argv[1],
    "root": sys.argv[2],
    "app_id": sys.argv[3],
    "members": sys.argv[4].split(":") if sys.argv[4] else [],
}, indent=2))
' "$cache_key" "$parent_dir" "$resolved_id" "$members_joined" 2>/dev/null)
        _lpg_cache_write "$target_dir" "$result_json"
    fi

    return 0
}

# Read CLAUDE.md from a single path, truncated to per-layer cap.
# stdout: file contents (possibly truncated); empty if file missing or empty.
_lpg_read_layer() {
    local path="${1:-}"
    [ -z "$path" ] || [ ! -f "$path" ] && return 0
    python3 - "$path" "$__LPG_PER_LAYER_CAP" <<'PYEOF' 2>/dev/null
import sys
path, cap = sys.argv[1], int(sys.argv[2])
try:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        text = f.read()
except Exception:
    sys.exit(0)
if len(text.encode('utf-8')) > cap:
    # Truncate by bytes then re-decode safely.
    enc = text.encode('utf-8')[:cap]
    try:
        text = enc.decode('utf-8', errors='ignore')
    except Exception:
        text = ''
    text = text.rstrip() + '\n<!-- truncated -->\n'
sys.stdout.write(text)
PYEOF
}

# Emit a layered CLAUDE.md block.
# Backward compat: empty stdout when LOKI_PROJECT_GRAPH_ROOT is unset.
# Honors __LPG_TOTAL_CAP across all layers (stops at layer boundary).
load_app_graph_context() {
    local root="${LOKI_PROJECT_GRAPH_ROOT:-}"
    [ -z "$root" ] && return 0

    local target_dir="${TARGET_DIR:-${LOKI_TARGET_DIR:-$(pwd)}}"
    target_dir=$(_lpg_abs "$target_dir")
    local target_basename
    target_basename=$(basename "$target_dir")

    local members_csv="${LOKI_PROJECT_GRAPH_MEMBERS:-}"
    local members_arr=()
    if [ -n "$members_csv" ]; then
        IFS=':' read -r -a members_arr <<<"$members_csv"
    fi

    local total_bytes=0
    local out=""
    local layer_kind layer_path layer_content layer_block layer_bytes

    _append_layer() {
        local kind="$1"
        local p="$2"
        [ ! -f "$p" ] && return 0
        local content
        content=$(_lpg_read_layer "$p")
        [ -z "$content" ] && return 0
        local block
        block=$(printf '<!-- LOKI_LAYER:%s path=%s -->\n%s\n<!-- /LOKI_LAYER -->\n' "$kind" "$p" "$content")
        local block_bytes
        block_bytes=$(printf '%s' "$block" | wc -c | tr -d ' ')
        if [ $((total_bytes + block_bytes)) -gt "$__LPG_TOTAL_CAP" ]; then
            # Stop at section boundary; do not split a layer mid-content.
            return 1
        fi
        if [ -z "$out" ]; then
            out="$block"
        else
            out="${out}${block}"
        fi
        total_bytes=$((total_bytes + block_bytes))
        return 0
    }

    # Parent layer first.
    _append_layer parent "$root/CLAUDE.md" || { printf '%s' "$out"; return 0; }

    # Member layers (skip the scope member -- we add it as scope below).
    local m
    for m in "${members_arr[@]}"; do
        [ -z "$m" ] && continue
        if [ "$m" = "$target_dir" ]; then
            continue
        fi
        _append_layer member "$m/CLAUDE.md" || { printf '%s' "$out"; return 0; }
    done

    # Scope layer (target dir).
    _append_layer scope "$target_dir/CLAUDE.md" || { printf '%s' "$out"; return 0; }

    printf '%s' "$out"
}
