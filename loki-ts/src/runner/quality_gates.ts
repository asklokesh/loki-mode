// Quality-gate orchestration for the autonomous loop.
//
// Bash sources of truth:
//   enforce_static_analysis()    autonomy/run.sh:5498  (real gate, Phase 5+)
//   enforce_test_coverage()      autonomy/run.sh:5704  (real gate, Phase 5+)
//   run_code_review()            autonomy/run.sh:4935  (real gate, Phase 5+)
//   run_doc_staleness_check()    autonomy/run.sh:5852
//   run_doc_quality_gate()       autonomy/run.sh:5884
//   run_magic_debate_gate()      autonomy/run.sh:5941
//   track_gate_failure()         autonomy/run.sh:5639
//   clear_gate_failure()         autonomy/run.sh:5660
//   get_gate_failure_count()     autonomy/run.sh:5680
//   gate orchestration block     autonomy/run.sh:10848-10963
//
// Escalation ladder (autonomy/run.sh:725-727 and :10894-10921, code_review only
// in bash today; this module applies the ladder uniformly to every gate so the
// TS port can extend coverage without diverging):
//   count >= GATE_PAUSE_LIMIT     -> write .loki/PAUSE + signals/GATE_ESCALATION
//   count >= GATE_ESCALATE_LIMIT  -> write signals/GATE_ESCALATION (no pause)
//   count >= GATE_CLEAR_LIMIT     -> log warning, treat as passing this round
//
// Phase 5 status: runStaticAnalysis and runTestCoverage are real ports of the
// shell+JS / npm-test branches of the bash gates. runCodeReview,
// runDocQualityGate, and runMagicDebateGate remain stubs pending their
// respective ports (council, doc scorer, debate). The orchestration logic,
// escalation ladder, and failure-count persistence are real and final.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lokiDir } from "../util/paths.ts";
import { run } from "../util/shell.ts";
import type { RunnerContext } from "./types.ts";

// --- Public types ----------------------------------------------------------

export type GateOutcome = {
  // Gate names that ran and passed (or were treated as passing under the
  // CLEAR_LIMIT rule).
  passed: string[];
  // Gate names that ran and failed this iteration.
  failed: string[];
  // True when at least one gate failed and was not cleared by the CLEAR rule.
  blocked: boolean;
  // True when the PAUSE_LIMIT or ESCALATE_LIMIT was reached for any gate.
  // Caller (autonomous.ts) inspects this to decide whether to pause the loop.
  escalated: boolean;
};

export type GateName =
  | "static_analysis"
  | "test_coverage"
  | "code_review"
  | "doc_coverage"
  | "magic_debate";

export type GateResult = {
  passed: boolean;
  // Optional human-readable detail surfaced into logs / prompt injection.
  detail?: string;
};

// Escalation ladder limits, mirroring autonomy/run.sh:725-727. Read once at
// gate-run time so tests can override via env without restarting the process.
type EscalationLimits = {
  clear: number;
  escalate: number;
  pause: number;
};

function readEscalationLimits(): EscalationLimits {
  const parse = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    clear: parse("LOKI_GATE_CLEAR_LIMIT", 3),
    escalate: parse("LOKI_GATE_ESCALATE_LIMIT", 5),
    pause: parse("LOKI_GATE_PAUSE_LIMIT", 10),
  };
}

// --- Failure-count persistence --------------------------------------------

// Match the bash on-disk path: <lokiDir>/quality/gate-failure-count.json.
function gateFilePath(base: string): string {
  return join(base, "quality", "gate-failure-count.json");
}

function resolveBase(override?: string): string {
  return override ?? lokiDir();
}

// Atomic write via tmp + rename, matching the pattern used by state.ts.
// renameSync is atomic on POSIX when both paths share a filesystem.
function atomicWrite(target: string, body: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
}

function readCounts(base: string): Record<string, number> {
  const file = gateFilePath(base);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    // Bash equivalent swallows JSONDecodeError/FileNotFoundError and returns {}.
    return {};
  }
}

function writeCounts(base: string, counts: Record<string, number>): void {
  atomicWrite(gateFilePath(base), `${JSON.stringify(counts, null, 2)}\n`);
}

// Increment and persist. Returns the new count for that gate.
// Mirror of bash track_gate_failure() (autonomy/run.sh:5639).
export function trackGateFailure(name: string, lokiDirOverride?: string): number {
  const base = resolveBase(lokiDirOverride);
  const counts = readCounts(base);
  const next = (counts[name] ?? 0) + 1;
  counts[name] = next;
  writeCounts(base, counts);
  return next;
}

