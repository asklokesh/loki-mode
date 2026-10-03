// CP-02 shipper (docs/v10/CONTROL-PLANE.md section 5). Reads events.jsonl (the spool, never written here) and POSTs
// batches to /v1/ingest. Progress lives in ship.json next to the log. Never throws: a failure returns ok:false.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readEvents } from "../../../../loki-ts/src/engine10/events.ts";
import type { EventEnvelope } from "../../../../loki-ts/src/engine10/types.ts";
import { redactSecrets } from "../../../../loki-ts/src/util/redact.ts";

export const BATCH = 200;
const MAX_BYTES = 800_000; // the service rejects a body over 1 MB

/** sha256(hostname NUL realpath(repo)), 16 hex. No raw path or hostname leaves the machine. */
export function sourceId(repoDir: string): string {
  let real = repoDir;
  try { real = realpathSync(repoDir); } catch { /* keep as given */ }
  return createHash("sha256").update(`${hostname()}\0${real}`).digest("hex").slice(0, 16);
}

const redactDeep = (x: unknown): unknown =>
  typeof x === "string" ? redactSecrets(x)
  : Array.isArray(x) ? x.map(redactDeep)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, redactDeep(v)]))
  : x;

export const redactEvent = (e: EventEnvelope): EventEnvelope => ({ ...e, data: redactDeep(e.data) as EventEnvelope["data"] });

/** Backoff 1, 2, 4 ... 60 s with up to 25% jitter. */
export const backoffMs = (failures: number, rnd: () => number = Math.random): number =>
  Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1)) * (1 + 0.25 * rnd());

export interface ShipState { acked_seq: number; url: string; skipped?: number }
export function readShip(runDir: string, url: string): ShipState {
  try {
    const s = JSON.parse(readFileSync(join(runDir, "ship.json"), "utf8")) as Partial<ShipState>;
    if (s.url === url && Number.isInteger(s.acked_seq)) return { acked_seq: s.acked_seq as number, url };
  } catch { /* none or corrupt: start over; the server dedupes */ }
  return { acked_seq: -1, url };
}
function writeShip(runDir: string, s: ShipState): void {
  const tmp = join(runDir, `ship.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s) + "\n");
  renameSync(tmp, join(runDir, "ship.json"));
}

export interface ShipOpts {
  runDir: string; // <repo>/.loki/runs/<id>
  url: string; // base URL of the control plane
  source: string;
  token?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch | undefined; // tests
}
export interface ShipResult { ok: boolean; sent: number; acked_seq: number; pending: number }

/** One pass: ship every event above acked_seq. ship.json is written only after a 2xx (or a 409, which a retry cannot fix). */
export async function shipRun(o: ShipOpts): Promise<ShipResult> {
  const st = readShip(o.runDir, o.url);
  const all = readEvents(join(o.runDir, "events.jsonl"));
  let lines = 0;
  try { lines = readFileSync(join(o.runDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length; } catch { /* none */ }
  const skipped = lines - all.length; // invalid lines (for example a tamper forgery) are never sent: the service 400s a whole batch on one
  const todo = all.filter((e) => e.seq > st.acked_seq).sort((a, b) => a.seq - b.seq);
  if (todo.length === 0) return { ok: true, sent: 0, acked_seq: st.acked_seq, pending: 0 };
  const run_id = todo[0]!.run;
  const f = o.fetchImpl ?? fetch;
  let sent = 0;
  const fail = (): ShipResult => ({ ok: false, sent, acked_seq: st.acked_seq, pending: todo.length - sent });
  for (let i = 0; i < todo.length;) {
    const batch: EventEnvelope[] = [];
    for (let bytes = 0; i < todo.length && batch.length < BATCH; i++) {
      bytes += JSON.stringify(todo[i]).length;
      if (batch.length > 0 && bytes > MAX_BYTES) break;
      batch.push(redactEvent(todo[i]!));
    }
    try {
      const r = await f(`${o.url.replace(/\/+$/, "")}/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
        body: JSON.stringify({ source: o.source, run_id, events: batch }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
      if (!r.ok && r.status !== 409) return fail();
    } catch { return fail(); }
    st.acked_seq = batch[batch.length - 1]!.seq;
    st.skipped = skipped;
    sent += batch.length;
    try { writeShip(o.runDir, st); } catch { return fail(); }
  }
  return { ok: true, sent, acked_seq: st.acked_seq, pending: 0 };
}

export const shipEnabled = (env: NodeJS.ProcessEnv): string | null => env.LOKI_CONTROL_URL || null;
export const hasSpool = (runDir: string): boolean => existsSync(join(runDir, "events.jsonl"));

/** Fire-and-forget ship loop: an unref'd timer with backoff; never throws. */
export function startShipLoop(o: Omit<ShipOpts, "timeoutMs">): void {
  let failures = 0, nextAt = 0, busy = false;
  const tick = async (): Promise<void> => {
    if (busy || Date.now() < nextAt) return;
    busy = true;
    try {
      const r = await shipRun({ ...o, timeoutMs: 5000 });
      failures = r.ok ? 0 : failures + 1;
      nextAt = r.ok ? 0 : Date.now() + backoffMs(failures);
    } catch { failures++; } finally { busy = false; }
  };
  setInterval(() => void tick(), 300).unref();
}
