// loki-ts/src/project_model/schema.ts -- EL-W1-01 (L0, L4): the Project Model schema. The MODEL
// answers what the repo is; this file only checks the answer's shape and that every claim cites a
// file that exists. It holds no knowledge about any language, framework or layout.
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

export const PROJECT_MODEL_SCHEMA = "loki.v10.project/1";
export const COMMAND_KINDS = ["test", "lint", "build", "start"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export interface ModelCommand {
  cmd: string; // the exact command line, run through a shell by whoever consumes it
  cwd: string; // repo-relative directory the command runs in ("." is the repo root)
  cite: string[]; // repo-relative files this command came from
}
export interface ModelUi {
  present: boolean;
  boot: ModelCommand | null; // how to boot the UI, when present
  cite: string[];
}
export interface ModelPackage {
  name: string;
  root: string; // repo-relative directory ("." is the repo root)
  runner: string | null; // the model's own label for the test runner
  commands: Record<CommandKind, ModelCommand | null>;
  ui: ModelUi;
  cite: string[];
}
export interface ProjectModel {
  schema: typeof PROJECT_MODEL_SCHEMA;
  status: "ok" | "unknown";
  key: string; // cache key: hash of the fingerprint files and the shallow directory set
  workspaceKind: string; // the model's own label (single, workspaces, multi-root, polyglot, ...)
  workspaceCite: string[];
  packages: ModelPackage[];
  fingerprintFiles: string[]; // manifests and lockfiles the model says define this repo
  reason?: string; // set when status is "unknown"
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Repo-relative, normalized path with no escape from repoDir; null when it is unsafe. */
export function safeRel(p: string): string | null {
  const n = normalize(p.trim()).split(sep).join("/").replace(/\/$/, "");
  if (n === "" || isAbsolute(n) || n === ".." || n.startsWith("../")) return null;
  return n;
}

function insideRepo(repoDir: string, rel: string): boolean {
  try {
    const real = realpathSync(join(repoDir, rel));
    const base = realpathSync(repoDir);
    return real === base || real.startsWith(base + sep);
  } catch {
    return false;
  }
}

/** A citation is "path" or "path:line[-line]"; it must name an existing file inside the repo. */
export function checkCitation(repoDir: string, raw: unknown): string | null {
  if (!isStr(raw)) return "citation is not a non-empty string";
  const rel = safeRel(raw.replace(/:\d+(?:-\d+)?$/, ""));
  if (rel === null) return `citation "${raw}" is not a repo-relative path`;
  const abs = join(repoDir, rel);
  if (!existsSync(abs) || !statSync(abs).isFile() || !insideRepo(repoDir, rel)) return `citation "${raw}" names a file that does not exist`;
  return null;
}

function checkCites(repoDir: string, v: unknown, where: string, errs: string[]): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    errs.push(`${where}: needs at least one citation (a repo-relative file path)`);
    return [];
  }
  const out: string[] = [];
  for (const c of v) {
    const e = checkCitation(repoDir, c);
    if (e) errs.push(`${where}: ${e}`);
    else out.push(String(c));
  }
  return out;
}

function checkDir(repoDir: string, v: unknown, where: string, errs: string[]): string {
  const rel = isStr(v) ? safeRel(v) : null;
  if (rel === null) {
    errs.push(`${where}: must be a repo-relative directory ("." for the repo root)`);
    return ".";
  }
  const abs = join(repoDir, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory() || !insideRepo(repoDir, rel)) errs.push(`${where}: directory "${rel}" does not exist`);
  return rel;
}

function checkCommand(repoDir: string, v: unknown, where: string, errs: string[]): ModelCommand | null {
  if (v === null || v === undefined) return null;
  if (!isRec(v) || !isStr(v.cmd)) {
    errs.push(`${where}: must be null or {cmd, cwd, cite}`);
    return null;
  }
  const cwd = checkDir(repoDir, v.cwd, `${where}.cwd`, errs);
  return { cmd: v.cmd.trim(), cwd, cite: checkCites(repoDir, v.cite, `${where}.cite`, errs) };
}

/** Validates the model's raw answer. Returns the typed model (key set by the caller) or every
 *  error found, so the one retry can show the model all of them at once. */
export function validateAnswer(repoDir: string, raw: unknown): { ok: true; model: Omit<ProjectModel, "key"> } | { ok: false; errors: string[] } {
  const errs: string[] = [];
  if (!isRec(raw)) return { ok: false, errors: ["answer must be a JSON object"] };
  if (!isStr(raw.workspaceKind)) errs.push("workspaceKind: required non-empty string");
  const workspaceCite = checkCites(repoDir, raw.workspaceCite, "workspaceCite", errs);
  if (!Array.isArray(raw.packages)) errs.push("packages: required array");
  const packages: ModelPackage[] = [];
  for (const [i, p] of (Array.isArray(raw.packages) ? raw.packages : []).entries()) {
    const w = `packages[${i}]`;
    if (!isRec(p) || !isStr(p.name)) {
      errs.push(`${w}: must be an object with a name`);
      continue;
    }
    const root = checkDir(repoDir, p.root, `${w}.root`, errs);
    const cmds = isRec(p.commands) ? p.commands : {};
    if (!isRec(p.commands)) errs.push(`${w}.commands: required object with keys ${COMMAND_KINDS.join(", ")} (each null or a command)`);
    const commands = {} as Record<CommandKind, ModelCommand | null>;
    for (const k of COMMAND_KINDS) commands[k] = checkCommand(repoDir, cmds[k], `${w}.commands.${k}`, errs);
    const ui = isRec(p.ui) ? p.ui : {};
    if (!isRec(p.ui) || typeof ui.present !== "boolean") errs.push(`${w}.ui: required {present: boolean, boot: command|null, cite}`);
    packages.push({
      name: p.name.trim(),
      root,
      runner: isStr(p.runner) ? p.runner.trim() : null,
      commands,
      ui: { present: ui.present === true, boot: checkCommand(repoDir, ui.boot, `${w}.ui.boot`, errs), cite: checkCites(repoDir, ui.cite, `${w}.ui.cite`, errs) },
      cite: checkCites(repoDir, p.cite, `${w}.cite`, errs),
    });
  }
  if (!Array.isArray(raw.fingerprintFiles)) errs.push("fingerprintFiles: required array of the manifest and lockfile paths");
  const fingerprintFiles = (Array.isArray(raw.fingerprintFiles) ? raw.fingerprintFiles : []).filter((f) => {
    const e = checkCitation(repoDir, f);
    if (e) errs.push(`fingerprintFiles: ${e}`);
    return e === null;
  }).map((f) => String(f).replace(/:\d+(?:-\d+)?$/, ""));
  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, model: { schema: PROJECT_MODEL_SCHEMA, status: "ok", workspaceKind: String(raw.workspaceKind).trim(), workspaceCite, packages, fingerprintFiles } };
}

/** The typed "I could not learn this repo" model. Consumers must treat it as no knowledge. */
export function unknownModel(key: string, reason: string): ProjectModel {
  return { schema: PROJECT_MODEL_SCHEMA, status: "unknown", key, workspaceKind: "unknown", workspaceCite: [], packages: [], fingerprintFiles: [], reason };
}

/** Shape check for a cached file (no filesystem checks: the user may edit it). */
export function isProjectModel(v: unknown): v is ProjectModel {
  return isRec(v) && v.schema === PROJECT_MODEL_SCHEMA && (v.status === "ok" || v.status === "unknown") && typeof v.key === "string" && Array.isArray(v.packages) && Array.isArray(v.fingerprintFiles);
}
