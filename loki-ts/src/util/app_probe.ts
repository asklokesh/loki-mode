// TEN-GATES-04: the TS-callable surface over autonomy/app-runner.sh. Boots the detected app in a bash child, probes its health,
// optionally runs the spec-derived functional harness, and ALWAYS stops the PID app-runner recorded. A missing runtime or no
// detectable app is not_run, never fail (a harness limit is not a code failure).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReceiptCheck } from "../engine10/types.ts";
import { plainTestEnv } from "./check_result.ts";
import { findPython3 } from "./python.ts";
import { REPO_ROOT } from "./paths.ts";

export interface AppProbeCheck extends ReceiptCheck { reason?: string }
export interface AppProbeOptions { specText?: string; timeoutMs?: number; env?: Record<string, string>; runnerPath?: string; verifyPath?: string; skipStop?: boolean }
export interface AppProbeResult { checks: AppProbeCheck[]; pid: number | null; url: string | null }

const PRELUDE = `set +e
log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_step() { :; }; register_pid() { :; }
export APP_RUNNER_ENABLED=true
export TARGET_DIR="$1"
source "$2" >/dev/null 2>&1 || exit 90
`;
const BOOT = `${PRELUDE}
app_runner_init >/dev/null 2>&1; ir=$?
sr=-1; hr=-1
if [ "$ir" -eq 0 ] && [ -s "$TARGET_DIR/.loki/app-runner/detection.json" ]; then
  app_runner_start >/dev/null 2>&1; sr=$?
  [ "$sr" -eq 0 ] && { app_runner_health_check >/dev/null 2>&1; hr=$?; }
fi
printf '__APP_PROBE__ %s %s %s\\n' "$ir" "$sr" "$hr"
`;
const STOP = `${PRELUDE}
_app_runner_dir
app_runner_stop >/dev/null 2>&1
`;

function readJson(p: string): Record<string, unknown> | null {
  try { const v: unknown = JSON.parse(readFileSync(p, "utf8")); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
}

/** Stops only the PID app-runner recorded under repoDir/.loki/app-runner (no-op when none). */
export function stopApp(repoDir: string, opts: Pick<AppProbeOptions, "runnerPath" | "timeoutMs"> = {}): void {
  const runner = opts.runnerPath ?? join(REPO_ROOT, "autonomy", "app-runner.sh");
  if (!existsSync(runner) || !existsSync(join(repoDir, ".loki", "app-runner", "app.pid"))) return;
  spawnSync("bash", ["-c", STOP, "app-probe", repoDir, runner], { cwd: repoDir, env: plainTestEnv(), timeout: opts.timeoutMs ?? 60_000, killSignal: "SIGKILL", stdio: "ignore" });
}

export async function appProbe(repoDir: string, lokiDir: string, opts: AppProbeOptions = {}): Promise<AppProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000, runner = opts.runnerPath ?? join(REPO_ROOT, "autonomy", "app-runner.sh");
  const dir = join(repoDir, ".loki", "app-runner"), checks: AppProbeCheck[] = [];
  const t0 = Date.now();
  const mk = (name: string, result: ReceiptCheck["result"], reason: string): AppProbeCheck => ({ name, cmd: "autonomy/app-runner.sh", result, duration_s: (Date.now() - t0) / 1000, reason });
  const sh = (script: string): { out: string; status: number | null } => {
    const r = spawnSync("bash", ["-c", script, "app-probe", repoDir, runner], { cwd: repoDir, env: { ...plainTestEnv(), ...(opts.env ?? {}) }, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
    return { out: r.stdout ?? "", status: r.error ? null : r.status };
  };
  let pid: number | null = null, url: string | null = null;
  if (!existsSync(runner)) return { checks: [mk("app boot", "not_run", "app-runner.sh not found"), mk("http probe", "not_run", "app not booted")], pid, url };
  try {
    const b = sh(BOOT);
    const m = b.out.match(/__APP_PROBE__ (-?\d+) (-?\d+) (-?\d+)/);
    if (!m) {
      checks.push(mk("app boot", "not_run", b.status === null ? "bash unavailable or boot timed out" : "app-runner did not report"), mk("http probe", "not_run", "app not booted"));
      return { checks, pid, url };
    }
    const ir = Number(m[1]), sr = Number(m[2]), hr = Number(m[3]);
    const pidTxt = existsSync(join(dir, "app.pid")) ? readFileSync(join(dir, "app.pid"), "utf8").trim() : "";
    pid = /^\d+$/.test(pidTxt) && sr >= 0 ? Number(pidTxt) : null;
    const st = readJson(join(dir, "state.json"));
    url = typeof st?.["url"] === "string" ? st["url"] : null;
    if (sr < 0) {
      checks.push(mk("app boot", "not_run", ir === 0 ? "app-runner detected no app" : "no runnable app detected or runtime missing"), mk("http probe", "not_run", "app not booted"));
      return { checks, pid, url };
    }
    if (sr !== 0) {
      checks.push(mk("app boot", "fail", "app start command failed or exited"), mk("http probe", "not_run", "app not booted"));
      return { checks, pid, url };
    }
    checks.push(mk("app boot", "pass", "app process started"));
    const health = readJson(join(dir, "health.json"));
    checks.push(hr === 0 && health?.["ok"] === true ? mk("http probe", "pass", "health.json ok") : mk("http probe", "fail", "app-runner health check failed"));
    if (opts.specText !== undefined && checks[1]?.result === "pass" && url) checks.push(await functionalVerify(opts, url, dir, lokiDir, timeoutMs));
    return { checks, pid, url };
  } finally {
    if (!opts.skipStop) stopApp(repoDir, { runnerPath: runner, timeoutMs });
  }
}

async function functionalVerify(opts: AppProbeOptions, url: string, dir: string, lokiDir: string, timeoutMs: number): Promise<AppProbeCheck> {
  const t0 = Date.now();
  const res = (result: ReceiptCheck["result"], reason: string): AppProbeCheck => ({ name: "functional verify", cmd: "autonomy/lib/functional-verify.py", result, duration_s: (Date.now() - t0) / 1000, reason });
  const py = await findPython3(), script = opts.verifyPath ?? join(REPO_ROOT, "autonomy", "lib", "functional-verify.py");
  if (!py || !existsSync(script)) return res("not_run", "python3 or functional-verify.py unavailable");
  const specFile = join(dir, "spec.txt");
  writeFileSync(specFile, opts.specText ?? "");
  const r = spawnSync(py, ["-I", script, specFile, url], { env: plainTestEnv(), encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
  let out: Record<string, unknown> | null = null;
  try { const v: unknown = JSON.parse(r.stdout ?? ""); out = v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { out = null; }
  if (!out || r.status !== 0) return res("not_run", "functional harness produced no result");
  const q = join(lokiDir, "quality");
  mkdirSync(q, { recursive: true });
  const tmp = join(q, `functional-results.json.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, join(q, "functional-results.json"));
  const s = String(out["functional_status"] ?? "inconclusive");
  return res(s === "verified" ? "pass" : s === "failed" ? "fail" : "not_run", `functional_status ${s}`);
}
