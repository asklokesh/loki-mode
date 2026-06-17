#!/usr/bin/env bash
# prd-enrich.sh -- LLM enrichment post-pass for PRD-parsed task queues.
#
# Problem: the python heredoc in run.sh::populate_prd_queue has no model
# access (json/re/os/sys only). When a PRD section has no body text, the
# deterministic parser falls back to description == title and a templated
# constant user_story. The dashboard task modal then shows placeholder junk.
#
# This module runs AFTER pending.json is written. For source=="prd" tasks
# that still carry a stub (description == title, or the templated user_story
# constant), it builds ONE batched provider call that passes the task titles
# plus the full PRD context and asks for a JSON array of enriched fields. The
# response is merged back into pending.json atomically (temp file + mv),
# preserving the on-disk format (bare list or {"tasks":[...]} wrapper).
#
# GRACEFUL FALLBACK: if the provider is unavailable (non-claude provider,
# PROVIDER_DEGRADED, claude binary absent, the call times out / fails, or the
# JSON cannot be parsed) the function leaves the deterministic output intact
# and returns 0. Queue population is NEVER blocked on the LLM.
#
# Contract:
#   loki_prd_enrich <pending_json_path> <prd_file_path>
#     - returns 0 always (best-effort enrichment; never fails the caller)
#     - mutates <pending_json_path> in place only on a successful enrichment
#
# Indirection (for testability): the actual model call goes through
#   _loki_prd_enrich_invoke <prompt>   (echoes the raw model response)
# Tests stub this function to return a fixed JSON array without a real model.
#
# No emojis. No em dashes. bash 3.2 safe. Honors `set -uo pipefail`.

# Bound the batched call so a huge PRD or task list cannot run away.
: "${LOKI_PRD_ENRICH_TIMEOUT:=120}"      # seconds for the single model call
: "${LOKI_PRD_ENRICH_MAX_TASKS:=40}"     # cap tasks sent in one batch
: "${LOKI_PRD_ENRICH_MAX_PRD_CHARS:=12000}"  # cap PRD context length

# The single model-call primitive. Kept as its own function so:
#   1. it is the ONE place that touches the provider, and
#   2. tests can override it to return canned JSON.
# Calls `claude -p` directly (not the provider_invoke shell function) because
# `timeout` needs a real command, not a function. Mirrors the in-tree
# precedent at autonomy/lib/voter-agents.sh:259.
_loki_prd_enrich_invoke() {
    local prompt="$1"
    command -v claude >/dev/null 2>&1 || return 1
    local rc=0
    local out=""
    if command -v timeout >/dev/null 2>&1; then
        out=$(CAVEMAN_DEFAULT_MODE=off timeout "${LOKI_PRD_ENRICH_TIMEOUT}" \
                  claude --dangerously-skip-permissions -p "$prompt" 2>/dev/null) || rc=$?
    else
        # No coreutils timeout (e.g. bare macOS). Run without it; the model
        # call is a one-shot and the caller still tolerates failure.
        out=$(CAVEMAN_DEFAULT_MODE=off \
                  claude --dangerously-skip-permissions -p "$prompt" 2>/dev/null) || rc=$?
    fi
    [ "$rc" -ne 0 ] && return 1
    [ -z "$out" ] && return 1
    printf '%s' "$out"
    return 0
}

# Decide whether enrichment should even be attempted. Returns 0 (attempt)
# only when the active provider is claude and not in degraded mode.
_loki_prd_enrich_provider_ok() {
    [ "${LOKI_PROVIDER:-claude}" = "claude" ] || return 1
    [ "${PROVIDER_DEGRADED:-false}" != "true" ] || return 1
    command -v claude >/dev/null 2>&1 || return 1
    return 0
}

