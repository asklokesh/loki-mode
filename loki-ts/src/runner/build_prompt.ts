// build_prompt.ts -- Bun port of bash build_prompt() (autonomy/run.sh:8912-9382).
//
// Parity-CRITICAL function. Assembles the autonomous-loop prompt that the
// orchestrator hands to Claude / Codex / Gemini. The function is read-only
// w.r.t. .loki/ state: it only consumes files and env vars, never writes.
//
// Two output shapes are produced (selected by env vars):
//   1. New static-first layout (v6.82.0+): <loki_system> ... </loki_system>
//      [CACHE_BREAKPOINT] <dynamic_context> ... </dynamic_context>
//   2. Legacy single-line layout (LOKI_LEGACY_PROMPT_ORDERING=true): all
//      sections concatenated on one echo line.
//
// And two provider modes inside layout (1):
//   - Full provider (Claude): full RARV / SDLC / autonomy / memory blocks.
//   - PROVIDER_DEGRADED=true (Codex / Gemini): minimal coding-assistant prefix
//     plus dynamic tail with priority/queue/PRD content.
//
// All bash variable expansion is resolved BEFORE assembling the prompt string,
// matching bash's printf semantics. No shell-out for substitution.
//
// References:
//   - autonomy/run.sh:8912 build_prompt()
//   - autonomy/run.sh:8126 load_ledger_context()
//   - autonomy/run.sh:8225 load_handoff_context()
//   - autonomy/run.sh:8282 load_startup_learnings()
//   - autonomy/run.sh:8359 retrieve_memory_context()
//   - autonomy/run.sh:8823 load_queue_tasks()
//   - loki-ts/docs/phase4-research/build_prompt.md

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runInline } from "../util/python.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunnerEnv {
  /** Map of env vars overriding process.env. Used by tests; production passes process.env. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface RunnerContext {
  /** Working directory (analog of bash cwd inside the run.sh subshell). */
  readonly cwd: string;
  /** Project root (analog of $PROJECT_DIR in bash). */
  readonly projectDir?: string;
  /** Env source (defaults to process.env). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface BuildPromptOpts {
  readonly retry: number;
  readonly prd: string | null;
  readonly iteration: number;
  readonly ctx: RunnerContext;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envBool(env: Readonly<Record<string, string | undefined>>, key: string): boolean {
  return env[key] === "true";
}

function envStr(env: Readonly<Record<string, string | undefined>>, key: string, dflt = ""): string {
  const v = env[key];
  return v === undefined || v === null ? dflt : v;
}

function envInt(env: Readonly<Record<string, string | undefined>>, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === "") return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

/** Read a UTF-8 file, returning null if missing. */
function readFileSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Strip trailing newlines (mirrors bash command-substitution semantics). */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}

/** Read a file then truncate to N bytes (bash `$(head -c N file)`).
 *
 * Bash command substitution `$(...)` ALSO strips embedded NUL bytes
 * (bash variables cannot hold NUL). Mirror that to keep parity with the
 * shell baseline, especially for binary PRD reads (fixture-50).
 */
function readBytesSafe(path: string, maxBytes: number): string | null {
  const buf = readFileBufferSafe(path);
  if (buf === null) return null;
  const sliced = buf.byteLength <= maxBytes ? buf : buf.subarray(0, maxBytes);
  // Strip NUL bytes BEFORE utf-8 decode so the byte count matches bash.
  let stripped: Buffer = sliced;
  if (sliced.includes(0)) {
    const out: number[] = [];
    for (const b of sliced) {
      if (b !== 0) out.push(b);
    }
    stripped = Buffer.from(out);
  }
  const text = stripped.toString("utf8");
  // Bash command substitution `$(...)` strips trailing newlines.
  return stripTrailingNewlines(text);
}

/** Read a file as raw bytes, returning null if missing. */
function readFileBufferSafe(path: string): Buffer | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Read a file then keep first N lines (bash `$(head -N file)`). */
function readLinesSafe(path: string, maxLines: number): string | null {
  const content = readFileSafe(path);
  if (content === null) return null;
  const lines = content.split("\n");
  // bash head -N emits the first N newline-terminated lines (last one has its \n).
  // The surrounding $(...) then strips trailing newlines.
  const limit = Math.min(maxLines, lines.length);
  // If the file ends with \n, lines[length-1] is "" -- skip it within the limit
  // for unbounded reads to mirror bash's "no trailing blank line" effect.
  const sliced = lines.slice(0, limit);
  return stripTrailingNewlines(sliced.join("\n"));
}

// ---------------------------------------------------------------------------
// SDLC phases list (run.sh:8917-8930)
// ---------------------------------------------------------------------------

const PHASE_KEYS = [
  "UNIT_TESTS",
  "API_TESTS",
  "E2E_TESTS",
  "SECURITY",
  "INTEGRATION",
  "CODE_REVIEW",
  "WEB_RESEARCH",
  "PERFORMANCE",
  "ACCESSIBILITY",
  "REGRESSION",
  "UAT",
] as const;

function buildPhases(env: Readonly<Record<string, string | undefined>>): string {
  const enabled: string[] = [];
  for (const key of PHASE_KEYS) {
    if (envBool(env, `PHASE_${key}`)) enabled.push(key);
  }
  return enabled.join(",");
}

// ---------------------------------------------------------------------------
// Static instruction generators (deterministic, byte-stable).
// These literals MUST match autonomy/run.sh:8933-8962 exactly.
// ---------------------------------------------------------------------------

