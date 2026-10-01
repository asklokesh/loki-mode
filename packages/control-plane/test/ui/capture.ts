// Regenerates the UI fixtures from the real service: CP-01 createApp over the CP-00 corpus, no hand-written shapes.
// Run: bun packages/control-plane/test/ui/capture.ts   (writes fixtures/runs.json, detail-<name>.json, empty.json)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateEnvelope } from "../../../../loki-ts/src/engine10/events.ts";
import { createApp } from "../../src/server/app.ts";

const HERE = import.meta.dir;
const CORPUS = join(HERE, "../fixtures/runs");
const OUT = join(HERE, "fixtures");
const SOURCE = "corpus0000000000";
const write = (f: string, body: unknown) => writeFileSync(join(OUT, f), JSON.stringify(body, null, 2) + "\n");

const { app } = createApp({ dbPath: ":memory:" });
const get = async (path: string) => (await app.request(path)).json() as Promise<unknown>;
write("empty.json", await get("/v1/runs"));

const runIds: Record<string, string> = {};
for (const name of readdirSync(CORPUS).sort()) {
  const events = readFileSync(join(CORPUS, name, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => validateEnvelope(e) === null);
  runIds[name] = events[0].run;
  const res = await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SOURCE, run_id: events[0].run, events }) });
  if (res.status !== 200) throw new Error(`ingest ${name}: ${res.status}`);
}
write("runs.json", await get("/v1/runs"));
for (const [name, run] of Object.entries(runIds)) write(`detail-${name}.json`, await get(`/v1/runs/${SOURCE}/${run}`));
