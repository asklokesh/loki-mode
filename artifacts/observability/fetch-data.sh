#!/usr/bin/env bash
# fetch-data.sh
# Fetches live adoption metrics + parses repo files into data.json.
# Run on the HOST (requires gh CLI auth + internet access).
# If any endpoint fails, that metric is marked "unavailable" in data.json; never crashes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT="${SCRIPT_DIR}/data.json"
FETCHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log() { printf '%s\n' "$*" >&2; }

# ---- helpers ----

safe_gh() {
  local path="$1"
  gh api "$path" 2>/dev/null || printf '{"error":"unavailable"}'
}

safe_curl() {
  local url="$1"
  curl -sf "$url" 2>/dev/null || printf '{"error":"unavailable"}'
}

# ---- write data.json via a single Python script ----
log "Fetching all metrics and writing data.json..."

python3 - <<PYEOF
import json, subprocess, urllib.request, urllib.error, re, glob, os

FETCHED_AT = "${FETCHED_AT}"
REPO_ROOT = "${REPO_ROOT}"
OUT = "${OUT}"

def fetch_gh(path):
    try:
        result = subprocess.run(
            ["gh", "api", path],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception:
        pass
    return {"error": "unavailable"}

def fetch_url(url):
    try:
        req = urllib.request.urlopen(url, timeout=15)
        return json.loads(req.read().decode())
    except Exception:
        pass
    return {"error": "unavailable"}

# GitHub repo stats
log_msg = lambda m: print(f"[fetch] {m}", flush=True)
log_msg("GitHub repo stats...")
gh_repo = fetch_gh("repos/asklokesh/loki-mode")
if "error" not in gh_repo:
    github = {
        "stars": gh_repo.get("stargazers_count", "unavailable"),
        "forks": gh_repo.get("forks_count", "unavailable"),
        "open_issues": gh_repo.get("open_issues_count", "unavailable"),
        "created_at": gh_repo.get("created_at", "unavailable"),
        "status": "ok",
        "fetched_at": FETCHED_AT
    }
else:
    github = {"stars": "unavailable", "forks": "unavailable", "open_issues": "unavailable",
              "created_at": "unavailable", "status": "unavailable", "fetched_at": FETCHED_AT}

# Per-release downloads
log_msg("Per-release downloads...")
gh_releases = fetch_gh("repos/asklokesh/loki-mode/releases")
releases_downloads = []
if isinstance(gh_releases, list):
    for r in gh_releases:
        total_dl = sum(a.get("download_count", 0) for a in r.get("assets", []))
        releases_downloads.append({"tag": r["tag_name"], "date": r["published_at"][:10], "downloads": total_dl})

# npm 30-day daily downloads
log_msg("npm downloads...")
npm_raw = fetch_url("https://api.npmjs.org/downloads/range/last-month/loki-mode")
if "error" not in npm_raw and "downloads" in npm_raw:
    dl_list = npm_raw["downloads"]
    total = sum(x["downloads"] for x in dl_list)
    npm = {"total": total, "daily": dl_list, "status": "ok", "fetched_at": FETCHED_AT}
else:
    npm = {"total": "unavailable", "daily": [], "status": "unavailable", "fetched_at": FETCHED_AT}

# Docker Hub
log_msg("Docker Hub...")
docker_raw = fetch_url("https://hub.docker.com/v2/repositories/asklokesh/loki-mode/")
if "error" not in docker_raw and "pull_count" in docker_raw:
    docker = {
        "pulls": docker_raw["pull_count"],
        "last_updated": docker_raw.get("last_updated", ""),
        "status": "ok",
        "fetched_at": FETCHED_AT
    }
else:
    docker = {"pulls": "unavailable", "last_updated": "", "status": "unavailable", "fetched_at": FETCHED_AT}

homebrew = {
    "status": "not_available",
    "note": "not available (custom tap has no public install API)"
}

# Current version
try:
    current_version = open(os.path.join(REPO_ROOT, "VERSION")).read().strip()
except Exception:
    current_version = "unknown"

# Release timeline from CHANGELOG
releases_timeline = []
try:
    changelog = open(os.path.join(REPO_ROOT, "CHANGELOG.md")).read()
    sections = re.split(r'\n(?=## \[)', changelog)
    for s in sections:
        m = re.match(r'## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})', s)
        if not m:
            continue
        version = m.group(1)
        date = m.group(2)
        if version == "Unreleased":
            continue
        lines = s.split('\n')
        summary = ""
        for line in lines[1:]:
            line = line.strip()
            if line.startswith("###"):
                summary = line.lstrip("#").strip()
                break
            elif line and not line.startswith("##"):
                summary = line[:140]
                break
        releases_timeline.append({"version": version, "date": date, "summary": summary})
    releases_timeline = releases_timeline[:35]
except Exception as e:
    releases_timeline = []

# Benchmark data
benchmarks = []
results_dir = os.path.join(REPO_ROOT, "benchmarks", "results")
for f in sorted(glob.glob(os.path.join(results_dir, "speed-*.json"))):
    try:
        d = json.load(open(f))
        benchmarks.append({
            "file": os.path.basename(f),
            "label": d.get("label", "unknown"),
            "stamp": d.get("stamp", ""),
            "wall_clock_min": d.get("wall_clock_min"),
            "act_iterations": d.get("act_iterations"),
            "completion_claims": d.get("completion_claims"),
            "engine_completed": d.get("engine_completed"),
            "events_total": d.get("events_total"),
            "per_iteration_work": d.get("per_iteration_work_s", [])
        })
    except Exception:
        pass

# Mistakes -> fixes (real, source-attributed)
mistakes = [
    {
        "id": "fix-a-overblock",
        "what": "Bun runner FIX A: first attempt used broad blocked||escalated gate that over-blocked clean runs",
        "caught_by": "adversarial hunt + test suite (autonomous.test.ts)",
        "fixed_in": "v7.97.0",
        "how_fixed": "Rewrote to gate only on real code_review BLOCK (hardGates); clean runs complete again",
        "source": "CHANGELOG v7.97.0 FIX A rework"
    },
    {
        "id": "completion-gate-fail-open",
        "what": "Completion gates armed with type-probe that silently skipped if council library failed to source; allowed unverified completion (fake-green)",
        "caught_by": "cycle-3 adversarial bug-hunt",
        "fixed_in": "v7.95.0",
        "how_fixed": "Gate chain now verifies core functions are loadable before running; refuses claim if any missing (fail-closed)",
        "source": "CHANGELOG v7.95.0"
    },
    {
        "id": "council-force-review-fail-open",
        "what": "Council force-review path had same fail-open hole: partial library load force-approved completion ungated",
        "caught_by": "wave-4 adversarial bug-hunt",
        "fixed_in": "v7.96.0",
        "how_fixed": "Force-review now probes core gate functions before approving",
        "source": "CHANGELOG v7.96.0"
    },
    {
        "id": "tasks-500-malformed-json",
        "what": "server.py /api/tasks raised AttributeError on malformed dashboard-state.json (non-dict tasks or task groups not lists), 500ing and blanking the whole task board",
        "caught_by": "RED/GREEN test proof (council gate)",
        "fixed_in": "v7.104.4",
        "how_fixed": "State-group reader now coerces defensively; non-dict tasks treated as empty",
        "source": "CHANGELOG v7.104.4"
    },
    {
        "id": "convergence-non-stop",
        "what": "Completion council only evaluated every 5 iterations; build verifiably done at iteration 1 (19/19 tests green, checklist complete) ran 13 more needless iterations. Pathological case: 14 iterations, ~97 min wall-clock for work done in ~2 min",
        "caught_by": "Real build telemetry (anonima events.jsonl) + speed diagnosis",
        "fixed_in": "v7.105.0",
        "how_fixed": "Explicit completion claim now triggers immediate council evaluation; no-claim cadence unchanged",
        "source": "CHANGELOG v7.105.0, docs/SPEED-DIAGNOSIS-2026-07-01.md"
    },
    {
        "id": "council-threshold-ignored",
        "what": "LOKI_COUNCIL_THRESHOLD operator config was silently ignored; hardcoded 2/3 formula used even when operator set stricter threshold",
        "caught_by": "wave-6 adversarial hunt",
        "fixed_in": "v7.98.0",
        "how_fixed": "Effective threshold = max(2/3 floor, operator threshold), shared helper at all three vote sites",
        "source": "CHANGELOG v7.98.0"
    },
    {
        "id": "ci-shell-test-contract",
        "what": "v7.81.0 python test registered as command string in run-all-tests.sh but runner exec's via bash; local-ci passed (different contract), CI failed post-push",
        "caught_by": "CI failure post v7.81.0 push",
        "fixed_in": "v7.81.1",
        "how_fixed": "Bash wrapper added; pattern now consistent across both gates",
        "source": "CHANGELOG v7.81.1"
    }
]

# What did NOT work
didnt_work = [
    {
        "id": "embeddings-only-signal",
        "what": "wave-7 batch included an embeddings-only signal for anti-pattern memory dedupe; reverted as inert",
        "reason": "Added no actual behavior change; core fix was the dedup logic, not the embedding signal",
        "outcome": "Superseded and reverted in v7.99.1",
        "source": "CHANGELOG v7.99.1"
    },
    {
        "id": "prd-reuse-rebuild-always",
        "what": "PRD-reuse on rerun assumed rebuild-always: a loki start with no PRD over an already-completed project would rebuild the full task queue and re-run the entire RARV loop, redoing finished work",
        "reason": "Reuse path never asked 'is this spec already satisfied by current code?'",
        "outcome": "Fixed in v7.94.0 with done-recognition gate; rebuild-always approach retired",
        "source": "CHANGELOG v7.94.0, docs/SPEED-DIAGNOSIS-2026-07-01.md"
    },
    {
        "id": "never-finished-prompt-all-modes",
        "what": "RARV instruction 'There is NEVER a finished state - always find the next improvement' was emitted in every mode, including finite PRD/checkpoint runs - a direct self-contradiction and the prompt root of 14-iteration convergence bug",
        "reason": "Intended for perpetual/no-promise mode only; biased model toward redundant self-verification in finite builds",
        "outcome": "Mode-aware rarv instruction; finite runs now get stop-when-verified-done directive",
        "source": "docs/research-2026-07/GAP-ANALYSIS-BACKLOG.md item 8"
    },
    {
        "id": "local-ci-parallelization",
        "what": "local-ci.sh parallelized for speed; non-hermetic tests began flaking under concurrent execution, making the gate non-deterministic",
        "reason": "Shared temp state between lanes; ordering dependencies not accounted for",
        "outcome": "Reverted to serial gate",
        "source": "MEMORY.md feedback-localci-parallelization-flake"
    }
]

# What worked
what_worked = [
    {"item": "Completion council trust moat (fail-closed gates)", "version": "v7.95.0-v7.96.0",
     "evidence": "Adversarial bug-hunt + real gate behavior; no fake-green on partial library load"},
    {"item": "Convergence fix: council evaluates on explicit completion claim", "version": "v7.105.0",
     "evidence": "test-council-convergence-on-claim.sh RED on pre-fix, GREEN on fix; matches telemetry pathology"},
    {"item": "Sonnet 5 as default (~40% cheaper vs Opus, near-frontier intelligence)", "version": "v7.104.0",
     "evidence": "Live builds completing; council still 3/3; released npm/Docker/Homebrew"},
    {"item": "Auth preflight: keychain login detection (macOS native Claude Code 2.x)", "version": "v7.104.2",
     "evidence": "8-case test suite + live Docker; reproduced false-block, confirmed fix"},
    {"item": "Memory panel accuracy (PR #178 + sibling gaps closed)", "version": "v7.104.5",
     "evidence": "Live vs anonima project; count and drill-in list agree; contributor PR merged"},
    {"item": "Task board honest done column (no empty cards, no dups)", "version": "v7.104.3",
     "evidence": "Live vs real anonima, browser screenshots, council 3/3"},
    {"item": "3-reviewer completion council (2 Opus + 1 Sonnet, unanimous-required)", "version": "v7.43.0+",
     "evidence": "Implemented at run.sh:10461-10954; catches fake-green before ship"},
    {"item": "Zero-friction preflight: catch not-logged-in before build stall", "version": "v7.98.0",
     "evidence": "Fails fast with one-step fix; 401 no longer the discovery mechanism"}
]

# Open founder decisions
founder_decisions = [
    {"id": "A1", "label": "License for @autonomi/verify", "options": "BUSL-1.1 / MIT / Apache / other",
     "blocks": "All commercial launch of Autonomi Verify", "rank": 5},
    {"id": "A2", "label": "npm registry + package name for @autonomi/verify",
     "options": "Publish @autonomi/verify publicly? Confirm bin name (resolve loki-verify collision)",
     "blocks": "npm-installable SDK; collision fix", "rank": 4},
    {"id": "A3", "label": "Hosted /verify deploy target + signing-key storage",
     "options": "Fly / Render / AWS / your infra + secret manager choice",
     "blocks": "Category-defining signed neutral REST endpoint", "rank": 6},
    {"id": "A4", "label": "Wire verifyCompletion() pipeline (XL build)",
     "options": "Start after A1+A2 resolved",
     "blocks": "Whole SDK/MCP value prop; currently stubbed", "rank": 3},
    {"id": "B5", "label": "Enterprise deploy shape: hosted-multitenant vs on-prem first",
     "options": "Sequences RBAC/SSO/API-key/metering + sandbox backend",
     "blocks": "Enterprise sale capability", "rank": 15},
    {"id": "C7", "label": "SWE-bench Pro 119 resume (paused at 35/119)",
     "options": "yes / no (compute spend decision)",
     "blocks": "Real public benchmark datapoint", "rank": 7},
    {"id": "D8", "label": "Outreach: MCP registry + Glama claim + awesome-list PRs",
     "options": "Approve external posts (yes/no)",
     "blocks": "Discovery surface; posts need your nod per action rules", "rank": 8}
]

out = {
    "generated_at": FETCHED_AT,
    "current_version": current_version,
    "github": github,
    "npm": npm,
    "docker": docker,
    "homebrew": homebrew,
    "releases_downloads": releases_downloads,
    "releases_timeline": releases_timeline,
    "benchmarks": benchmarks,
    "what_worked": what_worked,
    "didnt_work": didnt_work,
    "mistakes": mistakes,
    "founder_decisions": founder_decisions
}

with open(OUT, "w") as f:
    json.dump(out, f, indent=2)

print(f"data.json written: {OUT}")
PYEOF
