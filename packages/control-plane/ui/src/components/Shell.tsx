// The frame: sidebar (navigation, repositories, theme), the top bar under 860px, and the drawer scrim. Children are the main pane.
import type { ReactNode } from "react";
import { href } from "../lib/router";
import { TITLES, type View } from "../lib/model";
import type { Theme } from "../lib/data";
import { Icon, Sprite, type IconId } from "./Icon";

const NAV: [View, IconId][] = [["needs", "inbox"], ["running", "run"], ["delivered", "done"], ["all", "all"]];

export function Shell({ view, counts, repos, repo, onRepo, open, navOpen, setNavOpen, onNew, onToggleTheme, theme, children }: {
  view: View; counts: Record<string, number>; repos: string[]; repo: string | null; onRepo: (r: string | null) => void; open: boolean;
  navOpen: boolean; setNavOpen: (b: boolean) => void; onNew: () => void; onToggleTheme: () => void; theme: Theme; children: ReactNode;
}) {
  const link = (v: View, icon: IconId, hot = false) => (
    <a key={v} href={href.view(v)} className={hot && counts[v] ? "hot" : ""} aria-current={view === v ? "page" : undefined} onClick={() => setNavOpen(false)}>
      <Icon id={icon} />{TITLES[v]}{v in counts ? <span className="n">{counts[v]}</span> : null}
    </a>
  );
  return (
    <div className={`app${open ? " open" : ""}${navOpen ? " nav-open" : ""}`}>
      <Sprite />
      <div className="scrim" onClick={() => setNavOpen(false)} />
      <aside className="side" aria-label="Navigation">
        <div className="brand"><span className="mark">L</span>Loki</div>
        <button className="newbtn" onClick={() => { setNavOpen(false); onNew(); }}><Icon id="plus" />New work</button>
        <nav className="nav" aria-label="Views">
          {NAV.map(([v, i]) => link(v, i, v === "needs"))}
          <div className="sec">Repositories</div>
          {repos.length === 0 ? <div className="repo">None seen yet</div> : repos.map((r) => (
            <a key={r} className="repo" href={href.view("all")} aria-current={repo === r ? "true" : undefined} onClick={() => { onRepo(repo === r ? null : r); setNavOpen(false); }}><i />{r}</a>
          ))}
          <div className="sec">Account</div>
          {link("spend", "coin")}
          {link("setup", "gear")}
        </nav>
        <div className="foot"><span>{theme ?? "system"} theme</span><button className="iconbtn" onClick={onToggleTheme} aria-label="Toggle theme"><Icon id="moon" /></button></div>
      </aside>
      <div className="main">
        <div className="top">
          <button className="iconbtn" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Icon id="menu" /></button>
          <span className="mark">L</span><b style={{ fontWeight: 600 }}>{TITLES[view]}</b>
          <button className="iconbtn" style={{ marginLeft: "auto" }} aria-label="New work" onClick={onNew}><Icon id="plus" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
