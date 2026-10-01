// A-117 round 2: the signed log.sealed line after run.completed makes deleting the post-seal tail (or the line) a TAMPERED verdict.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";
import { receiptSha256, signReceipt } from "../../src/engine10/stages/seal.ts";
import { main, verifyReceipt } from "../../src/engine10/verify_cmd.ts";

const root = mkdtempSync(join(tmpdir(), "e10-logseal-"));
const saved = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];
beforeAll(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "k.pem"); });
afterAll(() => { if (saved === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = saved; rmSync(root, { recursive: true, force: true }); });

let n = 0;
/** A signed run whose log line 1 is edited before the seal (the supervisor then appends tamper.detected), or an honest one. */
function run(tamper: boolean, marker = true): { dir: string; path: string; lines: () => string[]; put: (l: string[]) => void } {
  const id = `e10-ls-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl");
  mkdirSync(dir, { recursive: true });
  const log = new SupervisorLog(ev, id);
  log.append("run.started", null, { provider: "claude" });
  if (tamper) writeFileSync(ev, readFileSync(ev, "utf8").replace('"claude"', '"claudX"'));
  const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", events_sha256: sha(readFileSync(ev)), ...(marker ? { log_seal: true } : {}) };
  const hash = receiptSha256(body as never);
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(id, hash) }, null, 2));
  log.append("receipt.sealed", "seal", { receipt_sha256: hash });
  log.verify();
  log.append("run.completed", null, {});
  log.sealLog();
  const lines = () => readFileSync(ev, "utf8").trim().split("\n");
  return { dir, path: join(dir, "receipt.json"), lines, put: (l) => writeFileSync(ev, l.join("\n") + "\n") };
}
const sha = (b: Buffer): string => new Bun.CryptoHasher("sha256").update(b).digest("hex");

describe("A-117 log.sealed", () => {
  test("honest run VERIFIED; a run tampered in flight is TAMPERED", async () => {
    expect((await verifyReceipt(run(false).path)).verdict).toBe("VERIFIED");
    expect((await verifyReceipt(run(true).path)).verdict).toBe("TAMPERED");
  });
  test("deleting the last 4 lines (sealed .. log.sealed) of a tampered run is TAMPERED, not VERIFIED", async () => {
    const r = run(true), l = r.lines();
    r.put(l.slice(0, -4));
    expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
  });
  test("the log.sealed line deleted alone is TAMPERED", async () => {
    const r = run(false);
    r.put(r.lines().slice(0, -1));
    expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
  });
  test("log.sealed forged with another key, or with tampered flipped, is TAMPERED", async () => {
    for (const forge of ["key", "flag"]) {
      const r = run(false), l = r.lines(), e = JSON.parse(l.at(-1)!);
      const sig = (k: KeyObject, t: boolean) => sign(null, Buffer.from(`${e.data.events_sha256}:${t}`), k).toString("base64url");
      if (forge === "key") e.data.sig = sig(generateKeyPairSync("ed25519").privateKey, false);
      else { e.data.tampered = true; }
      r.put([...l.slice(0, -1), JSON.stringify(e)]);
      expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
    }
  });
  test("back-compat: a receipt without the log_seal marker keeps the round-1 checks (VERIFIED on an old-style log, no log.sealed line)", async () => {
    const r = run(false, false);
    r.put(r.lines().slice(0, -1));
    expect((await verifyReceipt(r.path)).verdict).toBe("VERIFIED");
    expect((await verifyReceipt(run(true, false).path)).verdict).toBe("TAMPERED"); // tamper.detected still counts
  });
  test("a marker-bearing receipt cannot shed the marker: removing it breaks receipt_sha256", async () => {
    const r = run(false);
    writeFileSync(r.path, readFileSync(r.path, "utf8").replace('"log_seal": true,', ""));
    expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
  });
  test("an interrupted run (sealed, no run.completed) is UNCHECKED rc 2", async () => {
    const r = run(false);
    r.put(r.lines().slice(0, -2));
    expect((await verifyReceipt(r.path)).verdict).toBe("UNCHECKED");
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as never;
    try { expect(await main([r.dir.split("/").pop()!], { runsRoot: join(root, "runs") })).toBe(2); } finally { process.stdout.write = w; }
  });
});