// Reset a single gate counter to 0. Mirror of bash clear_gate_failure()
// (autonomy/run.sh:5660). When the file does not exist this is a no-op so
// successful gates on a fresh repo do not create empty files.
export function clearGateFailure(name: string, lokiDirOverride?: string): void {
  const base = resolveBase(lokiDirOverride);
  const file = gateFilePath(base);
  if (!existsSync(file)) return;
  const counts = readCounts(base);
  counts[name] = 0;
  writeCounts(base, counts);
}

// Read-only view of the current count. Mirror of bash get_gate_failure_count().
export function getGateFailureCount(name: string, lokiDirOverride?: string): number {
  const counts = readCounts(resolveBase(lokiDirOverride));
  return counts[name] ?? 0;
}

// --- Stub gate runners (Phase 5+ replaces these with real ports) ----------

// Each stub honors a per-gate env override so tests (and operators wanting to
// dry-run the orchestration) can force a deterministic outcome without the
// real analyzer being available.
//
// LOKI_STUB_GATE_<UPPER>=fail  -> stub returns failure
// LOKI_STUB_GATE_<UPPER>=pass  -> stub returns pass (default)
function stubResult(name: GateName): GateResult {
  const key = `LOKI_STUB_GATE_${name.toUpperCase()}`;
  const v = process.env[key];
  if (v === "fail") return { passed: false, detail: `stub forced fail via ${key}` };
  return { passed: true, detail: "stub" };
}

// Recursively list files under `dir` whose name ends with `suffix`.
// Returns absolute paths. Returns [] if `dir` is missing -- callers treat
// that as "nothing to check" (see runStaticAnalysis below).
function listFilesBySuffix(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  let st;
  try {
    st = statSync(dir);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        // Skip node_modules and dotdirs to keep the scan bounded.
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(p);
      } else if (e.isFile() && e.name.endsWith(suffix)) {
        out.push(p);
      }
    }
  }
  return out;
}

// Phase 5 real implementation. Mirrors the bash `enforce_static_analysis`
// shell-script + JS branches at autonomy/run.sh:5572-5593 and 5516-5543, but
// scoped to the directory layout the spec calls out (autonomy/*.sh +
// scripts/*.js). Both subprocess wrappers honor a 30s timeout per file so a
// hung interpreter cannot stall the iteration.
//
// Honors LOKI_STUB_GATE_STATIC_ANALYSIS for tests that prefer to drive the
// orchestrator without spawning real subprocesses (the stub override wins).
export async function runStaticAnalysis(ctx?: RunnerContext): Promise<GateResult> {
  const stubKey = "LOKI_STUB_GATE_STATIC_ANALYSIS";
  const stubVal = process.env[stubKey];
  if (stubVal === "fail" || stubVal === "pass") return stubResult("static_analysis");

  const root = ctx?.cwd ?? process.cwd();
  const shFiles = listFilesBySuffix(join(root, "autonomy"), ".sh");
  const jsFiles = listFilesBySuffix(join(root, "scripts"), ".js");

  const errors: string[] = [];
  const TIMEOUT_MS = 30_000;

  for (const f of shFiles) {
    const r = await run(["bash", "-n", f], { timeoutMs: TIMEOUT_MS });
    if (r.exitCode !== 0) {
      const msg = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim().split(/\r?\n/).slice(0, 3).join(" | ");
      errors.push(`bash -n ${f}: ${msg}`);
    }
  }
  for (const f of jsFiles) {
    const r = await run(["node", "--check", f], { timeoutMs: TIMEOUT_MS });
    if (r.exitCode !== 0) {
      const msg = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim().split(/\r?\n/).slice(0, 3).join(" | ");
      errors.push(`node --check ${f}: ${msg}`);
    }
  }

  const total = shFiles.length + jsFiles.length;
  if (errors.length > 0) {
    return {
      passed: false,
      detail: `static_analysis: ${errors.length}/${total} failed -- ${errors.slice(0, 3).join("; ")}`,
    };
  }
  return { passed: true, detail: `static_analysis: ${total} files clean` };
}

// Shape the bash gate writes to .loki/quality/test-results.json (see
// enforce_test_coverage at autonomy/run.sh:5704). When that artifact is
// already present we trust it -- this lets the bash gate (still running in
// production) hand off to the TS orchestrator without re-running the suite.
type TestResultsArtifact = {
  pass?: boolean;
  passed?: number;
  failed?: number;
  runner?: string;
  summary?: string;
};

function readTestResultsArtifact(base: string): TestResultsArtifact | null {
  const p = join(base, "quality", "test-results.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as TestResultsArtifact;
  } catch {
    return null;
  }
}

