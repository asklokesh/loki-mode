// `loki queue`: an overnight queue of GitHub issue refs.
//   loki queue add <issue...>   append refs to .loki/issue-queue.json
//   loki queue list [--json]    show what is queued (--json: the refs as a JSON array)
//   loki queue remove <issue...> take refs out of the queue (missing ref: "not queued", exit 0)
//   loki queue clear            empty the queue
//   loki queue run [--no-pr] [--max-total-cost <usd>]  process one at a time through issue-mode `loki start`,
//                               consulting the usage governor before each item, then
//                               write and print a morning digest. --max-total-cost stops
//                               before the next item once cumulative recorded spend reaches the cap.
// The runner and the governor are injectable so tests never call claude.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteText } from "../util/atomic.ts";
import { REPO_ROOT } from "../util/paths.ts";
import { suggestWord } from "../cli/registry.ts";
import { printForecast, readingFromGovernorJson, recordWindowDelta, type UsageReading } from "../contrib/forecast.ts";

export interface QueueItem {
  ref: string;
  added_at: string;
}

export interface RunResult {
  rc: number;
  output: string;
  verdict?: string | null;
  costUsd?: number | null;
  didWork?: boolean | null; // the sealed receipt's head_sha differs from its base_sha: the run committed a change; null when no receipt says
  runId?: string | null; // the engine10 run id (.loki/runs/<id>), so `loki issues run` can stack on loki/<id> (MASS-2)
}

export interface GovernorReading {
  ok: boolean; // false when the governor could not be read
  hold: boolean;
  reason: string;
  usage?: UsageReading | null; // measured window reading, when the governor had one (advisory forecast only)
}

export interface QueueDeps {
  lokiDir: string;
  runner: (ref: string, opts: RunOpts) => Promise<RunResult>;
  governor: () => Promise<GovernorReading>;
  now: () => Date;
  out: (s: string) => void;
  err: (s: string) => void;
  parallel?: number; // items in flight at once (default 1, capped at MAX_PARALLEL); `loki issues run --parallel`
  draft?: boolean; // every PR opened as a draft; passed to the runner, which hands it to the existing PR path
  onResult?: (r: ItemResult) => void; // called as each item finishes (live progress lines)
}

export interface RunOpts {
  pr: boolean;
  draft?: boolean;
  cwd?: string; // run in this checkout (a per-issue worktree) with its own .loki
  env?: NodeJS.ProcessEnv;
  prBase?: string; // MASS-2: the PR targets this branch (a stacked slice's parent), via LOKI_PR_BASE to the run's PR stage
  prRefs?: string; // MASS-2: owner/repo#N the PR body refers to (the epic), via LOKI_PR_REFS
  logName?: string; // queue-logs file name when the ref is long task text
}

export interface ItemResult {
  ref: string;
  res: RunResult;
  row: DigestRow;
  seconds: number;
}

export const MAX_PARALLEL = 4;

const REF_RE = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|#?\d+)$/;
const URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;
const PR_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

