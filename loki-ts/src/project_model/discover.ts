// loki-ts/src/project_model/discover.ts -- EL-W1-01 (L0, L4): one model discovery session reads the
// repo and answers the Project Model; the harness validates it (schema.ts), retries once with the
// errors, and otherwise returns a typed "unknown" model. Cached in .loki/project.json by key.
// The session goes through ctx.sessions (the engine10 provider path) on the run's own model (L1).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext } from "../engine10/types.ts";
import { computeKey, gather, shallowDirs, type Gathered } from "./gather.ts";
import { isProjectModel, unknownModel, validateAnswer, type ProjectModel } from "./schema.ts";

export const PROJECT_FILE = ".loki/project.json";
const DISCOVERY_LIMIT_S = 120;

export interface Discovery {
  model: ProjectModel;
  cached: boolean;
  attempts: number; // model sessions spent (0 on a cache hit)
}

export function loadCached(repoDir: string): ProjectModel | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(repoDir, PROJECT_FILE), "utf8"));
    return isProjectModel(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function buildBrief(g: Gathered, answerPath: string, errors: string[] | null): string {
  const files = g.files.map((f) => `=== ${f.path} ===\n${f.text}`).join("\n\n");
  return [
    "You are the Loki 10 Project Model discovery step. Read this repository like a senior engineer who has just joined it, and describe how it is built and tested. You decide; nothing here is a hint about what you will find.",
    "Sources of truth, in order: (1) loki.yaml overrides; (2) AGENTS.md, CLAUDE.md, CONTRIBUTING and README instructions; (3) CI workflow files (how the project's own CI really runs tests); (4) manifests and config files; (5) conventions. Open any file you need with your tools; the inlined files below are only a head start.",
    `Write ONLY a JSON object to this file (absolute path): ${answerPath}`,
    `Shape: {"workspaceKind": string (your own label: single, workspaces, multi-root, polyglot, ...), "workspaceCite": [file], "fingerprintFiles": [every manifest and lockfile that defines the repo, repo-relative], "packages": [{"name": string, "root": repo-relative dir ("." for the repo root), "runner": string|null, "cite": [file], "commands": {"test": C|null, "lint": C|null, "build": C|null, "start": C|null}, "ui": {"present": boolean, "boot": C|null, "cite": [file]}}]} where C = {"cmd": exact command line, "cwd": repo-relative dir it must run in, "cite": [file]}.`,
    "Rules: every package, command and ui entry MUST cite at least one repo-relative file that exists and that you actually read. Use null for a command the repo does not define; never invent one. A package root is the directory the commands run from; list every package, including ones with no root manifest.",
    errors ? `Your previous answer was REJECTED. Fix every error and rewrite the file:\n${errors.map((e) => `- ${e}`).join("\n")}` : "",
    `Tracked files (depth-limited):\n${g.tree.join("\n")}`,
    files,
    "When the file is written, finish with exactly one line: LOKI_DONE",
  ].filter((s) => s !== "").join("\n\n");
}

/** The answer file first; a JSON object in the session's closing text as a fallback. */
function readAnswer(answerPath: string, summary: string | undefined): unknown {
  for (const text of [existsSync(answerPath) ? readFileSync(answerPath, "utf8") : "", summary ?? ""]) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch { /* try the next source */ }
  }
  return undefined;
}

export async function discoverProjectModel(ctx: RunContext, signal: AbortSignal, opts: { force?: boolean } = {}): Promise<Discovery> {
  const dirs = shallowDirs(ctx.repoDir);
  const cached = opts.force ? null : loadCached(ctx.repoDir);
  if (cached && cached.status === "ok" && computeKey(ctx.repoDir, cached.fingerprintFiles, dirs) === cached.key) return { model: cached, cached: true, attempts: 0 };

  const g = gather(ctx.repoDir);
  mkdirSync(ctx.runDir, { recursive: true });
  const answerPath = join(ctx.runDir, "project-model.answer.json");
  let errors: string[] | null = null;
  const MAX_ATTEMPTS = 2; // one answer, one retry with the validation errors (L0)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) return { model: unknownModel("", "aborted"), cached: false, attempts: attempt - 1 };
    rmSync(answerPath, { force: true });
    const session = await ctx.sessions.run({
      stage: "intake",
      brief: buildBrief(g, answerPath, errors),
      tier: "development",
      iterationId: `${ctx.runId}-project-model${attempt > 1 ? "-retry" : ""}`,
      limitS: DISCOVERY_LIMIT_S,
      signal,
      cwd: ctx.repoDir,
    });
    const raw = readAnswer(answerPath, session.summary);
    if (raw === undefined) {
      errors = [session.killed || session.exit !== 0 ? "the discovery session did not finish" : "no JSON answer was found: write the JSON object to the answer file"];
      continue;
    }
    const v = validateAnswer(ctx.repoDir, raw);
    if (v.ok) {
      const model: ProjectModel = { ...v.model, key: computeKey(ctx.repoDir, v.model.fingerprintFiles, dirs) };
      mkdirSync(join(ctx.repoDir, ".loki"), { recursive: true });
      writeFileSync(join(ctx.repoDir, PROJECT_FILE), `${JSON.stringify(model, null, 2)}\n`);
      return { model, cached: false, attempts: attempt };
    }
    errors = v.errors.slice(0, 20);
  }
  return { model: unknownModel("", `discovery answer rejected twice: ${(errors ?? []).slice(0, 3).join("; ")}`), cached: false, attempts: MAX_ATTEMPTS };
}

/** Intake's stage-data fragment: runs discovery (cached by manifest hash) and records its key.
 *  Work surface (L2): any failure yields {} and never blocks intake. LOKI_E10_PROJECT_MODEL=0 turns it off. */
export async function intakeProjectModel(ctx: RunContext, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (process.env["LOKI_E10_PROJECT_MODEL"] === "0") return {};
  try {
    const { model, cached, attempts } = await discoverProjectModel(ctx, signal);
    return { project_model: { status: model.status, key: model.key, cached, attempts, ref: PROJECT_FILE, ...(model.reason ? { reason: model.reason } : {}) } };
  } catch {
    return {};
  }
}