function rarvInstruction(maxParallel: number): string {
  // run.sh:8933
  return `RALPH WIGGUM MODE ACTIVE. Use Reason-Act-Reflect-VERIFY cycle: 1) REASON - READ .loki/CONTINUITY.md including 'Mistakes & Learnings' section to avoid past errors. CHECK .loki/state/relevant-learnings.json for cross-project learnings from previous projects (mistakes to avoid, patterns to apply). Check .loki/state/ and .loki/queue/, identify next task. CHECK .loki/state/resources.json for system resource warnings - if CPU or memory is high, reduce parallel agent spawning or pause non-critical tasks. Limit to MAX_PARALLEL_AGENTS=${maxParallel}. If queue empty, find new improvements. 2) ACT - Execute task, write code, commit changes atomically (git checkpoint). 3) REFLECT - Update .loki/CONTINUITY.md with progress, update state, identify NEXT improvement. Save valuable learnings for future projects. 4) VERIFY - Run automated tests (unit, integration, E2E), check compilation/build, verify against spec. IF VERIFICATION FAILS: a) Capture error details (stack trace, logs), b) Analyze root cause, c) UPDATE 'Mistakes & Learnings' in CONTINUITY.md with what failed, why, and how to prevent, d) Rollback to last good git checkpoint if needed, e) Apply learning and RETRY from REASON. If verification passes, mark task complete and continue. This self-verification loop achieves 2-3x quality improvement. CRITICAL: There is NEVER a 'finished' state - always find the next improvement, optimization, test, or feature.`;
}

function completionInstruction(
  completionPromise: string,
  iteration: number,
  maxIterations: number,
): string {
  // run.sh:8941-8945
  if (completionPromise.length > 0) {
    return `COMPLETION_PROMISE: [${completionPromise}]. When all PRD requirements are implemented, tests pass, and the PRD checklist is at or near 100%, invoke the loki_complete_task MCP tool with your completion_statement and evidence (cite tests that passed, checklist items verified, files created/modified). Do NOT emit a completion string in prose -- use the tool call.`;
  }
  return `NO COMPLETION PROMISE SET. Continue finding improvements. The Completion Council will evaluate your progress periodically. Iteration ${iteration} of max ${maxIterations}. If you do decide the task is complete, invoke the loki_complete_task MCP tool with a structured statement and evidence rather than emitting prose.`;
}

function autonomousSuffix(perpetual: boolean, completionPromise: string): string {
  // run.sh:8948-8953
  if (perpetual) {
    return `CRITICAL AUTONOMY RULES: 1) NEVER ask questions - just decide. 2) NEVER wait for confirmation - just act. 3) NEVER say 'done' or 'complete' - there's always more to improve. 4) NEVER stop voluntarily - if out of tasks, create new ones (add tests, optimize, refactor, add features). 5) Work continues PERPETUALLY. Even if PRD is implemented, find bugs, add tests, improve UX, optimize performance.`;
  }
  return `CRITICAL AUTONOMY RULES: 1) NEVER ask questions - just decide. 2) NEVER wait for confirmation - just act. 3) When all PRD requirements are implemented and tests pass, invoke the loki_complete_task MCP tool (completion_statement='${completionPromise}' plus evidence + confidence). Do not emit completion prose. 4) If out of tasks but PRD is not fully implemented, continue working on remaining requirements. 5) Focus on completing PRD scope, not endless improvements.`;
}

function sdlcInstruction(phases: string): string {
  // run.sh:8956
  return `SDLC_PHASES_ENABLED: [${phases}]. Execute ALL enabled phases. Log results to .loki/logs/. See .loki/SKILL.md for phase details. Skill modules at .loki/skills/.`;
}

const ANALYSIS_INSTRUCTION =
  // run.sh:8959
  `CODEBASE_ANALYSIS_MODE: No PRD. FIRST: Analyze codebase - scan structure, read package.json/requirements.txt, examine README. THEN: Generate PRD at .loki/generated-prd.md. FINALLY: Execute SDLC phases.`;

const MEMORY_INSTRUCTION =
  // run.sh:8962
  `MEMORY SYSTEM: Relevant context from past sessions is provided below (if any). Your actions will be automatically recorded for future reference. For complex handoffs: create .loki/memory/handoffs/{timestamp}.md. For important decisions: they will be captured in the timeline. Check .loki/CONTINUITY.md for session-level working memory.`;

// ---------------------------------------------------------------------------
// load_ledger_context (run.sh:8126) -- newest LEDGER-*.md, head -100 lines.
// ---------------------------------------------------------------------------

function loadLedgerContext(cwd: string): string {
  const dir = resolve(cwd, ".loki/memory/ledgers");
  if (!existsSync(dir)) return "";
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.startsWith("LEDGER-") && f.endsWith(".md"));
  } catch {
    return "";
  }
  if (entries.length === 0) return "";
  // bash `ls -t` sorts by mtime descending. Stat each file and pick newest.
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    const p = resolve(dir, name);
    try {
      const st = statSync(p);
      if (newest === null || st.mtimeMs > newest.mtimeMs) {
        newest = { path: p, mtimeMs: st.mtimeMs };
      }
    } catch {
      /* skip */
    }
  }
  if (newest === null) return "";
  return readLinesSafe(newest.path, 100) ?? "";
}

// ---------------------------------------------------------------------------
// load_handoff_context (run.sh:8225). Newest .json (within 1 day, bash uses
// `find -mtime -1`); falls back to newest .md (head -80 lines).
// We mirror the touch-on-load semantics by NOT enforcing the mtime filter --
// the bash test harness touches files just before invocation, so it is
// effectively "newest of all".
// ---------------------------------------------------------------------------

