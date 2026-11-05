// The one path predicate for "test, build, lint and type config, and lockfiles": what a run must not edit unless its task asks.
// Used by the config write fence (runner/host_guard.ts hook, util/config_fence.ts restore). The lockfile and manifest lists are the commit filter's own (e10ext/commit_filter.ts), imported, not copied.
import { basename } from "node:path";
import { LOCKFILE, taskWantsLockChange } from "../e10ext/commit_filter.ts";

/** Test, build, lint and type-check config: an edit here is almost always a workaround so the run's own checks can start, not part of the change. */
export const TEST_BUILD_CONFIG = /(^|\/)(?:(?:vitest|vite|jest|webpack|rollup|babel|playwright|eslint)(?:\.[\w-]+)?\.config\.[cm]?[jt]s|jest\.config\.json|tsconfig(?:\.[\w-]+)?\.json|\.eslintrc(?:\.[\w]+)?|\.babelrc|karma\.conf\.[cm]?[jt]s|pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc)$/;
// A config-named file under a test fixture directory is test data (a fixture project), never the run's own config.
const FIXTURE_DIR = /(^|\/)(__fixtures__|fixtures?|testdata)\//;

/** Repo-relative path of a fenced file (config or lockfile), anywhere but node_modules, .loki and test fixture directories. */
export const isFencedPath = (rel: string): boolean => !/(^|\/)(node_modules|\.loki)\//.test(rel) && !FIXTURE_DIR.test(rel) && (TEST_BUILD_CONFIG.test(rel) || LOCKFILE.test(rel));

/** The task names the file (path, basename, or the basename without its extension, so "tsconfig strict" names tsconfig.json) or is a dependency change for a lockfile. */
export function taskNamesFenced(task: string, rel: string): boolean {
  if (!task) return false;
  const t = task.toLowerCase(), bn = basename(rel).toLowerCase(), stem = bn.replace(/\.[^.]*$/, "").replace(/^\./, "");
  if (LOCKFILE.test(rel)) return taskWantsLockChange(task, rel);
  return t.includes(rel.toLowerCase()) || t.includes(bn) || (stem.length >= 5 && new RegExp(`(^|[^\\w])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(t));
}
