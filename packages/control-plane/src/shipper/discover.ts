// C2 CP-DEFAULT: find a running local Control Plane (docs/v10/CONTROL-PLANE.md section 6). Reads
// ~/.loki/control/instance.json; returns its url only when the pid is alive and /health answers service=loki-control
// within 300 ms. Never starts a server, never throws. LOKI_CONTROL=0 disables discovery.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { sourceId } from "./ship.ts";
import { registryRepos } from "./watch.ts";

export const instancePath = (env: NodeJS.ProcessEnv): string => join(env.HOME || homedir(), ".loki", "control", "instance.json");

export interface DiscoverOpts { fetchImpl?: typeof fetch | undefined; alive?: ((pid: number) => boolean) | undefined }

const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function isLoopbackHttp(u: string): boolean {
  try { const p = new URL(u); return p.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(p.hostname); } catch { return false; }
}

export interface LocalRepo { sourceId: string; realpath: string; name: string }

/** Local repo discovery for the server: its own repo plus every registered project (existing directories only). Purely local; nothing here comes from /v1/ingest. */
export function discoverLocalRepos(repoDir: string, env: NodeJS.ProcessEnv = process.env): LocalRepo[] {
  const out = new Map<string, LocalRepo>();
  for (const dir of [repoDir, ...registryRepos(env)]) {
    try {
      const real = realpathSync(dir);
      if (!statSync(real).isDirectory()) continue;
      const id = sourceId(real);
      if (!out.has(id)) out.set(id, { sourceId: id, realpath: real, name: basename(real) });
    } catch { /* a vanished or unreadable path is simply not a repo */ }
  }
  return [...out.values()];
}

export async function discoverControlUrl(env: NodeJS.ProcessEnv, o: DiscoverOpts = {}): Promise<string | null> {
  if (env.LOKI_CONTROL === "0") return null;
  if (env.LOKI_CONTROL_URL) return env.LOKI_CONTROL_URL;
  try {
    const inst = JSON.parse(readFileSync(instancePath(env), "utf8")) as { pid?: unknown; url?: unknown };
    if (!Number.isInteger(inst.pid) || typeof inst.url !== "string" || !(o.alive ?? isAlive)(inst.pid as number)) return null;
    if (!isLoopbackHttp(inst.url)) return null; // a planted instance.json must never redirect events off this machine
    const url = inst.url.replace(/\/+$/, "");
    const h = (await (await (o.fetchImpl ?? fetch)(`${url}/health`, { signal: AbortSignal.timeout(300) })).json()) as { service?: string };
    return h.service === "loki-control" ? url : null;
  } catch { return null; }
}
