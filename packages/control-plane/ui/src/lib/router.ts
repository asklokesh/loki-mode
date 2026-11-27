// Hash routes: #needs #running #delivered #all #spend #setup and #run/<source>/<run>. #runs/<source>/<run> is the link the CLI prints (runPageUrl).
import { useEffect, useState } from "react";
import type { View } from "./model";

export type Route = { view: View; run: { source: string; run: string } | null };
const VIEW_SET = new Set<string>(["needs", "running", "delivered", "all", "spend", "setup"]);

export function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if ((p[0] === "run" || p[0] === "runs") && p[1] && p[2]) return { view: "all", run: { source: p[1], run: p[2] } };
  return { view: VIEW_SET.has(p[0] ?? "") ? (p[0] as View) : "needs", run: null };
}
export const href = {
  view: (v: View): string => `#${v}`,
  run: (source: string, run: string): string => `#run/${encodeURIComponent(source)}/${encodeURIComponent(run)}`,
};
export function useRoute(): Route {
  const [r, set] = useState<Route>(() => parse(location.hash));
  useEffect(() => {
    const on = (): void => set(parse(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return r;
}
