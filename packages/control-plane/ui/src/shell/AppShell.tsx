// Lean shell (CPE-02): left sidebar (brand, New run, grouped sessions, Settings) plus one router outlet.
// Everything visual is a --cp-* token or a CPE-01 primitive. Pages come from pages/registry.ts.
import { Menu, Moon, Settings as Cog, Sun } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { listRuns, watchRuns, type RunRow } from "../api";
import { Button, Drawer, EmptyState, GroupHead, NavItem, Spinner, StatusDot, VerdictBadge, VERDICT, effectiveVerdict, type DotState } from "../design/primitives";
import { matchPage, pathOf, registryVersion, settingsPages, subscribeRegistry, type PageDef } from "../pages/registry";
import { groupRuns } from "./grouping";
import { openCommandPalette } from "./hooks";
import { Mascot } from "./Mascot";
import { applyTheme, toggleTheme, useTheme } from "./theme";

const t = (n: string) => `var(--cp-${n})`;

function useHash(): string {
  const [hash, setHash] = useState(globalThis.location?.hash ?? "");
  useEffect(() => {
    const f = () => setHash(location.hash);
    f();
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return hash;
}

/** Runs for the sidebar: GET /v1/runs once, then again on every runs-list SSE event. */
export function useSessions(): { runs: RunRow[] | null; error: string | null } {
  const [s, set] = useState<{ runs: RunRow[] | null; error: string | null }>({ runs: null, error: null });
  const load = useCallback(() => {
    listRuns({}).then((r) => set({ runs: r.runs, error: null }), (e: Error) => set((p) => ({ runs: p.runs, error: e.message })));
  }, []);
  useEffect(() => {
    load();
    return watchRuns(load);
  }, [load]);
  return s;
}

const dotState = (r: RunRow): DotState => (r.status === "running" || (!r.verdict && !r.ended_at) ? "active" : r.verdict === VERDICT.FAILED || effectiveVerdict(r) === VERDICT.TAMPERED ? "error" : "idle");
export const sessionTitle = (r: RunRow): string => r.title ?? r.issue_ref ?? r.run_id;
const BADGE_CLIP: CSSProperties = { display: "block", flex: "0 1 auto", minWidth: 0, maxWidth: "46%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const sessionHref = (r: RunRow) => `#/runs/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`;

function SessionRow({ run, active, onNavigate }: { run: RunRow; active: boolean; onNavigate?: () => void }) {
  const style: CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: t("radius-nav"), textDecoration: "none",
    color: active ? t("accent") : t("text"), background: active ? t("accent-glow") : "transparent", fontSize: t("text-md"),
  };
  return (
    <a data-testid="session-row" href={sessionHref(run)} aria-current={active ? "page" : undefined} onClick={onNavigate} style={style}>
      <StatusDot state={dotState(run)} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span title={sessionTitle(run)} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionTitle(run)}</span>
        {run.origin_repo || (run.title && run.issue_ref) ? <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: t("text-sm"), color: t("text-muted") }}>{[run.origin_repo, run.title ? run.issue_ref : null].filter(Boolean).join(" \u00b7 ")}</span> : null}
      </span>
      {run.verdict ? <VerdictBadge run={run} style={BADGE_CLIP} /> : null}
    </a>
  );
}

export function SessionList({ runs, error, now, activeHash, onNavigate }: { runs: RunRow[] | null; error: string | null; now: number; activeHash: string; onNavigate?: () => void }) {
  if (!runs) return error ? <p role="alert" style={{ padding: "0 12px", color: t("error"), fontSize: t("text-sm") }}>Could not load sessions: {error}</p> : <div style={{ padding: 12 }}><Spinner label="Loading sessions" /></div>;
  if (runs.length === 0) return <p data-testid="sessions-empty" style={{ padding: "0 12px", color: t("text-muted"), fontSize: t("text-sm") }}>No sessions yet.</p>;
  const path = pathOf(activeHash);
  return (
    <div data-testid="session-list">
      {groupRuns(runs, now).map((g) => (
        <section key={g.name} aria-label={g.name} style={{ marginBottom: 12 }}>
          <GroupHead>{g.name}</GroupHead>
          {g.runs.map((r) => <SessionRow key={`${r.source_id}/${r.run_id}`} run={r} active={pathOf(sessionHref(r)) === path} onNavigate={onNavigate} />)}
        </section>
      ))}
    </div>
  );
}

