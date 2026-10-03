// CPE-POLISH item 5: the theme follows prefers-color-scheme until the viewer toggles; the choice persists in localStorage.
// Each case loads a fresh copy of the theme module (the store reads storage and the media query at import time).
import "./dom";
import { afterEach, expect, test } from "bun:test";

const root = () => document.documentElement;
let n = 0;
function stubSystem(dark: boolean) {
  (globalThis as any).matchMedia = (q: string) => ({ matches: q.includes("dark") ? dark : false, media: q, addEventListener() {}, removeEventListener() {} });
}
const fresh = () => import(`../../ui/src/shell/theme.ts?case=${++n}`) as Promise<typeof import("../../ui/src/shell/theme")>;
const realMatchMedia = (globalThis as any).matchMedia;
afterEach(() => { (globalThis as any).matchMedia = realMatchMedia; localStorage.clear(); root().removeAttribute("data-theme"); root().classList.remove("dark"); });

test("no stored choice: follows a dark system and leaves data-theme off so the CSS media query decides", async () => {
  stubSystem(true);
  const th = await fresh();
  th.applyTheme();
  expect(th.systemTheme()).toBe("dark");
  expect(root().hasAttribute("data-theme")).toBe(false);
  expect(root().classList.contains("dark")).toBe(true);
});

test("no stored choice: a light system gives the light theme", async () => {
  stubSystem(false);
  const th = await fresh();
  th.applyTheme();
  expect(root().classList.contains("dark")).toBe(false);
  expect(root().hasAttribute("data-theme")).toBe(false);
});

test("toggle pins the opposite theme and persists it; a new load restores it over the system preference", async () => {
  stubSystem(true);
  const th = await fresh();
  th.toggleTheme();
  expect(root().getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem("loki-theme")).toBe("light");
  const again = await fresh();
  again.applyTheme();
  expect(root().getAttribute("data-theme")).toBe("light");
  expect(root().classList.contains("dark")).toBe(false);
});

test("unavailable storage never throws and the system default still applies", async () => {
  stubSystem(false);
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try {
    const th = await fresh();
    expect(() => th.toggleTheme()).not.toThrow();
    expect(root().getAttribute("data-theme")).toBe("dark");
  } finally { Object.defineProperty(globalThis, "localStorage", real); }
});