export function normalizeRef(raw: string): string | null {
  const m = URL_RE.exec(raw);
  if (m) return /^0+$/.test(m[2]!) ? null : `${m[1]}#${m[2]}`;
  if (!REF_RE.test(raw)) return null;
  // issue numbers start at 1; #0, 0 and o/r#00 are unrunnable
  return /^0+$/.test(raw.replace(/^.*#/, "")) ? null : raw;
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

// A queue file that exists but does not parse (a crash left it truncated) must not be overwritten by
// the next add: move it aside for inspection and warn once. Same pattern as util/outbox.ts.
function quarantineCorruptQueue(lokiDir: string, now: Date, warn: (s: string) => void): void {
  const p = queuePath(lokiDir);
  if (!existsSync(p)) return;
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as { items?: unknown } | null;
    if (d !== null && typeof d === "object" && Array.isArray(d.items)) return;
  } catch { /* fall through to quarantine */ }
  const q = `${p}.corrupt-${now.getTime()}`;
  try {
    renameSync(p, q);
    warn(`warn: queue file ${p} is corrupt; quarantined as ${q}\n`);
  } catch { /* best effort */ }
}

function writeQueue(lokiDir: string, items: QueueItem[]): void {
  mkdirSync(lokiDir, { recursive: true });
  const p = queuePath(lokiDir);
  atomicWriteText(p, JSON.stringify({ version: 1, items }, null, 2) + "\n");
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
  quarantineCorruptQueue(d.lokiDir, d.now(), d.err);
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

export function queueRemove(refs: readonly string[], d: QueueDeps): number {
  if (refs.length === 0) {
    d.err("usage: loki queue remove <issue...>   (owner/repo#N, #N, N or a GitHub issue URL)\n");
    return 2;
  }
  const norm: string[] = [];
  for (const r of refs) {
    const n = normalizeRef(r);
    if (!n) {
      d.err(`loki queue remove: not an issue reference: ${r}\n`);
      return 2;
    }
    norm.push(n);
  }
  quarantineCorruptQueue(d.lokiDir, d.now(), d.err);
  let items = readQueue(d.lokiDir);
  let removed = 0;
  for (const ref of new Set(norm)) {
    if (!items.some((i) => i.ref === ref)) {
      d.out(`not queued: ${ref}\n`);
      continue;
    }
    items = items.filter((i) => i.ref !== ref);
    removed++;
    d.out(`removed: ${ref}\n`);
  }
  if (removed > 0) writeQueue(d.lokiDir, items);
  d.out(`${removed} removed, ${items.length} left\n`);
  return 0;
}

export function queueClear(d: QueueDeps): number {
  quarantineCorruptQueue(d.lokiDir, d.now(), d.err);
  const n = readQueue(d.lokiDir).length;
  if (n > 0) writeQueue(d.lokiDir, []);
  d.out(`${n} removed, 0 left\n`);
  return 0;
}

export function formatAge(addedAt: string, now: Date): string {
  const t = Date.parse(addedAt);
  if (!Number.isFinite(t)) return "unknown";
  const sec = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function queueList(d: QueueDeps, json = false): number {
  const items = readQueue(d.lokiDir);
  if (json) {
    d.out(JSON.stringify(items.map((it) => it.ref)) + "\n");
    return 0;
  }
  if (items.length === 0) {
    d.out("queue is empty\nnext: loki queue add <issue...>  (owner/repo#N, #N or an issue URL)\n");
    return 0;
  }
  const rows = items.map((it) => ({ id: it.ref, age: formatAge(it.added_at, d.now()), status: "queued" }));
  const w = Math.max(2, ...rows.map((r) => r.id.length));
  const aw = Math.max(3, ...rows.map((r) => r.age.length));
  d.out(`${"ID".padEnd(w)}  ${"AGE".padEnd(aw)}  STATUS\n`);
  for (const r of rows) d.out(`${r.id.padEnd(w)}  ${r.age.padEnd(aw)}  ${r.status}\n`);
  d.out(`${rows.length} queued\n`);
  return 0;
}

export interface DigestRow {
  ref: string;
  verdict: string;
  pr: string | null;
  cost: string;
  note: string;
  position?: string; // "n/m" place in this run, shown in the digest next to the ref
}

export interface Skipped {
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
    L.push(r.position ? `  [${r.position}] ${r.ref}` : `  ${r.ref}`);
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

// --max-total-cost <usd> or --max-total-cost=<usd>: null when absent, NaN when present but not a positive number.
export function parseMaxTotalCost(args: readonly string[]): number | null {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--max-total-cost") raw = args[i + 1] ?? "";
    else if (a.startsWith("--max-total-cost=")) raw = a.slice("--max-total-cost=".length);
  }
  if (raw === undefined) return null;
  const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  return n > 0 ? n : Number.NaN;
}

const QUEUE_SUBCOMMANDS = ["add", "list", "remove", "rm", "clear", "run"] as const;
const QUEUE_RUN_FLAGS = ["--no-pr", "--max-total-cost"] as const;
const QUEUE_USAGE = "usage: loki queue <add <issue...> | list [--json] | remove <issue...> | clear | run [--no-pr] [--max-total-cost <usd>]>\n";

// First argument queue run does not understand (so a mistyped --no-pr cannot open PRs), or null when all are valid.
function unknownRunArg(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--no-pr" || a.startsWith("--max-total-cost=")) continue;
    if (a === "--max-total-cost") {
      i++;
      continue;
    }
    return a;
  }
  return null;
}

export async function queueRun(args: readonly string[], d: QueueDeps): Promise<number> {
  const bad = unknownRunArg(args);
  if (bad !== null) {
    const flagPart = bad.split("=")[0] as string;
    const guess = suggestWord(flagPart, QUEUE_RUN_FLAGS);
    d.err(`loki queue run: unknown argument '${bad}'${guess ? ` (did you mean '${guess}'?)` : ""}\n${QUEUE_USAGE}`);
    return 2;
  }
  const pr = !args.includes("--no-pr");
  const cap = parseMaxTotalCost(args);
  if (cap !== null && Number.isNaN(cap)) {
    d.err("loki queue run: --max-total-cost needs a positive USD amount, e.g. --max-total-cost 5\n");
    return 2;
  }
  let spent = 0;
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
  const pending = [...remaining];
  const total = pending.length;
  let begun = 0;
  const width = Math.max(1, Math.min(MAX_PARALLEL, Math.floor(d.parallel ?? 1)));
  const lane = async (): Promise<void> => {
    while (stopReason === null) {
      if (cap !== null && spent >= cap) {
        stopReason = `total cost cap $${cap.toFixed(2)} reached (spent $${spent.toFixed(2)})`;
        return;
      }
      const item = pending.shift();
      if (!item) return;
      const g = await d.governor();
      if (g.hold) {
        stopReason = `governor hold: ${g.reason}`;
        return;
      }
      if (!forecastShown) {
        forecastShown = true;
        await printForecast(d.lokiDir, async () => g.usage ?? null, d.err);
      }
      const position = `${++begun}/${total}`;
      d.err(`[${position}] ${item.ref}\n`);
      const t0 = Date.now();
      let res: RunResult;
      try {
        res = await d.runner(item.ref, { pr, ...(d.draft ? { draft: true } : {}) });
      } catch (e) {
        res = { rc: 1, output: `runner threw: ${e instanceof Error ? e.message : String(e)}` };
      }
      const prUrl = PR_RE.exec(res.output)?.[0] ?? null;
      const verdict = res.verdict || (res.rc === 0 ? "COMPLETED (no proof verdict)" : `FAILED (exit ${res.rc})`);
      const row: DigestRow = {
        ref: item.ref,
        position,
        verdict,
        pr: prUrl,
        cost: typeof res.costUsd === "number" ? `$${res.costUsd.toFixed(2)}` : "NOT RECORDED",
        note: g.ok ? "" : `governor unreadable (${g.reason}); proceeded`,
      };
      rows.push(row);
      if (typeof res.costUsd === "number") spent += res.costUsd;
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
      d.onResult?.({ ref: item.ref, res, row, seconds: (Date.now() - t0) / 1000 });
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
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
export function newestRecord(lokiDir: string, since: number): { verdict: string | null; costUsd: number | null; runId?: string | null; didWork?: boolean | null } {
  for (const [sub, file] of [["runs", "receipt.json"], ["proofs", "proof.json"]] as const) {
    const dir = join(lokiDir, sub);
    let best: { t: number; p: string; name: string } | null = null;
    try {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name, file);
        if (!existsSync(p)) continue;
        const t = statSync(p).mtimeMs;
        if (t >= since && (!best || t > best.t)) best = { t, p, name };
      }
      if (!best) continue;
      const d = JSON.parse(readFileSync(best.p, "utf8")) as { verdict?: unknown; base_sha?: unknown; head_sha?: unknown; cost?: { usd?: unknown; source?: unknown } };
      const usd = d.cost?.usd;
      const unmetered = d.cost?.source === "cli-invoker-unmetered";
      return {
        verdict: typeof d.verdict === "string" ? d.verdict : null,
        costUsd: !unmetered && typeof usd === "number" && Number.isFinite(usd) ? usd : null,
        ...(sub === "runs" ? { runId: best.name, didWork: typeof d.base_sha === "string" && typeof d.head_sha === "string" ? d.base_sha !== d.head_sha : null } : {}),
      };
    } catch {
      continue;
    }
  }
  return { verdict: null, costUsd: null };
}

/** The child `loki start` env: the run's own .loki for a worktree, and the PR asks (draft, stacked base, epic ref). */
export function runnerEnv(opts: RunOpts, runLoki: string): NodeJS.ProcessEnv {
  return { ...(opts.env ?? process.env), LOKI_NO_BROWSER: "1", ...(opts.cwd ? { LOKI_DIR: runLoki } : {}), ...(opts.draft ? { LOKI_PR_DRAFT: "1" } : {}), ...(opts.prBase ? { LOKI_PR_BASE: opts.prBase } : {}), ...(opts.prRefs ? { LOKI_PR_REFS: opts.prRefs } : {}) };
}

/** Per-item timeout in minutes: only a positive finite value that fits setTimeout is honored, else 120 with one stderr note. */
export function itemTimeoutMin(raw: string | undefined, warn: (s: string) => void = (s) => void process.stderr.write(s)): number {
  if (raw === undefined || raw.trim() === "") return 120;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n * 60_000 <= 2_147_483_647) return n;
  warn(`loki queue: ignoring invalid LOKI_QUEUE_ITEM_TIMEOUT_MIN=${JSON.stringify(raw)} (need a positive number of minutes); using 120\n`);
  return 120;
}

/** The `loki start` argv for one queue item: engine10 opens a PR by default, so PR-off passes --no-pr and PR-on passes the accepted no-op --pr. */
export function queueStartArgs(ref: string, pr: boolean): string[] {
  return ["start", ref, pr ? "--pr" : "--no-pr"];
}

export function makeDefaultRunner(lokiDir: string): QueueDeps["runner"] {
  return async (ref, opts) => {
    const since = Date.now();
    const argv = [resolve(REPO_ROOT, "bin", "loki"), ...queueStartArgs(ref, !!opts.pr)];
    // A per-issue worktree gets its own .loki so parallel runs never share run state (autonomy/loki refuses that).
    const runLoki = opts.cwd ? join(opts.cwd, ".loki") : lokiDir;
    const env = runnerEnv(opts, runLoki);
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    const mins = itemTimeoutMin(process.env["LOKI_QUEUE_ITEM_TIMEOUT_MIN"]);
    const timer = setTimeout(() => proc.kill(), mins * 60_000);
    const [so, se] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const rc = await proc.exited;
    clearTimeout(timer);
    const output = so + se;
    try {
      const logDir = join(lokiDir, "queue-logs");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `${(opts.logName ?? ref).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120)}.log`), output);
    } catch {
      /* log is best effort */
    }
    const proof = newestRecord(runLoki, since);
    return { rc, output, verdict: proof.verdict, costUsd: proof.costUsd, runId: proof.runId ?? null, didWork: proof.didWork ?? null };
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
    {
      const extra = rest.find((a) => a !== "--json");
      if (extra !== undefined) {
        d.err(`loki queue list: unexpected argument '${extra}'\n${QUEUE_USAGE}`);
        return 2;
      }
      return queueList(d, rest.includes("--json"));
    }
    case "remove":
    case "rm":
      return queueRemove(rest, d);
    case "clear":
      if (rest.length > 0) {
        d.err(`loki queue clear: unexpected argument '${rest[0]}'\n${QUEUE_USAGE}`);
        return 2;
      }
      return queueClear(d);
    case "run":
      return queueRun(rest, d);
    default: {
      if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
        d.err(QUEUE_USAGE);
        return 2;
      }
      const guess = suggestWord(sub, QUEUE_SUBCOMMANDS);
      d.err(`loki queue: unknown subcommand '${sub}'${guess ? ` (did you mean '${guess}'?)` : ""}\n${QUEUE_USAGE}`);
      return 2;
    }
  }
}
