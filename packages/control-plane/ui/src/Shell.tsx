// App shell pieces: empty-state import, and the Work, Cost and Settings pages.
import { useEffect, useState } from "react";
import { displayOutcome } from "./display";
import { fmtUsd } from "./format";
import { Button } from "./design/primitives";
import { toggleTheme, useTheme } from "./shell/theme";
import { importRuns, effectiveVerdict, listRuns, type RunRow } from "./api";

const btn = "min-h-11 rounded bg-sky-700 px-4 py-2 text-sm text-white disabled:opacity-50 md:min-h-0 md:px-3 md:py-1";

export const START_CLI = "loki start owner/repo#N";

export function ImportButton() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await importRuns();
      setMsg(r.failed.length ? { ok: false, text: `Imported ${r.runs} runs; ${r.failed.length} failed.` } : { ok: true, text: r.runs === 0 ? "No runs found in this folder." : `Imported ${r.runs} runs. Reload to see them.` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  };
  return (
    <div>
      <button type="button" data-testid="import-runs" disabled={busy} onClick={go} className={btn}>Import runs from this folder</button>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</p>}
    </div>
  );
}

export function EmptyState() {
  return (
    <div data-testid="empty-state" className="rounded border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
      <p className="text-lg font-medium">No runs yet</p>
      <div className="mt-4 flex justify-center"><ImportButton /></div>
      <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">Or start your first run from a terminal:</p>
      <code className="mt-2 inline-block rounded bg-slate-200 px-2 py-1 text-sm dark:bg-slate-800">{START_CLI}</code>
    </div>
  );
}

function useRuns(): { runs: RunRow[] | null; error: string | null } {
  const [s, set] = useState<{ runs: RunRow[] | null; error: string | null }>({ runs: null, error: null });
  useEffect(() => { listRuns({}).then((r) => set({ runs: r.runs, error: null }), (e: Error) => set({ runs: null, error: e.message })); }, []);
  return s;
}

export function WorkPage() {
  const { runs, error } = useRuns();
  const rows = (runs ?? []).filter((r) => r.issue_ref);
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Work</h1>
      {error && <p role="alert" className="text-red-600">Could not load work: {error}</p>}
      {runs && rows.length === 0 && <p className="text-slate-500">No issue-driven runs yet. Start one with <code>{START_CLI}</code>.</p>}
      <ul className="space-y-2 text-sm">
        {rows.map((r) => (
          <li key={`${r.source_id}/${r.run_id}`} data-testid="work-row" className="flex flex-wrap items-center gap-3 rounded border border-slate-200 p-3 dark:border-slate-800">
            <span className="font-mono">{r.issue_ref}</span>
            <span className="text-slate-500">{displayOutcome(effectiveVerdict(r)).label}</span>
            {r.pr_url ? <a className="text-sky-600 hover:underline dark:text-sky-400" href={r.pr_url} target="_blank" rel="noreferrer">PR</a> : <span className="text-slate-500">no PR yet</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CostPage() {
  const { runs, error } = useRuns();
  const priced = (runs ?? []).filter((r) => r.cost_usd !== null && r.cost_usd !== undefined);
  const total = priced.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  const unpriced = (runs ?? []).length - priced.length;
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Cost</h1>
      {error && <p role="alert" className="text-red-600">Could not load cost: {error}</p>}
      {runs && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Priced runs</dt><dd data-testid="cost-priced">{priced.length}</dd>
          <dt className="text-slate-500">Total priced cost</dt><dd data-testid="cost-total">${total.toFixed(4)}</dd>
          <dt className="text-slate-500">Unpriced runs</dt><dd data-testid="cost-unpriced">{unpriced} (not counted in the total)</dd>
        </dl>
      )}
    </section>
  );
}

export function SettingsPage() {
  const theme = useTheme();
  return (
    <section>
      <h2 className="mb-4 text-xl" style={{ fontFamily: "var(--cp-font-serif)", fontWeight: 400 }}>General</h2>
      <p className="mb-2 text-sm" style={{ color: "var(--cp-text-2)" }}>Appearance</p>
      <Button variant="secondary" onClick={toggleTheme}>{theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}</Button>
      <div className="mt-6"><ImportButton /></div>
    </section>
  );
}
