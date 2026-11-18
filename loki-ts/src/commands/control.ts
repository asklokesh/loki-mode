// `loki control serve|backfill|status` (D56 Loki Control Plane, on by default, LOKI_CONTROL=0 turns it off).
// serve runs the bundled service (packages/control-plane/dist/server.js, or the TypeScript source in a checkout) on
// 127.0.0.1. backfill ships .loki/runs through the same shipper the live hook uses. status probes /health.
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SAFE_BUN_FLAGS } from "../runner/worker_proc.ts";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { instancePath, isLoopbackHttp, isThrowawayPath } from "../../../packages/control-plane/src/shipper/discover.ts";
import { ingestAndWatch } from "../../../packages/control-plane/src/shipper/watch.ts";
import { backfill } from "../../../packages/control-plane/src/shipper/backfill.ts";
import { openDb } from "../../../packages/control-plane/src/db/migrate.ts";
import { openReadOnly, parseBefore, pruneRuns, type PruneFilter } from "../../../packages/control-plane/src/db/prune.ts";
import { REPO_ROOT } from "../util/paths.ts";
import { suggestWord } from "../cli/registry.ts";

const CONTROL_SUBCOMMANDS = ["serve", "open", "backfill", "prune", "stop", "status", "help"] as const;

export const DEFAULT_PORT = 47821;
export const OFF_LINE = "loki control is off (LOKI_CONTROL=0). Unset it to turn the Control Plane back on.";

const HELP = `Usage: loki control <command> [options]   (on by default; LOKI_CONTROL=0 turns it off)

Commands:
  serve [--port N] [--db PATH]   Run the control plane + UI on 127.0.0.1 (default port ${DEFAULT_PORT}, 0 = any free port)
  open [--no-open]               Open the dashboard in your browser and print its URL; starts it first when needed (also: loki dashboard)
  backfill [DIR]                 Ship DIR/.loki/runs (default: current directory) to the control plane
  prune --repo OWNER/NAME | --before ISO_DATE [--dry-run] [--db PATH]
                                 Delete matching runs, their events and orphaned sources (works with the server up or down)
  stop                           Stop the running control plane (PID from ~/.loki/control/instance.json, verified via /health)
  status [--json]                Show whether the control plane is reachable and how many runs it holds (--json: one JSON object)

The control plane URL comes from LOKI_CONTROL_URL, else http://127.0.0.1:\${LOKI_CONTROL_PORT:-${DEFAULT_PORT}}.
Runs on this machine ship to a running control plane automatically (~/.loki/control/instance.json); LOKI_CONTROL_URL overrides.
`;

const baseUrl = (env: NodeJS.ProcessEnv): string => (env.LOKI_CONTROL_URL || `http://127.0.0.1:${env.LOKI_CONTROL_PORT || DEFAULT_PORT}`).replace(/\/+$/, "");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A value flag that is present but has no value (end of args, or the next token is another flag) must fail, never fall back to a default. */
function missingValue(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  return i >= 0 && (args[i + 1] === undefined || args[i + 1]!.startsWith("--"));
}

