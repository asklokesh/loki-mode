import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeReceiptHash, verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { captureVisualEvidence, evidenceSection, hashScreens, isPageFile, routeFor, sealEvidence } from "../../src/features/visual_evidence.ts";

let root = "";
let RUN = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vis-ev-"));
  RUN = join(root, "runs", "r1");
  mkdirSync(join(root, "runs", "r1"), { recursive: true });
  mkdirSync(join(root, "runs", "r1", "evidence", "screens"), { recursive: true });
  writeFileSync(join(root, "runs", "r1", "evidence", "screens", "index.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeReceipt(screens: { path: string; sha256: string }[] | null): string {
  const body: Record<string, unknown> = { schema: "loki.v10.receipt/1", run_id: "r1", verdict: "VERIFIED", ...(screens ? { evidence_screens: screens } : {}) };
  const receipt = { ...body, receipt_sha256: computeReceiptHash(body), verification: { jwt: null, kid: null } };
  const p = join(root, "runs", "r1", "receipt.json");
  writeFileSync(p, JSON.stringify(receipt));
  return p;
}

test("page file and route detection", () => {
  expect(isPageFile("src/pages/about.tsx")).toBe(true);
  expect(isPageFile("lib/util.ts")).toBe(false);
  expect(routeFor("app/dashboard/page.tsx")).toBe("/dashboard");
  expect(routeFor("public/index.html")).toBe("/");
});

test("hashScreens records sha256 and drops missing files", () => {
  const s = hashScreens(RUN, ["evidence/screens/index.png", "evidence/screens/nope.png"]);
  expect(s.length).toBe(1);
  expect(s[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("verify passes intact screens and is unchanged when the field is absent", async () => {
  const s = hashScreens(RUN, ["evidence/screens/index.png"]);
  expect((await verifyReceipt(writeReceipt(s))).verdict).toBe("UNSIGNED");
  expect((await verifyReceipt(writeReceipt(null))).verdict).toBe("UNSIGNED");
});

test("verify detects an altered screenshot", async () => {
  const s = hashScreens(RUN, ["evidence/screens/index.png"]);
  const p = writeReceipt(s);
  writeFileSync(join(RUN, "evidence", "screens", "index.png"), Buffer.from([9, 9, 9]));
  const r = await verifyReceipt(p);
  expect(r.verdict).toBe("TAMPERED");
  expect(r.reasons[0]).toContain("altered");
});

test("verify detects a missing screenshot", async () => {
  const s = hashScreens(RUN, ["evidence/screens/index.png"]);
  const p = writeReceipt(s);
  rmSync(join(RUN, "evidence", "screens", "index.png"));
  const r = await verifyReceipt(p);
  expect(r.verdict).toBe("TAMPERED");
  expect(r.reasons[0]).toContain("missing");
});

test("evidence section lists screens from the receipt, empty otherwise", () => {
  const s = hashScreens(RUN, ["evidence/screens/index.png"]);
  expect(evidenceSection(writeReceipt(s))).toContain(`sha256:${s[0]!.sha256}`);
  expect(evidenceSection(writeReceipt(null))).toBe("");
  expect(evidenceSection(undefined)).toBe("");
});

test("sealEvidence is a no-op when LOKI_VISUAL_EVIDENCE=0", async () => {
  process.env["LOKI_VISUAL_EVIDENCE"] = "0";
  try {
    const np = new Set<string>();
    expect(await sealEvidence(root, join(root, "runs", "r1"), {}, np)).toEqual({});
    expect(np.size).toBe(0);
  } finally { delete process.env["LOKI_VISUAL_EVIDENCE"]; }
});

test("unset flag is on: a repo with no web pages spawns nothing, creates no evidence dir, records one NOT PROVEN line", async () => {
  delete process.env["LOKI_VISUAL_EVIDENCE"];
  const repo = join(root, "plain");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "touch spawned.marker" } }));
  const run = join(root, "runs", "r2");
  mkdirSync(run, { recursive: true });
  const np = new Set<string>();
  expect(await sealEvidence(repo, run, { verify: { changed_files: ["lib/util.ts"] } }, np)).toEqual({});
  expect(np.size).toBe(1);
  expect(existsSync(join(run, "evidence"))).toBe(false);
  expect(existsSync(join(repo, "spawned.marker"))).toBe(false);
});

function slowRepo(): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "sleep 200" } }));
  writeFileSync(join(repo, "openapi.json"), JSON.stringify({ paths: { "/a": {} } }));
  return repo;
}

