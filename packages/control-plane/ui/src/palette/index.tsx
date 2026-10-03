// Command palette (CPE-22). Cmd+K opens it through the CPE-02 hook; it also owns the global shortcuts:
//   Cmd+Enter       dispatches COMPOSER_SUBMIT_EVENT on window (CPE-08's composer listens and submits)
//   Cmd+N           opens a new run (#/new)
//   Cmd+Shift+D     toggles the theme
//   Esc             closes the palette
// ARIA: combobox input controlling a listbox, aria-activedescendant tracks the highlighted option.
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listRuns, type RunRow } from "../api";
import { Kbd } from "../design/primitives";
import { listPages, registryVersion, subscribeRegistry } from "../pages/registry";
import { setCommandPaletteHandler } from "../shell/hooks";
import { toggleTheme } from "../shell/theme";
import { COMPOSER_SUBMIT_EVENT, actionItems, pageItems, runItems, search, type PaletteItem } from "./items";

export { COMPOSER_SUBMIT_EVENT } from "./items";

const t = (n: string) => `var(--cp-${n})`;
const goto = (path: string) => { location.hash = `#${path}`; };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const regVersion = useSyncExternalStore(subscribeRegistry, registryVersion, registryVersion);

  const close = () => { setOpen(false); setQuery(""); setActive(0); };

  useEffect(() => {
    setCommandPaletteHandler(() => setOpen((o) => !o));
    return () => setCommandPaletteHandler(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setRunsError(null);
    listRuns().then((r) => { if (live) setRuns(r.runs); }, (e: Error) => { if (live) setRunsError(e.message); });
    queueMicrotask(() => input.current?.focus());
    return () => { live = false; };
  }, [open]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (e.key === "Escape" && open) { e.preventDefault(); close(); }
      else if (mod && e.key === "Enter") { e.preventDefault(); window.dispatchEvent(new CustomEvent(COMPOSER_SUBMIT_EVENT)); if (open) close(); }
      else if (mod && !e.shiftKey && k === "n") { e.preventDefault(); goto("/new"); if (open) close(); }
      else if (mod && e.shiftKey && k === "d") { e.preventDefault(); toggleTheme(); }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [open]);

  const items = useMemo(
    () => search(query, pageItems(listPages()), runItems(runs), actionItems()),
    // regVersion re-lists pages when the registry changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, runs, regVersion],
  );
  const cur = Math.min(active, Math.max(0, items.length - 1));

  const pick = (it: PaletteItem) => {
    if (it.action === "toggle-theme") toggleTheme();
    else if (it.to) goto(it.to);
    close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(items.length ? (cur + 1) % items.length : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(items.length ? (cur - 1 + items.length) % items.length : 0); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(Math.max(0, items.length - 1)); }
    else if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); const it = items[cur]; if (it) pick(it); }
  };

  if (!open) return null;
  let lastKind = "";
  return (
    <div data-testid="palette-backdrop" onClick={close} style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.4)", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "14vh" }}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 92vw)", background: t("bg"), color: t("text"), border: `1px solid ${t("border")}`, borderRadius: t("radius-lg"), boxShadow: t("shadow-lg"), overflow: "hidden", fontFamily: t("font-sans") }}>
        <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-label="Search pages, runs and actions"
          aria-activedescendant={items[cur] ? `${listId}-${cur}` : undefined}
          value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} placeholder="Search pages, runs, actions"
          style={{ width: "100%", boxSizing: "border-box", padding: "14px 16px", background: "transparent", color: t("text"), border: "none", borderBottom: `1px solid ${t("border")}`, outline: "none", fontSize: "1rem" }} />
        <ul id={listId} role="listbox" aria-label="Results" style={{ listStyle: "none", margin: 0, padding: 6, maxHeight: "50vh", overflowY: "auto" }}>
          {items.map((it, i) => {
            const head = it.kind !== lastKind ? it.kind : null;
            lastKind = it.kind;
            return (
              <li key={it.id} role="presentation">
                {head && <div role="presentation" style={{ padding: "8px 10px 4px", fontSize: t("text-sm"), color: t("text-2") }}>{head}</div>}
                <div id={`${listId}-${i}`} role="option" aria-selected={i === cur} onMouseMove={() => setActive(i)} onClick={() => pick(it)}
                  style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 10px", borderRadius: t("radius-md"), cursor: "pointer", background: i === cur ? t("bg-3") : "transparent" }}>
                  <span>{it.label}</span>
                  {it.hint && <span style={{ color: t("text-2"), fontSize: t("text-sm") }}>{it.hint.startsWith("Cmd") ? <Kbd>{it.hint}</Kbd> : it.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        {items.length === 0 && <p role="status" style={{ margin: 0, padding: "14px 16px", color: t("text-2") }}>No matches</p>}
        {runsError && <p role="alert" style={{ margin: 0, padding: "8px 16px", color: t("error"), fontSize: t("text-sm") }}>Recent runs not loaded: {runsError}</p>}
      </div>
    </div>
  );
}