function serverCmd(): string[] | null {
  const bundled = join(REPO_ROOT, "packages/control-plane/dist/server.js");
  if (existsSync(bundled)) return ["bun", ...SAFE_BUN_FLAGS, bundled];
  const src = join(REPO_ROOT, "packages/control-plane/src/server/serve.ts");
  // --install=fallback: a checkout whose packages/control-plane has no node_modules still resolves hono and drizzle-orm. Bare
  // auto-install switches OFF as soon as ANY ancestor has a node_modules (CI's repo-root npm install), which killed serve on Linux.
  return existsSync(src) ? ["bun", ...SAFE_BUN_FLAGS, "--install=fallback", "run", src] : null;
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const installedVersion = (): string => { try { return readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim() || "unknown"; } catch { return "unknown"; } };

/** FC-26: a Control Plane left running across an upgrade keeps serving the old code, and one whose install was deleted keeps answering /health
 *  while every page fails. Reads the PID that CP recorded in instance.json (never a name or pattern match), and when /health still answers as
 *  loki-control and the server is stale (staleReason: install gone, dashboard page gone, or another version), SIGTERMs that one PID (the serve
 *  wrapper, which stops its child) and waits for it to exit. Returns the stopped PID or null. */
export async function restartStaleControlPlane(env: NodeJS.ProcessEnv, current: string = installedVersion(), opts: StaleOpts = {}): Promise<number | null> {
  const alive = opts.alive ?? pidAlive;
  let inst: { pid?: unknown; url?: unknown; version?: unknown; install_path?: unknown };
  try { inst = JSON.parse(readFileSync(recordFile(env, opts), "utf8")); } catch { return null; }
  if (!Number.isInteger(inst.pid) || (inst.pid as number) <= 1 || (inst.pid as number) === process.pid || typeof inst.url !== "string") return null;
  const pid = inst.pid as number;
  if (!alive(pid)) return null;
  const h = await healthOf(inst.url, 3000, opts.fetchImpl);
  if (!h) return null; // nothing answers as loki-control there: the recorded pid now belongs to something else
  const why = staleReason(h, inst, current, opts);
  if (!why) return null;
  return (await stopStale(pid, why, opts)) ? pid : null;
}

export interface Health { service?: string; pid?: number; version?: string; install_path?: string; ui?: boolean }
export interface StaleOpts { alive?: (pid: number) => boolean; waitMs?: number; fetchImpl?: typeof fetch; /** does this path exist (tests) */ exists?: (p: string) => boolean; /** this install has a built dashboard page (tests) */ ownUi?: boolean; /** this install lives in a throwaway path (tests) */ throwaway?: boolean }
const UI_INDEX = "packages/control-plane/ui/dist/index.html";

/** An install in a temp directory (a test or CI install, a fixture). LOKI_CONTROL_THROWAWAY_INSTALL=1 says so for any install (it only makes this one more careful). */
export const isThrowawayInstall = (env: NodeJS.ProcessEnv): boolean => env.LOKI_CONTROL_THROWAWAY_INSTALL === "1" || isThrowawayPath(REPO_ROOT);

/** The record this install reads, writes and acts on: ~/.loki/control/instance.json. The one exception: an install in a throwaway path, while
 *  instance.json names a live process of ANOTHER install (the person's real dashboard), uses instance.throwaway.json beside it. So a test or CI
 *  install of another version never stops that dashboard and never rewrites its record: it starts its own on a free port, finds it
 *  again through its own record, and `control stop` from it stops only its own. (The mirror image of a stale server being reused: a throwaway
 *  install must not be able to take the real one down.) */
export function recordFile(env: NodeJS.ProcessEnv, o: { alive?: (pid: number) => boolean; throwaway?: boolean } = {}): string {
  const main = instancePath(env);
  if (!(o.throwaway ?? isThrowawayInstall(env))) return main;
  try {
    const r = JSON.parse(readFileSync(main, "utf8")) as { pid?: unknown; install_path?: unknown };
    if (Number.isInteger(r.pid) && (r.pid as number) > 1 && r.pid !== process.pid && typeof r.install_path === "string" && r.install_path !== REPO_ROOT && (o.alive ?? pidAlive)(r.pid as number)) return join(dirname(main), "instance.throwaway.json");
  } catch { /* no record, or not one of ours to judge: the usual file */ }
  return main;
}

/** The URL in a record file when its process is alive, the URL is loopback http and /health answers there as a Control Plane; else null. */
async function recordedUrl(file: string, o: StaleOpts): Promise<string | null> {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; url?: unknown };
    if (!Number.isInteger(r.pid) || typeof r.url !== "string" || !(o.alive ?? pidAlive)(r.pid as number) || !isLoopbackHttp(r.url)) return null; // a planted record must never point off this machine
    const u = r.url.replace(/\/+$/, "");
    return (await healthOf(u, 300, o.fetchImpl)) ? u : null;
  } catch { return null; }
}

