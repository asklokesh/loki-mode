// Loki 10 run glue (E-14): wires supervisor, worker, machine, stages, session,
// cost and output into one runnable engine. It is also an entry point:
//   bun src/engine10/run.ts [engine10] "<task>" --no-pr
// reuses cli.ts's router (runEngine10) with a loader that falls back to the
// glue below ONLY when a routed module lacks its export (today supervisor.ts
// and worker.ts export no `main`). Once their owners add `main`, the sibling
// export wins and this fallback goes dead.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runEngine10 } from "./cli.ts";
import { recordSessionCost, sumResultCosts } from "./cost.ts";
import { fold, readEvents, tail } from "./events.ts";
import { fetchIssueToFile } from "./fetch_issue.ts";
import { runMachine } from "./machine.ts";
import { formatHeartbeatLine, formatStageLine, formatSummary } from "./output.ts";
import { createSessionRunner } from "./session.ts";
import { eventsRelPath, githubRepoFromUrl, readOriginUrl, runSupervisor } from "./supervisor.ts";
import { RealTestMapProvider } from "./testmap.ts";
import { DEEP_CAP_S, DEFAULT_CAP_S } from "./types.ts";
import type { EventEnvelope, RunContext, SessionMarkers, SessionRunner, Stage, StageName, StageResult } from "./types.ts";
import { runWorker } from "./worker.ts";
import { implementStage } from "./stages/implement.ts";
import { intakeStage } from "./stages/intake.ts";
import { planStage } from "./stages/plan.ts";
import { commitStage, sealStage } from "./stages/seal.ts";
import { verifyStage } from "./stages/verify.ts";

type Obj = Record<string, unknown>;
const ISSUE_RE = /^(?:[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+\/(?:-\/)?issues\/\d+)$/;

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

interface Parsed { task: string; noPr: boolean; deep: boolean; provider: string; resume: string | null }

function parseArgs(args: string[]): Parsed {
  const p: Parsed = { task: "", noPr: false, deep: false, provider: process.env.LOKI_PROVIDER || "claude", resume: null };
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-pr") p.noPr = true;
    else if (a === "--deep") p.deep = true;
    else if (a === "--provider") p.provider = args[++i] ?? p.provider;
    else if (a === "--resume") p.resume = args[++i] ?? "";
    else words.push(a);
  }
  p.task = words.join(" ").trim();
  return p;
}

/** Same rules as session.ts parseMarkers (not exported there). */
function parseMarkers(text: string): SessionMarkers {
  const done = /LOKI_ALREADY_DONE:\s*(.+)/.exec(text);
  const conflict = /LOKI_SPEC_CONFLICT:\s*(.+)/.exec(text);
  return { done: !done && !conflict, alreadyDone: done?.[1]?.trim() ?? null, specConflict: conflict?.[1]?.trim() ?? null };
}

// ---------------------------------------------------------------- supervisor (P0)