test("slow server yields a skip within budget and writes nothing", async () => {
  process.env["LOKI_VISUAL_EVIDENCE"] = "1";
  try {
    const t0 = Date.now();
    const ev = await captureVisualEvidence(slowRepo(), RUN, [], { budgetMs: 1200 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ev.screens).toEqual([]);
    expect(ev.skipped).toContain("did not answer");
  } finally { delete process.env["LOKI_VISUAL_EVIDENCE"]; }
});

test("aborted seal writes nothing and sealEvidence throws so no receipt follows", async () => {
  process.env["LOKI_VISUAL_EVIDENCE"] = "1";
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const np = new Set<string>();
    const t0 = Date.now();
    await expect(sealEvidence(slowRepo(), RUN, {}, np, ctl.signal)).rejects.toThrow("aborted");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(np.size).toBe(0);
    expect(existsSync(join(RUN, "receipt.json"))).toBe(false);
    expect(readdirSync(join(RUN, "evidence")).filter((n) => n !== "screens")).toEqual([]);
  } finally { delete process.env["LOKI_VISUAL_EVIDENCE"]; }
});

test("two runs touching the same route both verify (per-run dirs)", async () => {
  const mk = (id: string, bytes: number[]): string => {
    const run = join(root, "runs", id);
    mkdirSync(join(run, "evidence", "x"), { recursive: true });
    writeFileSync(join(run, "evidence", "x", "index.png"), Buffer.from(bytes));
    const body: Record<string, unknown> = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", evidence_screens: hashScreens(run, ["evidence/x/index.png"]) };
    const p = join(run, "receipt.json");
    writeFileSync(p, JSON.stringify({ ...body, receipt_sha256: computeReceiptHash(body), verification: { jwt: null, kid: null } }));
    return p;
  };
  const a = mk("ra", [1, 2, 3]), b = mk("rb", [4, 5, 6]);
  expect((await verifyReceipt(a)).verdict).toBe("UNSIGNED");
  expect((await verifyReceipt(b)).verdict).toBe("UNSIGNED");
});

test("verify refuses a symlinked screenshot and never touches the outside file", async () => {
  const outside = join(root, "outside.png");
  writeFileSync(outside, Buffer.from([7, 7, 7]));
  const link = join(RUN, "evidence", "screens", "link.png");
  symlinkSync(outside, link);
  const s = hashScreens(RUN, ["evidence/screens/link.png"]);
  const r = await verifyReceipt(writeReceipt(s));
  expect(r.verdict).toBe("TAMPERED");
  expect(r.reasons[0]).toContain("symlink");
  expect([...readFileSync(outside)]).toEqual([7, 7, 7]);
});

test("capture refuses a symlinked evidence dir", async () => {
  process.env["LOKI_VISUAL_EVIDENCE"] = "1";
  try {
    const repo = join(root, "repo2");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "node -e \"require('http').createServer((q,r)=>r.end('ok')).listen(process.env.PORT,'127.0.0.1')\"" } }));
    writeFileSync(join(repo, "openapi.json"), JSON.stringify({ paths: { "/a": {} } }));
    const outsideDir = join(root, "outdir");
    mkdirSync(outsideDir);
    rmSync(join(RUN, "evidence"), { recursive: true, force: true });
    symlinkSync(outsideDir, join(RUN, "evidence"));
    const ev = await captureVisualEvidence(repo, RUN, [], { budgetMs: 10_000 });
    expect(ev.skipped).toContain("symlink");
    expect(readdirSync(outsideDir)).toEqual([]);
  } finally { delete process.env["LOKI_VISUAL_EVIDENCE"]; }
});

