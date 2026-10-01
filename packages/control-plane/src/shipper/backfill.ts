// CP-02 backfill: ship every .loki/runs/*/events.jsonl of a repo through the same shipRun path as the live hook.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { backoffMs, hasSpool, shipEnabled, shipRun, sourceId, type ShipResult } from "./ship.ts";

export interface BackfillOpts {
  repoDir: string;
  env?: NodeJS.ProcessEnv;
  attempts?: number; // per run, with backoff between
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export async function backfill(o: BackfillOpts): Promise<{ runs: number; sent: number; failed: string[] }> {
  const env = o.env ?? process.env;
  const url = shipEnabled(env);
  if (!url) return { runs: 0, sent: 0, failed: [] };
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = o.attempts ?? 3;
  const root = join(o.repoDir, ".loki", "runs");
  let ids: string[] = [];
  try { ids = readdirSync(root).sort(); } catch { return { runs: 0, sent: 0, failed: [] }; }
  const source = sourceId(o.repoDir);
  let runs = 0, sent = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const runDir = join(root, id);
    if (!hasSpool(runDir)) continue;
    runs++;
    let res: ShipResult = { ok: false, sent: 0, acked_seq: -1, pending: 0 };
    for (let a = 1; a <= attempts; a++) {
      res = await shipRun({ runDir, url, source, token: env.LOKI_CONTROL_TOKEN, fetchImpl: o.fetchImpl });
      sent += res.sent;
      if (res.ok) break;
      if (a < attempts) await sleep(backoffMs(a));
    }
    if (!res.ok) failed.push(id);
  }
  return { runs, sent, failed };
}