/** /health of a Control Plane, or null when nothing answers there as one. */
async function healthOf(url: string, ms: number, f: typeof fetch = fetch): Promise<Health | null> {
  try { const h = (await (await f(`${url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(ms) })).json()) as Health; return h && h.service === "loki-control" ? h : null; } catch { return null; }
}

/** Why a running Control Plane must not serve this install, or null when it may. A server answers /health from memory long after the install it was
 *  started from is gone, so an answer alone proves nothing. Three checks: the install it runs from still exists; that install still holds the
 *  dashboard page (unless this install has none either, a checkout with no UI build); and it runs this install's version, so a person who upgraded
 *  is not served by the old server. `recorded` is its instance.json entry (the install root), when there is one. */
export function staleReason(h: Health, recorded: { install_path?: unknown; version?: unknown } | null, current: string, o: StaleOpts = {}): string | null {
  const exists = o.exists ?? existsSync;
  const rootOf = (p: string): string => { const i = p.indexOf("/packages/control-plane/"); return i > 0 ? p.slice(0, i) : p; };
  const root = typeof recorded?.install_path === "string" && recorded.install_path ? recorded.install_path : typeof h.install_path === "string" && h.install_path ? rootOf(h.install_path) : null;
  if (root && !exists(root)) return `it was started from an install that no longer exists (${root})`;
  const ui = typeof h.ui === "boolean" ? h.ui : root ? exists(join(root, UI_INDEX)) : true; // a server from before `ui` was reported is checked on disk
  if (!ui && (o.ownUi ?? exists(join(REPO_ROOT, UI_INDEX)))) return `its install${root ? ` (${root})` : ""} no longer holds the dashboard page`;
  const running = typeof h.version === "string" ? h.version : typeof recorded?.version === "string" ? recorded.version : "unknown";
  return running === current ? null : `it is out of date (running ${running}, installed ${current})`;
}

/** SIGTERMs one PID (the one recorded in instance.json, never a name or pattern) and waits for it to exit. */
async function stopStale(pid: number, why: string, o: StaleOpts): Promise<boolean> {
  const alive = o.alive ?? pidAlive;
  process.stderr.write(`loki control: replacing the running Control Plane: ${why}\n`);
  try { process.kill(pid, "SIGTERM"); } catch { return false; }
  const until = Date.now() + (o.waitMs ?? 8000);
  while (alive(pid) && Date.now() < until) await sleep(50);
  return !alive(pid);
}

/** The base URL of a running Control Plane this install may use, or null. The one "is a dashboard up" check for everything that opens or links to it:
 *  a server that is stale (staleReason) is stopped here so the caller starts its own in its place. LOKI_CONTROL=0 finds none. An explicit
 *  LOKI_CONTROL_URL is the operator's choice: used when it answers, never judged and never stopped. */
export async function liveControlPlane(env: NodeJS.ProcessEnv, o: StaleOpts & { current?: string } = {}): Promise<string | null> {
  if (env.LOKI_CONTROL === "0") return null;
  if (env.LOKI_CONTROL_URL) { const u = env.LOKI_CONTROL_URL.replace(/\/+$/, ""); return (await healthOf(u, 1000, o.fetchImpl)) ? u : null; }
  const current = o.current ?? installedVersion();
  await restartStaleControlPlane(env, current, o);
  const found = await recordedUrl(recordFile(env, o), o);
  if (found) {
    let inst: { install_path?: unknown; version?: unknown } | null = null;
    try { inst = JSON.parse(readFileSync(recordFile(env, o), "utf8")); } catch { /* judged from /health alone */ }
    const h = await healthOf(found, 1000, o.fetchImpl);
    if (h && !staleReason(h, inst, current, o)) return found;
  }
  // No usable record: a server may still answer on the configured port (its record was removed, or it was started by hand).
  const port = env.LOKI_CONTROL_PORT || String(DEFAULT_PORT);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  const url = `http://127.0.0.1:${port}`;
  if (url === found) return null;
  const h = await healthOf(url, 300, o.fetchImpl);
  if (!h) return null;
  // A stale server with no record is not reused and not signalled (only a PID recorded in instance.json is ever stopped): the caller starts its
  // own, and `control serve` takes another free port when the default one is still held.
  return staleReason(h, null, current, o) ? null : url;
}

/** `loki control stop`: SIGTERMs only the PID recorded in instance.json, and only after that instance's /health answers as loki-control.
 *  A dead or missing record is not an error (exit 0); a live PID whose /health does not match is refused (exit 1) and never signalled. */
export async function stopControlPlane(env: NodeJS.ProcessEnv, opts: { alive?: (pid: number) => boolean; waitMs?: number } = {}): Promise<number> {
  const alive = opts.alive ?? pidAlive;
  const file = recordFile(env, opts);
  let inst: { pid?: unknown; url?: unknown };
  try { inst = JSON.parse(readFileSync(file, "utf8")); } catch { process.stdout.write("loki control: not running\n"); return 0; }
  const pid = inst.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid || typeof inst.url !== "string" || !alive(pid)) {
    rmSync(file, { force: true });
    process.stdout.write("loki control: not running (removed stale instance record)\n");
    return 0;
  }
  try {
    const h = (await (await fetch(`${inst.url}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { service?: string };
    if (h.service !== "loki-control") throw new Error("health identity is not loki-control");
  } catch (e) {
    process.stderr.write(`loki control: refusing to stop pid ${pid}: ${(e as Error).message}\n`);
    return 1;
  }
  try { process.kill(pid, "SIGTERM"); } catch (e) { process.stderr.write(`loki control: could not signal pid ${pid}: ${(e as Error).message}\n`); return 1; }
  const until = Date.now() + (opts.waitMs ?? 8000);
  while (alive(pid) && Date.now() < until) await sleep(50);
  if (alive(pid)) { process.stderr.write(`loki control: pid ${pid} did not exit after SIGTERM\n`); return 1; }
  rmSync(file, { force: true });
  process.stdout.write(`loki control: stopped (pid ${pid})\n`);
  return 0;
}

export interface EnsureOpts extends StaleOpts {
  current?: string;
  /** the directory the server is started in: it reads that repository's .loki/runs, so a run started there shows up without any setup */
  cwd?: string;
  waitMs?: number;
  /** true: the wait never keeps the process alive on its own (the live console must not hold a finished run open) */
  unref?: boolean;
  /** starts `loki control serve` detached and returns its pid (tests record the call instead) */
  startImpl?: (argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; log: string }) => number | undefined;
}

function startDetached(argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; log: string }): number | undefined {
  const fd = openSync(o.log, "a", 0o600);
  try {
    const c = nodeSpawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", fd, fd] });
    c.on("error", () => { /* reported by the wait below: nothing answers */ });
    c.unref();
    return c.pid;
  } finally { closeSync(fd); }
}

/** A Control Plane this install may use: the running one (liveControlPlane, which replaces a stale one), else one started here the way
 *  `loki control serve` starts it, detached, with the user's own data directory, waited on for about 5 seconds. Throws an Error whose message is
 *  the short reason when there is none to be had; it never throws anything else and never waits longer than waitMs plus the probes' timeouts. */
export async function ensureControlPlane(env: NodeJS.ProcessEnv, o: EnsureOpts = {}): Promise<{ url: string; started: boolean }> {
  const live = await liveControlPlane(env, o);
  if (live) return { url: live, started: false };
  if (env.LOKI_CONTROL === "0") throw new Error("the Control Plane is off (LOKI_CONTROL=0)");
  if (env.LOKI_CONTROL_URL) throw new Error(`nothing answers at ${env.LOKI_CONTROL_URL}`);
  const entry = [join(REPO_ROOT, "loki-ts/dist/loki.js"), join(REPO_ROOT, "loki-ts/src/cli.ts")].find((p) => existsSync(p));
  if (!entry || !serverCmd()) throw new Error("this install has no Control Plane server");
  const dir = join(env.HOME || homedir(), ".loki", "control"), log = join(dir, "serve.log"), alive = o.alive ?? pidAlive, wait = o.waitMs ?? (Number(env.LOKI_CONTROL_START_WAIT_MS) || 5000); // the env knob is for slow machines and CI
  let pid: number | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    pid = (o.startImpl ?? startDetached)(["bun", ...SAFE_BUN_FLAGS, entry, "control", "serve"], { cwd: o.cwd ?? process.cwd(), env: { ...env, LOKI_CONTROL: "1", LOKI_NO_BROWSER: "1" }, log });
    if (pid) writeFileSync(join(dir, "serve.pid"), `${pid}\n`);
  } catch (e) { throw new Error(`it could not be started (${(e as Error).message.split("\n")[0]!.slice(0, 80)})`); }
  const nap = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); if (o.unref) (t as { unref?: () => void }).unref?.(); });
  for (const until = Date.now() + wait; ;) {
    const url = await recordedUrl(recordFile(env, o), o);
    if (url) return { url, started: true };
    if (pid && !alive(pid)) throw new Error("it stopped as it started (see ~/.loki/control/serve.log)");
    if (Date.now() >= until) throw new Error(`it did not answer within ${Math.round(wait / 1000)} s (see ~/.loki/control/serve.log)`);
    await nap(100);
  }
}

/** The command that opens a URL in the person's browser, or null when none should be tried: an opt-out (LOKI_NO_BROWSER=1, and the two older
 *  switches the bash opener honours), CI or a test runner, an SSH session, no terminal on stdout, no display on Linux, or no opener on PATH.
 *  The same rules as autonomy/lib/browser-open.sh, plus SSH and the display. The URL is one argv element; no shell ever sees it. */
export function browserArgv(url: string, env: NodeJS.ProcessEnv, o: { platform?: NodeJS.Platform; tty?: boolean; which?: (cmd: string) => string | null } = {}): string[] | null {
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$'()*+,;=%-]+$/.test(url)) return null;
  const on = (k: string): boolean => env[k] === "1" || env[k] === "true";
  if (on("LOKI_NO_BROWSER") || on("LOKI_NO_AUTO_OPEN") || on("LOKI_HEADLESS")) return null;
  if (env.CI || env.LOKI_TEST || env.BATS_VERSION || env.BATS_TEST_FILENAME || env.PYTEST_CURRENT_TEST) return null;
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return null;
  if (!(o.tty ?? !!process.stdout.isTTY)) return null;
  const platform = o.platform ?? process.platform, which = o.which ?? ((c: string) => Bun.which(c, { PATH: env.PATH ?? "" }));
  if (platform === "darwin") return which("open") ? ["open", url] : null;
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return which("xdg-open") ? ["xdg-open", url] : null;
}

/** Opens the URL in the browser when one should be tried (browserArgv). False means nothing was spawned: the caller prints the URL instead. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv, o: Parameters<typeof browserArgv>[2] & { spawnImpl?: (argv: string[]) => void } = {}): boolean {
  const argv = browserArgv(url, env, o);
  if (!argv) return false;
  try {
    (o.spawnImpl ?? ((a: string[]) => { const c = nodeSpawn(a[0]!, a.slice(1), { detached: true, stdio: "ignore" }); c.on("error", () => { /* no opener after all */ }); c.unref(); }))(argv);
    return true;
  } catch { return false; }
}

const OPEN_USAGE = "Usage: loki control open [--no-open]   (also: loki dashboard)\n\nOpens the dashboard (the Control Plane) in your browser and prints its URL. Starts it first when it is not running.\n  --no-open   print the URL only (LOKI_NO_BROWSER=1 does the same)\n";

/** `loki control open` (and `loki dashboard`): the dashboard's home page, started first when needed. Always prints the URL. */
async function open(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const bad = args.find((a) => a !== "--no-open");
  if (bad !== undefined) { process.stderr.write(`loki control open: unexpected argument '${bad}'\n${OPEN_USAGE}`); return 2; }
  let cp: { url: string; started: boolean };
  try { cp = await ensureControlPlane(env, { cwd: process.cwd() }); } catch (e) {
    process.stderr.write(`loki control: could not start the dashboard: ${(e as Error).message}; run \`loki control serve\`\n`);
    return 1;
  }
  const url = `${cp.url}/`, opened = !args.includes("--no-open") && openBrowser(url, env);
  process.stdout.write(`${url}\n${cp.started ? "Started the dashboard. " : ""}${opened ? "Opened it in your browser.\n" : cp.started ? "\n" : ""}Give it work:   loki start "<brief>"\nStop the UI:    loki control stop\n`);
  return 0;
}

async function serve(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  for (const f of ["--port", "--db"]) {
    if (missingValue(args, f)) { process.stderr.write(`loki control serve: ${f} needs a value\nUsage: loki control serve [--port N] [--db PATH]\n`); return 2; }
  }
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
  const inst = recordFile(env); // a throwaway install never rewrites another install's live record
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

async function status(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const json = args.includes("--json");
  const url = baseUrl(env);
  try {
    const h = (await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { service?: string; pid?: number };
    if (h.service !== "loki-control") throw new Error("not a loki control plane");
    let runs: string;
    let total: number | null = null;
    try {
      const res = await fetch(`${url}/v1/runs?limit=1`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = (await res.json()) as { total?: unknown };
      if (typeof r.total !== "number") throw new Error("no total in response");
      total = r.total;
      runs = `${r.total} runs`;
    } catch (e) {
      runs = `runs: unknown (${(e as Error).message})`;
    }
    if (json) {
      const port = Number(new URL(url).port) || null;
      process.stdout.write(`${JSON.stringify({ running: true, pid: h.pid ?? null, port, url, runs: total })}\n`);
      return 0;
    }
    process.stdout.write(`loki control: up at ${url} (pid ${h.pid}), ${runs}\n`);
    return 0;
  } catch (e) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ running: false, pid: null, port: null, url, runs: null, error: (e as Error).message })}\n`);
      return 1;
    }
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

// stop and status take no positional args; status takes only --json. Anything else is a typo, not something to ignore.
function rejectExtra(sub: "stop" | "status", rest: string[]): boolean {
  const bad = rest.find((a) => !(sub === "status" && a === "--json"));
  if (bad === undefined) return false;
  process.stderr.write(`loki control ${sub}: unexpected argument '${bad}'\nUsage: loki control ${sub === "status" ? "status [--json]" : "stop"}\n`);
  return true;
}

export async function runControl(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { process.stdout.write(HELP); return 0; }
  if (sub === "open" && (rest.includes("--help") || rest.includes("-h"))) { process.stdout.write(OPEN_USAGE); return 0; }
  if (env.LOKI_CONTROL === "0") { process.stdout.write(`${OFF_LINE}\n`); return 0; }
  switch (sub) {
    case "serve": return serve(rest, env);
    case "open": return open(rest, env);
    case "stop": return rejectExtra("stop", rest) ? 2 : stopControlPlane(env);
    case "status": return rejectExtra("status", rest) ? 2 : status(rest, env);
    case "prune": return prune(rest, env);
    case "backfill": {
      if (missingValue(rest, "--repo")) { process.stderr.write("loki control backfill: --repo needs a value\nUsage: loki control backfill [--repo DIR | DIR]\n"); return 2; }
      const dir = resolve(flag(rest, "--repo") ?? rest.find((a) => !a.startsWith("-")) ?? process.cwd());
      const r = await backfill({ repoDir: dir, env: { ...env, LOKI_CONTROL_URL: baseUrl(env) } });
      process.stdout.write(`loki control: backfill ${r.runs} runs, ${r.sent} events sent, ${r.failed.length} failed${r.failed.length ? ` (${r.failed.join(", ")})` : ""}\n`);
      return r.failed.length ? 1 : 0;
    }
    default:
      process.stderr.write(`loki control: unknown command '${sub}'\n`);
      {
        const hint = suggestWord(sub, CONTROL_SUBCOMMANDS);
        if (hint) process.stderr.write(`Did you mean '${hint}'?\n`);
      }
      process.stderr.write(HELP);
      return 2;
  }
}
