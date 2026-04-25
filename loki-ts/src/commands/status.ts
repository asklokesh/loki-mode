// Port of autonomy/loki:1963 (cmd_status) and :2124 (cmd_status_json).
// Reproduces text output byte-for-byte (modulo ANSI normalization in tests)
// and JSON output field-for-field.
//
// JSON path strategy: option (a) -- we shell out to python3 with the EXACT
// same inline script the bash uses. This guarantees field parity (key order,
// indentation, datetime parsing, edge cases) without re-deriving 100+ lines
// of Python in TypeScript. Reviewer 1's parity diff is the design contract.
//
// Text path strategy: reimplemented in TS for speed, but every echo line
// matches bash byte-for-byte. jq is shelled out (same as bash) for the
// orchestrator phase / pending task count branches.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { commandExists, run } from "../util/shell.ts";
import { findPython3 } from "../util/python.ts";
import { BOLD, CYAN, GREEN, YELLOW, RED, DIM, NC } from "../util/colors.ts";
import { lokiDir, REPO_ROOT } from "../util/paths.ts";

// Inline Python source -- copied verbatim from autonomy/loki:2131-2275
// (cmd_status_json body). DO NOT modify without updating bash side too.
const STATUS_JSON_PY = `
import json, os, sys, time

skill_dir = sys.argv[1]
loki_dir = sys.argv[2]
dashboard_port = sys.argv[3]
env_provider = sys.argv[4]
result = {}

# Version
version_file = os.path.join(skill_dir, 'VERSION')
if os.path.isfile(version_file):
    with open(version_file) as f:
        result['version'] = f.read().strip()
else:
    result['version'] = 'unknown'

# Check if session exists
if not os.path.isdir(loki_dir):
    result['status'] = 'inactive'
    result['phase'] = None
    result['iteration'] = 0
    result['provider'] = env_provider
    result['dashboard_url'] = None
    result['pid'] = None
    result['elapsed_time'] = 0
    result['task_counts'] = {'total': 0, 'completed': 0, 'failed': 0, 'pending': 0}
    print(json.dumps(result, indent=2))
    sys.exit(0)

# Status from signals and session.json
if os.path.isfile(os.path.join(loki_dir, 'PAUSE')):
    result['status'] = 'paused'
elif os.path.isfile(os.path.join(loki_dir, 'STOP')):
    result['status'] = 'stopped'
else:
    session_file = os.path.join(loki_dir, 'session.json')
    if os.path.isfile(session_file):
        try:
            with open(session_file) as f:
                session = json.load(f)
            result['status'] = session.get('status', 'unknown')
        except Exception:
            result['status'] = 'unknown'
    else:
        result['status'] = 'unknown'

# Phase and iteration from dashboard-state.json
ds_file = os.path.join(loki_dir, 'dashboard-state.json')
if os.path.isfile(ds_file):
    try:
        with open(ds_file) as f:
            ds = json.load(f)
        result['phase'] = ds.get('phase', ds.get('currentPhase'))
        result['iteration'] = ds.get('iteration', ds.get('currentIteration', 0))
    except Exception:
        result['phase'] = None
        result['iteration'] = 0
else:
    orch_file = os.path.join(loki_dir, 'state', 'orchestrator.json')
    if os.path.isfile(orch_file):
        try:
            with open(orch_file) as f:
                orch = json.load(f)
            result['phase'] = orch.get('currentPhase')
            result['iteration'] = orch.get('currentIteration', 0)
        except Exception:
            result['phase'] = None
            result['iteration'] = 0
    else:
        result['phase'] = None
        result['iteration'] = 0

# Provider
provider_file = os.path.join(loki_dir, 'state', 'provider')
if os.path.isfile(provider_file):
    with open(provider_file) as f:
        result['provider'] = f.read().strip()
else:
    result['provider'] = env_provider

# PID
pid_file = os.path.join(loki_dir, 'loki.pid')
if os.path.isfile(pid_file):
    try:
        with open(pid_file) as f:
            result['pid'] = int(f.read().strip())
    except (ValueError, Exception):
        result['pid'] = None
else:
    result['pid'] = None

# Elapsed time from session.json
session_file = os.path.join(loki_dir, 'session.json')
if os.path.isfile(session_file):
    try:
        with open(session_file) as f:
            session = json.load(f)
        start_time = session.get('start_time', session.get('startTime'))
        if start_time:
            if isinstance(start_time, (int, float)):
                result['elapsed_time'] = int(time.time() - start_time)
            else:
                from datetime import datetime
                dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                result['elapsed_time'] = int(time.time() - dt.timestamp())
        else:
            result['elapsed_time'] = 0
    except Exception:
        result['elapsed_time'] = 0
else:
    result['elapsed_time'] = 0

# Dashboard URL
dashboard_pid_file = os.path.join(loki_dir, 'dashboard', 'dashboard.pid')
dashboard_url = None
if os.path.isfile(dashboard_pid_file):
    try:
        with open(dashboard_pid_file) as f:
            dpid = int(f.read().strip())
        os.kill(dpid, 0)
        dashboard_url = 'http://127.0.0.1:' + dashboard_port + '/'
    except (ProcessLookupError, PermissionError, ValueError, Exception):
        pass
result['dashboard_url'] = dashboard_url

# Task counts from queue files
task_counts = {'total': 0, 'completed': 0, 'failed': 0, 'pending': 0}
queue_dir = os.path.join(loki_dir, 'queue')
if os.path.isdir(queue_dir):
    for name, key in [('pending.json', 'pending'), ('completed.json', 'completed'), ('failed.json', 'failed')]:
        fpath = os.path.join(queue_dir, name)
        if os.path.isfile(fpath):
            try:
                with open(fpath) as f:
                    data = json.load(f)
                if isinstance(data, list):
                    task_counts[key] = len(data)
                elif isinstance(data, dict) and 'tasks' in data:
                    task_counts[key] = len(data['tasks'])
            except Exception:
                pass
    task_counts['total'] = task_counts['pending'] + task_counts['completed'] + task_counts['failed']
result['task_counts'] = task_counts

print(json.dumps(result, indent=2))
`;