# Deterministic (no-model) enrichment. Replaces the templated user_story
# constant (run.sh:13614) with a content-derived one, varying by the task's
# own body text. Description is left to Bug-A (already real where body exists).
# Pure python (json/re/os only): safe on any provider, offline, or air-gapped.
# Always atomic (temp + replace), best-effort, returns 0.
_loki_prd_enrich_deterministic() {
    local pending_path="${1:-}"
    [ -n "$pending_path" ] && [ -f "$pending_path" ] || return 0
    LOKI_PE_PENDING="$pending_path" python3 << 'PE_DET_EOF'
import json, os, re, sys, tempfile

pending = os.environ.get("LOKI_PE_PENDING", "")
if not pending or not os.path.isfile(pending):
    sys.exit(0)

try:
    with open(pending, "r") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

if isinstance(data, list):
    tasks = data
    wrapper = None
elif isinstance(data, dict):
    tasks = data.get("tasks", [])
    wrapper = data
else:
    sys.exit(0)

def is_stub_user_story(s):
    return isinstance(s, str) and s.endswith("so that the product delivers its core value.")

def first_sentence(text, limit=160):
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return ""
    m = re.search(r"(.+?[.!?])(\s|$)", text)
    s = m.group(1) if m else text
    return s[:limit].strip()

changed = 0
for t in tasks:
    if not isinstance(t, dict):
        continue
    if t.get("source") != "prd":
        continue
    if not is_stub_user_story(t.get("user_story")):
        continue
    title = (t.get("title") or "").strip()
    if not title:
        continue
    # Derive a benefit clause from the section body (description minus the
    # leading title line), falling back to the first acceptance criterion.
    desc = (t.get("description") or "").strip()
    body = desc
    if body.startswith(title):
        body = body[len(title):].strip()
    benefit = first_sentence(body)
    if not benefit:
        ac = t.get("acceptance_criteria")
        if isinstance(ac, list) and ac:
            benefit = first_sentence(str(ac[0]))
    cap = title[:1].lower() + title[1:] if title else title
    if benefit:
        t["user_story"] = "As a user, I want %s, so that %s" % (
            cap.rstrip("."),
            benefit[:1].lower() + benefit[1:] if benefit else benefit,
        )
        if not t["user_story"].endswith("."):
            t["user_story"] += "."
    else:
        # No body text at all: still drop the generic constant for a
        # capability-specific phrasing.
        t["user_story"] = "As a user, I want %s, so that I can use this capability." % cap.rstrip(".")
    changed += 1

if changed == 0:
    sys.exit(0)

if wrapper is not None:
    wrapper["tasks"] = tasks
    output = wrapper
else:
    output = tasks

d = os.path.dirname(os.path.abspath(pending)) or "."
fd, tmp = tempfile.mkstemp(dir=d, prefix=".pending-det-", suffix=".json")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(output, f, indent=2)
    os.replace(tmp, pending)
except Exception:
    try:
        os.unlink(tmp)
    except Exception:
        pass
    sys.exit(0)
PE_DET_EOF
    return 0
}

