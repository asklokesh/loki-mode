// CPE-19: workspace data derived from GET /v1/config and GET /v1/runs. Anything not measured reads null, never a fake zero.
import type { RunRow } from "../../api";

export interface WsRepo { repo?: string; path?: string; setup?: string; after?: string[] }
export interface WsDef { repos?: WsRepo[]; integration?: { command?: string; timeout_s?: number } }
export interface RepoView { name: string; path: string | null; after: string[]; shell: boolean; latest: RunRow | null; runs: number }
export interface WsView { name: string; repos: RepoView[]; shell: boolean; integrationShell: boolean; status: { verified: number; failed: number; running: number; total: number } | null }

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const base = (s: string) => s.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? s;

/** Workspaces of loki.yaml; tolerant of malformed input (the server already validates). */
export function parseWorkspaces(config: unknown): Array<{ name: string; def: WsDef }> {
  const ws = obj(config) && obj(config.workspaces) ? config.workspaces : {};
  return Object.entries(ws).map(([name, d]) => ({ name, def: (obj(d) ? d : {}) as WsDef }));
}

const matches = (r: WsRepo, run: RunRow): boolean => {
  const o = run.origin_repo;
  if (!o) return false;
  if (r.repo && (o === r.repo || o.endsWith(`/${r.repo}`) || base(o) === base(r.repo))) return true;
  return !!r.path && base(o) === base(r.path);
};

const t = (r: RunRow) => r.started_at ?? "";

export function buildViews(config: unknown, runs: RunRow[]): WsView[] {
  return parseWorkspaces(config).map(({ name, def }) => {
    const repos = (Array.isArray(def.repos) ? def.repos : []).map((r): RepoView => {
      const hits = runs.filter((x) => matches(r, x)).sort((a, b) => t(b).localeCompare(t(a)));
      return { name: r.repo ?? (r.path ? base(r.path) : "unnamed"), path: r.path ?? null, after: Array.isArray(r.after) ? r.after : [], shell: typeof r.setup === "string", latest: hits[0] ?? null, runs: hits.length };
    });
    const measured = repos.filter((r) => r.latest);
    const status = repos.length && measured.length === repos.length
      ? {
          total: repos.length,
          verified: measured.filter((r) => r.latest!.verdict === "VERIFIED").length,
          failed: measured.filter((r) => r.latest!.verdict !== null && r.latest!.verdict !== "VERIFIED").length,
          running: measured.filter((r) => r.latest!.verdict === null).length,
        }
      : null;
    const integrationShell = !!def.integration && typeof def.integration.command === "string";
    return { name, repos, shell: integrationShell || repos.some((r) => r.shell), integrationShell, status };
  });
}
