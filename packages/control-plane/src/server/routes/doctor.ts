// GET /v1/doctor (A5): the real `loki doctor --json` checks, mapped to {name,status,detail}. Fixed argv, no shell, 25s timeout,
// the same scrubbed child env as spawned runs, cached for 60s. Unusable output is an error (502), never an invented pass.
import { spawn } from "node:child_process";
import { childEnv } from "../spawn.ts";
import { probeAllowed, ttlCache, type RouteCtx } from "./index.ts";

export const DOCTOR_TIMEOUT_MS = 25_000;
const MAX_OUT = 1_000_000;

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorCheck { name: string; status: DoctorStatus; detail: string }

const isStatus = (s: unknown): s is DoctorStatus => s === "pass" || s === "warn" || s === "fail";

/** Run `<bin> doctor --json` and return stdout. doctor exits 1 when a check fails, so the exit code is not the signal; the JSON is. */
export function runDoctor(bin: string, timeoutMs = DOCTOR_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let done = false;
    let child: ReturnType<typeof spawn>;
    const finish = (f: () => void): void => { if (!done) { done = true; clearTimeout(timer); f(); } };
    try {
      child = spawn(bin, ["doctor", "--json"], { stdio: ["ignore", "pipe", "ignore"], shell: false, env: childEnv() });
    } catch (e) { return reject(new Error(`could not run loki doctor: ${(e as Error).message}`)); }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(() => reject(new Error(`loki doctor timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { if (out.length < MAX_OUT) out += d.toString("utf8"); });
    child.on("error", (e) => finish(() => reject(new Error(`could not run loki doctor: ${e.message}`))));
    child.on("close", () => finish(() => resolve(out)));
  });
}

/** Map the doctor JSON (tool checks plus disk and AI provider) to the flat checklist shape. */
export function mapDoctor(raw: string): DoctorCheck[] {
  let j: { checks?: unknown; disk?: unknown; ai_provider?: unknown };
  try { j = JSON.parse(raw); } catch { throw new Error("loki doctor did not return JSON"); }
  if (!j || !Array.isArray(j.checks)) throw new Error("loki doctor JSON has no checks");
  const out: DoctorCheck[] = [];
  for (const c of j.checks as Record<string, unknown>[]) {
    if (typeof c?.name !== "string" || !isStatus(c.status)) continue;
    const sev = typeof c.required === "string" ? c.required : "";
    const detail = c.found === false
      ? `not found${sev ? ` (${sev})` : ""}`
      : `${typeof c.version === "string" ? c.version : "found"}${c.status === "warn" && typeof c.min_version === "string" ? `, needs ${c.min_version} or newer` : ""}`;
    out.push({ name: c.name, status: c.status, detail });
  }
  const d = j.disk as { available_gb?: unknown; status?: unknown } | undefined;
  if (d && isStatus(d.status)) out.push({ name: "Disk space", status: d.status, detail: typeof d.available_gb === "number" ? `${d.available_gb} GB available` : "unknown" });
  const a = j.ai_provider as { found?: unknown; status?: unknown; detail?: unknown } | undefined;
  if (a && isStatus(a.status)) out.push({ name: "AI provider", status: a.status, detail: typeof a.detail === "string" && a.detail ? a.detail : a.found ? "found" : "not found" });
  if (out.length === 0) throw new Error("loki doctor returned no usable checks");
  return out;
}

export function mount(ctx: RouteCtx): void {
  const cached = ttlCache<{ checks: DoctorCheck[] }>();
  ctx.app.get("/v1/doctor", async (c) => {
    if (!probeAllowed(ctx, c)) return c.json({ error: "loopback only without a token" }, 403);
    try {
      return c.json(await cached("doctor", async () => ({ checks: mapDoctor(await runDoctor(ctx.startBin ?? "loki")) })));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });
}
