// `loki control serve|backfill|status` (D56 Loki Control Plane, on by default, LOKI_CONTROL=0 turns it off).
// serve runs the bundled service (packages/control-plane/dist/server.js, or the TypeScript source in a checkout) on
// 127.0.0.1. backfill ships .loki/runs through the same shipper the live hook uses. status probes /health.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { instancePath } from "../../../packages/control-plane/src/shipper/discover.ts";
import { ingestAndWatch } from "../../../packages/control-plane/src/shipper/watch.ts";
import { backfill } from "../../../packages/control-plane/src/shipper/backfill.ts";
import { openDb } from "../../../packages/control-plane/src/db/migrate.ts";
import { openReadOnly, parseBefore, pruneRuns, type PruneFilter } from "../../../packages/control-plane/src/db/prune.ts";
import { REPO_ROOT } from "../util/paths.ts";

export const DEFAULT_PORT = 47821;
export const OFF_LINE = "loki control is off (LOKI_CONTROL=0). Unset it to turn the Control Plane back on.";

const HELP = `Usage: loki control <command> [options]   (on by default; LOKI_CONTROL=0 turns it off)

Commands:
  serve [--port N] [--db PATH]   Run the control plane + UI on 127.0.0.1 (default port ${DEFAULT_PORT}, 0 = any free port)
  backfill [DIR]                 Ship DIR/.loki/runs (default: current directory) to the control plane
  prune --repo OWNER/NAME | --before ISO_DATE [--dry-run] [--db PATH]
                                 Delete matching runs, their events and orphaned sources (works with the server up or down)
  status                         Show whether the control plane is reachable and how many runs it holds

The control plane URL comes from LOKI_CONTROL_URL, else http://127.0.0.1:\${LOKI_CONTROL_PORT:-${DEFAULT_PORT}}.
Runs on this machine ship to a running control plane automatically (~/.loki/control/instance.json); LOKI_CONTROL_URL overrides.
`;

