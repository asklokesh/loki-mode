// `loki control serve|backfill|status` (D56 Loki Control Plane, on by default, LOKI_CONTROL=0 turns it off).
// serve runs the bundled service (packages/control-plane/dist/server.js, or the TypeScript source in a checkout) on
// 127.0.0.1. backfill ships .loki/runs through the same shipper the live hook uses. status probes /health.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { instancePath } from "../../../packages/control-plane/src/shipper/discover.ts";
import { backfill } from "../../../packages/control-plane/src/shipper/backfill.ts";
import { REPO_ROOT } from "../util/paths.ts";

export const DEFAULT_PORT = 47821;
export const OFF_LINE = "loki control is off (LOKI_CONTROL=0). Unset it to turn the Control Plane back on.";

const HELP = `Usage: loki control <command> [options]   (on by default; LOKI_CONTROL=0 turns it off)

Commands:
  serve [--port N] [--db PATH]   Run the control plane + UI on 127.0.0.1 (default port ${DEFAULT_PORT}, 0 = any free port)
  backfill [DIR]                 Ship DIR/.loki/runs (default: current directory) to the control plane
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

async function serve(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const explicit = flag(args, "--port") ?? env.LOKI_CONTROL_PORT;
  const port = explicit ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(port) || Number(port) > 65535) { process.stderr.write(`loki control: invalid --port ${port}\n`); return 2; }
  const db = resolve(flag(args, "--db") ?? env.LOKI_CONTROL_DB ?? join(env.HOME || homedir(), ".loki", "control", "control.db"));
  const cmd = serverCmd();
  if (!cmd) { process.stderr.write("loki control: server not found (packages/control-plane is missing from this install)\n"); return 1; }
  mkdirSync(dirname(db), { recursive: true });
  // the default port falls back to any free port when taken (the printed URL is the real one); an explicit port never does
  const child = Bun.spawn(cmd, { env: { ...env, PORT: port, LOKI_CONTROL_DB: db, LOKI_CONTROL_PORT_FALLBACK: explicit === undefined ? "1" : "0" }, stdio: ["inherit", "pipe", "inherit"] });
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

export async function runControl(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { process.stdout.write(HELP); return 0; }
  if (env.LOKI_CONTROL === "0") { process.stdout.write(`${OFF_LINE}\n`); return 0; }
  switch (sub) {
    case "serve": return serve(rest, env);
    case "status": return status(env);
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
