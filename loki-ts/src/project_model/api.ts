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
  /** The package's declared dependency roots; null when edges are unknown (field absent). */
  dependsOn(pkg: string): string[] | null;
  /** The model's install command for the package; null when none is known. */
  installFor(pkg: string): ModelCommand | null;
}

const clean = (p: unknown): string => (typeof p === "string" ? posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "") : "");
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
// Every accessor is total: a malformed package (a hand-edited or corrupt model) is skipped, never thrown on.
const wellFormed = (p: unknown): p is ModelPackage => isRec(p) && typeof p.root === "string" && typeof p.name === "string";

export function projectApi(model: ProjectModel): ProjectApi {
  const known = isRec(model) && model.status === "ok";
  const packages = known && Array.isArray(model.packages) ? model.packages.filter(wellFormed) : [];
  const packageOf = (file: string): ModelPackage | null => {
    const f = clean(file);
    if (f === "") return null;
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
    workspaceKind: () => (isRec(model) && typeof model.workspaceKind === "string" ? model.workspaceKind : "unknown"),
    packageRootOf: (file) => packageOf(file)?.root ?? null,
    packageOf,
    relativeToRoot: (file) => {
      const p = packageOf(file);
      return p ? (p.root === "." ? clean(file) : clean(file).slice(p.root.length + 1)) : null;
    },
    commandFor: (pkg, kind) => (packages.find((p) => p.root === clean(pkg) || p.name === pkg) ?? null)?.commands?.[kind] ?? null,
    dependsOn: (pkg) => {
      const d = (packages.find((p) => p.root === clean(pkg) || p.name === pkg) ?? null)?.dependsOn;
      return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : null;
    },
    installFor: (pkg) => {
      const i = (packages.find((p) => p.root === clean(pkg) || p.name === pkg) ?? null)?.install;
      return isRec(i) && typeof i.cmd === "string" ? (i as unknown as ModelCommand) : null;
    },
    hasUI: () => packages.some((p) => isRec(p.ui) && p.ui.present === true),
    uiBoot: () => {
      for (const p of packages) if (isRec(p.ui) && p.ui.present === true && isRec(p.ui.boot)) return { pkg: p, boot: p.ui.boot };
      return null;
    },
  };
}
