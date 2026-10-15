// Setup requirements per execution path. The table itself lives in
// autonomy/lib/setup-requirements.json (one source for doctor, loki setup, runtime
// errors and docs/contracts/setup.md). This module only loads and evaluates it.
import { existsSync, readdirSync, readFileSync, accessSync, constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./paths.ts";
import { commandExists, run } from "./shell.ts";

export type ReqLevel = "required" | "optional";
export type ReqKind = "command" | "env_any" | "env_value" | "sdk_binary";

export interface Requirement {
  id: string;
  path: string;
  level: ReqLevel;
  kind: ReqKind;
  target: string | string[];
  min?: string;
  values?: string[];
  label: string;
  fix: string;
}
export interface ReqPath { id: string; title: string; summary: string }
export interface ReqTable {
  version: number;
  paths: ReqPath[];
  requirements: Requirement[];
  missing_optional: { dependency: string; effect: string }[];
}

export interface ReqStatus {
  id: string;
  label: string;
  level: ReqLevel;
  status: "present" | "missing";
  detail: string | null;
  fix: string;
}
export interface PathReport { id: string; title: string; ready: boolean; items: ReqStatus[] }
export interface RequirementsReport { paths: PathReport[] }

export const REQUIREMENTS_FILE = resolve(REPO_ROOT, "autonomy/lib/setup-requirements.json");

let cached: ReqTable | null = null;
export function loadRequirements(file: string = REQUIREMENTS_FILE): ReqTable {
  if (file === REQUIREMENTS_FILE && cached) return cached;
  const t = JSON.parse(readFileSync(file, "utf8")) as ReqTable;
  if (file === REQUIREMENTS_FILE) cached = t;
  return t;
}

export function requirementById(id: string): Requirement | null {
  return loadRequirements().requirements.find((r) => r.id === id) ?? null;
}

/** One-line fix for a requirement id (a provider name such as "claude" is an id). Null when unknown. */
export function requirementFix(id: string): string | null {
  return requirementById(id)?.fix ?? null;
}

/** Shared runtime wording: "<label> is missing. Fix: <fix>". Doctor reports the same label and fix. */
export function requirementError(id: string): string {
  const r = requirementById(id);
  return r ? `${r.label} is missing. Fix: ${r.fix}` : `requirement '${id}' is missing`;
}

/** Minimum version for a command requirement, e.g. requirementMin("node") is "20.0". */
export function requirementMin(id: string): string | null {
  return requirementById(id)?.min ?? null;
}

function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length, 2); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

