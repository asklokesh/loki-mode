// loki-ts/src/project_model/graph.ts -- FC-22a: the package dependency graph over the Project Model.
// Edges are the model's own `dependsOn` claims (L0); nothing here reads imports.
import type { ProjectModel } from "./schema.ts";

/** Roots of every package that depends on one of `roots`, directly or transitively. The input
 *  roots are never returned. Cycle-safe. A package with no `dependsOn` (edges unknown) contributes
 *  no edges here; callers decide the fail-safe for unknown edges (see edgesKnown). */
export function dependentsOf(model: ProjectModel, roots: string[]): string[] {
  const pkgs = model.status === "ok" && Array.isArray(model.packages) ? model.packages : [];
  const seen = new Set<string>(roots);
  const out: string[] = [];
  const queue = [...seen];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const p of pkgs) {
      if (seen.has(p.root) || !Array.isArray(p.dependsOn) || !p.dependsOn.includes(cur)) continue;
      seen.add(p.root);
      out.push(p.root);
      queue.push(p.root);
    }
  }
  return out.sort();
}

/** True when every package declares its edges (`dependsOn` present, possibly empty). */
export function edgesKnown(model: ProjectModel): boolean {
  return model.status === "ok" && model.packages.length > 0 && model.packages.every((p) => Array.isArray(p.dependsOn));
}