const baseUrl = (env: NodeJS.ProcessEnv): string => (env.LOKI_CONTROL_URL || `http://127.0.0.1:${env.LOKI_CONTROL_PORT || DEFAULT_PORT}`).replace(/\/+$/, "");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function serverCmd(): string[] | null {
  const bundled = join(REPO_ROOT, "packages/control-plane/dist/server.js");
  if (existsSync(bundled)) return ["bun", bundled];
  const src = join(REPO_ROOT, "packages/control-plane/src/server/serve.ts");
  // --install=fallback: a checkout whose packages/control-plane has no node_modules still resolves hono and drizzle-orm. Bare
  // auto-install switches OFF as soon as ANY ancestor has a node_modules (CI's repo-root npm install), which killed serve on Linux.
  return existsSync(src) ? ["bun", "--install=fallback", "run", src] : null;
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const installedVersion = (): string => { try { return readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim() || "unknown"; } catch { return "unknown"; } };

/** FC-26: a Control Plane left running across an upgrade keeps serving the old code. Reads the PID that CP recorded in instance.json
 *  (never a name or pattern match), and when its recorded version differs from the installed one and /health still answers as loki-control,
 *  SIGTERMs that one PID (the serve wrapper, which stops its child) and waits for it to exit. Returns the restarted PID or null. */
export async function restartStaleControlPlane(env: NodeJS.ProcessEnv, current: string = installedVersion(), opts: { alive?: (pid: number) => boolean; waitMs?: number } = {}): Promise<number | null> {
  const alive = opts.alive ?? pidAlive;
  let inst: { pid?: unknown; url?: unknown; version?: unknown };
  try { inst = JSON.parse(readFileSync(instancePath(env), "utf8")); } catch { return null; }
  if (!Number.isInteger(inst.pid) || (inst.pid as number) <= 1 || (inst.pid as number) === process.pid || typeof inst.url !== "string") return null;
  const pid = inst.pid as number;
  if (!alive(pid)) return null;
  let running = typeof inst.version === "string" ? inst.version : "unknown";
  try {
    const h = (await (await fetch(`${inst.url}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { service?: string; version?: string };
    if (h.service !== "loki-control") return null; // the recorded pid now belongs to something else
    if (typeof h.version === "string") running = h.version;
  } catch { return null; }
  if (running === current) return null;
  process.stderr.write(`loki control: Control Plane is out of date (running ${running}, installed ${current}), restarting\n`);
  try { process.kill(pid, "SIGTERM"); } catch { return null; }
  const until = Date.now() + (opts.waitMs ?? 8000);
  while (alive(pid) && Date.now() < until) await sleep(50);
  return alive(pid) ? null : pid;
}

async function serve(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const explicit = flag(args, "--port") ?? env.LOKI_CONTROL_PORT;
  const port = explicit ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(port) || Number(port) > 65535) { process.stderr.write(`loki control: invalid --port ${port}\n`); return 2; }
  const db = resolve(flag(args, "--db") ?? env.LOKI_CONTROL_DB ?? join(env.HOME || homedir(), ".loki", "control", "control.db"));
  const cmd = serverCmd();
  if (!cmd) { process.stderr.write("loki control: server not found (packages/control-plane is missing from this install)\n"); return 1; }
  mkdirSync(dirname(db), { recursive: true });
  await restartStaleControlPlane(env);
  // the default port falls back to any free port when taken (the printed URL is the real one); an explicit port never does
  const child = Bun.spawn(cmd, { env: { ...env, PORT: port, LOKI_CONTROL_DB: db, LOKI_CONTROL_VERSION: installedVersion(), LOKI_VERSION_FILE: join(REPO_ROOT, "VERSION"), LOKI_CONTROL_PORT_FALLBACK: explicit === undefined ? "1" : "0" }, stdio: ["inherit", "pipe", "inherit"] });
  // the service must not outlive this CLI: forward stop signals and also kill on any exit path
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill());
  const inst = instancePath(env);
  const rmInst = (): void => { try { if ((JSON.parse(readFileSync(inst, "utf8")) as { pid?: number }).pid === process.pid) rmSync(inst, { force: true }); } catch { /* none */ } };
  process.on("exit", () => { child.kill(); rmInst(); });
  // tee the child's stdout; its "listening on" line publishes ~/.loki/control/instance.json for run discovery (C2)
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
    process.stdout.write(chunk);
    buf = (buf + dec.decode(chunk, { stream: true })).slice(-4096);
    const m = /listening on (http:\/\/[^\s:]+:(\d+))/.exec(buf);
    if (!m) continue;
    let version = "unknown";
    try { version = readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim(); } catch { /* keep */ }
    mkdirSync(dirname(inst), { recursive: true, mode: 0o700 });
    writeFileSync(inst, `${JSON.stringify({ pid: process.pid, port: Number(m[2]), url: m[1], version, install_path: REPO_ROOT, db })}\n`, { mode: 0o600 });
    chmodSync(inst, 0o600); // an existing file keeps its old mode through writeFileSync
    buf = "";
    // CP-INGEST: backfill this repo and every registered project, then tail .loki/runs so live runs appear with no setup
    if (env.LOKI_CONTROL_AUTOINGEST !== "0") {
      void ingestAndWatch({ repoDir: process.cwd(), url: m[1]!, env }).then((w) => { process.on("exit", () => w.stop()); }).catch(() => { /* ingest is best effort */ });
    }
  }
  const code = await child.exited;
  rmInst();
  return code;
}

async function status(env: NodeJS.ProcessEnv): Promise<number> {
  const url = baseUrl(env);
  try {
    const h = (await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { service?: string; pid?: number };
    if (h.service !== "loki-control") throw new Error("not a loki control plane");
    let runs: string;
    try {
      const res = await fetch(`${url}/v1/runs?limit=1`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = (await res.json()) as { total?: unknown };
      if (typeof r.total !== "number") throw new Error("no total in response");
      runs = `${r.total} runs`;
    } catch (e) {
      runs = `runs: unknown (${(e as Error).message})`;
    }
    process.stdout.write(`loki control: up at ${url} (pid ${h.pid}), ${runs}\n`);
    return 0;
  } catch (e) {
    process.stdout.write(`loki control: not reachable at ${url} (${(e as Error).message}). Start it with: loki control serve\n`);
    return 1;
  }
}

// prune opens the SQLite file directly (WAL, 5 s busy timeout, one BEGIN IMMEDIATE transaction) instead of calling the server:
// it works with the server stopped, and a running server only ever waits on this short write lock, never sees a half-delete.
function prune(args: string[], env: NodeJS.ProcessEnv): number {
  const err = (m: string): number => { process.stderr.write(`loki control prune: ${m}\n`); return 2; };
  const known = new Set(["--repo", "--before", "--db", "--dry-run"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!known.has(a)) return err(`unknown argument '${a}'`);
    if (a !== "--dry-run") { if (args[i + 1] === undefined || args[i + 1]!.startsWith("--")) return err(`${a} needs a value`); i++; }
  }
  const f: PruneFilter = {};
  const repo = flag(args, "--repo"), beforeRaw = flag(args, "--before");
  if (repo !== undefined) { if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return err(`--repo must be owner/name, got '${repo}'`); f.repo = repo; }
  if (beforeRaw !== undefined) {
    const b = parseBefore(beforeRaw);
    if (b === null) return err(`--before '${beforeRaw}' is not a valid ISO 8601 date (use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)`);
    f.before = b;
  }
  if (f.repo === undefined && f.before === undefined) return err("a filter is required: --repo OWNER/NAME and/or --before ISO_DATE");
  const dry = args.includes("--dry-run");
  const db = resolve(flag(args, "--db") ?? env.LOKI_CONTROL_DB ?? join(env.HOME || homedir(), ".loki", "control", "control.db"));
  if (!existsSync(db)) { process.stdout.write(`loki control: no control database at ${db}, nothing to ${dry ? "remove" : "prune"}\n`); return 0; }
  let sqlite: ReturnType<typeof openDb>["sqlite"] | undefined;
  try {
    // a dry run is strictly read-only: no migrations, no WAL change, no audit row
    sqlite = dry ? openReadOnly(db) : openDb(db).sqlite;
    const c = pruneRuns(sqlite, f, { dryRun: dry, actor: "cli" });
    process.stdout.write(`loki control: ${dry ? "would remove" : "removed"} ${c.runs} runs, ${c.events} events, ${c.sources} orphaned sources${dry ? " (dry run, nothing changed)" : ""}\n`);
    return 0;
  } catch (e) {
    const m = (e as Error).message;
    process.stderr.write(`loki control prune: nothing was ${dry ? "counted" : "removed"}: ${/no such table/.test(m) ? `this database has an older schema than this version (${m}); run 'loki control serve' once to migrate it` : m}\n`);
    return 1;
  } finally { sqlite?.close(); }
}

export async function runControl(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { process.stdout.write(HELP); return 0; }
  if (env.LOKI_CONTROL === "0") { process.stdout.write(`${OFF_LINE}\n`); return 0; }
  switch (sub) {
    case "serve": return serve(rest, env);
    case "status": return status(env);
    case "prune": return prune(rest, env);
    case "backfill": {
      const dir = resolve(flag(rest, "--repo") ?? rest.find((a) => !a.startsWith("-")) ?? process.cwd());
      const r = await backfill({ repoDir: dir, env: { ...env, LOKI_CONTROL_URL: baseUrl(env) } });
      process.stdout.write(`loki control: backfill ${r.runs} runs, ${r.sent} events sent, ${r.failed.length} failed${r.failed.length ? ` (${r.failed.join(", ")})` : ""}\n`);
      return r.failed.length ? 1 : 0;
    }
    default:
      process.stderr.write(`loki control: unknown command '${sub}'\n${HELP}`);
      return 2;
  }
}
