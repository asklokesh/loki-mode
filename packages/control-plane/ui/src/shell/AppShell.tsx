// Lean shell (CPE-02): left sidebar (brand, New run, grouped sessions, Settings) plus one router outlet.
// Everything visual is a --cp-* token or a CPE-01 primitive. Pages come from pages/registry.ts.
import { FolderGit2, GitPullRequest, LayoutDashboard, ListChecks, Menu, MessageSquare, Moon, ReceiptText, Settings as Cog, Sun } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Button, Drawer, EmptyState, GroupHead, NavItem } from "../design/primitives";
import { getAskState, useAsk } from "../pages/ask/api";
import { NewRunDialog } from "../pages/compose";
import { openNewRun } from "../pages/compose/store";
import { matchPage, pathOf, registryVersion, settingsPages, subscribeRegistry, type PageDef } from "../pages/registry";
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

const NAV: { href: string; label: string; icon: ReactNode; match: (p: string) => boolean }[] = [
  { href: "#/", label: "Overview", icon: <LayoutDashboard size={14} aria-hidden="true" />, match: (p) => p === "/" || p === "/home" },
  { href: "#/runs", label: "Runs", icon: <ListChecks size={14} aria-hidden="true" />, match: (p) => p === "/runs" || p.startsWith("/runs/") || p.startsWith("/r/") },
  { href: "#/pulls", label: "Pull requests", icon: <GitPullRequest size={14} aria-hidden="true" />, match: (p) => p === "/pulls" },
  { href: "#/repos", label: "Repos", icon: <FolderGit2 size={14} aria-hidden="true" />, match: (p) => p === "/repos" },
  { href: "#/receipts", label: "Receipts", icon: <ReceiptText size={14} aria-hidden="true" />, match: (p) => p.startsWith("/receipts") },
];

/** Past Ask threads. Never a list of runs. Empty and absent when Ask is off. */
export function AskHistory({ activePath, onNavigate }: { activePath: string; onNavigate?: () => void }) {
  const ask = useAsk();
  if (!ask.enabled) return null;
  return (
    <section data-testid="ask-history" aria-label="Ask Loki" style={{ marginTop: 16 }}>
      <GroupHead>Ask Loki</GroupHead>
      <NavItem href="#/ask" active={activePath === "/ask"} icon={<MessageSquare size={14} aria-hidden="true" />} onClick={onNavigate}>New question</NavItem>
      {ask.threads.map((th) => {
        const href = `#/ask/${encodeURIComponent(th.id)}`;
        const active = pathOf(href) === activePath;
        return (
          <a key={th.id} data-testid="ask-thread-link" href={href} title={th.title} aria-current={active ? "page" : undefined} onClick={onNavigate}
            style={{ display: "block", padding: "6px 12px", borderRadius: t("radius-nav"), textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: t("text-md"), color: active ? t("accent") : t("text"), background: active ? t("accent-glow") : "transparent" }}>
            {th.title}
          </a>
        );
      })}
    </section>
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
  const path = pathOf(hash);
  return (
    <>
      <a href="#/" onClick={onNavigate} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px 12px", textDecoration: "none", color: t("text") }}>
        <Mascot active={false} />
        <span style={{ fontFamily: t("font-serif"), fontSize: t("text-2xl") }}>Loki Mode</span>
      </a>
      <div style={{ padding: "0 12px 12px" }}>
        <Button data-testid="sidebar-new-run" style={{ width: "100%" }} onClick={() => { onNavigate?.(); openNewRun(); }}>New run</Button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
        <div data-testid="nav-links">
          {NAV.map((n) => <NavItem key={n.href} href={n.href} active={n.match(path)} icon={n.icon} onClick={onNavigate}>{n.label}</NavItem>)}
        </div>
        <AskHistory activePath={path} onNavigate={onNavigate} />
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
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      // Cmd+K opens Ask Loki when Ask is on; otherwise it opens the command palette. Cmd+/ always opens the palette.
      if (k === "k" && getAskState().enabled) { e.preventDefault(); location.hash = "#/ask"; }
      else if ((k === "k" || k === "/") && openCommandPalette()) e.preventDefault();
    };
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
  return (
    <div data-testid="app-shell" className="flex min-h-screen" style={{ background: t("bg"), color: t("text"), fontFamily: t("font-sans") }}>
      <nav data-testid="nav" aria-label="Main" className="hidden md:flex" style={sidebarStyle}><SidebarBody hash={hash} /></nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 p-2 md:hidden" style={{ borderBottom: `1px solid ${t("border")}` }}>
          <Button variant="ghost" aria-label="Open navigation" data-testid="open-drawer" onClick={() => setDrawer(true)}><Menu size={16} aria-hidden="true" /></Button>
          <span style={{ fontFamily: t("font-serif"), fontSize: t("text-xl") }}>Loki Mode</span>
        </header>
        <main data-testid="outlet" className="min-w-0 flex-1 overflow-x-auto p-3 md:p-6" style={{ maxWidth: "100%" }}><Outlet hash={hash} /></main>
      </div>
      <NewRunDialog />
      <Drawer open={drawer} title="Loki Mode" side="left" onClose={() => setDrawer(false)}>
        <div style={{ display: "flex", flexDirection: "column", minHeight: "80vh" }}><SidebarBody hash={hash} onNavigate={() => setDrawer(false)} /></div>
      </Drawer>
    </div>
  );
}
