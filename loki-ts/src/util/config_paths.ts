// The one path predicate for "test, build, lint and type config, and lockfiles": what a run must not edit unless its task asks.
// Shared by the write fence (runner/host_guard.ts, engine10/session.ts restore) and the commit filter's config rule (e10ext/commit_filter.ts, scope-guard lane).
import { basename } from "node:path";
import { taskWantsLockChange } from "../e10ext/commit_filter.ts";

/** Test, build, lint and type-check config: an edit here is almost always a workaround so the run's own checks can start, not part of the change. */
export const TEST_BUILD_CONFIG = /(^|\/)(?:(?:vitest|vite|jest|webpack|rollup|babel|playwright|eslint)(?:\.[\w-]+)?\.config\.[cm]?[jt]s|jest\.config\.json|tsconfig(?:\.[\w-]+)?\.json|\.eslintrc(?:\.[\w]+)?|\.babelrc|karma\.conf\.[cm]?[jt]s|pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc)$/;
export const LOCKFILE_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Cargo\.lock|go\.sum)$/;

/** Repo-relative path of a fenced file (config or lockfile), anywhere but node_modules and .loki. */
export const isFencedPath = (rel: string): boolean => !/(^|\/)(node_modules|\.loki)\//.test(rel) && (TEST_BUILD_CONFIG.test(rel) || LOCKFILE_PATH.test(rel));

/** The task names the file (path, basename, or the basename without its extension, so "tsconfig strict" names tsconfig.json) or is a dependency change for a lockfile. */
export function taskNamesFenced(task: string, rel: string): boolean {
  if (!task) return false;
  const t = task.toLowerCase(), bn = basename(rel).toLowerCase(), stem = bn.replace(/\.[^.]*$/, "").replace(/^\./, "");
  if (LOCKFILE_PATH.test(rel)) return taskWantsLockChange(task, rel);
  return t.includes(rel.toLowerCase()) || t.includes(bn) || (stem.length >= 5 && new RegExp(`(^|[^\\w])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(t));
}
