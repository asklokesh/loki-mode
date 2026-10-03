// CP follow-up 1: a finished run with no diff in its events gets changed files from the receipt's base and head via git numstat.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { localRepos } from "../../src/db/schema.ts";
import { parseNumstat } from "../../src/server/diffstat.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-ds-")));
const repo = join(root, "repo");
mkdirSync(repo);
const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { env: { PATH: process.env.PATH ?? "", HOME: root } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "a.ts"), "one\ntwo\n");
git("add", "a.ts");
git("commit", "-q", "-m", "base");
const BASE = git("rev-parse", "HEAD");
writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\nfour\n");
writeFileSync(join(repo, "b.ts"), "x\n");
git("add", "a.ts", "b.ts");
git("commit", "-q", "-m", "change");
const HEAD = git("rev-parse", "HEAD");

const SRC = "abcdef0123456789";
const { app, db, close } = createApp({ dbPath: ":memory:", loopbackOnly: true });
db.insert(localRepos).values({ sourceId: SRC, realpath: repo, name: "repo", discoveredAt: new Date().toISOString() }).run();
afterAll(() => { close(); rmSync(root, { recursive: true, force: true }); });

const evs = readFileSync(join(FIX, "verified", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const RUN = evs[0].run as string;
const call = (path: string, init?: RequestInit) => app.fetch(new Request(`http://127.0.0.1:1234${path}`, { ...init, headers: { host: "127.0.0.1:1234", ...(init?.headers ?? {}) } }), { requestIP: () => ({ address: "127.0.0.1" }) } as object);
expect((await call("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: RUN, events: evs }) })).status).toBe(200);
const runDir = join(repo, ".loki", "runs", RUN);
mkdirSync(runDir, { recursive: true });
const detail = async () => (await (await call(`/v1/runs/${SRC}/${RUN}`)).json()) as { diff_stat: { base: string; head: string; files: { path: string; added: number; removed: number }[]; added: number; removed: number } | null };

test("receipt base and head give per-file counts in the run detail and the list", async () => {
  writeFileSync(join(runDir, "receipt.json"), JSON.stringify({ base_sha: BASE, head_sha: HEAD }));
  const d = await detail();
  expect(d.diff_stat?.base).toBe(BASE);
  expect(d.diff_stat?.files).toEqual([{ path: "a.ts", added: 2, removed: 0 }, { path: "b.ts", added: 1, removed: 0 }]);
  expect([d.diff_stat?.added, d.diff_stat?.removed]).toEqual([3, 0]);
  const list = (await (await call("/v1/runs")).json()) as { runs: { run_id: string; diff_stat: { files: unknown[] } | null }[] };
  expect(list.runs.find((r) => r.run_id === RUN)?.diff_stat?.files).toHaveLength(2);
});

test("non-hex or missing shas read null (unmeasured), never an empty list", async () => {
  const SRC2 = "0123456789abcdef";
  db.insert(localRepos).values({ sourceId: SRC2, realpath: repo, name: "repo2", discoveredAt: new Date().toISOString() }).run();
  expect((await call("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC2, run_id: RUN, events: evs }) })).status).toBe(200);
  writeFileSync(join(runDir, "receipt.json"), JSON.stringify({ base_sha: "--output=/tmp/x", head_sha: HEAD }));
  const r = (await (await call(`/v1/runs/${SRC2}/${RUN}`)).json()) as { diff_stat: unknown };
  expect(r.diff_stat).toBeNull();
  writeFileSync(join(runDir, "receipt.json"), "{}");
  expect(((await (await call(`/v1/runs/${SRC2}/${RUN}`)).json()) as { diff_stat: unknown }).diff_stat).toBeNull();
});

test("parseNumstat keeps null counts for binary files and ignores noise", () => {
  expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\nnoise\n")).toEqual([{ path: "src/a.ts", added: 3, removed: 1 }, { path: "img.png", added: null, removed: null }]);
});