/** Light/dark toggle; the choice is persisted (theme.ts). Until chosen, the theme follows the system. */
function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" data-testid="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${next} theme`}
      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", marginTop: 2, border: 0, borderRadius: t("radius-nav"), background: "transparent", color: t("text-2"), cursor: "pointer", fontSize: t("text-md"), fontFamily: "inherit" }}>
      {theme === "dark" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
      {theme === "dark" ? "Light theme" : "Dark theme"}
    </button>
  );
}

function SidebarBody({ hash, onNavigate }: { hash: string; onNavigate?: () => void }) {
  const { runs, error } = useSessions();
  const path = pathOf(hash);
  return (
    <>
      <a href="#/" onClick={onNavigate} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px 12px", textDecoration: "none", color: t("text") }}>
        <Mascot active={Boolean(runs?.some((r) => r.status === "running"))} />
        <span style={{ fontFamily: t("font-serif"), fontSize: t("text-2xl") }}>Loki Mode</span>
      </a>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
        <SessionList runs={runs} error={error} now={Date.now()} activeHash={hash} onNavigate={onNavigate} />
      </div>
      <div style={{ padding: 8, borderTop: `1px solid ${t("border")}` }}>
        <NavItem href="#/settings" active={path.startsWith("/settings")} icon={<Cog size={14} aria-hidden="true" />} onClick={onNavigate}>Settings</NavItem>
        <ThemeToggle />
      </div>
    </>
  );
}

const sidebarStyle: CSSProperties = {
  width: t("sidebar-w"), flexShrink: 0, flexDirection: "column", height: "100vh", position: "sticky", top: 0, paddingTop: 16,
  background: t("glass"), borderRight: `1px solid ${t("glass-border")}`, boxShadow: t("glass-shadow"),
};

/** Settings area: the registered inSettings pages behind the one Settings entry. */
function SettingsArea({ path }: { path: string }) {
  const list = settingsPages();
  if (list.length === 0) return <EmptyState title="No settings available" />;
  const current = list.find((p) => pathOf(p.path) === path) ?? list[0]!;
  const View = current.component;
  return (
    <div data-testid="settings-area" style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
      <nav aria-label="Settings" data-testid="settings-nav" style={{ width: 200, flexShrink: 0 }}>
        <h1 style={{ fontFamily: t("font-serif"), fontWeight: 400, fontSize: t("text-2xl"), margin: "0 0 12px 12px" }}>Settings</h1>
        {list.map((p: PageDef) => <NavItem key={p.id} href={`#${p.path}`} active={p.id === current.id}>{p.title}</NavItem>)}
      </nav>
      <div style={{ flex: 1, minWidth: 0 }}><View params={{}} /></div>
    </div>
  );
}

function Outlet({ hash }: { hash: string }) {
  useSyncExternalStore(subscribeRegistry, registryVersion, registryVersion);
  const path = pathOf(hash);
  if (path === "/settings" || path.startsWith("/settings/")) return <SettingsArea path={path} />;
  const m = matchPage(hash);
  if (!m) return <EmptyState title="Page not found" hint={<a href="#/" style={{ color: t("accent") }}>Back to home</a>} />;
  const View = m.page.component;
  return <View params={m.params} />;
}

export function AppShell() {
  const hash = useHash();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { applyTheme(); }, []);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && openCommandPalette()) e.preventDefault();
    };
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
  return (
    <div data-testid="app-shell" className="flex min-h-screen" style={{ background: t("bg"), color: t("text"), fontFamily: t("font-sans") }}>
      <nav data-testid="nav" aria-label="Sessions" className="hidden md:flex" style={sidebarStyle}><SidebarBody hash={hash} /></nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 p-2 md:hidden" style={{ borderBottom: `1px solid ${t("border")}` }}>
          <Button variant="ghost" aria-label="Open sessions" data-testid="open-drawer" onClick={() => setDrawer(true)}><Menu size={16} aria-hidden="true" /></Button>
          <span style={{ fontFamily: t("font-serif"), fontSize: t("text-xl") }}>Loki Mode</span>
        </header>
        <main data-testid="outlet" className="min-w-0 flex-1 overflow-x-auto p-3 md:p-6" style={{ maxWidth: "100%" }}><Outlet hash={hash} /></main>
      </div>
      <Drawer open={drawer} title="Loki Mode" side="left" onClose={() => setDrawer(false)}>
        <div style={{ display: "flex", flexDirection: "column", minHeight: "80vh" }}><SidebarBody hash={hash} onNavigate={() => setDrawer(false)} /></div>
      </Drawer>
    </div>
  );
}
