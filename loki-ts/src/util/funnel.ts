// TEN-UX-03: the one TS bridge to the first-run funnel in autonomy/telemetry.sh.
// Detached and best-effort; every opt-out is enforced by the bash side. Only
// bounded enums cross: never a path, a brief or an error text.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, lokiDirFor } from "./paths.ts";
import { listProjectFiles, tokenFreeEnv } from "./safe_git.ts";
import { languageBytes } from "../project_model/linguist.ts";
import { buildTestMap } from "../engine10/testmap.ts";

export type FunnelKind = "first_run_blocked" | "build_verified" | "run_started" | "run_finished";

export function emitFunnel(kind: FunnelKind, key: string, extra: readonly string[] = []): void {
  try {
    const script = resolve(REPO_ROOT, "autonomy", "telemetry.sh");
    if (!existsSync(script)) return;
    const fn = kind === "first_run_blocked" ? 'loki_emit_first_run_blocked "$2"' : kind === "run_started" ? "loki_emit_run_started" : kind === "run_finished" ? 'loki_emit_run_finished "$2" "${@:3}"' : 'loki_emit_build_verified_enum VERIFIED "$2"';
    const child = spawn("bash", ["-c", `source "$1" >/dev/null 2>&1 && ${fn} >/dev/null 2>&1`, "_", script, key, ...extra], {
      detached: true,
      stdio: "ignore",
      env: tokenFreeEnv(process.env),
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // telemetry is best-effort
  }
}

/** The fixed enum of refusal classes; the value is chosen by the check that refused, never probed from the folder or parsed from message text. */
export const PREFLIGHT_BLOCKERS = ["not_a_repo", "git_identity", "dirty_tracked_tree", "no_provider", "not_logged_in", "prd_missing", "unsupported_flag", "disk", "other"] as const;
export type PreflightBlocker = (typeof PREFLIGHT_BLOCKERS)[number];
/** Narrows an untrusted value (an event field) to the enum, or null. */
export function blockerOf(v: unknown): PreflightBlocker | null { return typeof v === "string" && (PREFLIGHT_BLOCKERS as readonly string[]).includes(v) ? (v as PreflightBlocker) : null; }

let refusal: PreflightBlocker | null = null;
/** Called by the refusing check right before it returns nonzero. */
export function noteRefusal(b: PreflightBlocker | null): void { if (b) refusal = b; }
/** Reads and clears the noted class. */
export function takeRefusal(): PreflightBlocker | null { const b = refusal; refusal = null; return b; }
/** A refusal that happened inside the run (the intake stage) is in the event log: note its class from the failed intake event. */
export function noteRefusalFromEvents(events: readonly { type: string; stage?: string | null; data: Record<string, unknown> }[]): void {
  noteRefusal(blockerOf(events.find((e) => e.type === "stage.failed" && e.stage === "intake")?.data["blocker"]));
}

const RUN_VERDICTS = ["VERIFIED", "PARTIAL", "ALREADY_SATISFIED", "SPEC_CONFLICT", "FAILED"] as const;
const RUN_STAGES = ["intake", "plan", "wall", "implement", "verify", "fix", "commit", "seal", "pr", "deep"] as const;
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : null);

/** AN-06: stratification buckets. Every value is a member of a fixed list (mirrored in autonomy/lib/telemetry-schema.json); nothing is a path, a name or an exact count. Unknown reads "unknown", never a number. */
export const RUN_PROVIDERS = ["claude", "codex", "cline", "aider", "opencode", "other", "unknown"] as const;
export const MODEL_TIERS = ["fast", "balanced", "deep", "mixed", "unknown"] as const;
export const LANG_BUCKETS = ["python", "javascript", "typescript", "go", "rust", "java", "ruby", "php", "csharp", "c_cpp", "shell", "other"] as const;
export const SIZE_BUCKETS = ["xs", "s", "m", "l", "xl"] as const;
export const RUNNER_KINDS = ["pytest", "unittest", "vitest", "jest", "npm", "bun", "node", "go", "cargo", "maven", "gradle", "javac", "none", "unknown"] as const;
export const COST_BUCKETS = ["lt_1", "lt_5", "lt_20", "ge_20", "unknown"] as const;
export const TOKEN_BUCKETS = ["lt_100k", "lt_1m", "lt_10m", "ge_10m", "unknown"] as const;
const LANG_EXTS: Readonly<Record<string, (typeof LANG_BUCKETS)[number]>> = { py: "python", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", go: "go", rs: "rust", java: "java", rb: "ruby", php: "php", cs: "csharp", c: "c_cpp", h: "c_cpp", cc: "c_cpp", cpp: "c_cpp", hpp: "c_cpp", sh: "shell", bash: "shell" };
export const sizeBucket = (n: number): (typeof SIZE_BUCKETS)[number] => (n < 50 ? "xs" : n < 500 ? "s" : n < 5000 ? "m" : n < 50000 ? "l" : "xl");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Mirrors cost_breakdown.ts noUsage and the seal cost fields: a figure is a real dollar amount only when every session was priced, the dollar sum is complete, and a recorded 0 dollars comes with fully measured usage. Anything else is "unknown", never lt_1. */
export const costBucket = (cost: Record<string, unknown>): (typeof COST_BUCKETS)[number] => {
  const usd = cost["usd"];
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || cost["source"] === "cli-invoker-unmetered") return "unknown";
  const ms = cost["measured_sessions"], ts = cost["total_sessions"];
  if (typeof ms === "number" && typeof ts === "number" && ms < ts) return "unknown";
  const part = cost["partial_usd"];
  if (typeof part === "number" && Number.isFinite(part) && Math.abs(part - usd) > 1e-9) return "unknown";
  if (usd === 0 && (cost["tokens_measured"] !== undefined || ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"].every((k) => num(cost[k]) === 0))) return "unknown";
  return usd < 1 ? "lt_1" : usd < 5 ? "lt_5" : usd < 20 ? "lt_20" : "ge_20";
};
export const tokenBucket = (inTok: unknown, outTok: unknown, partial = false): (typeof TOKEN_BUCKETS)[number] => {
  if (partial || typeof inTok !== "number" || typeof outTok !== "number" || !Number.isFinite(inTok + outTok) || inTok < 0 || outTok < 0 || inTok + outTok === 0) return "unknown";
  const t = inTok + outTok;
  return t < 1e5 ? "lt_100k" : t < 1e6 ? "lt_1m" : t < 1e7 ? "lt_10m" : "ge_10m";
};
const tierOfModel = (m: string): (typeof MODEL_TIERS)[number] => (/haiku|mini|flash/i.test(m) ? "fast" : /opus/i.test(m) ? "deep" : /sonnet/i.test(m) ? "balanced" : "unknown");
/** One tier when every model used maps to the same tier, "mixed" when known tiers differ, "unknown" when any model is unrecognised or none is recorded. */
export const modelTier = (model: unknown, perModel?: unknown): (typeof MODEL_TIERS)[number] => {
  const names = perModel && typeof perModel === "object" ? Object.keys(perModel as object) : [];
  const tiers = new Set((names.length ? names : typeof model === "string" ? [model] : []).map(tierOfModel));
  return tiers.size === 0 || tiers.has("unknown") ? "unknown" : tiers.size === 1 ? [...tiers][0]! : "mixed";
};
const providerBucket = (v: unknown): (typeof RUN_PROVIDERS)[number] => (typeof v !== "string" ? "unknown" : ["claude", "codex", "cline", "aider", "opencode"].includes(v) ? (v as (typeof RUN_PROVIDERS)[number]) : "other");
/** Repo-derived buckets: tracked file count, top language by linguist bytes, first detected test runner. Names and paths are read but only the bucket leaves. */
function repoBuckets(cwd: string): string[] {
  let size: (typeof SIZE_BUCKETS)[number] = "xs", lang: (typeof LANG_BUCKETS)[number] = "other", runner: (typeof RUNNER_KINDS)[number] = "unknown";
  try {
    const files = listProjectFiles(cwd);
    size = sizeBucket(files.length);
    const bytes = languageBytes(cwd, files, (f) => LANG_EXTS[f.slice(f.lastIndexOf(".") + 1).toLowerCase()] ?? null);
    let best = 0;
    for (const [k, v] of bytes) if (v > best && (LANG_BUCKETS as readonly string[]).includes(k)) { best = v; lang = k as (typeof LANG_BUCKETS)[number]; }
  } catch { /* stays at the defaults */ }
  try { const r = buildTestMap(cwd).runners[0]; runner = r && (RUNNER_KINDS as readonly string[]).includes(r) ? r : "none"; } catch { /* unknown */ }
  return [`lang_bucket=${lang}`, `repo_size_bucket=${size}`, `test_runner=${runner}`];
}

/** AN-05: the run_finished pairs. Reads the run's receipt.json ONLY through this allowlist (verdict, time, fix_rounds count, exit code); no other receipt key is read, so a path or text in the receipt cannot reach the payload. No fresh receipt (none, or one older than this run) is INTERRUPTED, or BLOCKED on the engine's own blocked exit code 4. */
export function runFinishedArgs(code: number, cwd: string, startedMs?: number): string[] {
  let verdict: string = code === 4 ? "BLOCKED" : "INTERRUPTED";
  const pairs: string[] = [];
  let rec: Record<string, unknown> = {};
  try {
    const root = join(lokiDirFor(cwd), "runs");
    const id = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().pop() ?? null : null; // run ids embed a sortable UTC timestamp
    const file = id ? join(root, id, "receipt.json") : null;
    if (file && existsSync(file) && (startedMs === undefined || statSync(file).mtimeMs >= startedMs)) {
      const r = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if ((RUN_VERDICTS as readonly unknown[]).includes(r["verdict"])) {
        rec = r;
        verdict = r["verdict"] as string;
        const time = (r["time"] ?? {}) as Record<string, unknown>;
        const dur = nonNeg(time["total_s"]) ?? nonNeg(time["wall_s"]);
        if (dur !== null) pairs.push(`duration_s=${dur}`);
        const stages = (time["stages"] ?? {}) as Record<string, unknown>;
        for (const st of RUN_STAGES) { const v = nonNeg(stages[st]); if (v !== null) pairs.push(`stage_s_${st}=${v}`); }
        const fr = ((r["cost"] ?? {}) as Record<string, unknown>)["fix_rounds"];
        if (Array.isArray(fr)) pairs.push(`fix_rounds=${fr.length}`);
      }
    }
  } catch {
    // unreadable receipt: the verdict stays INTERRUPTED/BLOCKED
  }
  const cost = (rec["cost"] ?? {}) as Record<string, unknown>;
  const fo = rec["failover"];
  pairs.push(`provider=${providerBucket(rec["provider"])}`, `model_tier=${modelTier(rec["model"], cost["per_model"])}`, ...repoBuckets(cwd), `cost_bucket=${costBucket(cost)}`, `token_bucket=${tokenBucket(cost["input_tokens"], cost["output_tokens"], cost["tokens_measured"] !== undefined)}`);
  if (Object.keys(rec).length > 0) pairs.push(`provider_failovers=${Array.isArray(fo) ? Math.min(fo.length, 1000) : 0}`); // omitted with no receipt: 0 would claim a run with no failover
  return [verdict, ...pairs, `exit_code=${Math.max(0, Math.min(255, Math.trunc(code)))}`];
}

/** Called once after a run-route command returns. Every run (not --dry-run) reports run_started and run_finished (AN-05); a noted refusal class is sent for any nonzero exit; exit 2 with none noted is "other"; exit 0 is a build_verified. */
export async function funnelAfterRun(code: number, cwd: string, startedMs?: number, args: readonly string[] = []): Promise<void> {
  const b = takeRefusal();
  if (!args.includes("--dry-run")) {
    const [verdict, ...rest] = runFinishedArgs(code, cwd, startedMs);
    emitFunnel("run_started", "engine10");
    emitFunnel("run_finished", verdict!, rest);
  }
  if (code === 0) emitFunnel("build_verified", "engine10");
  else if (b || code === 2) emitFunnel("first_run_blocked", b ?? "other");
}
