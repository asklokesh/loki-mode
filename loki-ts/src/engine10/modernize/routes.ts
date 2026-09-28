// loki-ts/src/engine10/modernize/routes.ts -- M-19: strangler routing state (docs/v10/MODERNIZE.md
// section 8). routes.json maps a unit (Python) or module (Java) id to its current route status.
// Load/save and the switch guard are generic across targets; python3.ts and java21.ts own their
// own status vocabularies and how a status turns into build/test config.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { routesPath } from "./types.ts";
import type { ModernizeLog } from "./log.ts";

export interface RouteEntry {
  status: string;
  proven: boolean; // the wave that set this status is fully proven: switching back is refused
}
export type RouteMap = Record<string, RouteEntry>;

export function loadRoutes(repoDir: string, mid: string): RouteMap {
  const path = routesPath(repoDir, mid);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RouteMap;
  } catch {
    return {}; // torn or corrupt file: treat as no routes yet rather than crash
  }
}

export function saveRoutes(repoDir: string, mid: string, routes: RouteMap): void {
  const path = routesPath(repoDir, mid);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(routes, null, 2));
}

export interface SwitchResult {
  routes: RouteMap;
  ok: boolean;
  reason?: string; // set when ok is false
}

/** Section 8: "Switching back is always allowed until the wave is fully proven." `validStatuses`
 *  gives the target's status order (e.g. python3.PY_ROUTE_STATUSES); once an entry is proven,
 *  only a forward move through that order is allowed. */
export function switchRoute(
  routes: RouteMap, key: string, to: string, validStatuses: readonly string[],
): SwitchResult {
  if (!validStatuses.includes(to)) return { routes, ok: false, reason: `unknown status ${to}` };
  const current = routes[key];
  if (current?.proven) {
    const fromIdx = validStatuses.indexOf(current.status);
    const toIdx = validStatuses.indexOf(to);
    if (toIdx < fromIdx) {
      return { routes, ok: false, reason: `${key} is proven; cannot switch back from ${current.status} to ${to}` };
    }
  }
  return { routes: { ...routes, [key]: { status: to, proven: current?.proven ?? false } }, ok: true };
}

/** Marks the current status of `key` as proven (wave verify/ship, M-20/M-21). No-op if `key`
 *  has no route yet. */
export function markProven(routes: RouteMap, key: string): RouteMap {
  const current = routes[key];
  return current ? { ...routes, [key]: { ...current, proven: true } } : routes;
}

/** Persists a switch and appends `route.switched` (section 8: "Every switch emits route.switched").
 *  Rejected switches (see SwitchResult.ok) are neither persisted nor logged. */
export function applySwitch(
  repoDir: string, mid: string, log: ModernizeLog, routes: RouteMap,
  key: string, to: string, validStatuses: readonly string[],
): SwitchResult {
  const result = switchRoute(routes, key, to, validStatuses);
  if (!result.ok) return result;
  saveRoutes(repoDir, mid, result.routes);
  log.append("route.switched", { key, to, from: routes[key]?.status ?? null });
  return result;
}
