import { Activity, Briefcase, DollarSign, ExternalLink, Settings, Moon, Sun, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Landing } from "./Live";
import { CostPage, EmptyState, SettingsPage, StartRun, WorkPage } from "./Shell";
import { getRun, listRuns, postAnswer, type RunDetailResponse, type RunRow, type TimelineStage } from "./api";

const MISSING = "not recorded";

export function fmtCost(r: Pick<RunRow, "cost_usd" | "partial_usd" | "measured_sessions" | "total_sessions">): string {
  if (r.cost_usd !== null && r.cost_usd !== undefined) return `$${r.cost_usd.toFixed(4)}`;
  if (r.total_sessions > 0 && r.measured_sessions < r.total_sessions) {
    return `unpriced (${r.measured_sessions} of ${r.total_sessions} sessions priced)`;
  }
  return "unpriced";
}

const durationS = (s: TimelineStage): number | null =>
  s.started_at && s.ended_at ? (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000 : null;

const fmtSecs = (s: number | null | undefined): string => (typeof s === "number" ? `${s.toFixed(1)}s` : MISSING);
const fmtTime = (t: string | null | undefined): string => (t ? t.replace("T", " ").replace(/\.\d+Z$/, "Z") : MISSING);

const VERDICT_CLASS: Record<string, string> = {
  VERIFIED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30",
  PARTIAL: "bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30",
  FAILED: "bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30",
  TAMPERED: "bg-red-600/20 text-red-700 dark:text-red-300 ring-red-600/50",
  SPEC_CONFLICT: "bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-violet-500/30",
};

/** A tampered event log overrides whatever verdict was recorded: shown as TAMPERED, in red, everywhere. */
export function VerdictBadge({ verdict, tampered }: { verdict: string | null; tampered?: boolean }) {
  if (tampered) verdict = "TAMPERED";
  const cls = verdict ? (VERDICT_CLASS[verdict] ?? "bg-slate-500/15 text-slate-600 dark:text-slate-300 ring-slate-500/30") : "bg-slate-500/15 text-slate-600 dark:text-slate-300 ring-slate-500/30";
  return <span data-testid="verdict" className={`inline-block rounded px-2 py-0.5 text-xs font-medium ring-1 ${cls}`}>{verdict ?? "in progress"}</span>;
}

function PrLink({ url }: { url: string | null }) {
  if (!url) return <span className="text-slate-500">no PR</span>;
  const web = /^https?:\/\//.test(url);
  return web ? (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-600 hover:underline dark:text-sky-400">
      PR <ExternalLink size={12} />
    </a>
  ) : (
    <span className="break-all font-mono text-xs" title="local origin, no web URL">{url}</span>
  );
}

export const POLL_MS = 3000; // within the 2 to 5 s live window

/** Loads fn; while `again(data)` is true it re-polls every POLL_MS without clearing the screen. */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[], again?: (d: T) => boolean): { data: T | null; error: string | null } {
  const [state, set] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    set({ data: null, error: null });
    const load = () => fn().then((data) => {
      if (!live) return;
      set({ data, error: null });
      if (again?.(data)) timer = setTimeout(load, POLL_MS);
    }, (e: Error) => {
      if (!live) return;
      set((p) => ({ data: p.data, error: e.message }));
      if (again) timer = setTimeout(load, POLL_MS); // keep trying while a live view is open
    });
    void load();
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

const isRunning = (r: Pick<RunRow, "status">): boolean => r.status === "running";

/** Live elapsed: server value at fetch time, advanced by the local clock once a second while running. */
export function Elapsed({ run }: { run: RunRow }) {
  const [base] = useState(() => ({ at: Date.now(), s: run.elapsed_s ?? 0 }));
  const [, tick] = useState(0);
  const running = isRunning(run);
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  const s = running ? Math.max(run.elapsed_s ?? 0, base.s + (Date.now() - base.at) / 1000) : (run.elapsed_s ?? run.wall_s);
  return <span data-testid="elapsed">{typeof s === "number" ? `${Math.floor(s)}s` : MISSING}</span>;
}

export function RunsList({ onOpen }: { onOpen?: (r: RunRow) => void }) {
  const [verdict, setVerdict] = useState("");
  const [repo, setRepo] = useState("");
  const [since, setSince] = useState("");
  const { data, error } = useLoad(() => listRuns({ verdict, repo, since: since ? `${since}T00:00:00Z` : "" }), [verdict, repo, since], (d) => d.runs.some(isRunning));
  const filtered = Boolean(verdict || repo || since);
  const inp = "rounded border border-slate-300 bg-white px-2 py-2 text-sm md:py-1 dark:border-slate-700 dark:bg-slate-900";
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Runs</h1>
      <div className="mb-4 grid grid-cols-1 gap-3 text-sm sm:flex sm:flex-wrap sm:items-end">
        <label className="flex flex-col gap-1">Verdict
          <select aria-label="Verdict" className={inp} value={verdict} onChange={(e) => setVerdict(e.target.value)}>
            <option value="">All</option>
            {["VERIFIED", "PARTIAL", "FAILED", "SPEC_CONFLICT"].map((v) => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">Repo
          <input aria-label="Repo" className={inp} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
        </label>
        <label className="flex flex-col gap-1">Since
          <input aria-label="Since" type="date" className={inp} value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
      </div>
      {error && <p role="alert" className="text-red-600">Could not load runs: {error}</p>}
      {!data && !error && <p className="text-slate-500">Loading runs</p>}
      {data && data.runs.length === 0 && (filtered ? <p>No runs match these filters.</p> : <EmptyState />)}
      {data && data.runs.length > 0 && (
        <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-500 dark:bg-slate-900">
              <tr><th className="p-2">Verdict</th><th className="p-2">Run</th><th className="hidden p-2 md:table-cell">Repo</th><th className="hidden p-2 md:table-cell">Started</th><th className="p-2">Progress</th><th className="p-2">Cost</th><th className="p-2">PR</th></tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={`${r.source_id}/${r.run_id}`} data-testid="run-row" className="border-t border-slate-200 dark:border-slate-800">
                  <td className="p-2"><VerdictBadge verdict={r.verdict} tampered={r.tampered} /></td>
                  <td className="p-2 font-mono text-xs">
                    <a href={`#/runs/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`} onClick={() => onOpen?.(r)} className="inline-block break-all py-2 text-sky-600 hover:underline md:py-0 dark:text-sky-400">{r.run_id}</a>
                  </td>
                  <td className="hidden p-2 md:table-cell">{r.origin_repo ?? MISSING}</td>
                  <td className="hidden p-2 md:table-cell">{fmtTime(r.started_at)}</td>
                  <td className="p-2 text-xs" data-testid="progress">{isRunning(r) ? <>{r.current_stage ?? "starting"}, <Elapsed run={r} />, {(r.files_touched ?? []).length} files</> : ""}</td>
                  <td className="p-2" data-testid="cost">{fmtCost(r)}</td>
                  <td className="p-2"><PrLink url={r.pr_url} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <div className="rounded border border-slate-200 p-4 dark:border-slate-800"><h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">{title}</h2>{children}</div>;
}

function Timeline({ stages }: { stages: TimelineStage[] }) {
  if (stages.length === 0) return <p className="text-slate-500">No stages ingested for this run.</p>;
  return (
    <ol className="space-y-1 text-sm">
      {stages.map((s) => (
        <li key={s.stage} data-testid="stage" className="flex items-center justify-between gap-4">
          <span className="font-medium">{s.stage}</span>
          <span className="text-slate-500">{s.status === "started" ? "running" : fmtSecs(durationS(s))}</span>
        </li>
      ))}
    </ol>
  );
}

function AnswerBox({ source, run, question }: { source: string; run: string; question: string }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async () => {
    try { const r = await postAnswer(source, run, text); setMsg({ ok: true, text: `Saved to ${r.path}. Resume: ${r.resume}` }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  return (
    <Card title="Blocked: your answer is needed">
      <p data-testid="blocked-question" className="mb-2 text-sm">{question}</p>
      <textarea data-testid="answer-input" aria-label="Answer" maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded border border-slate-300 p-2 text-sm dark:border-slate-700 dark:bg-slate-900" rows={3} />
      <button type="button" data-testid="answer-submit" disabled={text.trim() === ""} onClick={submit} className="mt-2 min-h-11 rounded bg-sky-600 px-4 py-2 text-sm md:min-h-0 md:px-3 md:py-1 text-white disabled:opacity-50">Submit answer</button>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 break-all text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</p>}
    </Card>
  );
}

export function RunDetail({ source, run }: { source: string; run: string }) {
  const { data, error } = useLoad<RunDetailResponse>(() => getRun(source, run), [source, run], isRunning);
  if (error) return <p role="alert" className="text-red-600">Could not load run: {error}</p>;
  if (!data) return <p className="text-slate-500">Loading run</p>;
  const r = data;
  return (
    <section className="space-y-4">
      <a href="#/runs" className="text-sm text-sky-600 hover:underline dark:text-sky-400">Back to runs</a>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold">{r.run_id}</h1>
        <VerdictBadge verdict={r.verdict} tampered={r.tampered} />
        {r.tampered && <span className="inline-flex items-center gap-1 text-sm text-red-600"><TriangleAlert size={14} />event log tampered</span>}
        {r.conflict && <span className="inline-flex items-center gap-1 text-sm text-amber-600"><TriangleAlert size={14} />conflicting events ingested</span>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Summary">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-500">Repo</dt><dd>{r.origin_repo ?? MISSING}</dd>
            <dt className="text-slate-500">Issue</dt><dd>{r.issue_ref ?? MISSING}</dd>
            <dt className="text-slate-500">Provider</dt><dd>{r.provider ?? MISSING}</dd>
            <dt className="text-slate-500">Model</dt><dd>{r.model ?? MISSING}</dd>
            <dt className="text-slate-500">Started</dt><dd>{fmtTime(r.started_at)}</dd>
            {isRunning(r) && <><dt className="text-slate-500">Current stage</dt><dd data-testid="current-stage">{r.current_stage ?? "starting"}</dd></>}
            <dt className="text-slate-500">{isRunning(r) ? "Elapsed" : "Wall time"}</dt><dd>{isRunning(r) ? <Elapsed run={r} /> : fmtSecs(r.wall_s)}</dd>
            {isRunning(r) && <><dt className="text-slate-500">Files touched</dt><dd data-testid="files-touched">{(r.files_touched ?? []).join(", ") || "none yet"}</dd></>}
            <dt className="text-slate-500">Cost</dt><dd data-testid="cost">{fmtCost(r)}</dd>
            <dt className="text-slate-500">PR</dt><dd><PrLink url={r.pr_url} /></dd>
          </dl>
        </Card>
        <Card title="Stage timeline"><Timeline stages={data.stages} /></Card>
      </div>
      {data.blocked_question && <AnswerBox source={source} run={run} question={data.blocked_question} />}
      <Card title="Receipt">
        <div className="space-y-3 text-sm">
          {data.receipt ? (
            <p>Receipt verdict: <VerdictBadge verdict={data.receipt.verdict} tampered={r.tampered} /> <span className="ml-2 font-mono text-xs text-slate-500">{data.receipt.sha256}</span></p>
          ) : <p className="text-slate-500">No receipt ingested for this run.</p>}
          <div>
            <h3 className="font-medium">NOT PROVEN</h3>
            {data.not_proven.length === 0 ? <p className="text-slate-500">Nothing listed as not proven.</p> : (
              <ul className="list-disc pl-5">{data.not_proven.map((n) => <li key={n} data-testid="not-proven">{n}</li>)}</ul>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}

function route(hash: string): { source: string; run: string } | null {
  const m = /^#\/runs\/([^/]+)\/([^/]+)$/.exec(hash);
  return m ? { source: decodeURIComponent(m[1]!), run: decodeURIComponent(m[2]!) } : null;
}

const NAV: [string, string, typeof Activity][] = [["#/runs", "Runs", Activity], ["#/work", "Work", Briefcase], ["#/cost", "Cost", DollarSign], ["#/settings", "Settings", Settings]];

export function App() {
  const [hash, setHash] = useState(globalThis.location?.hash ?? "");
  const [dark, setDark] = useState(() => { try { return localStorage.getItem("loki-theme") !== "light"; } catch { return true; } });
  useEffect(() => { const f = () => setHash(location.hash); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("loki-theme", dark ? "dark" : "light"); } catch { /* storage unavailable */ }
  }, [dark]);
  const r = route(hash);
  const page = hash.startsWith("#/work") ? "#/work" : hash.startsWith("#/cost") ? "#/cost" : hash.startsWith("#/settings") ? "#/settings" : "#/runs";
  return (
    <div className="flex min-h-screen flex-col bg-white md:flex-row text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <nav data-testid="nav" className="flex w-full shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 p-3 md:block md:w-48 md:border-b-0 md:border-r md:p-4 dark:border-slate-800">
        <div className="font-semibold md:mb-6">Loki Mode</div>
        {NAV.map(([h, label, Icon]) => (
          <a key={h} href={h} aria-current={page === h ? "page" : undefined} className={`flex min-h-11 items-center gap-2 rounded px-3 text-sm md:min-h-0 md:px-2 md:py-1 ${page === h ? "bg-slate-100 dark:bg-slate-900" : "text-slate-500"}`}><Icon size={14} />{label}</a>
        ))}
        <button type="button" onClick={() => setDark(!dark)} aria-label="Toggle theme" className="ml-auto flex min-h-11 items-center gap-2 text-sm text-slate-500 md:ml-0 md:mt-6 md:min-h-0">
          {dark ? <Sun size={14} /> : <Moon size={14} />}{dark ? "Light theme" : "Dark theme"}
        </button>
      </nav>
      <main className="min-w-0 flex-1 overflow-x-auto p-3 md:p-6">{r ? <RunDetail source={r.source} run={r.run} /> : page === "#/work" ? <WorkPage /> : page === "#/cost" ? <CostPage /> : page === "#/settings" ? <SettingsPage dark={dark} toggle={() => setDark(!dark)} /> : hash === "#/runs" ? <><StartRun /><RunsList /></> : <Landing overview={hash === "#/overview"} fallback={<><StartRun /><RunsList /></>} />}</main>
    </div>
  );
}
