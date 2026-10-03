// Live run view and Overview. Everything is derived from the runs API; a value the API does not carry shows "unmeasured".
import { useEffect, useState, type ReactNode } from "react";
import { effectiveVerdict, VERDICT } from "./design/primitives";
import { getRun, listRuns, type RunDetailResponse, type RunRow, type TimelineStage } from "./api";

export const UNMEASURED = "unmeasured";
const POLL = 3000;

export const STAGES = ["intake", "plan", "Wall", "implement", "verify", "seal", "PR"] as const;

/** Per-stage limits are not part of the ingested events, so they are never shown as numbers. */
export interface StageView { name: string; status: "pending" | "running" | "done" | "failed"; elapsed_s: number | null }

export function buildStages(stages: TimelineStage[], now: number): StageView[] {
  const used = new Set<TimelineStage>();
  const find = (n: string) => stages.find((s) => !used.has(s) && s.stage.toLowerCase().includes(n.toLowerCase()));
  const view = (name: string, s: TimelineStage | undefined): StageView => {
    if (!s) return { name, status: "pending", elapsed_s: null };
    used.add(s);
    const t0 = s.started_at ? Date.parse(s.started_at) : NaN;
    const t1 = s.ended_at ? Date.parse(s.ended_at) : s.status === "started" ? now : NaN;
    const elapsed_s = Number.isNaN(t0) || Number.isNaN(t1) ? null : Math.max(0, (t1 - t0) / 1000);
    const status = s.status === "started" ? "running" : s.status === "completed" ? "done" : "failed";
    return { name, status, elapsed_s };
  };
  const out = STAGES.map((n) => view(n, find(n)));
  for (const s of stages) if (!used.has(s)) out.push(view(s.stage, s));
  return out;
}

const fmtS = (s: number | null) => (s === null ? UNMEASURED : s >= 60 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${s.toFixed(1)}s`);
export const costText = (r: Pick<RunRow, "cost_usd" | "partial_usd">): string =>
  r.cost_usd !== null && r.cost_usd !== undefined ? `$${r.cost_usd.toFixed(4)}` : r.partial_usd ? `at least $${r.partial_usd.toFixed(4)} (rest ${UNMEASURED})` : UNMEASURED;

function usePoll<T>(fn: () => Promise<T>, deps: unknown[], again: (d: T) => boolean) {
  const [st, set] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => fn().then((data) => { if (live) { set({ data, error: null }); if (again(data)) timer = setTimeout(load, POLL); } },
      (e: Error) => { if (live) { set((p) => ({ data: p.data, error: e.message })); timer = setTimeout(load, POLL); } });
    void load();
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return st;
}

const card = "rounded border border-slate-200 p-4 dark:border-slate-800";
const tag: Record<StageView["status"], string> = { pending: "text-slate-400", running: "text-sky-600 dark:text-sky-400", done: "text-emerald-600 dark:text-emerald-400", failed: "text-red-600" };

const webUrl = (u: string | null) => (u && /^https?:\/\//.test(u) ? u : null);

export function LiveRun({ source, run }: { source: string; run: string }) {
  const { data, error } = usePoll<RunDetailResponse>(() => getRun(source, run), [source, run], (d) => d.status === "running");
  const [, tick] = useState(0);
  const running = data?.status === "running";
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  if (error && !data) return <p role="alert" className="text-red-600">Could not load run: {error}</p>;
  if (!data) return <p className="text-slate-500">Loading run</p>;
  const stages = buildStages(data.stages ?? [], Date.now());
  const files = data.files_touched ?? [];
  const pr = webUrl(data.pr_url);
  return (
    <section data-testid="live-run" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{running ? "Live run" : "Run finished"}</h1>
        <span className="break-all font-mono text-xs text-slate-500">{data.run_id}</span>
      </div>
      <div className={card}>
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Stages</h2>
        <ol className="space-y-2 text-sm">
          {stages.map((s) => (
            <li key={s.name} data-testid="live-stage" data-status={s.status} className="flex flex-wrap items-center justify-between gap-x-4">
              <span className="font-medium">{s.name}</span>
              <span className={tag[s.status]}>{s.status}, {s.status === "pending" ? "not started" : fmtS(s.elapsed_s)}, limit {UNMEASURED}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className={card}><h2 className="mb-1 text-sm font-semibold uppercase text-slate-500">Diff</h2>
          <p data-testid="live-diff">{files.length} files, +/- {UNMEASURED}</p></div>
        <div className={card}><h2 className="mb-1 text-sm font-semibold uppercase text-slate-500">Cost so far</h2>
          <p data-testid="live-cost">{costText(data)}</p></div>
        <div className={card}><h2 className="mb-1 text-sm font-semibold uppercase text-slate-500">Model</h2>
          <p data-testid="live-model">{data.model ?? UNMEASURED}</p></div>
      </div>
      {!running && (
        <div data-testid="live-outcome" className={card}>
          <h2 className="mb-1 text-sm font-semibold uppercase text-slate-500">Outcome</h2>
          <p className={`text-lg font-medium${data.tampered ? " text-red-600" : ""}`}>{effectiveVerdict(data) ?? UNMEASURED}</p>
          <p className="mt-1 flex flex-wrap gap-4 text-sm">
            {pr ? <a data-testid="live-pr" href={pr} target="_blank" rel="noreferrer" className="text-sky-600 hover:underline dark:text-sky-400">Pull request</a> : <span data-testid="live-pr" className="text-slate-500">no PR</span>}
            {data.receipt ? <a data-testid="live-receipt" href={`#/runs/${encodeURIComponent(source)}/${encodeURIComponent(run)}`} className="text-sky-600 hover:underline dark:text-sky-400">Receipt{data.receipt.signed ? " (signed)" : " (unsigned)"}</a> : <span data-testid="live-receipt" className="text-slate-500">no receipt</span>}
          </p>
        </div>
      )}
      <a href="#/overview" className="inline-block py-2 text-sm text-sky-600 hover:underline dark:text-sky-400">Overview</a>
    </section>
  );
}

