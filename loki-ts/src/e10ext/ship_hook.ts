// CP-02: live shipping hook (docs/v10/CONTROL-PLANE.md section 5). Started by supervisor.ts unless LOKI_CONTROL=0; ships when LOKI_CONTROL_URL is set or a live local instance is discovered.
// Fire-and-forget: the timer is unref'd and nothing here throws or changes the run's exit code or output. Whatever is unshipped
// at exit is replayed by `loki control backfill` (ship.json keeps the cursor).
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { discoverControlUrl, discoveryRefusal } from "../../../packages/control-plane/src/shipper/discover.ts";
import { backoffMs, shipEnabled, shipRun, sourceId } from "../../../packages/control-plane/src/shipper/ship.ts";

function originOf(repoDir: string): string | null {
  try { return execFileSync("git", ["-C", repoDir, "config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

export async function startShip(repoDir: string, eventsPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  let url = shipEnabled(env);
  if (!url) {
    if (discoveryRefusal(repoDir, originOf(repoDir), env) !== null) return; // P0: never auto-ship a temp or fixture repo to a live local instance
    url = await discoverControlUrl(env); // C2: a live local instance.json counts; never starts a server
  }
  if (!url) return;
  const runDir = dirname(eventsPath);
  const source = sourceId(repoDir);
  let failures = 0, nextAt = 0, busy = false;
  const tick = async (): Promise<void> => {
    if (busy || Date.now() < nextAt) return;
    busy = true;
    try {
      const r = await shipRun({ runDir, url, source, token: env.LOKI_CONTROL_TOKEN, timeoutMs: 5000 });
      failures = r.ok ? 0 : failures + 1;
      nextAt = r.ok ? 0 : Date.now() + backoffMs(failures);
    } catch { failures++; } finally { busy = false; }
  };
  setInterval(() => void tick(), 300).unref();
}
