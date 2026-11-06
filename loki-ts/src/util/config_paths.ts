// The one path predicate for "test, build, lint and type config, and lockfiles": what a run must not edit unless its task asks.
// Used by the config write fence (runner/host_guard.ts hook, util/config_fence.ts restore). The lockfile and manifest lists are the commit filter's own (e10ext/commit_filter.ts), imported, not copied.
import { basename } from "node:path";
import { LOCKFILE, taskWantsLockChange } from "../e10ext/commit_filter.ts";
import { escapeRegex } from "./regex_escape.ts";

/** Test, build, lint and type-check config: an edit here is almost always a workaround so the run's own checks can start, not part of the change. */
export const TEST_BUILD_CONFIG = /(^|\/)(?:(?:vitest|vite|jest|webpack|rollup|babel|playwright|eslint)(?:\.[\w-]+)?\.config\.[cm]?[jt]s|jest\.config\.json|tsconfig(?:\.[\w-]+)?\.json|\.eslintrc(?:\.[\w]+)?|\.babelrc|karma\.conf\.[cm]?[jt]s|pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc)$/;
// A config-named file under a test fixture directory is test data (a fixture project), never the run's own config.
const FIXTURE_DIR = /(^|\/)(__fixtures__|fixtures?|testdata)\//;

/** Repo-relative path of a fenced file (config or lockfile), anywhere but node_modules, .loki and test fixture directories. */
export const isFencedPath = (rel: string): boolean => !/(^|\/)(node_modules|\.loki)\//.test(rel) && !FIXTURE_DIR.test(rel) && (TEST_BUILD_CONFIG.test(rel) || LOCKFILE.test(rel));

// A task that asks to change a setting needs the matching config edit even when it never names the file ("enable strict null checks" needs tsconfig.json).
// An action verb plus a setting phrase, in one sentence: a bare word ("pytest", "eslint", "coverage", "strict") never unlocks a file.
const VERB = "(?:enable|disable|turn(?: \\w+)? (?:on|off)|set(?: up)?|raise|lower|increase|decrease|configure|add|require|enforce|tighten|relax|change|tweak|switch on|switch off)";
// A code-object noun right after the phrase ("a reporter class", "a build config parser", "a settings page") means the task writes code, not config. Not "type", "types" or "tests": "noImplicitAny types" is config.
const CODE_NOUN = "(?:class(?:es)?|parser|parsers|module|modules|function|functions|helper|helpers|component|components|service|services|reader|readers|writer|writers|generator|handler|handlers|interface|script|scripts|loader class|wrapper|util|utility|utilities|page|pages|panel|panels|endpoint|endpoints|variables?|upload\\w*|dashboard|routes?|views?|screen|form|ui)";
const asks = (phrase: string): RegExp => new RegExp(`\\b${VERB}\\b[^.\\n]{0,50}?\\b(?:${phrase})(?![\\w-])(?!\\s+${CODE_NOUN}\\b)`, "i");
const CONCEPTS: [RegExp, RegExp][] = [
  [/tsconfig/, asks("strict(?: mode|NullChecks|FunctionTypes|PropertyInitialization)|strict null checks?|strict type[- ]check(?:ing|s)?|strict function types?|strict property initiali[sz]ation|strict bind[- ]call[- ]apply|strictness flag|noImplicit\\w+|noUnused\\w+|path aliases|path alias|compilerOptions|compiler options?|moduleResolution")],
  [/(?:vitest|vite|jest|karma|playwright)[\w.-]*(?:config|conf)/, asks("coverage thresholds?|coverage (?:config|settings?)|setup files?|setupFiles|test environment|(?:test|coverage|vitest|jest|junit) reporters?|reporters? (?:config\\w*|options?|settings?)")],
  [/eslint|\.eslintrc/, asks("lint(?:ing)? rules?|eslint rules?|eslint config\\w*|rule banning|rule forbidding|rule enforcing")],
  [/(?:webpack|rollup|vite|babel)[\w.-]*(?:config)?|\.babelrc/, asks("(?:babel|webpack|rollup|vite) (?:presets?|plugins?|loaders?|config\\w*)|build (?:config\\w*|settings?|options?)")],
  [/pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc/, asks("coverage thresholds?|coverage fail[-_ ]under|fail[-_ ]under|pytest markers?|pytest (?:config\\w*|settings?|options?)|tox (?:env\\w*|config\\w*)")],
];
// A named dependency to add, install, upgrade, bump or pin needs its lockfile even when the task gives no version. "Add the user module" is not a dependency.
const DEP_TASK = /\b(?:add|install)\s+(?:the\s+)?[@\w./-]+\s+(?:crate|npm package|python package|package|library|as an? (?:dev |peer )?dependency|to (?:the )?(?:dev )?dependenc)|\b(?:add|install)\b[^.\n]{0,40}\bas an? (?:dev |peer )?dependency\b|\b(?:add|install|upgrade|bump|pin)\s+(?:the\s+)?(?:dependency|package|crate|library)\s+[@\w./-]+|\b(?:upgrade|bump|pin)\s+(?:the\s+)?[@\w./-]+\s+(?:to\b|from\b|at\b|dependency\b|package\b|crate\b|library\b|version\b|v?\d)|\b(?:upgrade|bump|pin)\s+[@\w./-]+\s*(?:[.,;]|$)/i;
// A config-named file that does not exist yet under a test directory is test scaffolding the run creates: never denied and never deleted.
export const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//;

/** The task names the file (path, basename, or the basename without its extension, so "tsconfig strict" names tsconfig.json) or is a dependency change for a lockfile. */
export function taskNamesFenced(task: string, rel: string): boolean {
  if (!task) return false;
  const t = task.toLowerCase(), bn = basename(rel).toLowerCase(), stem = bn.replace(/\.[^.]*$/, "").replace(/^\./, "");
  if (LOCKFILE.test(rel)) return taskWantsLockChange(task, rel) || DEP_TASK.test(task);
  if (CONCEPTS.some(([c, w]) => c.test(rel) && w.test(task))) return true;
  return t.includes(rel.toLowerCase()) || t.includes(bn) || (stem.length >= 5 && /conf/i.test(stem) && new RegExp(`(^|[^\\w])${escapeRegex(stem)}([^\\w]|$)`).test(t));
}