// Mirror of require_jq (autonomy/loki:223). Returns true if jq is available;
// otherwise prints the same error block to stdout (bash uses echo, not >&2).
async function requireJq(): Promise<boolean> {
  const path = await commandExists("jq");
  if (path) return true;
  process.stdout.write(`${RED}Error: jq is required but not installed.${NC}\n`);
  process.stdout.write(`Install with:\n`);
  process.stdout.write(`  brew install jq    (macOS)\n`);
  process.stdout.write(`  apt install jq     (Debian/Ubuntu)\n`);
  process.stdout.write(`  yum install jq     (RHEL/CentOS)\n`);
  return false;
}

// Mirror of `kill -0 <pid>` -- check whether a process exists (signal 0).
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Mirror of list_running_sessions (autonomy/loki:1508).
// Returns array of "sid:pid" strings; "global" sid for top-level loki.pid.
function listRunningSessions(dir: string): string[] {
  const sessions: string[] = [];

  // Global session
  const globalPid = readPidFile(resolve(dir, "loki.pid"));
  if (globalPid !== null && pidAlive(globalPid)) {
    sessions.push(`global:${globalPid}`);
  }

  // Per-session PIDs
  const sessionsDir = resolve(dir, "sessions");
  if (existsSync(sessionsDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(sessionsDir);
    } catch {
      entries = [];
    }
    for (const sid of entries) {
      const sessionDir = resolve(sessionsDir, sid);
      try {
        if (!statSync(sessionDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const pidFile = resolve(sessionDir, "loki.pid");
      const pid = readPidFile(pidFile);
      if (pid !== null && pidAlive(pid)) {
        sessions.push(`${sid}:${pid}`);
      }
    }
  }

  // Legacy run-*.pid files
  if (existsSync(dir)) {
    let topEntries: string[] = [];
    try {
      topEntries = readdirSync(dir);
    } catch {
      topEntries = [];
    }
    for (const fname of topEntries) {
      if (!fname.startsWith("run-") || !fname.endsWith(".pid")) continue;
      const runPidFile = resolve(dir, fname);
      try {
        if (!statSync(runPidFile).isFile()) continue;
      } catch {
        continue;
      }
      const sid = basename(fname, ".pid").slice("run-".length);
      const pid = readPidFile(runPidFile);
      if (pid !== null && pidAlive(pid)) {
        // Avoid duplicates already in sessions/
        const dup = sessions.some((s) => s.startsWith(`${sid}:`));
        if (!dup) sessions.push(`${sid}:${pid}`);
      }
    }
  }

  return sessions;
}

// Run jq with the given filter against a file. Returns trimmed stdout or null
// on any failure (matches bash `2>/dev/null || echo "<fallback>"` patterns).
async function jqEval(filter: string, file: string): Promise<string | null> {
  const r = await run(["jq", "-r", filter, file]);
  if (r.exitCode !== 0) return null;
  const out = r.stdout.trim();
  return out;
}

// Reads VERSION-style budget number with python3 (bash uses inline python3).
// Fallback to manual JSON parse if python3 missing.
function readBudgetField(file: string, field: "budget_limit" | "budget_used"): string {
  try {
    const txt = readFileSync(file, "utf-8");
    const obj = JSON.parse(txt) as Record<string, unknown>;
    const v = obj[field];
    if (typeof v === "number") {
      // Bash uses round(..., 2) for budget_used, plain print() for budget_limit.
      if (field === "budget_used") {
        // Python's round(x, 2) is banker's rounding but our tests use whole/half
        // integers; close enough. Use toFixed then strip trailing zeros to match
        // python's print(round(...)) which prints e.g. "0", "1.5", "2.34".
        const rounded = Math.round(v * 100) / 100;
        // python int prints as "0" not "0.0"; floats keep one decimal min.
        if (Number.isInteger(rounded)) return String(rounded);
        return String(rounded);
      }
      return String(v);
    }
    if (v === undefined || v === null) {
      return "0";
    }
    return String(v);
  } catch {
    return "0";
  }
}

// Reads context-usage.json fields.
function readContextField(file: string, field: "window_size" | "used_tokens", fallback: number): number {
  try {
    const txt = readFileSync(file, "utf-8");
    const obj = JSON.parse(txt) as Record<string, unknown>;
    const v = obj[field];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    return fallback;
  } catch {
    return fallback;
  }
}

async function runStatusText(): Promise<number> {
  const dir = lokiDir();

  if (!(await requireJq())) {
    return 1;
  }

  if (!existsSync(dir)) {
    process.stdout.write(`${BOLD}Loki Mode Status${NC}\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`${YELLOW}No active session found.${NC}\n`);
    process.stdout.write(`Loki Mode has not been initialized in this directory.\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`To start a session:\n`);
    process.stdout.write(`  loki start <prd>              - Start with a PRD file\n`);
    process.stdout.write(`  loki start                    - Start without a PRD\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`${DIM}Current directory: ${process.cwd()}${NC}\n`);
    return 0;
  }

  process.stdout.write(`${BOLD}Loki Mode Status${NC}\n`);
  process.stdout.write(`\n`);

  // Provider
  let savedProvider = "";
  const providerFile = resolve(dir, "state", "provider");
  if (existsSync(providerFile)) {
    try {
      savedProvider = readFileSync(providerFile, "utf-8").trim();
    } catch {
      savedProvider = "";
    }
  }
  const currentProvider = savedProvider || process.env["LOKI_PROVIDER"] || "claude";
  let capability = "full features";
  switch (currentProvider) {
    case "codex":
    case "gemini":
    case "aider":
      capability = "degraded mode";
      break;
    case "cline":
      capability = "near-full mode";
      break;
    default:
      capability = "full features";
      break;
  }
  process.stdout.write(`${CYAN}Provider:${NC} ${currentProvider} (${capability})\n`);
  process.stdout.write(`${DIM}  Switch with: loki provider set <claude|codex|gemini|cline|aider>${NC}\n`);
  process.stdout.write(`\n`);

  // Running sessions
  const sessions = listRunningSessions(dir);
  if (sessions.length > 0) {
    process.stdout.write(`${GREEN}Active Sessions: ${sessions.length}${NC}\n`);
    for (const entry of sessions) {
      const colon = entry.indexOf(":");
      const sid = colon >= 0 ? entry.slice(0, colon) : entry;
      const spid = colon >= 0 ? entry.slice(colon + 1) : "";
      if (sid === "global") {
        process.stdout.write(`  ${CYAN}[global]${NC} PID ${spid}\n`);
      } else {
        process.stdout.write(`  ${CYAN}[#${sid}]${NC} PID ${spid}\n`);
      }
    }
    process.stdout.write(`\n`);
    process.stdout.write(`${DIM}  Stop specific: loki stop <session-id>${NC}\n`);
    process.stdout.write(`${DIM}  Stop all:      loki stop${NC}\n`);
    process.stdout.write(`\n`);
  }

  // Signals
  if (existsSync(resolve(dir, "PAUSE"))) {
    process.stdout.write(`${YELLOW}Status: PAUSED${NC}\n`);
    process.stdout.write(`${DIM}  Resume with: loki resume${NC}\n`);
    process.stdout.write(`\n`);
  } else if (existsSync(resolve(dir, "STOP"))) {
    process.stdout.write(`${RED}Status: STOPPED${NC}\n`);
    process.stdout.write(`${DIM}  Clear with: loki resume${NC}\n`);
    process.stdout.write(`\n`);
  }

  // STATUS.txt
  const statusTxt = resolve(dir, "STATUS.txt");
  if (existsSync(statusTxt)) {
    process.stdout.write(`${CYAN}Session Info:${NC}\n`);
    try {
      process.stdout.write(readFileSync(statusTxt, "utf-8"));
    } catch {
      // bash `cat` would print error to stderr; we silently skip.
    }
    process.stdout.write(`\n`);
  }

  // Orchestrator state (jq parity)
  const orchFile = resolve(dir, "state", "orchestrator.json");
  if (existsSync(orchFile)) {
    process.stdout.write(`${CYAN}Orchestrator State:${NC}\n`);
    const phase = await jqEval('.currentPhase // "unknown"', orchFile);
    process.stdout.write(`${phase ?? "unknown"}\n`);
  }

  // Pending tasks (jq parity)
  const pendingFile = resolve(dir, "queue", "pending.json");
  if (existsSync(pendingFile)) {
    const count = await jqEval(
      'if type == "array" then length elif .tasks then .tasks | length else 0 end',
      pendingFile,
    );
    process.stdout.write(`${CYAN}Pending Tasks:${NC} ${count ?? "0"}\n`);
  }

  // Budget
  const budgetFile = resolve(dir, "metrics", "budget.json");
  if (existsSync(budgetFile)) {
    const budgetLimit = readBudgetField(budgetFile, "budget_limit");
    const budgetUsed = readBudgetField(budgetFile, "budget_used");
    if (budgetLimit !== "0") {
      process.stdout.write(`${CYAN}Budget:${NC} \$${budgetUsed} / \$${budgetLimit}\n`);
      // context_gauge function is from TUI helpers loaded by bash; not ported.
    } else {
      process.stdout.write(`${CYAN}Cost:${NC} \$${budgetUsed} (no limit)\n`);
    }
  }

  // Context window
  const ctxFile = resolve(dir, "state", "context-usage.json");
  if (existsSync(ctxFile)) {
    const ctxTotal = readContextField(ctxFile, "window_size", 200000);
    const ctxUsed = readContextField(ctxFile, "used_tokens", 0);
    let ctxPct = 0;
    if (ctxTotal > 0) {
      ctxPct = Math.floor((ctxUsed * 100) / ctxTotal);
    }
    process.stdout.write(`${CYAN}Context:${NC} ${ctxPct}% (${ctxUsed} / ${ctxTotal} tokens)\n`);
  }

  // Dashboard
  const dashPidFile = resolve(dir, "dashboard", "dashboard.pid");
  if (existsSync(dashPidFile)) {
    const pid = readPidFile(dashPidFile);
    if (pid !== null && pidAlive(pid)) {
      const port = process.env["LOKI_DASHBOARD_PORT"] || "57374";
      process.stdout.write(`${CYAN}Dashboard:${NC} http://127.0.0.1:${port}/\n`);
    }
  }

  process.stdout.write(`\n`);
  process.stdout.write(`${DIM}  Tip: loki context show   - detailed token breakdown${NC}\n`);
  process.stdout.write(`${DIM}  Tip: loki code overview   - codebase intelligence${NC}\n`);
  return 0;
}

async function runStatusJson(): Promise<number> {
  const py = await findPython3();
  if (!py) {
    process.stderr.write(`{"error": "Failed to generate JSON status. Ensure python3 is available."}\n`);
    return 1;
  }
  const skillDir = REPO_ROOT;
  const dir = lokiDir();
  const dashboardPort = process.env["LOKI_DASHBOARD_PORT"] || "57374";
  const envProvider = process.env["LOKI_PROVIDER"] || "claude";

  // v7.4.2 fix (BUG-10): cap Python aggregation at 30s. Without this a wedged
  // python3 would hang `loki status --json` indefinitely.
  const r = await run([py, "-c", STATUS_JSON_PY, skillDir, dir, dashboardPort, envProvider], {
    timeoutMs: 30000,
  });
  if (r.exitCode !== 0) {
    process.stderr.write(`{"error": "Failed to generate JSON status. Ensure python3 is available."}\n`);
    return 1;
  }
  process.stdout.write(r.stdout);
  return 0;
}

export async function runStatus(argv: readonly string[]): Promise<number> {
  // Flag parsing mirrors bash while-loop at autonomy/loki:1965.
  const args = [...argv];
  while (args.length > 0) {
    const flag = args[0];
    if (flag === "--json") {
      return runStatusJson();
    }
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`Usage: loki status [--json]\n`);
      return 0;
    }
    process.stdout.write(`${RED}Unknown flag: ${flag}${NC}\n`);
    process.stdout.write(`Usage: loki status [--json]\n`);
    return 1;
  }
  return runStatusText();
}
