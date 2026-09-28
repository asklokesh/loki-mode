// loki-ts/src/engine10/modernize/targets/python3.ts -- M-19: Python 2 to 3 strangler target
// (docs/v10/MODERNIZE.md section 8). Route status is py2/dual/py3 per unit; the generated
// tox.ini envs run the suite on each interpreter a unit currently claims.
import type { RouteMap } from "../routes.ts";

export const PY_ROUTE_STATUSES = ["py2", "dual", "py3"] as const;
export type PyRouteStatus = (typeof PY_ROUTE_STATUSES)[number];

const ENVS_FOR_STATUS: Record<PyRouteStatus, readonly string[]> = {
  py2: ["py27"],
  dual: ["py27", "py3"],
  py3: ["py3"],
};

/** The tox envs a unit's current route claims to run clean on. No route yet defaults to py2
 *  (nothing has moved off the old interpreter). */
export function envsForUnit(routes: RouteMap, unitId: string): readonly string[] {
  const status = routes[unitId]?.status as PyRouteStatus | undefined;
  return ENVS_FOR_STATUS[status ?? "py2"];
}

/** Generates a tox.ini body: one envlist entry per env any unit currently claims, and one
 *  testenv section per env listing the units that run under it. */
export function generateToxIni(routes: RouteMap, unitIds: readonly string[]): string {
  const unitsByEnv = new Map<string, string[]>();
  for (const id of unitIds) {
    for (const env of envsForUnit(routes, id)) {
      const list = unitsByEnv.get(env) ?? [];
      list.push(id);
      unitsByEnv.set(env, list);
    }
  }
  const envlist = [...unitsByEnv.keys()].sort();
  const sections = envlist.map((env) => {
    const units = (unitsByEnv.get(env) ?? []).sort().join(", ");
    return `[testenv:${env}]\n# units: ${units}\ncommands = pytest`;
  });
  return [`[tox]`, `envlist = ${envlist.join(", ")}`, ...sections].join("\n\n") + "\n";
}
