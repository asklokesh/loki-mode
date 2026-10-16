// loki-ts/src/engine10/modernize/wave.ts -- M-20: wave verify (docs/v10/MODERNIZE.md section 3.5 "Per wave", D30).
// After a wave's units merge, run the full build, the integration checks and the ORIGINAL legacy test
// suite. A wave is verified only if all three pass; any failure blocks the next wave with a fixed
// reason naming the failing step (M-21 ship consumes this verdict). Child processes get tokenFreeEnv.
// Output is kept only as a bounded tail for humans, never parsed and never in the reason string.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InventoryResult } from "./inventory.ts";
import type { ModernizeLog } from "./log.ts";
import { tokenFreeEnv } from "../../util/safe_git.ts";

export const WAVE_STEPS = ["build", "integration", "original_suite"] as const;
export type WaveStep = (typeof WAVE_STEPS)[number];

export const DEFAULT_STEP_TIMEOUT_MS = 600_000;
const TAIL_CHARS = 4000;

export interface StepCommand {
  /** Argument array, never a shell string. */
  argv: string[];
  timeoutMs?: number;
}
export interface StepRun {
  status: number | null;
  timedOut: boolean;
  error: string | null;
  tail: string;
}
/** Injectable so the policy is tested without spawning. */
export type StepRunner = (step: WaveStep, cmd: StepCommand, cwd: string) => StepRun;

export interface StepResult {
  step: WaveStep;
  ran: boolean;
  passed: boolean;
  exit: number | null;
  tail: string;
}
export interface WaveVerdict {
  wave: number;
  verified: boolean;
  failedStep: WaveStep | null;
  reason: string | null;
  steps: StepResult[];
}

export interface VerifyWaveOpts {
  /** The merged tree the wave produced. */
  repoDir: string;
  wave: number;
  commands: Partial<Record<WaveStep, StepCommand | null>>;
  log?: ModernizeLog;
  run?: StepRunner;
  /** Steps whose command may be null: skipped with ran:false instead of blocking (M-27E, D2). */
  optional?: readonly WaveStep[];
}

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return DEFAULT_STEP_TIMEOUT_MS;
  return Math.min(Math.floor(ms), DEFAULT_STEP_TIMEOUT_MS);
}

