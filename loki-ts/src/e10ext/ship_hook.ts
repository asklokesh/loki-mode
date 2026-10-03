// CP-02: live shipping hook (docs/v10/CONTROL-PLANE.md section 5). Started by supervisor.ts unless LOKI_CONTROL=0; ships when LOKI_CONTROL_URL is set or a live local instance is discovered.
// Fire-and-forget: the timer is unref'd and nothing here throws or changes the run's exit code or output. Whatever is unshipped
// at exit is replayed by `loki control backfill` (ship.json keeps the cursor).
import { dirname } from "node:path";
import { discoverControlUrl, discoveryRefusal, gitOrigin } from "../../../packages/control-plane/src/shipper/discover.ts";
import { shipEnabled, sourceId, startShipLoop } from "../../../packages/control-plane/src/shipper/ship.ts";

export async function startShip(repoDir: string, eventsPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  let url = shipEnabled(env);
  if (!url) {
    if (discoveryRefusal(repoDir, gitOrigin(repoDir, env), env) !== null) return; // P0: never auto-ship a temp or fixture repo to a live local instance
    url = await discoverControlUrl(env); // C2: a live local instance.json counts; never starts a server
  }
  if (!url) return;
  startShipLoop({ runDir: dirname(eventsPath), url, source: sourceId(repoDir), token: env.LOKI_CONTROL_TOKEN });
}
