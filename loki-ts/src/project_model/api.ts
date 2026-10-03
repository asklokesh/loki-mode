// loki-ts/src/project_model/api.ts -- EL-W1-01 (L4): the typed read API over a ProjectModel.
// Pure lookups over what the model answered; no repo-shape knowledge lives here. An "unknown"
// model answers null / false everywhere, so a consumer must fall back honestly, never guess.
import { posix } from "node:path";
import type { CommandKind, ModelCommand, ModelPackage, ProjectModel } from "./schema.ts";

export interface ProjectApi {
  readonly model: ProjectModel;
  known(): boolean;
  packages(): ModelPackage[];
  workspaceKind(): string;
  /** The package whose root is the nearest ancestor of a repo-relative file; null when none. */
  packageRootOf(file: string): string | null;
  packageOf(file: string): ModelPackage | null;
  /** `file` made relative to its package root (what a runner invoked in that root expects). */
  relativeToRoot(file: string): string | null;
  /** A package by root or name, and its command of a kind (null when the repo defines none). */
  commandFor(pkg: string, kind: CommandKind): ModelCommand | null;
  hasUI(): boolean;
  uiBoot(): { pkg: ModelPackage; boot: ModelCommand } | null;
}

const clean = (p: string): string => posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");

export function projectApi(model: ProjectModel): ProjectApi {
  const known = model.status === "ok";
  const packages = known ? model.packages : [];
  const packageOf = (file: string): ModelPackage | null => {
    const f = clean(file);
    let best: ModelPackage | null = null;
    for (const p of packages) {
      const hit = p.root === "." || f === p.root || f.startsWith(`${p.root}/`);
      if (hit && (best === null || (p.root !== "." && (best.root === "." || p.root.length > best.root.length)))) best = p;
    }
    return best;
  };
  return {
    model,
    known: () => known,
    packages: () => packages,
    workspaceKind: () => model.workspaceKind,
    packageRootOf: (file) => packageOf(file)?.root ?? null,
    packageOf,
    relativeToRoot: (file) => {
      const p = packageOf(file);
      return p ? (p.root === "." ? clean(file) : clean(file).slice(p.root.length + 1)) : null;
    },
    commandFor: (pkg, kind) => (packages.find((p) => p.root === clean(pkg) || p.name === pkg) ?? null)?.commands[kind] ?? null,
    hasUI: () => packages.some((p) => p.ui.present),
    uiBoot: () => {
      for (const p of packages) if (p.ui.present && p.ui.boot) return { pkg: p, boot: p.ui.boot };
      return null;
    },
  };
}
