// `loki queue`: an overnight queue of GitHub issue refs.
//   loki queue add <issue...>   append refs to .loki/issue-queue.json
//   loki queue list             show what is queued
//   loki queue run [--no-pr]    process one at a time through issue-mode `loki start`,
//                               consulting the usage governor before each item, then
//                               write and print a morning digest.
// The runner and the governor are injectable so tests never call claude.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";
import { printForecast, readingFromGovernorJson, recordWindowDelta, type UsageReading } from "../engine10/forecast.ts";

export interface QueueItem {
  ref: string;
  added_at: string;
}

export interface RunResult {
  rc: number;
  output: string;
  verdict?: string | null;
  costUsd?: number | null;
}

export interface GovernorReading {
  ok: boolean; // false when the governor could not be read
  hold: boolean;
  reason: string;
  usage?: UsageReading | null; // measured window reading, when the governor had one (advisory forecast only)
}

export interface QueueDeps {
  lokiDir: string;
  runner: (ref: string, opts: { pr: boolean }) => Promise<RunResult>;
  governor: () => Promise<GovernorReading>;
  now: () => Date;
  out: (s: string) => void;
  err: (s: string) => void;
}

const REF_RE = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|#?\d+)$/;
const URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;
const PR_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

export function normalizeRef(raw: string): string | null {
  const m = URL_RE.exec(raw);
  if (m) return `${m[1]}#${m[2]}`;
  return REF_RE.test(raw) ? raw : null;
}

function queuePath(lokiDir: string): string {
  return join(lokiDir, "issue-queue.json");
}

export function readQueue(lokiDir: string): QueueItem[] {
  try {
    const d = JSON.parse(readFileSync(queuePath(lokiDir), "utf8")) as { items?: QueueItem[] };
    return Array.isArray(d.items) ? d.items.filter((i) => typeof i?.ref === "string") : [];
  } catch {
    return [];
  }
}

function writeQueue(lokiDir: string, items: QueueItem[]): void {
  mkdirSync(lokiDir, { recursive: true });
  const p = queuePath(lokiDir);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2) + "\n");
  renameSync(tmp, p);
}

export function queueAdd(refs: readonly string[], d: QueueDeps): number {
  if (refs.length === 0) {
    d.err("usage: loki queue add <issue...>   (owner/repo#N, #N, N or a GitHub issue URL)\n");
    return 2;
  }
  const norm: string[] = [];
  for (const r of refs) {
    const n = normalizeRef(r);
    if (!n) {
      d.err(`loki queue add: not an issue reference: ${r}\n`);
      return 2;
    }
    norm.push(n);
  }
  const items = readQueue(d.lokiDir);
  const have = new Set(items.map((i) => i.ref));
  let added = 0;
  for (const ref of norm) {
    if (have.has(ref)) {
      d.out(`already queued: ${ref}\n`);
      continue;
    }
    have.add(ref);
    items.push({ ref, added_at: d.now().toISOString() });
    added++;
    d.out(`queued: ${ref}\n`);
  }
  writeQueue(d.lokiDir, items);
  d.out(`${added} added, ${items.length} in queue\n`);
  return 0;
}

export function queueList(d: QueueDeps): number {
  const items = readQueue(d.lokiDir);
  if (items.length === 0) {
    d.out("queue is empty\n");
    return 0;
  }
  items.forEach((it, i) => d.out(`${i + 1}. ${it.ref}  (added ${it.added_at})\n`));
  return 0;
}

interface DigestRow {
  ref: string;
  verdict: string;
  pr: string | null;
  cost: string;
  note: string;
}

interface Skipped {
  ref: string;
  reason: string;
}

