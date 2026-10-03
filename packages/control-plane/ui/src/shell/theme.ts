// Theme store: one source of truth for the shell and the Settings page. Sets data-theme (tokens) and the dark class (legacy utilities).
// Default follows the system (prefers-color-scheme); an explicit choice from the toggle is persisted in localStorage and wins.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "loki-theme";
const subs = new Set<() => void>();

const stored = (): Theme | null => { try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null; } catch { return null; } };
const mq = (): MediaQueryList | null => { try { return typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-color-scheme: dark)") : null; } catch { return null; } };
/** The system preference; dark when the platform cannot say (the pre-existing default). */
export const systemTheme = (): Theme => { const m = mq(); return m ? (m.matches ? "dark" : "light") : "dark"; };

let explicit: Theme | null = stored();
let current: Theme = explicit ?? systemTheme();

export function applyTheme(t: Theme = current): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  // With no explicit choice the attribute is left off so the CSS prefers-color-scheme rules decide; a choice pins it.
  if (explicit) root.setAttribute("data-theme", t); else root.removeAttribute("data-theme");
  root.classList.toggle("dark", t === "dark");
}

export function setTheme(t: Theme): void {
  current = t;
  explicit = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
  applyTheme(t);
  for (const s of subs) s();
}

export const toggleTheme = (): void => setTheme(current === "dark" ? "light" : "dark");

// Follow the system while the viewer has not chosen.
mq()?.addEventListener?.("change", () => {
  if (explicit) return;
  current = systemTheme();
  applyTheme();
  for (const s of subs) s();
});

export function useTheme(): Theme {
  return useSyncExternalStore((l) => { subs.add(l); return () => { subs.delete(l); }; }, () => current, () => "dark");
}