// Phase 5 real implementation. First checks .loki/quality/test-results.json
// (written by the bash gate or any prior TS run); falls back to `npm test
// --silent` with the 5-minute timeout the bash gate uses (autonomy/run.sh:5718).
//
// Honors LOKI_STUB_GATE_TEST_COVERAGE so existing orchestration tests can keep
// using the stub escape hatch.
export async function runTestCoverage(ctx?: RunnerContext): Promise<GateResult> {
  const stubKey = "LOKI_STUB_GATE_TEST_COVERAGE";
  const stubVal = process.env[stubKey];
  if (stubVal === "fail" || stubVal === "pass") return stubResult("test_coverage");

  const base = ctx?.lokiDir ?? lokiDir();
  const artifact = readTestResultsArtifact(base);
  if (artifact !== null) {
    // Treat explicit pass=false or any failed>0 as a failure. When pass is
    // missing we infer from failed count (defaulting to 0 -> pass).
    const failed = typeof artifact.failed === "number" ? artifact.failed : 0;
    const passed = typeof artifact.passed === "number" ? artifact.passed : 0;
    const explicitPass = artifact.pass === true;
    const explicitFail = artifact.pass === false;
    const ok = explicitFail ? false : explicitPass || failed === 0;
    const detail = `test_coverage(artifact:${artifact.runner ?? "unknown"}): passed=${passed} failed=${failed}`;
    return { passed: ok, detail };
  }

  // No artifact -- fall back to running `npm test --silent` if package.json exists.
  const cwd = ctx?.cwd ?? process.cwd();
  if (!existsSync(join(cwd, "package.json"))) {
    return { passed: true, detail: "test_coverage: no test-results.json and no package.json -- skipping" };
  }

  const r = await run(["npm", "test", "--silent"], { cwd, timeoutMs: 300_000 });
  if (r.exitCode === 0) {
    return { passed: true, detail: "test_coverage: npm test exit 0" };
  }
  const tail = (r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
  return { passed: false, detail: `test_coverage: npm test exit ${r.exitCode} -- ${tail}` };
}

// STUB: Phase 5 next iteration -- replace with the 3-reviewer parallel council port.
export async function runCodeReview(): Promise<GateResult> {
  return stubResult("code_review");
}

// STUB: Phase 5 next iteration -- replace with documentation coverage scorer.
export async function runDocQualityGate(): Promise<GateResult> {
  return stubResult("doc_coverage");
}

// STUB: Phase 5 next iteration -- replace with Magic Modules debate council.
export async function runMagicDebateGate(): Promise<GateResult> {
  return stubResult("magic_debate");
}

// --- Orchestrator ---------------------------------------------------------

// Per-iteration toggles read from env. These mirror the bash gate-block guards
// at autonomy/run.sh:10851-10941 so the TS loop honors the same operator
// switches without re-reading them in every gate body.
type GateToggles = {
  hardGates: boolean;
  staticAnalysis: boolean;
  testCoverage: boolean;
  codeReview: boolean;
  docCoverage: boolean;
  magicDebate: boolean;
};

function readToggles(): GateToggles {
  const flag = (key: string, fallback: boolean): boolean => {
    const v = process.env[key];
    if (v === undefined || v === "") return fallback;
    return v === "true" || v === "1";
  };
  return {
    hardGates: flag("LOKI_HARD_GATES", true),
    staticAnalysis: flag("PHASE_STATIC_ANALYSIS", true),
    testCoverage: flag("PHASE_UNIT_TESTS", true),
    codeReview: flag("PHASE_CODE_REVIEW", true),
    docCoverage: flag("LOKI_GATE_DOC_COVERAGE", true),
    magicDebate: flag("LOKI_GATE_MAGIC_DEBATE", true),
  };
}

// Apply the escalation ladder for one failed gate. Returns the bookkeeping
// outcome the orchestrator needs without touching the loop's mutable state
// directly. Mirrors autonomy/run.sh:10904-10921.
type EscalationOutcome = {
  // True when the failure should be treated as passing (CLEAR_LIMIT rule).
  cleared: boolean;
  // True when ESCALATE_LIMIT or PAUSE_LIMIT was hit.
  escalated: boolean;
  // True only when PAUSE_LIMIT was hit -- caller writes the PAUSE signal.
  pause: boolean;
  count: number;
};

function applyEscalation(
  name: GateName,
  base: string,
  limits: EscalationLimits,
  ctx: RunnerContext,
): EscalationOutcome {
  const count = trackGateFailure(name, base);
  if (count >= limits.pause) {
    ctx.log(
      `Gate escalation: ${name} failed ${count} times (>= ${limits.pause}) - forcing PAUSE`,
    );
    writePauseSignal(base, name, count);
    return { cleared: false, escalated: true, pause: true, count };
  }
  if (count >= limits.escalate) {
    ctx.log(
      `Gate escalation: ${name} failed ${count} times (>= ${limits.escalate}) - escalating`,
    );
    writeEscalationSignal(base, name, count, "ESCALATE");
    return { cleared: false, escalated: true, pause: false, count };
  }
  if (count >= limits.clear) {
    ctx.log(
      `Gate cleared: ${name} failed ${count} times (>= ${limits.clear}) - passing this iteration, counter continues`,
    );
    return { cleared: true, escalated: false, pause: false, count };
  }
  return { cleared: false, escalated: false, pause: false, count };
}

// Match autonomy/run.sh:10906-10908. Two-line file: action then reason.
function writeEscalationSignal(base: string, gate: string, count: number, action: "PAUSE" | "ESCALATE"): void {
  const target = join(base, "signals", "GATE_ESCALATION");
  mkdirSync(dirname(target), { recursive: true });
  const body = `${action}\n${gate} gate failed ${count} consecutive times\n`;
  atomicWrite(target, body);
}

function writePauseSignal(base: string, gate: string, count: number): void {
  writeEscalationSignal(base, gate, count, "PAUSE");
  // Bash: `touch "${TARGET_DIR:-.}/.loki/PAUSE"` (run.sh:10908).
  const pause = join(base, "PAUSE");
  mkdirSync(dirname(pause), { recursive: true });
  writeFileSync(pause, "");
}

// Persist the comma-trailing failure list for prompt injection. Mirrors the
// `gate-failures.txt` write at autonomy/run.sh:10952-10955: write when there
// is at least one entry, delete otherwise.
function persistFailureList(base: string, failed: string[]): void {
  const target = join(base, "quality", "gate-failures.txt");
  if (failed.length === 0) {
    // Best-effort cleanup; rmSync with force ignores missing files already.
    try {
      rmSync(target, { force: true });
    } catch {
      // Nothing else depends on this file existing.
    }
    return;
  }
  const body = `${failed.join(",")},\n`;
  atomicWrite(target, body);
}

// Run every enabled gate in the bash order. Returns a structured outcome the
// caller (autonomous.ts) maps onto the iteration's terminate decision. The
// runner tolerates individual gate-runner exceptions: a thrown stub counts as
// a failure but does not abort the rest of the pipeline (bash treats a non-
// zero exit identically).
export async function runQualityGates(ctx: RunnerContext): Promise<GateOutcome> {
  const base = ctx.lokiDir;
  const limits = readEscalationLimits();
  const toggles = readToggles();
  const passed: string[] = [];
  const failed: string[] = [];
  let escalated = false;

  // Soft-gates path matches autonomy/run.sh:10957-10961: only code_review runs
  // (advisory) and the failure list is not persisted. We honor that in the
  // structured outcome by leaving `blocked` false even on advisory failures.
  if (!toggles.hardGates) {
    if (toggles.codeReview) {
      try {
        const r = await runCodeReview();
        if (r.passed) passed.push("code_review");
        else failed.push("code_review");
      } catch {
        failed.push("code_review");
      }
    }
    return { passed, failed, blocked: false, escalated: false };
  }

  // Hard-gates path -- mirror the bash ordering exactly. Real runners take
  // ctx so they can resolve repo + .loki paths without leaking env globals.
  const sequence: Array<{ name: GateName; enabled: boolean; run: () => Promise<GateResult> }> = [
    { name: "static_analysis", enabled: toggles.staticAnalysis, run: () => runStaticAnalysis(ctx) },
    { name: "test_coverage", enabled: toggles.testCoverage, run: () => runTestCoverage(ctx) },
    { name: "code_review", enabled: toggles.codeReview, run: runCodeReview },
    { name: "doc_coverage", enabled: toggles.docCoverage, run: runDocQualityGate },
    { name: "magic_debate", enabled: toggles.magicDebate, run: runMagicDebateGate },
  ];

  for (const gate of sequence) {
    if (!gate.enabled) continue;
    let result: GateResult;
    try {
      result = await gate.run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { passed: false, detail: `runner threw: ${msg}` };
    }
    if (result.passed) {
      clearGateFailure(gate.name, base);
      passed.push(gate.name);
      continue;
    }
    const esc = applyEscalation(gate.name, base, limits, ctx);
    if (esc.escalated) escalated = true;
    if (esc.cleared) {
      // Per bash CLEAR_LIMIT semantics the gate is treated as passing this
      // iteration even though the counter keeps climbing. Surface it under
      // `passed` so the caller's prompt-injection logic does not double-warn.
      passed.push(gate.name);
    } else {
      failed.push(gate.name);
    }
    if (esc.pause) {
      // PAUSE signal already written; stop running further gates so the
      // operator inspects state from a deterministic point. Matches the
      // intent of bash's PAUSE_LIMIT branch which signals immediate human
      // intervention.
      break;
    }
  }

  persistFailureList(base, failed);
  return {
    passed,
    failed,
    blocked: failed.length > 0,
    escalated,
  };
}
