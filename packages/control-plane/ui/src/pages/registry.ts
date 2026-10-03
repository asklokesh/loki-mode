// Page registry (CPE-02). Later slices register their page here; the shell renders whatever is registered.
// Settings-area pages (inSettings) appear behind the one Settings entry. Nothing is listed unless it has a real component.
import type { ComponentType } from "react";

export type PageParams = Record<string, string>;

export interface PageDef {
  id: string;
  /** Hash path without the leading "#", e.g. "/runs/:source/:run". */
  path: string;
  title: string;
  component: ComponentType<{ params: PageParams }>;
  inSettings?: boolean;
}

const pages = new Map<string, PageDef>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => { version++; for (const l of listeners) l(); };

export function registerPage(p: PageDef): void {
  pages.set(p.id, p);
  emit();
}

export function unregisterPage(id: string): void {
  if (pages.delete(id)) emit();
}

export const listPages = (): PageDef[] => [...pages.values()];
export const settingsPages = (): PageDef[] => listPages().filter((p) => p.inSettings);

export const subscribeRegistry = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const registryVersion = (): number => version;

/** "#/runs/a/b?x=1" and "/runs/a/b" both become "/runs/a/b"; empty becomes "/". */
export function pathOf(hash: string): string {
  const p = hash.replace(/^#/, "").split("?")[0] ?? "";
  const clean = p.replace(/\/+$/, "");
  return clean === "" ? "/" : clean.startsWith("/") ? clean : `/${clean}`;
}

function matchPath(pattern: string, path: string): PageParams | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: PageParams = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg.startsWith(":")) {
      try { params[seg.slice(1)] = decodeURIComponent(b[i]!); } catch { return null; }
    } else if (seg !== b[i]) return null;
  }
  return params;
}

/** Exact segments beat parameter segments, so "/runs/new" would win over "/runs/:source". */
export function matchPage(hash: string): { page: PageDef; params: PageParams } | null {
  const path = pathOf(hash);
  let best: { page: PageDef; params: PageParams; score: number } | null = null;
  for (const page of pages.values()) {
    const params = matchPath(page.path, path);
    if (!params) continue;
    const score = page.path.split("/").filter((s) => s && !s.startsWith(":")).length;
    if (!best || score > best.score) best = { page, params, score };
  }
  return best ? { page: best.page, params: best.params } : null;
}
