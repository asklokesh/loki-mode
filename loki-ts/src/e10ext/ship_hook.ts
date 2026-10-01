// CP-02: live shipping hook (docs/v10/CONTROL-PLANE.md section 5). Started by supervisor.ts only when LOKI_CONTROL_URL is set.
// Fire-and-forget: the timer is unref'd and nothing here throws or changes the run's exit code or output. Whatever is unshipped
// at exit is replayed by `loki control backfill` (ship.json keeps the cursor).
import { dirname } from "node:path";
import { backoffMs, shipEnabled, shipRun, sourceId } from "../../../packages/control-plane/src/shipper/ship.ts";

export function startShip(repoDir: string, eventsPath: string, env: NodeJS.ProcessEnv): void {
  const url = shipEnabled(env);
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
