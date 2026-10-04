// loki-ts/src/project_model/scope.ts -- FC-22a (L4): package-scoped test selection. A changed file can only
// affect tests in its own package and in packages that depend on it, so a test owned by any other package
// is scoped out. The scope applies only when the model is fully known; every doubt keeps the test.
// Fail-safe keeps (nothing dropped): no model, a single package, an unowned changed file, or any package
// whose dependsOn is absent (edges unknown, so it might depend on the changed package).
import { posix } from "node:path";
import type { TestMap, TestRef } from "../engine10/types.ts";
import type { ProjectApi } from "./api.ts";
import { dependentsOf, edgesKnown } from "./graph.ts";
import { isMultiRoot } from "./resolve.ts";

/** Opt-in (default off) until the receipt audit and a live run: without it selection is exactly the unscoped one. */
export const scopeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env["LOKI_E10_SCOPE"] === "1";

const apis = new WeakMap<object, ProjectApi>();
const imports = new WeakMap<object, Record<string, string[]>>();
const dropped = new WeakMap<object, Set<string>>();

/** Binds the model to a test map so impactedRefs can scope without a new parameter on every caller. */
export function attachScope(map: TestMap, api: ProjectApi | null, specs: Record<string, string[]> = {}): void {
  if (api) apis.set(map, api);
  imports.set(map, specs);
}

const stripExt = (p: string): string => p.replace(/\.[cm]?[jt]sx?$/, "");
/** Direct import evidence: a relative specifier in the test resolves to one of the changed files. */
function importsChanged(testPath: string, specs: string[], changed: ReadonlySet<string>): boolean {
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue;
    const base = stripExt(posix.normalize(posix.join(posix.dirname(testPath), spec)));
    if (changed.has(base) || changed.has(`${base}/index`)) return true;
  }
  return false;
}

/** Package roots a change can affect: owners of the changed files plus their dependents. Null means "do not scope". */
export function allowedRoots(api: ProjectApi | null | undefined, changedFiles: readonly string[]): Set<string> | null {
  if (!isMultiRoot(api) || !edgesKnown(api.model) || changedFiles.length === 0) return null;
  const owners = new Set<string>();
  for (const f of changedFiles) {
    const root = api.packageRootOf(f);
    // In a multi-root model the "." package owns everything left over, so it is not real ownership.
    if (root === null || root === ".") return null;
    owners.add(root);
  }
  const roots = [...owners];
  return new Set([...roots, ...dependentsOf(api.model, roots)]);
}

/** Drops tests owned by a package outside the allowed set; unowned tests are kept. Records what it dropped. */
export function scopeRefs(map: TestMap, changedFiles: readonly string[], refs: TestRef[]): TestRef[] {
  if (!scopeEnabled()) return refs;
  const api = apis.get(map);
  const allowed = allowedRoots(api, changedFiles);
  if (!api || !allowed) return refs;
  const kept: TestRef[] = [];
  const changed = new Set(changedFiles.map(stripExt));
  const specs = imports.get(map) ?? {};
  for (const r of refs) {
    const owner = api.packageRootOf(r.path);
    if (owner === null || owner === "." || allowed.has(owner) || importsChanged(r.path, specs[r.path] ?? [], changed)) kept.push(r);
    else {
      const set = dropped.get(map) ?? new Set<string>();
      set.add(r.path);
      dropped.set(map, set);
    }
  }
  return kept;
}

/** Tests scoped out so far on this map, for the verify audit event. */
export function scopedOutOf(map: TestMap): string[] {
  return [...(dropped.get(map) ?? [])].sort();
}
