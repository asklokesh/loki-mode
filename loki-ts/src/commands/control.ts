// `loki control serve|backfill|status` (D56 Loki Control Plane, preview, gated behind LOKI_CONTROL=1).
// serve runs the bundled service (packages/control-plane/dist/server.js, or the TypeScript source in a checkout) on
// 127.0.0.1. backfill ships .loki/runs through the same shipper the live hook uses. status probes /health.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backfill } from "../../../packages/control-plane/src/shipper/backfill.ts";
import { REPO_ROOT } from "../util/paths.ts";

export const DEFAULT_PORT = 47821;
export const PREVIEW_LINE = "loki control is in preview. Enable it with: export LOKI_CONTROL=1";

const HELP = `Usage: loki control <command> [options]   (preview, requires LOKI_CONTROL=1)

Commands:
  serve [--port N] [--db PATH]   Run the control plane + UI on 127.0.0.1 (default port ${DEFAULT_PORT}, 0 = any free port)
  backfill [DIR]                 Ship DIR/.loki/runs (default: current directory) to the control plane
  status                         Show whether the control plane is reachable and how many runs it holds

The control plane URL comes from LOKI_CONTROL_URL, else http://127.0.0.1:\${LOKI_CONTROL_PORT:-${DEFAULT_PORT}}.
Set LOKI_CONTROL_URL on 'loki start' to ship runs live.
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
  return existsSync(src) ? ["bun", "run", src] : null;
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
  const child = Bun.spawn(cmd, { env: { ...env, PORT: port, LOKI_CONTROL_DB: db, LOKI_CONTROL_PORT_FALLBACK: explicit === undefined ? "1" : "0" }, stdio: ["inherit", "inherit", "inherit"] });
  // the service must not outlive this CLI: forward stop signals and also kill on any exit path
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill());
  process.on("exit", () => child.kill());
  return await child.exited;
}

async function status(env: NodeJS.ProcessEnv): Promise<number> {
  const url = baseUrl(env);
  try {
    const h = (await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { service?: string; pid?: number };
    if (h.service !== "loki-control") throw new Error("not a loki control plane");
    const r = (await (await fetch(`${url}/v1/runs?limit=1`, { signal: AbortSignal.timeout(3000) })).json()) as { total?: number };
    process.stdout.write(`loki control: up at ${url} (pid ${h.pid}), ${r.total ?? 0} runs\n`);
    return 0;
  } catch (e) {
    process.stdout.write(`loki control: not reachable at ${url} (${(e as Error).message}). Start it with: loki control serve\n`);
    return 1;
  }
}

export async function runControl(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { process.stdout.write(HELP); return 0; }
  if (env.LOKI_CONTROL !== "1") { process.stdout.write(`${PREVIEW_LINE}\n`); return 0; }
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