export const spawnStepRunner: StepRunner = (_step, cmd, cwd) => {
  const [bin, ...args] = cmd.argv;
  const r = spawnSync(bin!, args, {
    cwd, encoding: "utf8", timeout: clampTimeout(cmd.timeoutMs), maxBuffer: 64 * 1024 * 1024,
    env: { ...tokenFreeEnv(), CI: "1", LOKI_NO_BROWSER: "1" },
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = code === "ETIMEDOUT";
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    status: r.status,
    timedOut,
    error: r.error && !timedOut ? (code ?? "spawn error") : null,
    tail: out.length > TAIL_CHARS ? out.slice(out.length - TAIL_CHARS) : out,
  };
};

function validArgv(c: StepCommand | null | undefined): c is StepCommand {
  return !!c && Array.isArray(c.argv) && c.argv.length > 0 && c.argv.every((a) => typeof a === "string" && a.length > 0);
}

/** Runs build, integration, original suite in order; stops at the first failure (later steps are not run). */
export function verifyWave(opts: VerifyWaveOpts): WaveVerdict {
  const run = opts.run ?? spawnStepRunner;
  const steps: StepResult[] = [];
  let failedStep: WaveStep | null = null;
  let reason: string | null = null;
  const skipped: WaveStep[] = [];
  const block = (step: WaveStep, why: string): void => {
    failedStep = step;
    reason = `wave ${opts.wave} blocked: ${step} ${why}`;
  };

  for (const step of WAVE_STEPS) {
    if (failedStep !== null) { steps.push({ step, ran: false, passed: false, exit: null, tail: "" }); continue; }
    const cmd = opts.commands[step];
    if (cmd == null && opts.optional?.includes(step)) { skipped.push(step); steps.push({ step, ran: false, passed: false, exit: null, tail: "" }); continue; }
    if (!validArgv(cmd)) {
      steps.push({ step, ran: false, passed: false, exit: null, tail: "" });
      block(step, "has no command configured");
      continue;
    }
    const r = run(step, cmd, opts.repoDir);
    const passed = r.status === 0 && !r.timedOut && r.error === null;
    steps.push({ step, ran: true, passed, exit: r.status, tail: r.tail });
    if (passed) continue;
    if (r.timedOut) block(step, `timed out after ${clampTimeout(cmd.timeoutMs)}ms`);
    else if (r.error !== null) block(step, "could not run");
    else if (r.status === null) block(step, "was killed by a signal");
    else block(step, `failed (exit ${r.status})`);
  }

  const verdict: WaveVerdict = { wave: opts.wave, verified: failedStep === null, failedStep, reason, steps };
  opts.log?.append("wave.verified", {
    wave: opts.wave, verified: verdict.verified, failed_step: failedStep, reason,
    steps: steps.map((s) => ({ step: s.step, ran: s.ran, passed: s.passed, exit: s.exit })), skipped,
  });
  return verdict;
}

/** The next wave may start only if every prior wave verified; otherwise the first failing wave's reason. */
export function nextWaveGate(prior: WaveVerdict[]): { allowed: boolean; reason: string | null } {
  const bad = prior.find((v) => !v.verified);
  return bad ? { allowed: false, reason: bad.reason ?? `wave ${bad.wave} blocked: not verified` } : { allowed: true, reason: null };
}

/** Verify argv from the Inventory (M-27D). Fail closed: an undetected step is null, never another step's command. */
export function detectWaveCommands(inv: InventoryResult, target: string): Record<WaveStep, StepCommand | null> {
  const { system, marker } = inv.buildSystem;
  const none = { build: null, integration: null, original_suite: null };
  const text = (): string => { try { return readFileSync(join(target, marker ?? ""), "utf8"); } catch { return ""; } };
  if (system === "maven") {
    // failsafe binds ITs to verify; surefire-only projects run IT-named classes through test; neither fails closed (null).
    const integration: StepCommand | null = text().includes("maven-failsafe-plugin") ? { argv: ["mvn", "-B", "verify"] }
      : inv.files.some((f) => ["IT.java", "ITCase.java", "IntegrationTest.java"].some((x) => f.endsWith(x))) ? { argv: ["mvn", "-B", "test", "-Dtest=*IT,*ITCase,*IntegrationTest", "-Dsurefire.failIfNoSpecifiedTests=false"] } : null;
    return { build: { argv: ["mvn", "-B", "-q", "compile"] }, integration, original_suite: { argv: ["mvn", "-B", "test"] } };
  }
  if (system === "gradle") {
    let gw = "gradle";
    try { if (inv.files.includes("gradlew") && (statSync(join(target, "gradlew")).mode & 0o111) !== 0) gw = "./gradlew"; } catch { /* keep gradle */ }
    return { build: { argv: [gw, "assemble"] }, integration: text().includes("integrationTest") ? { argv: [gw, "integrationTest"] } : null, original_suite: { argv: [gw, "test"] } };
  }
  if (system !== "setuptools" && system !== "poetry" && system !== "tox") return none;
  // Segment-prefix match (never raw startsWith) and the dir must hold at least one .py file.
  const itDir = ["tests/integration", "integration"].find((d) => inv.files.some((f) => f.startsWith(d + "/") && f.endsWith(".py")));
  const pytest = "pytest" in inv.tests.evidence;
  // tox.ini is read by file, not by build-system marker: pyproject usually wins the marker and would hide tox.
  let toxIni = "";
  if (inv.files.includes("tox.ini")) { try { toxIni = readFileSync(join(target, "tox.ini"), "utf8"); } catch { /* none */ } }
  const integration: StepCommand | null = toxIni.includes("[testenv:integration") ? { argv: ["tox", "-e", "integration"] }
    : itDir && pytest ? { argv: ["python3", "-m", "pytest", "-q", itDir] } : null;
  return { build: { argv: ["python3", "-m", "compileall", "-q", "-x", "/(\\.loki|\\.venv|venv|node_modules|\\.tox|\\.git)/", "."] }, integration, original_suite: pytest ? { argv: ["python3", "-m", "pytest", "-q"] } : null };
}
