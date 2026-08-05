#!/usr/bin/env bash
# spec-expand.sh -- RUN-25 iter 24 (Wave D #4): turn an API CONTRACT (OpenAPI /
# GraphQL SDL / Postman collection) passed as the build source into a full,
# per-operation build checklist instead of letting the raw contract get copied
# verbatim and then TRUNCATED to the first 4000 bytes of the prompt (a real
# defect: a 40-operation OpenAPI file loses 21 of 40 ops to `head -c 4000`, so
# the builder never sees over half the contract).
#
# One entry point: spec_maybe_expand_contract <src-file>
#   - sniffs the file; if it is an OpenAPI/GraphQL/Postman contract, expands it
#     into .loki/generated-prd.md as a checklist (one `- [ ]` per operation,
#     keyed by operationId/field/request name) and echoes ".loki/generated-prd.md".
#   - otherwise echoes NOTHING and touches no state (the caller keeps the raw
#     path -> existing behavior is byte-identical for non-contract specs).
#
# Deterministic, pure-python stdlib (json always; yaml when importable, regex
# fallback otherwise). No new dependency, no network, no LLM. Not byte-lock
# gated: it rewrites an INPUT file, it does not change build_prompt() output.
#
# No emojis. No em dashes.

# spec_maybe_expand_contract <src>
# On a recognized contract, writes the per-operation checklist to a TEMP file and
# echoes that temp path (the caller feeds it to persist_user_prd, which copies it
# into .loki/generated-prd.md AND writes the source:"user" signature so a later
# no-file run reuses it exactly like a user PRD -- no duplicated persist logic).
# Echoes empty and touches no state on anything that is not a contract.
#
# For a standalone caller (no persist_user_prd in scope, e.g. the unit test), set
# LOKI_SPEC_EXPAND_INPLACE=1 to write straight to .loki/generated-prd.md and echo
# that path instead. The default (temp + persist) is what the runner uses.
spec_maybe_expand_contract() {
    local src="$1"
    [ -n "$src" ] || { echo ""; return 0; }
    [ -f "$src" ] || { echo ""; return 0; }
    command -v python3 >/dev/null 2>&1 || { echo ""; return 0; }

    # Never re-expand our own generated PRD.
    case "$src" in
        *.loki/generated-prd.md|*.loki/generated-prd.json) echo ""; return 0 ;;
    esac

    local loki_dir="${TARGET_DIR:-.}/.loki"
    local inplace="${LOKI_SPEC_EXPAND_INPLACE:-0}"
    # Default: write a temp checklist the caller persists (writes the signature).
    # In-place: write the canonical slot directly (standalone/test path).
    local tmp dest
    if [ "$inplace" = "1" ]; then
        mkdir -p "$loki_dir" 2>/dev/null || { echo ""; return 0; }
        dest="$loki_dir/generated-prd.md"
        tmp="$loki_dir/.generated-prd.md.expand.$$"
    else
        tmp="${TMPDIR:-/tmp}/loki-spec-expand.$$.md"
        dest="$tmp"
    fi

    # The python does the sniff + expansion. It writes the checklist to $tmp and
    # exits 0 ONLY when it actually recognized a contract; any other exit (not a
    # contract, parse error, empty operation set) leaves state untouched.
    if _SPEC_EXP_SRC="$src" _SPEC_EXP_OUT="$tmp" python3 - <<'PYEOF'
import json, os, re, sys

src = os.environ["_SPEC_EXP_SRC"]
out = os.environ["_SPEC_EXP_OUT"]

