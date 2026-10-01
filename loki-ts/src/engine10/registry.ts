// E-32: literal lazy imports, so bun build bundles every module and dist/loki.js (the npm
// package ships no src) can load them. Keys are the specifiers callers use, relative to this
// dir. A slice adding a module adds one line (registry.test.ts).
type Mod = Record<string, unknown>;
export const REGISTRY: Readonly<Record<string, () => Promise<Mod>>> = {
  "./stages/intake.ts": () => import("./stages/intake.ts"),
  "./stages/plan.ts": () => import("./stages/plan.ts"),
  "./stages/wall.ts": () => import("./stages/wall.ts"),
  "./stages/implement.ts": () => import("./stages/implement.ts"),
  "./stages/verify.ts": () => import("./stages/verify.ts"),
  "./stages/commit.ts": () => import("./stages/commit.ts"),
  "./stages/fix.ts": () => import("./stages/fix.ts"),
  "./stages/seal.ts": () => import("./stages/seal.ts"),
  "./stages/pr.ts": () => import("./stages/pr.ts"),
  "./stages/deep.ts": () => import("./stages/deep.ts"),
  "./status.ts": () => import("./status.ts"),
  "./verify_cmd.ts": () => import("./verify_cmd.ts"),
  "./keys_cmd.ts": () => import("./keys_cmd.ts"),
  "./dashboard/server.ts": () => import("./dashboard/server.ts"),
  "./modernize/cli.ts": () => import("./modernize/cli.ts"),
  "./worker.ts": () => import("./worker.ts"),
  "./session.ts": () => import("./session.ts"),
  "./supervisor.ts": () => import("./supervisor.ts"),
  "./eta.ts": () => import("./eta.ts"),
  "../e10ext/ship_hook.ts": () => import("../e10ext/ship_hook.ts"),
};
/** An unregistered specifier rejects like a missing file, so "not built yet" still works. */
export function registryLoader(spec: string): Promise<Mod> {
  const hit = REGISTRY[spec];
  if (hit) return hit();
  return Promise.reject(Object.assign(new Error(`Cannot find module '${spec}'`), { code: "ERR_MODULE_NOT_FOUND" }));
}
