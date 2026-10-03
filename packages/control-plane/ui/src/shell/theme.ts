// Theme store: one source of truth for the shell and the Settings page. Sets data-theme (tokens) and the dark class (legacy utilities).
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "loki-theme";
const subs = new Set<() => void>();

const read = (): Theme => { try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; } catch { return "dark"; } };
let current: Theme = read();

export function applyTheme(t: Theme = current): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.setAttribute("data-theme", t);
  root.classList.toggle("dark", t === "dark");
}

export function setTheme(t: Theme): void {
  current = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
  applyTheme(t);
  for (const s of subs) s();
}

export const toggleTheme = (): void => setTheme(current === "dark" ? "light" : "dark");

export function useTheme(): Theme {
  return useSyncExternalStore((l) => { subs.add(l); return () => { subs.delete(l); }; }, () => current, () => "dark");
}
