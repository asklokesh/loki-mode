// loki-ts/src/engine10/modernize/wave.ts -- M-20: wave verify (docs/v10/MODERNIZE.md section 3.5 "Per wave", D30).
// After a wave's units merge, run the full build, the integration checks and the ORIGINAL test suite of the
// legacy repo. A wave is verified only if all three pass. Any failure blocks the next wave with a fixed
// reason that names the failing step. No other modernize module owns wave verification (scheduler.ts only
// plans and runs units; M-21 ship consumes this verdict), so this is the one home for it. Child processes get
// tokenFreeEnv (no GH token, no SSH agent). Output is kept only as a bounded tail for humans: it is never
// parsed, and it never enters the reason string, so the reason is deterministic.
import { spawnSync } from "node:child_process";
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
  const block = (step: WaveStep, why: string): void => {
    failedStep = step;
    reason = `wave ${opts.wave} blocked: ${step} ${why}`;
  };

  for (const step of WAVE_STEPS) {
    if (failedStep !== null) { steps.push({ step, ran: false, passed: false, exit: null, tail: "" }); continue; }
    const cmd = opts.commands[step];
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
    steps: steps.map((s) => ({ step: s.step, ran: s.ran, passed: s.passed, exit: s.exit })),
  });
  return verdict;
}

/** The next wave may start only if every prior wave verified; otherwise the first failing wave's reason. */
export function nextWaveGate(prior: WaveVerdict[]): { allowed: boolean; reason: string | null } {
  const bad = prior.find((v) => !v.verified);
  return bad ? { allowed: false, reason: bad.reason ?? `wave ${bad.wave} blocked: not verified` } : { allowed: true, reason: null };
}
