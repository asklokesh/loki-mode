// A hash router small enough to read: #/, #/project/<org>/<project>, #/repo/<name>, #/runs/<source>/<run>.
import { useEffect, useState } from "react";

export type Route =
  | { page: "account" }
  | { page: "project"; org: string; project: string }
  | { page: "repo"; repo: string }
  | { page: "run"; source: string; run: string };

export function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (p[0] === "project" && p[1] && p[2]) return { page: "project", org: p[1], project: p[2] };
  if (p[0] === "repo" && p[1]) return { page: "repo", repo: p.slice(1).join("/") };
  if ((p[0] === "run" || p[0] === "runs") && p[1] && p[2]) return { page: "run", source: p[1], run: p[2] }; // "runs" is the link the CLI prints (runPageUrl)
  return { page: "account" };
}

export const href = {
  account: (): string => "#/",
  project: (org: string, project: string): string => `#/project/${encodeURIComponent(org)}/${encodeURIComponent(project)}`,
  repo: (repo: string): string => `#/repo/${encodeURIComponent(repo)}`,
  run: (source: string, run: string): string => `#/runs/${encodeURIComponent(source)}/${encodeURIComponent(run)}`,
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