export function renderDigest(started: Date, finished: Date, rows: DigestRow[], skipped: Skipped[], stopReason: string | null): string {
  const L: string[] = [];
  L.push("Loki overnight queue digest");
  L.push(`Started:  ${started.toISOString()}`);
  L.push(`Finished: ${finished.toISOString()}`);
  L.push(`Processed: ${rows.length}   Skipped: ${skipped.length}`);
  if (stopReason) L.push(`Stopped early: ${stopReason}`);
  L.push("");
  L.push("Results");
  if (rows.length === 0) L.push("  (none)");
  for (const r of rows) {
    L.push(`  ${r.ref}`);
    L.push(`    verdict: ${r.verdict}`);
    L.push(`    pr:      ${r.pr ?? "none"}`);
    L.push(`    cost:    ${r.cost}`);
    if (r.note) L.push(`    note:    ${r.note}`);
  }
  L.push("");
  L.push("Skipped (still queued)");
  if (skipped.length === 0) L.push("  (none)");
  for (const s of skipped) L.push(`  ${s.ref}: ${s.reason}`);
  return L.join("\n") + "\n";
}

export async function queueRun(args: readonly string[], d: QueueDeps): Promise<number> {
  const pr = !args.includes("--no-pr");
  const started = d.now();
  const rows: DigestRow[] = [];
  const skipped: Skipped[] = [];
  let stopReason: string | null = null;
  let remaining = readQueue(d.lokiDir);
  if (remaining.length === 0) {
    d.out("queue is empty\n");
    return 0;
  }
  let forecastShown = false;
  for (const item of [...remaining]) {
    const g = await d.governor();
    if (g.hold) {
      stopReason = `governor hold: ${g.reason}`;
      break;
    }
    if (!forecastShown) {
      forecastShown = true;
      await printForecast(d.lokiDir, async () => g.usage ?? null, d.err);
    }
    let res: RunResult;
    try {
      res = await d.runner(item.ref, { pr });
    } catch (e) {
      res = { rc: 1, output: `runner threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    const prUrl = PR_RE.exec(res.output)?.[0] ?? null;
    const verdict = res.verdict || (res.rc === 0 ? "COMPLETED (no proof verdict)" : `FAILED (exit ${res.rc})`);
    rows.push({
      ref: item.ref,
      verdict,
      pr: prUrl,
      cost: typeof res.costUsd === "number" ? `$${res.costUsd.toFixed(2)}` : "NOT RECORDED",
      note: g.ok ? "" : `governor unreadable (${g.reason}); proceeded`,
    });
    // Advisory history: window consumed by this item, from two cached governor readings (best effort).
    if (g.usage) {
      try {
        recordWindowDelta(d.lokiDir, g.usage, (await d.governor()).usage ?? null);
      } catch {
        /* forecast history is best effort */
      }
    }
    // Processed items leave the queue whether they passed or failed; the digest keeps the record.
    remaining = remaining.filter((r) => r.ref !== item.ref);
    writeQueue(d.lokiDir, remaining);
  }
  for (const r of remaining) skipped.push({ ref: r.ref, reason: stopReason ?? "not reached" });
  const finished = d.now();
  const text = renderDigest(started, finished, rows, skipped, stopReason);
  try {
    mkdirSync(d.lokiDir, { recursive: true });
    const stamp = finished.toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(d.lokiDir, `queue-digest-${stamp}.txt`), text);
    writeFileSync(join(d.lokiDir, "queue-digest-latest.txt"), text);
  } catch (e) {
    d.err(`loki queue: could not write digest: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  d.out(text);
  return 0;
}

// Governor: reuse scripts/usage-governor.py (cached 15 min `claude -p /usage` read).
async function governorReport(timeoutMs: number): Promise<unknown> {
  const proc = Bun.spawn(["python3", resolve(REPO_ROOT, "scripts", "usage-governor.py"), "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  return JSON.parse(text);
}

// Same cached script read, bounded shorter, for the advisory forecast (QF-2). Null when unreadable.
export async function defaultUsageReading(): Promise<UsageReading | null> {
  try {
    return readingFromGovernorJson(await governorReport(20_000));
  } catch {
    return null;
  }
}

type GovernorReport = {
  governor?: { max_engineers_reason?: string; cap_basis?: string };
  measured?: { status?: string; session_pct?: number; week_pct?: number } | null;
};

// Pure mapping from the usage-governor `--json` report to a queue reading (kept separate so it is testable without a spawn).
export function governorReadingFromReport(rep: GovernorReport): GovernorReading {
  const usage = readingFromGovernorJson(rep);
  const reason = rep.governor?.max_engineers_reason ?? "";
  const m = rep.measured;
  const sess = m?.status === "ok" && typeof m.session_pct === "number" ? `${m.session_pct}% session` : "session unmeasured";
  if (reason === "hold_above_70_session" || reason === "over_ceiling") {
    return { ok: true, hold: true, reason: `${reason} (${sess})`, usage };
  }
  return { ok: rep.governor?.cap_basis === "measured", hold: false, reason: `${reason || "ok"} (${sess})`, usage };
}

export async function defaultGovernor(): Promise<GovernorReading> {
  try {
    return governorReadingFromReport((await governorReport(90_000)) as GovernorReport);
  } catch (e) {
    return { ok: false, hold: false, reason: e instanceof Error ? e.message : "unreadable" };
  }
}

// Engine10 writes .loki/runs/<id>/receipt.json; the legacy loops write .loki/proofs/<id>/proof.json.
// Both carry a top-level verdict and cost.usd. Newest file modified since `since` wins; runs/ first.
export function newestRecord(lokiDir: string, since: number): { verdict: string | null; costUsd: number | null } {
  for (const [sub, file] of [["runs", "receipt.json"], ["proofs", "proof.json"]] as const) {
    const dir = join(lokiDir, sub);
    let best: { t: number; p: string } | null = null;
    try {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name, file);
        if (!existsSync(p)) continue;
        const t = statSync(p).mtimeMs;
        if (t >= since && (!best || t > best.t)) best = { t, p };
      }
      if (!best) continue;
      const d = JSON.parse(readFileSync(best.p, "utf8")) as { verdict?: unknown; cost?: { usd?: unknown; source?: unknown } };
      const usd = d.cost?.usd;
      const unmetered = d.cost?.source === "cli-invoker-unmetered";
      return {
        verdict: typeof d.verdict === "string" ? d.verdict : null,
        costUsd: !unmetered && typeof usd === "number" && Number.isFinite(usd) ? usd : null,
      };
    } catch {
      continue;
    }
  }
  return { verdict: null, costUsd: null };
}

export function makeDefaultRunner(lokiDir: string): QueueDeps["runner"] {
  return async (ref, opts) => {
    const since = Date.now();
    const argv = [resolve(REPO_ROOT, "bin", "loki"), "start", ref, ...(opts.pr ? ["--pr"] : [])];
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, LOKI_NO_BROWSER: "1" } });
    const mins = Number(process.env["LOKI_QUEUE_ITEM_TIMEOUT_MIN"]) || 120;
    const timer = setTimeout(() => proc.kill(), mins * 60_000);
    const [so, se] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const rc = await proc.exited;
    clearTimeout(timer);
    const output = so + se;
    try {
      const logDir = join(lokiDir, "queue-logs");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `${ref.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`), output);
    } catch {
      /* log is best effort */
    }
    const proof = newestRecord(lokiDir, since);
    return { rc, output, verdict: proof.verdict, costUsd: proof.costUsd };
  };
}

export async function runQueue(args: readonly string[], inject?: Partial<QueueDeps>): Promise<number> {
  const lokiDir = inject?.lokiDir ?? process.env["LOKI_DIR"] ?? resolve(process.cwd(), ".loki");
  const d: QueueDeps = {
    lokiDir,
    runner: inject?.runner ?? makeDefaultRunner(lokiDir),
    governor: inject?.governor ?? defaultGovernor,
    now: inject?.now ?? (() => new Date()),
    out: inject?.out ?? ((s) => void process.stdout.write(s)),
    err: inject?.err ?? ((s) => void process.stderr.write(s)),
  };
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "add":
      return queueAdd(rest, d);
    case "list":
      return queueList(d);
    case "run":
      return queueRun(rest, d);
    default:
      d.err("usage: loki queue <add <issue...> | list | run [--no-pr]>\n");
      return 2;
  }
}