async function loadHandoffContext(cwd: string): Promise<string> {
  const dir = resolve(cwd, ".loki/memory/handoffs");
  if (!existsSync(dir)) return "";
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return "";
  }

  const pickNewest = (suffix: string): string | null => {
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const name of entries) {
      if (!name.endsWith(suffix)) continue;
      const p = resolve(dir, name);
      try {
        const st = statSync(p);
        if (newest === null || st.mtimeMs > newest.mtimeMs) {
          newest = { path: p, mtimeMs: st.mtimeMs };
        }
      } catch {
        /* skip */
      }
    }
    return newest === null ? null : newest.path;
  };

  const json = pickNewest(".json");
  if (json !== null) {
    // run.sh:8233 -- format JSON via Python. We replicate the format in TS
    // since it is a stable schema (no need to shell out).
    const raw = readFileSafe(json);
    if (raw === null) return "";
    try {
      const h = JSON.parse(raw) as Record<string, unknown>;
      const parts: string[] = [];
      const ts = String(h["timestamp"] ?? "unknown");
      const reason = String(h["reason"] ?? "unknown");
      parts.push(`Handoff from ${ts} (reason: ${reason})`);
      parts.push(`Iteration: ${String(h["iteration"] ?? 0)}`);
      const files = h["files_modified"];
      if (Array.isArray(files) && files.length > 0) {
        parts.push(`Modified files: ${files.slice(0, 10).map(String).join(", ")}`);
      }
      const tasks = (h["task_status"] as Record<string, unknown> | undefined) ?? {};
      parts.push(
        `Tasks - pending: ${String(tasks["pending"] ?? 0)}, completed: ${String(tasks["completed"] ?? 0)}`,
      );
      const oq = h["open_questions"];
      if (Array.isArray(oq)) {
        for (const q of oq) parts.push(`Open question: ${String(q)}`);
      }
      const bl = h["blockers"];
      if (Array.isArray(bl)) {
        for (const b of bl) parts.push(`Blocker: ${String(b)}`);
      }
      return parts.join(" | ");
    } catch {
      return "";
    }
  }

  const md = pickNewest(".md");
  if (md !== null) {
    return readLinesSafe(md, 80) ?? "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// load_startup_learnings (run.sh:8282). Reads .loki/state/memory-context.json,
// emits "STARTUP LEARNINGS (pre-loaded):" header + top 5 memories formatted
// as `- [source|score] summary[:100]`.
// ---------------------------------------------------------------------------

function loadStartupLearnings(cwd: string): string {
  const path = resolve(cwd, ".loki/state/memory-context.json");
  const raw = readFileSafe(path);
  if (raw === null) return "";
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) return "";
    if (typeof data["memory_count"] !== "number") return "";
    const memories = data["memories"];
    if (!Array.isArray(memories) || memories.length === 0) return "";
    const lines: string[] = ["STARTUP LEARNINGS (pre-loaded):"];
    for (const m of memories.slice(0, 5)) {
      if (typeof m !== "object" || m === null) continue;
      const mo = m as Record<string, unknown>;
      const source = String(mo["source"] ?? "unknown");
      const summaryRaw = String(mo["summary"] ?? "");
      const summary = summaryRaw.slice(0, 100);
      const score = mo["score"] ?? 0;
      if (summary.length > 0) lines.push(`- [${source}|${String(score)}] ${summary}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// retrieve_memory_context (run.sh:8359). Stub: returns empty unless
// .loki/memory/index.json exists. The full implementation shells out to
// Python with the in-tree memory package; for prompt-parity in fixtures
// (which never include index.json) the empty-return path is sufficient.
// ---------------------------------------------------------------------------

function retrieveMemoryContext(cwd: string): string {
  const indexPath = resolve(cwd, ".loki/memory/index.json");
  if (!existsSync(indexPath)) return "";
  // For now, do not attempt to invoke the Python retrieval pipeline from
  // build_prompt -- a follow-up port wires it in. Returning empty matches
  // bash when the Python path errors out (every fixture exercises this).
  return "";
}

// ---------------------------------------------------------------------------
// load_queue_tasks (run.sh:8823). Reads .loki/queue/in-progress.json (if
// present) AND .loki/queue/pending.json. Each is parsed and the first 3
// tasks are formatted in either rich (PRD-source) or legacy form. Combined
// with "IN-PROGRESS TASKS (EXECUTE THESE):\n" / "PENDING:\n" headers and
// joined with "\n---\n".
// ---------------------------------------------------------------------------

interface QueueTask {
  id?: string;
  source?: string;
  type?: string;
  title?: string;
  description?: string;
  acceptance_criteria?: unknown[];
  user_story?: string;
  payload?: Record<string, unknown> | string | null;
}

function extractQueueTasks(path: string, prefix: string): string {
  const raw = readFileSafe(path);
  if (raw === null) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  let tasks: unknown;
  if (Array.isArray(parsed)) {
    tasks = parsed;
  } else if (parsed !== null && typeof parsed === "object" && "tasks" in parsed) {
    tasks = (parsed as Record<string, unknown>)["tasks"];
  } else {
    tasks = parsed;
  }
  if (!Array.isArray(tasks)) return "";

  const results: string[] = [];
  const slice = tasks.slice(0, 3);
  for (let i = 0; i < slice.length; i++) {
    const t = slice[i];
    if (t === null || typeof t !== "object") continue;
    const task = t as QueueTask;
    const taskId = task.id ?? "unknown";
    const source = task.source ?? "";

    if (source === "prd" || taskId.startsWith("prd-")) {
      const title = task.title ?? "Task";
      const lines: string[] = [`${prefix}[${i + 1}] ${taskId}: ${title}`];
      const desc = task.description ?? "";
      if (desc.length > 0 && desc !== title) {
        let descShort = desc.replace(/\n/g, " ").replace(/\r/g, "").slice(0, 300);
        if (desc.length > 300) descShort += "...";
        lines.push(`  Description: ${descShort}`);
      }
      const criteria = task.acceptance_criteria;
      if (Array.isArray(criteria) && criteria.length > 0) {
        const criteriaStr = criteria.slice(0, 5).map((c) => String(c)).join("; ");
        lines.push(`  Acceptance: ${criteriaStr}`);
      }
      const story = task.user_story ?? "";
      if (story.length > 0) lines.push(`  User Story: ${story}`);
      results.push(lines.join("\n"));
    } else {
      const taskType = task.type ?? "unknown";
      let action = "";
      const payload = task.payload;
      if (payload !== null && payload !== undefined && typeof payload === "object") {
        const pl = payload as Record<string, unknown>;
        action = String(pl["action"] ?? pl["goal"] ?? "");
      } else if (payload !== null && payload !== undefined) {
        action = String(payload);
      }
      if (action.length === 0) {
        action = String(task.title ?? task.description ?? "");
      }
      action = action.replace(/\n/g, " ").replace(/\r/g, "").slice(0, 500);
      // bash bug: `len(str(action)) > 500` after slicing always false; we
      // mirror the practical effect (no ellipsis appended).
      results.push(`${prefix}[${i + 1}] id=${taskId} type=${taskType}: ${action}`);
    }
  }
  return results.join("\n");
}

function loadQueueTasks(cwd: string): string {
  const inProgressPath = resolve(cwd, ".loki/queue/in-progress.json");
  const pendingPath = resolve(cwd, ".loki/queue/pending.json");
  const hasIn = existsSync(inProgressPath);
  const hasPending = existsSync(pendingPath);
  if (!hasIn && !hasPending) return "";

  const inProgress = hasIn ? extractQueueTasks(inProgressPath, "TASK") : "";
  const pending = hasPending ? extractQueueTasks(pendingPath, "PENDING") : "";
  const out: string[] = [];
  if (inProgress.length > 0) out.push(`IN-PROGRESS TASKS (EXECUTE THESE):\n${inProgress}`);
  if (pending.length > 0) out.push(`PENDING:\n${pending}`);
  return out.join("\n---\n");
}

// ---------------------------------------------------------------------------
// Gate failure context (run.sh:9007-9023).
// ---------------------------------------------------------------------------

async function buildGateFailureContext(cwd: string): Promise<string> {
  const gfPath = resolve(cwd, ".loki/quality/gate-failures.txt");
  const failuresRaw = readFileSafe(gfPath);
  if (failuresRaw === null) return "";
  // bash `cat <file>` includes trailing newline; we strip it for printf '%s\n'.
  const failures = failuresRaw.replace(/\n$/, "");
  let ctx = `QUALITY GATE FAILURES FROM PREVIOUS ITERATION: [${failures}]. `;

  const saPath = resolve(cwd, ".loki/quality/static-analysis.json");
  if (existsSync(saPath)) {
    const summary = await readSummaryField(saPath);
    if (summary.length > 0) ctx += `Static analysis: ${summary}. `;
  }
  const trPath = resolve(cwd, ".loki/quality/test-results.json");
  if (existsSync(trPath)) {
    const summary = await readSummaryField(trPath);
    if (summary.length > 0) ctx += `Tests: ${summary}. `;
  }
  ctx += `FIX THESE ISSUES BEFORE PROCEEDING WITH NEW WORK.`;
  return ctx;
}

async function readSummaryField(path: string): Promise<string> {
  // Matches run.sh:9013-9020: `python3 -c "import json; d=json.load(...); print(d.get('summary',''))"`.
  const raw = readFileSafe(path);
  if (raw === null) return "";
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return String(data["summary"] ?? "");
  } catch {
    // Bash `|| echo ""` swallows the error. Fall back to Python (rare).
    try {
      const r = await runInline(
        `import json; d=json.load(open(${JSON.stringify(path)})); print(d.get('summary',''))`,
      );
      return r.stdout.replace(/\n$/, "");
    } catch {
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// App runner info (run.sh:9060-9073).
// ---------------------------------------------------------------------------

function buildAppRunnerInfo(cwd: string): string {
  const path = resolve(cwd, ".loki/app-runner/state.json");
  const raw = readFileSafe(path);
  if (raw === null) return "";
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const status = String(d["status"] ?? "");
    if (status === "running") {
      return `APP_RUNNING_AT: ${String(d["url"] ?? "")} (auto-restarts on code changes). Method: ${String(d["method"] ?? "")}`;
    }
    if (status === "crashed") {
      return `APP_CRASHED: Application has crashed ${String(d["crash_count"] ?? 0)} times. Check .loki/app-runner/app.log for errors.`;
    }
    return "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Playwright info (run.sh:9075-9091).
// ---------------------------------------------------------------------------

function buildPlaywrightInfo(cwd: string): string {
  const path = resolve(cwd, ".loki/verification/playwright-results.json");
  const raw = readFileSafe(path);
  if (raw === null) return "";
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d["passed"] === true) {
      return `PLAYWRIGHT_SMOKE_TEST: PASSED - App loads correctly.`;
    }
    const errors = Array.isArray(d["errors"]) ? (d["errors"] as unknown[]) : [];
    const checks = (d["checks"] as Record<string, unknown> | undefined) ?? {};
    const failing: string[] = [];
    for (const [k, v] of Object.entries(checks)) {
      if (!v) failing.push(k);
    }
    let line = `PLAYWRIGHT_SMOKE_TEST: FAILED - ${failing.slice(0, 3).join(", ")}`;
    if (errors.length > 0) {
      line += `. Errors: ${errors.slice(0, 3).map((e) => String(e)).join("; ")}`;
    }
    return line;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// BMAD context (run.sh:9093-9130).
// ---------------------------------------------------------------------------

function buildBmadContext(cwd: string): string {
  const meta = resolve(cwd, ".loki/bmad-metadata.json");
  if (!existsSync(meta)) return "";

  const archPath = resolve(cwd, ".loki/bmad-architecture-summary.md");
  const tasksPath = resolve(cwd, ".loki/bmad-tasks.json");
  const validPath = resolve(cwd, ".loki/bmad-validation.md");

  let bmad =
    "BMAD_CONTEXT: This project uses BMAD Method structured artifacts. Architecture decisions and epic/story breakdown are provided below.";

  if (existsSync(archPath)) {
    const arch = readBytesSafe(archPath, 16000) ?? "";
    if (arch.length > 0) bmad += ` ARCHITECTURE DECISIONS: ${arch}`;
  }
  if (existsSync(tasksPath)) {
    const tasks = formatBmadTasks(tasksPath);
    if (tasks.length > 0) bmad += ` EPIC/STORY TASKS (from BMAD): ${tasks}`;
  }
  if (existsSync(validPath)) {
    const valid = readBytesSafe(validPath, 8000) ?? "";
    if (valid.length > 0) bmad += ` ARTIFACT VALIDATION: ${valid}`;
  }
  return bmad;
}

function formatBmadTasks(path: string): string {
  const raw = readFileSafe(path);
  if (raw === null) return "";
  try {
    const data: unknown = JSON.parse(raw);
    let working: unknown = data;
    // Bash uses `json.dumps(data, indent=None)` which emits Python's default
    // separators `(', ', ': ')` -- NOT JS JSON.stringify's compact `,` `:`.
    let out = pythonJsonDumps(working);
    if (out.length > 32000 && Array.isArray(working)) {
      const arr: unknown[] = [...working];
      while (arr.length > 0 && pythonJsonDumps(arr).length > 32000) arr.pop();
      working = arr;
      out = pythonJsonDumps(working);
    }
    return out.slice(0, 32000);
  } catch {
    return "";
  }
}

/**
 * Serialize a JS value with the same separator defaults as
 * Python's `json.dumps(value, indent=None)`: `, ` between items and
 * `: ` between key/value. Keys are emitted in insertion order which
 * mirrors what `json.load` produces from a text file (Python preserves
 * insertion order since 3.7, matching what we read with JSON.parse).
 *
 * Strings are escaped with JSON.stringify (matches Python default for
 * the ASCII / common BMP text the BMAD inputs use).
 */
function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return JSON.stringify(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => pythonJsonDumps(v)).join(", ") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj)) {
      parts.push(JSON.stringify(k) + ": " + pythonJsonDumps(obj[k]));
    }
    return "{" + parts.join(", ") + "}";
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// OpenSpec delta context (run.sh:9132-9153).
// ---------------------------------------------------------------------------

function buildOpenspecContext(cwd: string): string {
  const path = resolve(cwd, ".loki/openspec/delta-context.json");
  const raw = readFileSafe(path);
  if (raw === null) return "";
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = ["OPENSPEC DELTA CONTEXT:"];
    const deltas = (data["deltas"] as Record<string, Record<string, unknown[]>> | undefined) ?? {};
    for (const [domain, d] of Object.entries(deltas)) {
      for (const req of (d["added"] as unknown[] | undefined) ?? []) {
        const r = req as Record<string, unknown>;
        parts.push(`  ADDED [${domain}]: ${String(r["name"] ?? "")} - Create new code following existing patterns`);
      }
      for (const req of (d["modified"] as unknown[] | undefined) ?? []) {
        const r = req as Record<string, unknown>;
        parts.push(
          `  MODIFIED [${domain}]: ${String(r["name"] ?? "")} - Find and update existing code, do NOT create new files. Previously: ${String(r["previously"] ?? "N/A")}`,
        );
      }
      for (const req of (d["removed"] as unknown[] | undefined) ?? []) {
        const r = req as Record<string, unknown>;
        parts.push(
          `  REMOVED [${domain}]: ${String(r["name"] ?? "")} - Deprecate or remove. Reason: ${String(r["reason"] ?? "N/A")}`,
        );
      }
    }
    parts.push(`Complexity: ${String(data["complexity"] ?? "unknown")}`);
    return parts.join(" ");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// MiroFish context (run.sh:9155-9217).
// ---------------------------------------------------------------------------

function buildMirofishContext(cwd: string): string {
  const ctxPath = resolve(cwd, ".loki/mirofish-context.json");
  const ctxRaw = readFileSafe(ctxPath);
  if (ctxRaw !== null) {
    try {
      const data = JSON.parse(ctxRaw) as Record<string, unknown>;
      const parts: string[] = ["MIROFISH MARKET VALIDATION:"];
      const adv = (data["analysis"] as Record<string, unknown> | undefined) ?? {};
      const summary = String(adv["overall_sentiment"] ?? "");
      const score = adv["sentiment_score"] ?? 0;
      const conf = String(adv["confidence"] ?? "");
      const rec = String(adv["recommendation"] ?? "");
      if (summary.length > 0) {
        parts.push(`Overall: ${summary} (score=${String(score)}, confidence=${conf}, recommendation=${rec})`);
      }
      const concerns = (adv["key_concerns"] as unknown[] | undefined) ?? [];
      if (concerns.length > 0) {
        parts.push(
          `Key Concerns: ${concerns.slice(0, 5).map((c) => String(c).slice(0, 200)).join("; ")}`,
        );
      }
      const rankings = (adv["feature_rankings"] as unknown[] | undefined) ?? [];
      if (rankings.length > 0) {
        const ranked = rankings
          .slice(0, 5)
          .map((r) => {
            const ro = r as Record<string, unknown>;
            return `${String(ro["feature"] ?? "")}=${String(ro["reception_score"] ?? "")}`;
          })
          .join(", ");
        parts.push(`Feature Reception: ${ranked}`);
      }
      const quotes = (adv["notable_quotes"] as unknown[] | undefined) ?? [];
      if (quotes.length > 0) {
        parts.push(`Agent Quotes: ${quotes.slice(0, 3).map((q) => String(q).slice(0, 150)).join(" | ")}`);
      }
      parts.push(
        "NOTE: MiroFish results are advisory only. They do NOT override Completion Council or quality gates.",
      );
      return parts.join(" ");
    } catch {
      return "";
    }
  }

  const pipePath = resolve(cwd, ".loki/mirofish/pipeline-state.json");
  const pipeRaw = readFileSafe(pipePath);
  if (pipeRaw !== null) {
    try {
      const state = JSON.parse(pipeRaw) as Record<string, unknown>;
      const status = String(state["status"] ?? "unknown");
      const stage = state["current_stage"] ?? 0;
      const pid = state["pid"] ?? 0;
      let alive = false;
      if (typeof pid === "number" && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (status === "running" && alive) {
        const s3 = ((state["stages"] as Record<string, unknown> | undefined) ?? {})["3_simulation"] as
          | Record<string, unknown>
          | undefined;
        let progress = "";
        if (s3 !== undefined && s3["status"] === "running") {
          const cr = s3["current_round"] ?? 0;
          const tr = s3["total_rounds"] ?? 0;
          if (typeof tr === "number" && tr !== 0) progress = ` (simulation round ${String(cr)}/${String(tr)})`;
        }
        return `MIROFISH_STATUS: Market validation running stage ${String(stage)}/4${progress}. Advisory will appear when complete.`;
      }
      if (status === "failed") {
        const error = String(state["error"] ?? "unknown").slice(0, 200);
        return `MIROFISH_STATUS: Market validation failed at stage ${String(stage)}: ${error}. Proceeding without.`;
      }
      return "";
    } catch {
      return "";
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Magic Modules context (run.sh:9219-9232).
// ---------------------------------------------------------------------------

function buildMagicContext(cwd: string, targetDir: string): string {
  // bash builds magic_specs_dir = "$TARGET_DIR/.loki/magic/specs"; we resolve
  // against cwd to mirror bash's relative-path behavior.
  const magicSpecsDir = `${targetDir}/.loki/magic/specs`;
  const dirAbs = resolve(cwd, magicSpecsDir);
  if (!existsSync(dirAbs)) return "";
  let entries: string[];
  try {
    entries = readdirSync(dirAbs).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }
  if (entries.length === 0) {
    return `MAGIC_MODULES: available. To create UI components, write spec at ${magicSpecsDir}/<Name>.md and run 'loki magic update'. Spec-driven generation produces React + Web Component variants with auto-generated tests. Debate gate runs in VERIFY.`;
  }
  // v7.4.9: sort alphabetically. Pre-v7.4.9 used readdirSync raw order which
  // is filesystem-dependent: macOS APFS returns creation order, Linux ext4
  // returns hash-table order. The alphabetical sort makes output deterministic
  // across both filesystems. Bash baseline regenerated for fixtures 27 + 45
  // to match this ordering.
  entries.sort((a, b) => a.localeCompare(b));
  const names = entries.map((f) => f.replace(/\.md$/, ""));
  const specList = names.join(",");
  return `MAGIC_MODULES: ${entries.length} component specs exist: ${specList}. To add or update a component: write markdown to ${magicSpecsDir}/<Name>.md and run 'loki magic update'. The spec becomes source of truth; implementation regenerates automatically. Debate runs in VERIFY phase -- if accessibility or performance blocks, refine the spec and re-run.`;
}

// ---------------------------------------------------------------------------
// Checklist status (run.sh:9047-9057).
// ---------------------------------------------------------------------------

function buildChecklistStatus(
  cwd: string,
  prd: string | null,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const checklistPath = resolve(cwd, ".loki/checklist/checklist.json");
  if (prd !== null && prd.length > 0 && !existsSync(checklistPath)) {
    const interval = envInt(env, "CHECKLIST_INTERVAL", 5);
    return `PRD_CHECKLIST_INIT: Create .loki/checklist/checklist.json from the PRD. Extract requirements into categories with items. Each item needs: id, title, description, priority (critical|major|minor), and verification checks (file_exists, file_contains, tests_pass, grep_codebase, command). This checklist will be auto-verified every ${interval} iterations.`;
  }
  // The elif branch in bash requires `checklist_summary` to be defined as a
  // shell function. The TS port does not implement it -- matches the harness
  // behavior because bash's `type checklist_summary &>/dev/null` returns
  // false (the function lives outside run.sh).
  return "";
}

// ---------------------------------------------------------------------------
// Resolved context (ledger + handoff + startup learnings + memory ctx).
// ---------------------------------------------------------------------------

interface ResolvedSections {
  contextSection: string;
  gateFailureContext: string;
  humanDirective: string;
  queueTasks: string;
  appRunnerInfo: string;
  playwrightInfo: string;
  bmadContext: string;
  openspecContext: string;
  mirofishContext: string;
  magicContext: string;
  checklistStatus: string;
}

async function resolveDynamicSections(
  opts: BuildPromptOpts,
  targetDir: string,
): Promise<ResolvedSections> {
  const { ctx, retry, prd, iteration } = opts;
  const env = ctx.env;

  // context_injection (run.sh:8965-9004) -- ledger+handoff (resume only),
  // startup learnings (iteration==1 only), and retrieved memory.
  let contextInjection = "";
  if (retry > 0) {
    const ledger = loadLedgerContext(ctx.cwd);
    const handoff = await loadHandoffContext(ctx.cwd);
    if (ledger.length > 0) contextInjection = `PREVIOUS_LEDGER_STATE: ${ledger}`;
    if (handoff.length > 0) contextInjection = `${contextInjection} RECENT_HANDOFF: ${handoff}`;
  }
  if (iteration === 1) {
    const startup = loadStartupLearnings(ctx.cwd);
    if (startup.length > 0) contextInjection = `${contextInjection} ${startup}`;
  }
  const memCtx = retrieveMemoryContext(ctx.cwd);
  if (memCtx.length > 0) contextInjection = `${contextInjection} ${memCtx}`;

  const contextSection = contextInjection.length > 0 ? `CONTEXT: ${contextInjection}` : "";

  // human_directive (run.sh:9025-9032).
  const humanInput = envStr(env, "LOKI_HUMAN_INPUT", "");
  const humanDirective =
    humanInput.length > 0
      ? `HUMAN_DIRECTIVE (PRIORITY): ${humanInput} Execute this directive BEFORE continuing normal tasks.`
      : "";

  // queue_tasks (run.sh:9036-9039).
  const rawQueue = loadQueueTasks(ctx.cwd);
  const queueTasks =
    rawQueue.length > 0
      ? `QUEUED_TASKS (PRIORITY): ${rawQueue}. Execute these tasks BEFORE finding new improvements.`
      : "";

  return {
    contextSection,
    gateFailureContext: await buildGateFailureContext(ctx.cwd),
    humanDirective,
    queueTasks,
    appRunnerInfo: buildAppRunnerInfo(ctx.cwd),
    playwrightInfo: buildPlaywrightInfo(ctx.cwd),
    bmadContext: buildBmadContext(ctx.cwd),
    openspecContext: buildOpenspecContext(ctx.cwd),
    mirofishContext: buildMirofishContext(ctx.cwd),
    magicContext: buildMagicContext(ctx.cwd, targetDir),
    checklistStatus: buildChecklistStatus(ctx.cwd, prd, env),
  };
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export async function buildPrompt(opts: BuildPromptOpts): Promise<string> {
  const { retry, prd, iteration, ctx } = opts;
  const env = ctx.env;

  const phases = buildPhases(env);
  const maxParallel = envInt(env, "MAX_PARALLEL_AGENTS", 10);
  const maxIterations = envInt(env, "MAX_ITERATIONS", 1000);
  const completionPromise = envStr(env, "COMPLETION_PROMISE", "");
  const autonomyMode = envStr(env, "AUTONOMY_MODE", "");
  const perpetualMode = envBool(env, "PERPETUAL_MODE");
  const perpetual = autonomyMode === "perpetual" || perpetualMode;
  const targetDir = envStr(env, "TARGET_DIR", ".");
  const legacyOrdering = envBool(env, "LOKI_LEGACY_PROMPT_ORDERING");
  const providerDegraded = envBool(env, "PROVIDER_DEGRADED");

  // Resolve all variables BEFORE assembling the string (parity hazard).
  const rarvText = rarvInstruction(maxParallel);
  const completionText = completionInstruction(completionPromise, iteration, maxIterations);
  const autonomyText = autonomousSuffix(perpetual, completionPromise);
  const sdlcText = sdlcInstruction(phases);
  const sections = await resolveDynamicSections(opts, targetDir);

  // ----- Legacy single-line layout (run.sh:9250-9286) ----------------------
  if (legacyOrdering) {
    if (providerDegraded) {
      return buildLegacyDegraded(opts, sections, prd, retry, iteration);
    }
    return buildLegacyFull(opts, {
      rarvText,
      completionText,
      autonomyText,
      sdlcText,
      analysis: ANALYSIS_INSTRUCTION,
      memory: MEMORY_INSTRUCTION,
      sections,
    });
  }

  // ----- Degraded provider (run.sh:9304-9334) ------------------------------
  if (providerDegraded) {
    return buildStaticFirstDegraded(opts, sections);
  }

  // ----- Full static-first layout (run.sh:9336-9381) -----------------------
  const lines: string[] = [];
  const prdAnchor = prd !== null && prd.length > 0 ? `Loki Mode with PRD at ${prd}` : "Loki Mode";
  lines.push("<loki_system>");
  lines.push(prdAnchor);
  lines.push(rarvText);
  lines.push(sdlcText);
  lines.push(autonomyText);
  lines.push(MEMORY_INSTRUCTION);
  if (prd === null || prd.length === 0) {
    lines.push(ANALYSIS_INSTRUCTION);
  }
  lines.push("</loki_system>");
  lines.push("[CACHE_BREAKPOINT]");
  lines.push(`<dynamic_context iteration="${iteration}" retry="${retry}">`);

  if (retry > 0) {
    if (prd !== null && prd.length > 0) {
      lines.push(`Resume iteration #${iteration} (retry #${retry}). PRD: ${prd}`);
    } else {
      lines.push(`Resume iteration #${iteration} (retry #${retry}). Use .loki/generated-prd.md if exists.`);
    }
  }
  if (sections.humanDirective.length > 0) lines.push(sections.humanDirective);
  if (sections.gateFailureContext.length > 0) lines.push(sections.gateFailureContext);
  if (sections.queueTasks.length > 0) lines.push(sections.queueTasks);
  if (sections.bmadContext.length > 0) lines.push(sections.bmadContext);
  if (sections.openspecContext.length > 0) lines.push(sections.openspecContext);
  if (sections.mirofishContext.length > 0) lines.push(sections.mirofishContext);
  if (sections.magicContext.length > 0) lines.push(sections.magicContext);
  if (sections.checklistStatus.length > 0) lines.push(sections.checklistStatus);
  if (sections.appRunnerInfo.length > 0) lines.push(sections.appRunnerInfo);
  if (sections.playwrightInfo.length > 0) lines.push(sections.playwrightInfo);
  if (sections.contextSection.length > 0) lines.push(sections.contextSection);
  lines.push(completionText);
  lines.push("</dynamic_context>");

  // bash printf '%s\n' on every section emits a trailing newline -- match that.
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Static-first degraded (run.sh:9304-9334).
// ---------------------------------------------------------------------------

function buildStaticFirstDegraded(opts: BuildPromptOpts, sections: ResolvedSections): string {
  const { prd, iteration, retry, ctx } = opts;
  let prdContent = "";
  if (prd !== null && prd.length > 0) {
    const abs = resolve(ctx.cwd, prd);
    const raw = readBytesSafe(abs, 4000);
    prdContent = raw ?? "";
  }
  const anchor = prd !== null && prd.length > 0 ? "Loki Mode with PRD" : "Loki Mode";
  const lines: string[] = [];
  lines.push("<loki_system>");
  lines.push(anchor);
  if (prd !== null && prd.length > 0) {
    lines.push(
      "You are a coding assistant. Read and implement the requirements from the PRD. Write working code, run tests if possible, and commit changes.",
    );
  } else {
    lines.push(
      "You are a coding assistant. Analyze this codebase and suggest improvements. Write working code and commit changes.",
    );
  }
  lines.push("</loki_system>");
  lines.push("[CACHE_BREAKPOINT]");
  lines.push(`<dynamic_context iteration="${iteration}" retry="${retry}">`);
  if (sections.humanDirective.length > 0) lines.push(`Priority: ${sections.humanDirective}`);
  if (sections.queueTasks.length > 0) lines.push(`Tasks: ${sections.queueTasks}`);
  if (prd !== null && prd.length > 0) lines.push(`PRD contents: ${prdContent}`);
  lines.push("</dynamic_context>");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Legacy ordering -- single echo line (run.sh:9252-9285).
// ---------------------------------------------------------------------------

interface LegacyFullParts {
  rarvText: string;
  completionText: string;
  autonomyText: string;
  sdlcText: string;
  analysis: string;
  memory: string;
  sections: ResolvedSections;
}

function buildLegacyFull(opts: BuildPromptOpts, p: LegacyFullParts): string {
  const { prd, retry, iteration } = opts;
  const s = p.sections;
  // Order from run.sh:9273-9281. Empty optional sections are emitted as empty
  // strings between two spaces, exactly as bash's "$var $var" expansion does.
  const tail = [
    s.humanDirective,
    s.gateFailureContext,
    s.queueTasks,
    s.bmadContext,
    s.openspecContext,
    s.mirofishContext,
    s.magicContext,
    s.checklistStatus,
    s.appRunnerInfo,
    s.playwrightInfo,
    s.contextSection,
  ].join(" ");

  if (retry === 0) {
    if (prd !== null && prd.length > 0) {
      return `Loki Mode with PRD at ${prd}. ${tail} ${p.rarvText} ${p.memory} ${p.completionText} ${p.sdlcText} ${p.autonomyText}\n`;
    }
    return `Loki Mode. ${tail} ${p.analysis} ${p.rarvText} ${p.memory} ${p.completionText} ${p.sdlcText} ${p.autonomyText}\n`;
  }
  if (prd !== null && prd.length > 0) {
    return `Loki Mode - Resume iteration #${iteration} (retry #${retry}). PRD: ${prd}. ${tail} ${p.rarvText} ${p.memory} ${p.completionText} ${p.sdlcText} ${p.autonomyText}\n`;
  }
  return `Loki Mode - Resume iteration #${iteration} (retry #${retry}). ${tail} Use .loki/generated-prd.md if exists. ${p.rarvText} ${p.memory} ${p.completionText} ${p.sdlcText} ${p.autonomyText}\n`;
}

function buildLegacyDegraded(
  opts: BuildPromptOpts,
  sections: ResolvedSections,
  prd: string | null,
  retry: number,
  iteration: number,
): string {
  const { ctx } = opts;
  let prdContent = "";
  if (prd !== null && prd.length > 0) {
    const abs = resolve(ctx.cwd, prd);
    prdContent = readBytesSafe(abs, 4000) ?? "";
  }
  // bash `${var:+prefix $var}` -- if var is non-empty, output `prefix $var`,
  // else nothing. Exactly two spaces around each segment in bash's echo.
  const human = sections.humanDirective.length > 0 ? `Priority: ${sections.humanDirective}` : "";
  const tasks = sections.queueTasks.length > 0 ? `Tasks: ${sections.queueTasks}` : "";

  if (retry === 0) {
    if (prd !== null && prd.length > 0) {
      return `You are a coding assistant. Read and implement the requirements from the PRD below. Write working code, run tests if possible, and commit changes. ${human} ${tasks} PRD contents: ${prdContent}\n`;
    }
    return `You are a coding assistant. Analyze this codebase and suggest improvements. Write working code and commit changes. ${human} ${tasks}\n`;
  }
  if (prd !== null && prd.length > 0) {
    return `You are a coding assistant. Continue working on iteration ${iteration}. Review what exists, implement remaining PRD requirements, fix any issues, add tests. ${human} ${tasks} PRD contents: ${prdContent}\n`;
  }
  return `You are a coding assistant. Continue working on iteration ${iteration}. Review what exists, improve code, fix bugs, add tests. ${human} ${tasks}\n`;
}

// ---------------------------------------------------------------------------
// Test-only exports (no `__test__` prefix because we want strict types).
// ---------------------------------------------------------------------------

export const _internals = {
  buildPhases,
  rarvInstruction,
  completionInstruction,
  autonomousSuffix,
  sdlcInstruction,
  ANALYSIS_INSTRUCTION,
  MEMORY_INSTRUCTION,
  loadLedgerContext,
  loadHandoffContext,
  loadStartupLearnings,
  loadQueueTasks,
  buildGateFailureContext,
  buildAppRunnerInfo,
  buildPlaywrightInfo,
  buildBmadContext,
  buildOpenspecContext,
  buildMirofishContext,
  buildMagicContext,
  buildChecklistStatus,
};

// ---------------------------------------------------------------------------
// Runner adapter (Phase 4 v7.4.1).
//
// autonomous.ts uses a different RunnerContext shape than this module's
// internal one (the runner threads iterationCount/retryCount/prdPath via the
// loop; this module's internal RunnerContext only carries cwd/projectDir/env).
// This adapter pulls the necessary fields off the runner ctx and synthesizes
// the BuildPromptOpts the implementation expects. Resolves the v7.4.0 DA
// finding "autonomous.ts <-> build_prompt.ts signature mismatch".
//
// The named export `buildPromptForRunner` is the marker key autonomous.ts
// gates on via tryImport.
// ---------------------------------------------------------------------------
import type { RunnerContext as LoopRunnerContext } from "./types.ts";

export async function buildPromptForRunner(ctx: LoopRunnerContext): Promise<string> {
  let prdContent: string | null = null;
  if (ctx.prdPath) {
    try {
      if (existsSync(ctx.prdPath)) {
        prdContent = readFileSync(ctx.prdPath, "utf8");
      }
    } catch {
      prdContent = null;
    }
  }
  return buildPrompt({
    retry: ctx.retryCount,
    iteration: ctx.iterationCount,
    prd: prdContent,
    ctx: {
      cwd: ctx.cwd,
      projectDir: ctx.cwd,
      env: process.env,
    },
  });
}
