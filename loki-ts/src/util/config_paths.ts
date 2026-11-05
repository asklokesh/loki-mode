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

// A task that names a setting concept needs the matching config edit even when it never names the file ("enable strict null checks" needs tsconfig.json).
const CONCEPTS: [RegExp, RegExp][] = [
  [/tsconfig/, /\bstrict(?:ness|NullChecks|FunctionTypes|PropertyInitialization)?\b|\bnoImplicit\w*|\bnoUnused\w*|\bnull checks?\b|\bcompilerOptions\b|\bpath aliases\b|\bpath alias\b|\bpaths? mapping|\bmoduleResolution\b|\bcompiler options?\b|\btype[- ]?check(?:ing)? (?:config|setting|option|flag)/i],
  [/(?:vitest|vite|jest|karma|playwright)[\w.-]*(?:config|conf)/, /\bcoverage\b|\bthresholds?\b|\bsetup ?files?\b|\bsetupFiles\b|\btest (?:timeout|environment|setup)\b|\bglobals?\b|\btest alias|\breporters?\b|\bjsdom\b|\bsnapshot (?:serializer|config)/i],
  [/eslint|\.eslintrc/, /\blint(?:ing)? rules?\b|\beslint\b|\brule (?:banning|forbidding|enforcing|that)|\bno-[a-z-]+ rule\b/i],
  [/(?:webpack|rollup|vite|babel)[\w.-]*(?:config)?|\.babelrc/, /\bbundl\w+|\bbabel\b|\bwebpack\b|\brollup\b|\bloaders?\b|\bbuild (?:config|setting|option)|\btranspil\w+|\bpresets?\b/i],
  [/pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc/, /\bcoverage\b|\bfail[-_ ]under\b|\bpytest\b|\bmarkers?\b|\btox\b|\bsetup\.cfg\b|\btest (?:config|setting|option)/i],
];
// A dependency to add, install or upgrade needs its lockfile even when the task gives no version.
const DEP_TASK = /\b(?:add|install|upgrade|bump|update)\b[^.\n]{0,40}\b(?:dependenc\w*|packages?|crates?|librar\w+|modules?|npm|pip|cargo|yarn|pnpm)\b|\b(?:upgrade|bump)\s+[@\w./-]+|\bas an? (?:dev |peer )?dependency\b/i;

/** The task names the file (path, basename, or the basename without its extension, so "tsconfig strict" names tsconfig.json) or is a dependency change for a lockfile. */
export function taskNamesFenced(task: string, rel: string): boolean {
  if (!task) return false;
  const t = task.toLowerCase(), bn = basename(rel).toLowerCase(), stem = bn.replace(/\.[^.]*$/, "").replace(/^\./, "");
  if (LOCKFILE.test(rel)) return taskWantsLockChange(task, rel) || DEP_TASK.test(task);
  if (CONCEPTS.some(([c, w]) => c.test(rel) && w.test(task))) return true;
  return t.includes(rel.toLowerCase()) || t.includes(bn) || (stem.length >= 5 && new RegExp(`(^|[^\\w])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(t));
}