export interface OverviewStats {
  today: number; week: number; verified: number; unchecked: number; partial: number; failed: number; other: number; running: number;
  costUsd: number; unmeasuredRuns: number; prsOpened: number; last: RunRow[];
}

export function summarize(runs: RunRow[], now: number): OverviewStats {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const t0 = day.getTime();
  const s: OverviewStats = { today: 0, week: 0, verified: 0, unchecked: 0, partial: 0, failed: 0, other: 0, running: 0, costUsd: 0, unmeasuredRuns: 0, prsOpened: 0, last: [] };
  for (const r of runs) {
    const t = r.started_at ? Date.parse(r.started_at) : NaN;
    if (!Number.isNaN(t)) { if (t >= t0) s.today++; if (t >= t0 - 6 * 86400000) s.week++; }
    const ev = effectiveVerdict(r); if (ev === VERDICT.VERIFIED) s.verified++; else if (ev === VERDICT.VERIFIED_UNCHECKED) s.unchecked++; else if (ev === VERDICT.PARTIAL) s.partial++; else if (ev === VERDICT.FAILED) s.failed++; else if (ev) s.other++; else s.running++;
    if (r.cost_usd !== null && r.cost_usd !== undefined) s.costUsd += r.cost_usd; else { s.unmeasuredRuns++; s.costUsd += r.partial_usd ?? 0; }
    if (r.pr_url) s.prsOpened++;
  }
  s.last = [...runs].sort((a, b) => Date.parse(b.started_at ?? "") - Date.parse(a.started_at ?? "")).slice(0, 10);
  return s;
}

function Stat({ id, label, value }: { id: string; label: string; value: string }) {
  return <div className={card}><div className="text-xs uppercase text-slate-500">{label}</div><div data-testid={id} className="mt-1 text-lg font-semibold">{value}</div></div>;
}

export function Overview({ runs, now = Date.now() }: { runs: RunRow[]; now?: number }) {
  const s = summarize(runs, now);
  const cost = s.unmeasuredRuns === 0 ? `$${s.costUsd.toFixed(4)}` : `$${s.costUsd.toFixed(4)} measured, ${s.unmeasuredRuns} run${s.unmeasuredRuns === 1 ? "" : "s"} ${UNMEASURED}`;
  return (
    <section data-testid="overview" className="space-y-4">
      <h1 className="text-xl font-semibold">Overview</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat id="ov-today" label="Runs today" value={String(s.today)} />
        <Stat id="ov-week" label="Runs, last 7 days" value={String(s.week)} />
        <Stat id="ov-verified" label={VERDICT.VERIFIED} value={String(s.verified)} />
        <Stat id="ov-unchecked" label="Signature not checked" value={String(s.unchecked)} />
        <Stat id="ov-partial" label={VERDICT.PARTIAL} value={String(s.partial)} />
        <Stat id="ov-failed" label={VERDICT.FAILED} value={String(s.failed)} />
        <Stat id="ov-cost" label="Total cost" value={cost} />
        <Stat id="ov-pr-opened" label="PRs opened" value={String(s.prsOpened)} />
        <Stat id="ov-pr-merged" label="PRs merged" value={UNMEASURED} />
      </div>
      <div className={card}>
        <h2 className="mb-2 text-sm font-semibold uppercase text-slate-500">Last 10 runs</h2>
        <ul className="space-y-1 text-sm">
          {s.last.map((r) => (
            <li key={`${r.source_id}/${r.run_id}`} data-testid="ov-run" className="flex flex-wrap justify-between gap-x-4">
              <a href={`#/runs/${encodeURIComponent(r.source_id)}/${encodeURIComponent(r.run_id)}`} className="break-all py-1 font-mono text-xs text-sky-600 hover:underline dark:text-sky-400">{r.run_id}</a>
              <span className={r.tampered ? "text-red-600" : undefined}>{effectiveVerdict(r) ?? "in progress"}, {costText(r)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Landing: the live view when a run is active, else the Overview; with no runs at all, the caller's existing empty state. */
export function Landing({ fallback, overview }: { fallback: ReactNode; overview?: boolean }) {
  const { data } = usePoll(() => listRuns(), [], (d) => d.runs.some((r) => r.status === "running"));
  if (!data) return <p className="text-slate-500">Loading runs</p>;
  if (data.runs.length === 0) return <>{fallback}</>;
  const active = data.runs.find((r) => r.status === "running");
  if (active && !overview) return <LiveRun source={active.source_id} run={active.run_id} />;
  return <Overview runs={data.runs} />;
}