export async function supervisorMain(args: string[]): Promise<number> {
  const p = parseArgs(args);
  if (p.resume !== null) { process.stderr.write("engine10: --resume is not wired yet\n"); return 2; }
  if (!p.task) { process.stderr.write("engine10: no task given\n"); return 2; }
  // ponytail: the PR step (stages/pr.ts runPr) needs a PrContext the supervisor
  // cannot build yet; until it is wired, refuse rather than silently skip it.
  if (!p.noPr) { process.stderr.write("engine10: the PR step is not wired yet; pass --no-pr\n"); return 2; }

  let repoDir: string;
  try { repoDir = gitOut(process.cwd(), ["rev-parse", "--show-toplevel"]); } catch {
    process.stderr.write("engine10: not inside a git repository\n");
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runId = `e10-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
  const runDir = join(repoDir, ".loki", "runs", runId);
  const isIssue = ISSUE_RE.test(p.task);
  const model = process.env.LOKI_MODEL_OVERRIDE || process.env.LOKI_SESSION_MODEL || "default";

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (isIssue) fetchIssueToFile(p.task, join(runDir, "issue.json")); // P1: deterministic, before any LLM
  else env.LOKI_E10_TASK_TEXT = p.task;
  // session.ts forces LOKI_SDK_LOOP=1 for claude and never reads LOKI_E10_INVOKER;
  // LOKI_LEGACY_BASH wins in selectClaudeInvokerKind (providers.ts:148).
  if (process.env.LOKI_E10_INVOKER === "cli") env.LOKI_LEGACY_BASH = "1";

  const t0 = Date.now();
  const eventsPath = join(repoDir, eventsRelPath(runId));
  const live = (e: EventEnvelope): void => {
    const clockS = (Date.parse(e.ts) - t0) / 1000;
    const d = e.data;
    if (e.type === "stage.completed" || e.type === "stage.failed" || e.type === "stage.skipped") {
      const status = e.type === "stage.completed" ? "done" : e.type === "stage.failed" ? "failed" : "skipped";
      const detail = typeof d.reason === "string" ? d.reason : typeof d.summary === "string" ? d.summary : "";
      process.stdout.write(formatStageLine({ clockS, name: String(e.stage), status, durationS: Number(d.duration_s ?? 0), detail }) + "\n");
    } else if (e.type === "heartbeat") {
      process.stdout.write(formatHeartbeatLine({
        clockS, stage: String(e.stage), waitingOn: `${p.provider} session`, elapsedS: Number(d.elapsed_s ?? 0),
        diff: d.diff as { files: number; insertions: number; deletions: number } | null,
      }) + "\n");
    }
  };
  let stopTail = (): void => {};
  const tailTimer = setInterval(() => {
    if (existsSync(eventsPath)) { clearInterval(tailTimer); stopTail = tail(eventsPath, live, { intervalMs: 250 }); }
  }, 100);

  const res = await runSupervisor({
    runId,
    repoDir,
    workerArgv: [process.execPath, import.meta.path, "engine10", "worker", runId, p.provider, model, p.deep ? "deep" : "fast"],
    env,
    capS: p.deep ? DEEP_CAP_S : undefined,
    started: {
      task_source: isIssue ? "issue" : "text", issue_ref: isIssue ? p.task : null, provider: p.provider, model,
      model_override_applied: !!process.env.LOKI_MODEL_OVERRIDE && p.provider === "claude",
      branch: `loki/${runId}`, deep: p.deep, cap_s: p.deep ? DEEP_CAP_S : Number(process.env.LOKI_E10_CAP_S) || DEFAULT_CAP_S,
    },
  });
  clearInterval(tailTimer);
  await new Promise((r) => setTimeout(r, 300)); // let the tail flush the last lines
  stopTail();

  const events = readEvents(eventsPath);
  const f = fold(events);
  const stages = events
    .filter((e) => e.type === "stage.completed" && typeof e.data.duration_s === "number")
    .map((e) => ({ label: String(e.stage), seconds: e.data.duration_s as number }));
  const sawCost = events.some((e) => e.type === "cost");
  const wallS = Number(f.run.completed?.data.wall_s ?? (Date.now() - t0) / 1000);
  process.stdout.write(formatSummary({
    pr: res.prUrl ? { url: res.prUrl, draft: false } : null,
    verdict: res.verdict,
    notProven: res.notProven,
    flaky: [],
    cost: {
      usd: f.cost.usd, provider: p.provider, tokens: sawCost ? f.cost.inputTokens + f.cost.outputTokens : null,
      note: f.cost.usd === null ? (process.env.LOKI_E10_INVOKER === "cli" ? "CLI invoker records no cost" : null) : null,
    },
    wallS,
    stages,
  }) + "\n");
  process.stdout.write(`Run:        ${runId} (${eventsRelPath(runId)})\n`);
  return res.verdict === "FAILED" ? 1 : 0;
}

// ---------------------------------------------------------------- worker (P2)

export async function workerMain(args: string[]): Promise<number> {
  const [runId, provider = "claude", model = "default", mode = "fast"] = args;
  if (!runId) { process.stderr.write("engine10 worker: missing run id\n"); return 2; }
  const repoDir = process.cwd();
  const lokiRoot = join(repoDir, ".loki");
  const runDir = join(lokiRoot, "runs", runId);
  const deep = mode === "deep";
  const origin = readOriginUrl(repoDir); // read before any provider runs
  const baseSha = gitOut(repoDir, ["rev-parse", "HEAD"]);
  const issuePath = join(runDir, "issue.json");
  let task = process.env.LOKI_E10_TASK_TEXT ?? "";
  if (existsSync(issuePath)) {
    const i = JSON.parse(readFileSync(issuePath, "utf8")) as { title?: string; body?: string };
    task = `${i.title ?? ""}\n\n${i.body ?? ""}`.trim();
  }

  await runWorker(async (emit) => {
    const idsByStage: Partial<Record<StageName, string[]>> = {};
    const base = createSessionRunner({ provider, model, emit: emit as never });
    const sessions: SessionRunner = {
      async run(o) {
        const r = await base.run(o);
        // The CLI invoker writes its output only to the iteration log and never
        // tees stdout, so session.ts misses the markers; re-read them there.
        const logPath = join(o.cwd ?? repoDir, ".loki", `iteration-${o.iterationId}.log`);
        if (!r.markers.alreadyDone && !r.markers.specConflict && existsSync(logPath)) {
          r.markers = parseMarkers(readFileSync(logPath, "utf8"));
        }
        const status = r.killed ? "killed" : r.exit === 0 ? "completed" : "failed";
        const c = recordSessionCost(lokiRoot, o.iterationId, { status, durationMs: Math.round(r.durationS * 1000), model });
        emit("cost", o.stage, {
          session_id: o.iterationId, usd: c.usd, input_tokens: c.input_tokens, output_tokens: c.output_tokens,
          cache_read_tokens: c.cache_read_tokens, cache_creation_tokens: c.cache_creation_tokens, source: c.source || "not measured",
        });
        (idsByStage[o.stage] ??= []).push(o.iterationId);
        return r;
      },
    };

    // Intake emits only task_sha256; plan and implement read intake.task,
    // commit reads intake.title, seal reads intake.repo and intake.resumed.
    const intake: Stage = {
      ...intakeStage,
      async run(ctx, signal) {
        const r = await intakeStage.run(ctx, signal);
        if (r.status !== "completed") return r;
        const title = task.split("\n")[0]!.slice(0, 72);
        return { ...r, data: { ...r.data, task, title, repo: githubRepoFromUrl(origin), resumed: false } };
      },
    };
    // seal.ts commitStage stages with `add -A -- . :(exclude).loki`; git exits 1
    // on that pathspec once intake has put .loki/ in .git/info/exclude, so the
    // commit always fails. Fallback only when that exact failure occurs: stage
    // with `add -A -- .` (the exclude file keeps .loki/ out, checked first).
    const commit: Stage = {
      ...commitStage,
      async run(ctx, signal) {
        const r = await commitStage.run(ctx, signal);
        if (r.status !== "failed" || r.reason !== "git add failed") return r;
        try {
          gitOut(repoDir, ["check-ignore", "-q", ".loki/"]);
          gitOut(repoDir, ["add", "-A", "--", "."]);
          try { gitOut(repoDir, ["diff", "--cached", "--quiet"]); return { status: "completed", data: { committed: false } }; } catch { /* staged changes */ }
          const title = (typeof ctx.outputs().intake?.title === "string" ? String(ctx.outputs().intake!.title) : `run ${runId}`).split("\n")[0]!.slice(0, 72);
          gitOut(repoDir, ["commit", "-q", "-m", `loki: ${title || `run ${runId}`}`, "-m", `Loki-Run: ${runId}`]);
          return { status: "completed", data: { committed: true, head_sha: gitOut(repoDir, ["rev-parse", "HEAD"]) } };
        } catch (err) {
          return { status: "failed", data: {}, reason: `commit fallback failed: ${(err as Error).message.split("\n")[0]}` };
        }
      },
    };
    const prSkipped: Stage = {
      name: "pr", targetS: 15, limitS: 60,
      run: async (): Promise<StageResult> => ({ status: "skipped", data: {}, reason: "--no-pr (the PR runs in the supervisor)" }),
    };
    const table: Partial<Record<StageName, Stage>> = {
      intake, plan: planStage, implement: implementStage, verify: verifyStage, commit, seal: sealStage, pr: prSkipped,
    };
    // Seal reads each stage's iteration_ids to price the run.
    const withIds = (s: Stage): Stage => ({
      ...s,
      async run(ctx, signal) {
        const r = await s.run(ctx, signal);
        const ids = idsByStage[s.name];
        return ids?.length ? { ...r, data: { ...r.data, iteration_ids: ids } } : r;
      },
    });

    const ctx: RunContext = {
      runId, repoDir, runDir, baseSha, branch: `loki/${runId}`, provider, model, deep,
      capS: deep ? DEEP_CAP_S : Number(process.env.LOKI_E10_CAP_S) || DEFAULT_CAP_S,
      emit, sessions,
      tests: new RealTestMapProvider(),
      cost: {
        read(dir, ids) {
          const c = sumResultCosts(join(dir, ".loki"), ids);
          return { usd: c.usd, inputTokens: c.input_tokens, outputTokens: c.output_tokens, cacheReadTokens: c.cache_read_tokens };
        },
      },
      clock: { now: () => Date.now() },
      outputs: () => ({}), // replaced by the machine
    };
    await runMachine(ctx, { load: async (n) => (table[n] ? withIds(table[n]!) : null) });
  });
  return 0;
}

// ---------------------------------------------------------------- entry

const FALLBACK: Record<string, [string, (a: string[]) => Promise<number>]> = {
  "./supervisor.ts": ["main", supervisorMain],
  "./worker.ts": ["main", workerMain],
};

export async function glueLoader(spec: string): Promise<Obj> {
  const mod = (await import(spec)) as Obj;
  const fb = FALLBACK[spec];
  if (fb && typeof mod[fb[0]] !== "function") return { ...mod, [fb[0]]: fb[1] };
  return mod;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "engine10") argv.shift(); // bin/loki prepends it
  process.exit(await runEngine10(argv, glueLoader));
}