test("verify returns a verdict, never throws, for a directory evidence path", async () => {
  for (const path of [".", "evidence", "evidence/screens"]) {
    const r = await verifyReceipt(writeReceipt([{ path, sha256: "0".repeat(64) }]));
    expect(r.verdict).toBe("TAMPERED");
    expect(r.reasons[0]).toContain("regular file");
  }
});

test("a SIGTERM-ignoring dev server is dead after capture (recorded pid and group only)", async () => {
  const repo = join(root, "stubborn");
  mkdirSync(repo, { recursive: true });
  const pidFile = join(root, "server.pid");
  writeFileSync(join(repo, "server.js"), [
    "process.on('SIGTERM', () => {});",
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
  ].join("\n"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
  writeFileSync(join(repo, "openapi.json"), JSON.stringify({ paths: { "/a": {} } }));
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let pid = 0;
  try {
    const ev = await captureVisualEvidence(repo, RUN, [], { env: { ...process.env, LOKI_VISUAL_EVIDENCE: "1", LOKI_NO_BROWSER: "1" } });
    expect(ev.http).toBe(true);
    pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(1);
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  } finally {
    if (pid > 1 && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}, 20000);

function apiRepo(name: string, dev: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev } }));
  writeFileSync(join(repo, "openapi.json"), JSON.stringify({ paths: { "/a": {} } }));
  return repo;
}
const SERVER = "node -e \"require('fs').writeFileSync('spawned.marker','1');require('http').createServer((q,r)=>r.end('ok')).listen(process.env.PORT,'127.0.0.1')\"";

test("default (flag unset): a non-page change never spawns the start script even with openapi and a start script", async () => {
  const repo = apiRepo("dflt", SERVER);
  const env = { ...process.env }; delete env["LOKI_VISUAL_EVIDENCE"];
  const ev = await captureVisualEvidence(repo, RUN, ["lib/util.py"], { env, budgetMs: 3000 });
  expect(ev.http).toBe(false);
  expect(ev.skipped).toContain("no changed page files");
  expect(existsSync(join(repo, "spawned.marker"))).toBe(false);
  expect(readdirSync(join(RUN, "evidence")).filter((n) => n !== "screens")).toEqual([]);
});

test("explicit =1 keeps the API transcript path", async () => {
  const repo = apiRepo("explicit", SERVER);
  const ev = await captureVisualEvidence(repo, RUN, ["lib/util.py"], { env: { ...process.env, LOKI_VISUAL_EVIDENCE: "1" }, budgetMs: 10_000 });
  expect(ev.http).toBe(true);
  expect(existsSync(join(repo, "spawned.marker"))).toBe(true);
});

test("the dev server process group is announced via onServer and sealEvidence emits session.started with that pgid", async () => {
  const repo = apiRepo("announce", SERVER);
  const seen: number[] = [];
  await captureVisualEvidence(repo, RUN, [], { env: { ...process.env, LOKI_VISUAL_EVIDENCE: "1" }, budgetMs: 10_000, onServer: (g) => seen.push(g) });
  expect(seen.length).toBe(1);
  expect(seen[0]!).toBeGreaterThan(1);
  process.env["LOKI_VISUAL_EVIDENCE"] = "1";
  try {
    const events: { type: string; stage: string; data: Record<string, unknown> }[] = [];
    await sealEvidence(apiRepo("announce2", SERVER), RUN, { verify: { changed_files: [] } }, new Set<string>(), undefined, (type, stage, data) => events.push({ type, stage, data }));
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("session.started");
    expect(typeof events[0]!.data["pgid"]).toBe("number");
  } finally { delete process.env["LOKI_VISUAL_EVIDENCE"]; }
});

test("verify fails closed on a FIFO evidence path and does not hang", async () => {
  const fifo = join(RUN, "evidence", "screens", "pipe.png");
  const mk = Bun.spawnSync(["mkfifo", fifo]);
  expect(mk.exitCode).toBe(0);
  const r = await Promise.race([
    verifyReceipt(writeReceipt([{ path: "evidence/screens/pipe.png", sha256: "0".repeat(64) }])),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("verify hung on FIFO")), 5000)),
  ]);
  expect(r.verdict).toBe("TAMPERED");
  expect(r.reasons[0]).toContain("not a regular file");
});
