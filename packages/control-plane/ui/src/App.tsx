// The whole UI: load the runs once, pick the pane from the address, draw it inside the shell.
import { useEffect, useMemo, useState } from "react";
import { Shell } from "./components/Shell";
import { WorkList } from "./components/WorkList";
import { WorkDetail } from "./components/WorkDetail";
import { NewWork } from "./components/NewWork";
import { Spend } from "./components/Spend";
import { Defaults } from "./components/Defaults";
import { repoList, startableRepos, useData, useSeen, useTheme } from "./lib/data";
import { bucket, repoName, runKey, TITLES, VIEWS, type View } from "./lib/model";
import { href, useRoute } from "./lib/router";

const PAGE = 100;
type ListView = "needs" | "running" | "delivered" | "all";
const isListView = (v: View): v is ListView => v in VIEWS;

export function App() {
  const d = useData();
  const route = useRoute();
  const [seen, markSeen] = useSeen();
  const [theme, toggleTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [last, setLast] = useState<ListView>(() => (route.run ? "all" : isListView(route.view) ? route.view : "needs")); // the list a run was opened from, for the back link
  useEffect(() => { if (!route.run && isListView(route.view)) setLast(route.view); setShown(PAGE); setNavOpen(false); }, [route.view, route.run, repo]);
  useEffect(() => {
    const on = (e: KeyboardEvent): void => { if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) { e.preventDefault(); setNewOpen(true); } };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  const inRepo = (r: { origin_repo: string | null; issue_ref: string | null }): boolean => !repo || repoName(r) === repo || repoName(r).endsWith(`/${repo}`);
  const scoped = useMemo(() => d.runs.filter(inRepo), [d.runs, repo]); // eslint-disable-line react-hooks/exhaustive-deps
  const bucketed = useMemo(() => scoped.map((r) => ({ r, b: bucket(r, d.blocked, seen) })), [scoped, d.blocked, seen]);
  const counts = useMemo(() => ({
    needs: bucketed.filter((x) => x.b === "needs").length, running: bucketed.filter((x) => x.b === "running").length,
    delivered: bucketed.filter((x) => x.b === "delivered").length, all: bucketed.length,
  }), [bucketed]);
  const repos = useMemo(() => repoList(d.repos, d.runs), [d.repos, d.runs]);
  const startable = useMemo(() => startableRepos(d.repos, d.runs), [d.repos, d.runs]);

  const view = route.view;
  const listView: ListView = route.run || !isListView(view) ? last : view;
  const rows = bucketed.filter((x) => listView === "all" || x.b === listView).map((x) => x.r);
  const sel = route.run ? `${route.run.source}/${route.run.run}` : null;
  const selRow = sel ? d.runs.find((r) => runKey(r) === sel) ?? null : null;
  const isPage = view === "spend" || view === "setup";
  const [title, sub] = VIEWS[listView];

  let main;
  if (d.error && d.runs.length === 0) main = <div className="body"><div className="err" style={{ gridColumn: "1/-1" }}>{d.error}</div></div>;
  else if (view === "spend") main = <div className="body"><Spend runs={d.runs} tick={d.tick} /></div>;
  else if (view === "setup") main = <div className="body"><Defaults repos={repos} /></div>;
  else main = (
    <div className="body" id="body">
      <WorkList title={title} sub={d.loading ? "Loading" : sub} rows={rows.slice(0, shown)} selected={sel} filter={repo} onClearFilter={() => setRepo(null)}
        empty={d.loading ? "Loading" : listView === "needs" ? "Nothing waiting on you. New work starts from the button on the left." : "Nothing here yet."} more={Math.max(0, rows.length - shown)} onMore={() => setShown((n) => n + PAGE)} />
      {route.run
        ? <WorkDetail row={selRow} source={route.run.source} run={route.run.run} tick={d.tick} bucket={selRow ? bucket(selRow, d.blocked, seen) : null} onDismiss={markSeen}
            onGone={() => { location.hash = href.view(last); d.reload(); }} onBack={() => { location.hash = href.view(last); }} backLabel={TITLES[last]} backHref={href.view(last)} />
        : <section className="detail" aria-live="polite"><div className="empty" style={{ paddingTop: 120 }}>Pick a piece of work to see what it promised and what it proved.</div></section>}
    </div>
  );

  return (
    <Shell view={isPage ? view : listView} counts={counts} repos={repos} repo={repo} onRepo={setRepo} open={!!route.run && !isPage} navOpen={navOpen} setNavOpen={setNavOpen} onNew={() => setNewOpen(true)} onToggleTheme={toggleTheme} theme={theme}>
      {main}
      <NewWork open={newOpen} onClose={() => setNewOpen(false)} repos={startable} defaultRepo={repo} onStarted={d.reload} />
    </Shell>
  );
}
