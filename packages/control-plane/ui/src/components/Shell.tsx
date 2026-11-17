// The frame around every page: the account at the top of the sidebar, then each org with its projects and their repositories.
import { Building2, FolderGit2, GitBranch, Home } from "lucide-react";
import type { ReactNode } from "react";
import type { RunRow, Workspace } from "../api";
import { isWorking, repoOf } from "../lib/format";
import { href, type Route } from "../lib/router";

export function Shell({ ws, runs, route, children }: { ws: Workspace | null; runs: RunRow[]; route: Route; children: ReactNode }) {
  const live = (repo: string): number => runs.filter((r) => repoOf(r) === repo && isWorking(r)).length;
  return (
    <div className="app">
      <aside className="side">
        <a className="brand" href={href.account()}>
          <span className="brand-dot" />
          Loki
        </a>
        <nav className="nav">
          <a className={route.page === "account" ? "on" : ""} href={href.account()}>
            <Home size={16} />
            {ws?.account.name ?? "Account"}
          </a>
        </nav>
        {(ws?.orgs ?? []).map((o) => (
          <nav className="nav" key={o.id}>
            <div className="nav-label">
              <Building2 size={11} style={{ verticalAlign: "-1px", marginRight: 5 }} />
              {o.name}
            </div>
            {o.projects.map((p) => (
              <div key={p.id}>
                <a className={route.page === "project" && route.org === o.id && route.project === p.id ? "on" : ""} href={href.project(o.id, p.id)}>
                  <FolderGit2 size={16} />
                  {p.name}
                  <span className="count">{p.repos.length}</span>
                </a>
                {p.repos.map((r) => (
                  <a key={r} className={`sub ${route.page === "repo" && route.repo === r ? "on" : ""}`} href={href.repo(r)}>
                    <GitBranch size={14} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r}</span>
                    {live(r) ? <span className="count" style={{ color: "var(--accent)" }}>{live(r)} live</span> : null}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        ))}
        {ws && ws.unassigned.length > 0 ? (
          <nav className="nav">
            <div className="nav-label">Not in a project yet</div>
            {ws.unassigned.map((r) => (
              <a key={r} className={`sub ${route.page === "repo" && route.repo === r ? "on" : ""}`} href={href.repo(r)}>
                <GitBranch size={14} />
                {r}
              </a>
            ))}
          </nav>
        ) : null}
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