loki_prd_enrich() {
    local pending_path="${1:-}"
    local prd_path="${2:-}"

    [ -n "$pending_path" ] && [ -f "$pending_path" ] || return 0
    [ -n "$prd_path" ] && [ -f "$prd_path" ] || return 0

    # Provider gate. On a degraded / non-claude / no-binary provider we still
    # improve tasks deterministically (content-derived user_story) so even
    # offline users get informative tasks, then return without a model call.
    if ! _loki_prd_enrich_provider_ok; then
        _loki_prd_enrich_deterministic "$pending_path"
        return 0
    fi

    # Stage 1 (python): identify stub prd tasks and emit a compact JSON
    # payload {tasks:[{id,title}], prd:"..."} for the model. If there is
    # nothing to enrich, emit empty and we return early.
    local payload
    payload=$(LOKI_PE_PENDING="$pending_path" LOKI_PE_PRD="$prd_path" \
              LOKI_PE_MAX_TASKS="${LOKI_PRD_ENRICH_MAX_TASKS}" \
              LOKI_PE_MAX_PRD="${LOKI_PRD_ENRICH_MAX_PRD_CHARS}" \
              python3 << 'PE_PAYLOAD_EOF'
import json, os, sys

pending = os.environ.get("LOKI_PE_PENDING", "")
prd = os.environ.get("LOKI_PE_PRD", "")
max_tasks = int(os.environ.get("LOKI_PE_MAX_TASKS", "40") or "40")
max_prd = int(os.environ.get("LOKI_PE_MAX_PRD", "12000") or "12000")

try:
    with open(pending, "r") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

if isinstance(data, list):
    tasks = data
elif isinstance(data, dict):
    tasks = data.get("tasks", [])
else:
    sys.exit(0)

# Templated constant produced by run.sh:13614 (the sentinel we replace).
def is_stub_user_story(s):
    if not isinstance(s, str):
        return False
    return s.endswith("so that the product delivers its core value.")

stubs = []
for t in tasks:
    if not isinstance(t, dict):
        continue
    if t.get("source") != "prd":
        continue
    title = (t.get("title") or "").strip()
    desc = (t.get("description") or "").strip()
    us = t.get("user_story") or ""
    if not title:
        continue
    # Stub = description is just the title, OR the templated user_story.
    if desc == title or is_stub_user_story(us):
        stubs.append({"id": t.get("id"), "title": title})

if not stubs:
    sys.exit(0)

stubs = stubs[:max_tasks]

try:
    with open(prd, "r", errors="replace") as f:
        prd_text = f.read()
except Exception:
    prd_text = ""
prd_text = prd_text[:max_prd]

print(json.dumps({"tasks": stubs, "prd": prd_text}))
PE_PAYLOAD_EOF
)

    # Nothing to enrich, or payload generation failed -> keep deterministic.
    [ -n "$payload" ] || return 0

    # Stage 2: build the batched prompt and call the model.
    local task_lines prd_context
    task_lines=$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for t in d.get("tasks", []):
    print("- id=%s | %s" % (t.get("id"), t.get("title")))
' 2>/dev/null)
    prd_context=$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sys.stdout.write(d.get("prd", ""))
' 2>/dev/null)

    [ -n "$task_lines" ] || return 0

    local prompt
    prompt=$(cat <<PE_PROMPT_EOF
You are enriching a software task backlog so each task carries real, useful
information for an engineer. Below is the source PRD followed by a list of
tasks (each with an id and title) whose descriptions are currently empty or
generic. For EACH task id, produce informative fields grounded in the PRD.

Return ONLY a JSON array (no prose, no markdown fences). Each element:
{
  "id": "<the exact task id given>",
  "description": "<2-4 concrete sentences describing what to build and why, grounded in the PRD>",
  "acceptance_criteria": ["<concrete, testable bullet>", "..."],
  "user_story": "As <specific persona>, I want <capability>, so that <real benefit>."
}
Rules: use only ids from the list. Keep descriptions specific to the PRD, not
boilerplate. 3-6 acceptance_criteria per task. No emojis. No em dashes.

=== PRD ===
${prd_context}

=== TASKS TO ENRICH ===
${task_lines}
PE_PROMPT_EOF
)

    local response
    # Model call failed (offline / timeout / non-zero) -> fall back to the
    # deterministic content-derived enrichment instead of leaving the stub.
    response=$(_loki_prd_enrich_invoke "$prompt") || { _loki_prd_enrich_deterministic "$pending_path"; return 0; }
    if [ -z "$response" ]; then
        _loki_prd_enrich_deterministic "$pending_path"
        return 0
    fi

    # Stage 3 (python): parse the model JSON defensively and merge into
    # pending.json, preserving on-disk format. Write to a temp file and mv
    # for atomicity. Any failure leaves the original file untouched.
    LOKI_PE_PENDING="$pending_path" LOKI_PE_RESP="$response" python3 << 'PE_MERGE_EOF'
import json, os, sys, tempfile

pending = os.environ.get("LOKI_PE_PENDING", "")
resp = os.environ.get("LOKI_PE_RESP", "")

if not pending or not os.path.isfile(pending):
    sys.exit(0)

# Defensive parse: slice first '[' to last ']' to tolerate prose/fences.
def parse_array(text):
    try:
        return json.loads(text)
    except Exception:
        pass
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        v = json.loads(text[start:end + 1])
        return v
    except Exception:
        return None

enriched = parse_array(resp)
if not isinstance(enriched, list) or not enriched:
    sys.exit(0)

# Index enrichment by id.
by_id = {}
for e in enriched:
    if not isinstance(e, dict):
        continue
    eid = e.get("id")
    if eid:
        by_id[eid] = e

if not by_id:
    sys.exit(0)

try:
    with open(pending, "r") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

if isinstance(data, list):
    tasks = data
    wrapper = None
elif isinstance(data, dict):
    tasks = data.get("tasks", [])
    wrapper = data
else:
    sys.exit(0)

def clean_str(v):
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v or None

merged = 0
for t in tasks:
    if not isinstance(t, dict):
        continue
    if t.get("source") != "prd":
        continue
    tid = t.get("id")
    e = by_id.get(tid)
    if not e:
        continue
    title = (t.get("title") or "").strip()
    # description: overwrite only with a real, non-title value.
    d = clean_str(e.get("description"))
    if d and d != title:
        t["description"] = d
    # acceptance_criteria: accept a non-empty list of non-empty strings.
    ac = e.get("acceptance_criteria")
    if isinstance(ac, list):
        ac = [c.strip() for c in ac if isinstance(c, str) and c.strip()]
        if ac:
            t["acceptance_criteria"] = ac[:10]
    # user_story: overwrite with a real "As ..., I want ..., so that ...".
    us = clean_str(e.get("user_story"))
    if us:
        t["user_story"] = us
    merged += 1

if merged == 0:
    sys.exit(0)

if wrapper is not None:
    wrapper["tasks"] = tasks
    output = wrapper
else:
    output = tasks

# Atomic write: temp file in the same dir, then mv.
d = os.path.dirname(os.path.abspath(pending)) or "."
fd, tmp = tempfile.mkstemp(dir=d, prefix=".pending-enrich-", suffix=".json")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(output, f, indent=2)
    os.replace(tmp, pending)
except Exception:
    try:
        os.unlink(tmp)
    except Exception:
        pass
    sys.exit(0)

print("Enriched %d PRD task(s) via LLM" % merged, file=sys.stderr)
PE_MERGE_EOF

    # Final deterministic sweep: any task the model did not cover (parse fail,
    # missing id) still carries the templated user_story constant. Replace it
    # with a content-derived one so no task is left with placeholder text.
    _loki_prd_enrich_deterministic "$pending_path"

    return 0
}
