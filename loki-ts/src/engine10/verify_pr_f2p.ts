// VPR-2: the fail-to-pass (F2P) check for `loki verify-pr`. A check derived from the LINKED ISSUE must FAIL on the PR
// base and PASS on the PR head. Pure decision logic plus check extraction; execution is injected (the VPR-1 sandbox).
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SandboxResult { status: "COMPLETED" | "TIMEOUT" | "ERROR" | "BLOCKED"; exit_code: number | null; detail?: string }
export type F2pOutcome =
  | { ok: true }
  | { ok: false; blocked: boolean; reason: string };

const MAX_CHECKS = 5;
const MAX_CMD = 500;

/** Runnable checks the issue author wrote: `Check: \`cmd\`` lines and ```loki-check fences. Only the issue body is read, never the PR body. */
export function extractChecks(issueBody: string): string[] {
  const out: string[] = [];
  const add = (c: string): void => { const t = c.trim(); if (t && t.length <= MAX_CMD && !out.includes(t) && out.length < MAX_CHECKS) out.push(t); };
  let fence = false, inCheck = false;
  for (const ln of issueBody.split(/\r?\n/)) {
    const f = /^\s*(```|~~~)\s*(\S*)/.exec(ln);
    if (f) { if (fence) { fence = false; inCheck = false; } else { fence = true; inCheck = f[2] === "loki-check"; } continue; }
    if (fence) { if (inCheck) add(ln); continue; }
    const m = /^\s*(?:[-*+]\s+)?check:\s*`([^`]+)`/i.exec(ln);
    if (m) add(m[1]!);
  }
  return out;
}

/** Repo-relative file paths a check command names that exist in `dir`. Used to detect a check whose test the PR deleted. */
export function referencedFiles(cmd: string, dir: string): string[] {
  return cmd.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => t !== "" && !t.startsWith("-") && !t.startsWith("/") && !t.includes("..") && existsSync(join(dir, t)));
}

/** Decides one check. `base` must exit non-zero and `head` must exit zero; any sandbox non-completion is NOT PROVEN, never a pass or a fail. */
export function judgeF2p(check: string, base: SandboxResult, head: SandboxResult): F2pOutcome {
  for (const [side, r] of [["base", base], ["head", head]] as const) {
    if (r.status === "BLOCKED") return { ok: false, blocked: true, reason: `sandbox blocked on ${side}: ${r.detail ?? "unavailable"}` };
    if (r.status !== "COMPLETED" || r.exit_code === null) return { ok: false, blocked: false, reason: `check did not complete on ${side} (${r.status}): ${check}` };
  }
  if (base.exit_code === 0) return { ok: false, blocked: false, reason: `check does not discriminate (passes on base): ${check}` };
  if (head.exit_code !== 0) return { ok: false, blocked: false, reason: `check still fails on head (exit ${head.exit_code}): ${check}` };
  return { ok: true };
}