async function defaultVersion(cmd: string): Promise<string | null> {
  try {
    const r = await run([cmd, "--version"], { timeoutMs: 5000 });
    const m = (r.stdout || r.stderr || "").match(/(\d+\.\d+(?:\.\d+)*)/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Search roots for the Agent SDK platform binary; mirrors detect_bundled_sdk_provider in autonomy/provider-offer.sh. */
export function sdkSearchRoots(env: Record<string, string | undefined>, root: string = REPO_ROOT): string[] {
  const seam = env["LOKI_SDK_NODE_MODULES"];
  if (seam) return [seam];
  return [resolve(root, "node_modules"), resolve(root, "loki-ts/node_modules"), resolve(root, ".."), resolve(root, "../..")];
}

export function sdkBinaryPresent(env: Record<string, string | undefined>, root: string = REPO_ROOT): boolean {
  for (const nm of sdkSearchRoots(env, root)) {
    const scope = resolve(nm, "@anthropic-ai");
    if (!existsSync(scope)) continue;
    let names: string[] = [];
    try { names = readdirSync(scope); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith("claude-agent-sdk-")) continue;
      try { accessSync(resolve(scope, n, "claude"), fsConstants.X_OK); return true; } catch { /* keep looking */ }
    }
  }
  return false;
}

export interface EvalDeps {
  env?: Record<string, string | undefined>;
  commandPath?: (cmd: string) => Promise<string | null>;
  version?: (cmd: string) => Promise<string | null>;
  sdkBinary?: () => boolean;
  table?: ReqTable;
}

export async function evaluateRequirement(r: Requirement, d: EvalDeps = {}): Promise<ReqStatus> {
  const env = d.env ?? (process.env as Record<string, string | undefined>);
  const base = { id: r.id, label: r.label, level: r.level, fix: r.fix };
  const missing = (detail: string): ReqStatus => ({ ...base, status: "missing", detail });
  const ok: ReqStatus = { ...base, status: "present", detail: null };
  const targets = Array.isArray(r.target) ? r.target : [r.target];
  switch (r.kind) {
    case "command": {
      const p = await (d.commandPath ?? commandExists)(targets[0]!);
      if (!p) return missing(`${targets[0]} not found on PATH`);
      if (r.min) {
        const v = await (d.version ?? defaultVersion)(targets[0]!);
        if (v && !versionAtLeast(v, r.min)) return missing(`${targets[0]} ${v} is older than ${r.min}`);
      }
      return ok;
    }
    case "env_any":
      return targets.some((n) => (env[n] ?? "").trim() !== "") ? ok : missing(`none of ${targets.join(", ")} is set`);
    case "env_value":
      return targets.some((n) => (r.values ?? []).includes((env[n] ?? "").trim().toLowerCase())) ? ok : missing(`${targets.join(", ")} is not set to ${(r.values ?? []).join(" or ")}`);
    case "sdk_binary":
      return (d.sdkBinary ? d.sdkBinary() : sdkBinaryPresent(env)) ? ok : missing("no runnable SDK platform binary found");
  }
}

/** A path is ready when every required item is present; a path with no required items needs any one item. */
export async function evaluateRequirements(d: EvalDeps = {}): Promise<RequirementsReport> {
  const table = d.table ?? loadRequirements();
  const paths: PathReport[] = [];
  for (const p of table.paths) {
    const items = await Promise.all(table.requirements.filter((r) => r.path === p.id).map((r) => evaluateRequirement(r, d)));
    const req = items.filter((i) => i.level === "required");
    const ready = req.length > 0 ? req.every((i) => i.status === "present") : items.some((i) => i.status === "present");
    paths.push({ id: p.id, title: p.title, ready, items });
  }
  return { paths };
}

/** Readiness of a first task: common requirements plus at least one ready execution path. */
export function firstTaskReady(rep: RequirementsReport): boolean {
  const common = rep.paths.find((p) => p.id === "common");
  return !!common && common.ready && rep.paths.some((p) => p.id !== "common" && p.ready);
}

/** Markdown requirements table for docs/contracts/setup.md; a test asserts the doc embeds exactly this text. */
export function renderContractTable(t: ReqTable = loadRequirements()): string {
  const out: string[] = [];
  for (const p of t.paths) {
    out.push(`### ${p.title}`, "", `${p.summary}.`, "", "| Requirement | Level | Check | Fix |", "| --- | --- | --- | --- |");
    for (const r of t.requirements.filter((x) => x.path === p.id)) {
      const list = Array.isArray(r.target) ? r.target : [r.target];
      const tg = list.join(" or ");
      const check =
        r.kind === "command" ? `\`${tg}\` on PATH${r.min ? `, version ${r.min} or newer` : ""}`
        : r.kind === "sdk_binary" ? `executable \`${tg}-<platform>/claude\` in an installed node_modules`
        : r.kind === "env_value" ? `\`${tg}\` is ${(r.values ?? []).map((v) => `\`${v}\``).join(" or ")}`
        : `one of ${list.map((v) => `\`${v}\``).join(", ")} is set`;
      out.push(`| ${r.label} | ${r.level} | ${check} | ${r.fix} |`);
    }
    out.push("");
  }
  out.push("### When an optional dependency is missing", "", "| Missing | Effect |", "| --- | --- |");
  for (const m of t.missing_optional) out.push(`| ${m.dependency} | ${m.effect} |`);
  return `${out.join("\n")}\n`;
}

export function renderRequirementsText(rep: RequirementsReport): string {
  const out: string[] = [];
  for (const p of rep.paths) {
    out.push(`${p.title}: ${p.ready ? "ready" : "not ready"}`);
    for (const i of p.items) {
      out.push(`  [${i.status === "present" ? " OK " : "MISS"}] ${i.level.padEnd(8)} ${i.label}${i.status === "missing" ? `. Fix: ${i.fix}` : ""}`);
    }
  }
  return out.join("\n");
}