try:
    with open(src, encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
except OSError:
    sys.exit(2)

if not raw.strip():
    sys.exit(2)


def load_structured(text):
    # Try JSON first (Postman + OpenAPI-json), then YAML if available.
    try:
        return json.loads(text)
    except Exception:
        pass
    try:
        import yaml  # PyYAML present in this env; optional elsewhere.
        return yaml.safe_load(text)
    except Exception:
        return None


def norm_id(text, fallback):
    t = (text or "").strip()
    if not t:
        return fallback
    t = re.sub(r"\s+", " ", t)
    return t


data = load_structured(raw)
ops = []          # list of (op_id, description)
kind = None

# ---- OpenAPI / Swagger (structured) ----------------------------------------
if isinstance(data, dict) and ("openapi" in data or "swagger" in data) and isinstance(data.get("paths"), dict):
    kind = "OpenAPI"
    for path, item in data["paths"].items():
        if not isinstance(item, dict):
            continue
        for method, op in item.items():
            if method.lower() not in ("get", "post", "put", "patch", "delete", "head", "options", "trace"):
                continue
            if not isinstance(op, dict):
                continue
            opid = op.get("operationId") or "%s %s" % (method.upper(), path)
            summary = op.get("summary") or op.get("description") or ""
            desc = "%s %s -- %s" % (method.upper(), path, summary.strip()) if summary else "%s %s" % (method.upper(), path)
            ops.append((norm_id(opid, "%s %s" % (method.upper(), path)), desc.strip()))

# ---- Postman collection (structured) ---------------------------------------
elif isinstance(data, dict) and isinstance(data.get("info"), dict) and "item" in data:
    kind = "Postman"

    def walk(items, prefix=""):
        for it in items or []:
            if not isinstance(it, dict):
                continue
            name = it.get("name", "request")
            if isinstance(it.get("item"), list):        # folder
                walk(it["item"], prefix + name + " / ")
            elif isinstance(it.get("request"), (dict, str)):
                req = it["request"]
                method = req.get("method", "") if isinstance(req, dict) else ""
                label = (prefix + name).strip()
                ops.append((label, ("%s %s" % (method, label)).strip()))

    walk(data.get("item"))

# ---- GraphQL SDL (text; not JSON/YAML) -------------------------------------
if not ops:
    # Recognize a schema with a Query/Mutation/Subscription type and pull each
    # field as one operation. Cheap brace-depth scan, no graphql lib needed.
    if re.search(r"\btype\s+(Query|Mutation|Subscription)\b", raw):
        kind = "GraphQL"
        for root in ("Query", "Mutation", "Subscription"):
            m = re.search(r"\btype\s+" + root + r"\b[^{]*\{", raw)
            if not m:
                continue
            i = m.end()
            depth = 1
            body_start = i
            while i < len(raw) and depth > 0:
                if raw[i] == "{":
                    depth += 1
                elif raw[i] == "}":
                    depth -= 1
                i += 1
            body = raw[body_start:i - 1]
            # A field line: name(optional args): ReturnType
            for fm in re.finditer(r"^\s*([A-Za-z_]\w*)\s*(\([^)]*\))?\s*:\s*([^\n#]+)", body, re.M):
                field = fm.group(1)
                ret = fm.group(3).strip()
                ops.append(("%s.%s" % (root, field), "%s %s -> %s" % (root, field, ret)))

if not ops:
    sys.exit(3)   # nothing recognized -> caller keeps the raw path

# De-dup on op id, preserve order.
seen = set()
uniq = []
for oid, desc in ops:
    if oid in seen:
        continue
    seen.add(oid)
    uniq.append((oid, desc))

title = os.path.basename(src)
lines = []
lines.append("# Build checklist from %s contract: %s" % (kind, title))
lines.append("")
lines.append("Source: %s (%s). Each operation below is one build requirement." % (title, kind))
lines.append("Implement, test, and verify every item. Do not drop any operation.")
lines.append("")
lines.append("## Operations (%d)" % len(uniq))
lines.append("")
for oid, desc in uniq:
    lines.append("- [ ] %s: %s" % (oid, desc))
lines.append("")

try:
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
except OSError:
    sys.exit(4)

sys.exit(0)
PYEOF
    then
        if [ "$inplace" = "1" ]; then
            mv -f "$tmp" "$dest" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; echo ""; return 0; }
            echo ".loki/generated-prd.md"
        else
            # tmp == dest here; hand the temp checklist to the caller to persist.
            echo "$tmp"
        fi
        return 0
    fi
    rm -f "$tmp" 2>/dev/null
    echo ""
    return 0
}
