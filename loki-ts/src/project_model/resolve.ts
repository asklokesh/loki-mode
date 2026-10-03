// loki-ts/src/project_model/resolve.ts -- FC-01 (L4): the ONE shared resolver every runner invocation
// goes through. A file is owned by a package (the Project Model's answer); a command for that file runs in
// the package's directory with the file path relative to it. A repo whose model is unknown, or whose only
// package is the repo root (the single-package case), resolves to null: callers keep their repo-root
// behavior byte for byte, so nothing changes for a repo that never had the problem.
import { join } from "node:path";
import { loadCached, projectModelEnabled } from "./discover.ts";
import { projectApi, type ProjectApi } from "./api.ts";
import type { ModelPackage } from "./schema.ts";

/** The cached model of repoDir as an API, or null when disabled, absent, unknown or invalid. Never throws. */
export function loadProjectApi(repoDir: string, env: NodeJS.ProcessEnv = process.env): ProjectApi | null {
  if (!projectModelEnabled(env)) return null;
  try {
    const model = loadCached(repoDir);
    const api = model ? projectApi(model) : null;
    return api && api.known() ? api : null;
  } catch {
    return null;
  }
}

/** True only when some package lives below the repo root: the one shape where the root is the wrong cwd. */
export function isMultiRoot(api: ProjectApi | null | undefined): api is ProjectApi {
  return !!api && api.known() && api.packages().some((p) => p.root !== ".");
}

export interface PackageSite {
  pkg: ModelPackage;
  /** Repo-relative package directory (never "."). */
  root: string;
  /** Absolute package directory under `repoDir`. */
  cwd: string;
  /** The queried file made relative to the package root. */
  file: string;
}

/** Where a repo-relative file must be run from: null means "the repo root, as before". */
export function siteFor(api: ProjectApi | null | undefined, repoDir: string, file: string): PackageSite | null {
  if (!isMultiRoot(api)) return null;
  const pkg = api.packageOf(file);
  const rel = api.relativeToRoot(file);
  if (!pkg || pkg.root === "." || rel === null) return null;
  return { pkg, root: pkg.root, cwd: join(repoDir, pkg.root), file: rel };
}

/** Groups repo-relative files by owning package root ("." = repo root or unowned). Order is stable. */
export function groupByPackage(api: ProjectApi | null | undefined, repoDir: string, files: string[]): { root: string; cwd: string; files: string[]; rel: string[] }[] {
  const out = new Map<string, { root: string; cwd: string; files: string[]; rel: string[] }>();
  for (const f of files) {
    const s = siteFor(api, repoDir, f);
    const root = s?.root ?? ".";
    const g = out.get(root) ?? { root, cwd: s?.cwd ?? repoDir, files: [], rel: [] };
    g.files.push(f);
    g.rel.push(s?.file ?? f);
    out.set(root, g);
  }
  return [...out.values()];
}
