// A-117 round 2: the signed log.sealed line after run.completed makes deleting the post-seal tail (or the line) a TAMPERED verdict.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";
import { receiptSha256 } from "../../src/engine10/stages/seal.ts";
import { loggedRun, type LoggedRun } from "./fixtures/verify/seal_corpus.ts";
import { redactEnvelope, redactSecrets } from "../../src/util/redact.ts";
import { main, verifyReceipt } from "../../src/engine10/verify_cmd.ts";

const root = mkdtempSync(join(tmpdir(), "e10-logseal-"));
const saved = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];
beforeAll(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "k.pem"); });
afterAll(() => { if (saved === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = saved; rmSync(root, { recursive: true, force: true }); });

let n = 0;
/** A signed run whose log line 1 is edited before the seal (the supervisor then appends tamper.detected), or an honest one. */
const run = (tamper: boolean, marker = true, started: Record<string, unknown> = { provider: "claude" }): LoggedRun => loggedRun(root, `e10-ls-${n++}`, { tamper, marker, started });
const sha = (b: Buffer): string => new Bun.CryptoHasher("sha256").update(b).digest("hex");

describe("Q17-05b redact at source", () => {
  const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  test("a token in event data is redacted before the line is hashed and sealed; the run is VERIFIED and re-redaction is a no-op", async () => {
    const r = run(false, true, { provider: "claude", note: `key ${SECRET}`, nested: { list: [`Bearer ${"a".repeat(30)}`] } });
    const raw = readFileSync(join(r.dir, "events.jsonl"), "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("[REDACTED:OPENAI_KEY]");
    expect(redactSecrets(raw)).toBe(raw);
    expect((await verifyReceipt(r.path)).verdict).toBe("VERIFIED");
    const seal = JSON.parse(r.lines().at(-1)!).data.events_sha256 as string;
    expect(seal).toBe(sha(Buffer.from(r.lines().slice(0, -1).join("\n") + "\n")));
  });
  test("a planted placeholder edit after sealing is TAMPERED", async () => {
    const r = run(false, true, { provider: "claude", note: `key ${SECRET}` });
    r.put(r.lines().map((l) => l.replace("[REDACTED:OPENAI_KEY]", "[REDACTED]")));
    expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
  });
});

describe("Q17-05b seal fields are not redacted", () => {
  test("seal crypto fields of the engine shape keep their bytes even when they match a token rule; the same values elsewhere, or a wrong shape, are redacted", () => {
    const sig = "sk-" + "b".repeat(83), kid = "sk-" + "c".repeat(40), token = "sk-ant-" + "a".repeat(40);
    const id = `e10-ls-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl");
    mkdirSync(dir, { recursive: true });
    const log = new SupervisorLog(ev, id);
    log.append("receipt.sealed", "seal", { path: `/x/${token}`, receipt_sha256: "0".repeat(64), signed: true, kid });
    log.append("log.sealed", null, { kid, events_sha256: "0".repeat(64), tampered: false, sig });
    log.append("worker.note", null, { sig, kid });
    log.append("log.sealed", null, { kid: "k", events_sha256: "0", tampered: false, sig: token });
    const [receipt, sealed, normal, smuggled] = readFileSync(ev, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect([receipt.data.kid, sealed.data.kid, sealed.data.sig]).toEqual([kid, kid, sig]);
    expect(receipt.data.path).not.toContain(token);
    expect(normal.data.sig).toContain("[REDACTED:OPENAI_KEY]");
    expect(normal.data.kid).toContain("[REDACTED:OPENAI_KEY]");
    expect(smuggled.data.sig).not.toContain(token);
    for (const e of [receipt, sealed, normal, smuggled]) expect(redactEnvelope(e)).toEqual(e); // the shipper and ingest redaction is a no-op on every engine-written line
  });
  test("600 honest signed runs all VERIFY", async () => {
    for (let i = 0; i < 600; i++) {
      const r = run(false);
      expect((await verifyReceipt(r.path)).verdict).toBe("VERIFIED");
    }
  }, 120000);
});

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
  test("whitespace or blank lines appended to a signed log are TAMPERED, the untouched log stays VERIFIED", async () => {
    const r = run(false), orig = readFileSync(join(r.dir, "events.jsonl"), "utf8");
    expect((await verifyReceipt(r.path)).verdict).toBe("VERIFIED");
    for (const add of [" ", "\t", " \n", "\n\n"]) {
      writeFileSync(join(r.dir, "events.jsonl"), orig + add);
      expect([JSON.stringify(add), (await verifyReceipt(r.path)).verdict]).toEqual([JSON.stringify(add), "TAMPERED"]);
    }
    const body = orig.slice(0, -1), last = body.lastIndexOf("\n") + 1;
    const shapes: Record<string, string> = { trailingSpace: body + " \n", trailingTab: body + "\t\n", trailingCr: body + "\r\n", leadingSpace: body.slice(0, last) + " " + body.slice(last) + "\n", midLogTab: orig.replace("\n", "\t\n"), fullCrlf: orig.replace(/\n/g, "\r\n") };
    for (const [name, text] of Object.entries(shapes)) {
      writeFileSync(join(r.dir, "events.jsonl"), text);
      expect([name, (await verifyReceipt(r.path)).verdict]).toEqual([name, "TAMPERED"]);
    }
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

describe("torn last line of events.jsonl", () => {
  const evPath = (r: { dir: string }): string => join(r.dir, "events.jsonl");
  const cli = async (r: { dir: string }): Promise<number> => {
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as never;
    try { return await main([r.dir.split("/").pop()!], { runsRoot: join(root, "runs") }); } finally { process.stdout.write = w; }
  };
  test("an unterminated, unparseable final line is UNCHECKED rc 2, never TAMPERED", async () => {
    const r = run(false);
    appendFileSync(evPath(r), '{"v":1,"seq":99,"type":"log.app');
    expect(await cli(r)).toBe(2);
  });
  test("a truncated JSON line in the middle (newline kept) is TAMPERED", async () => {
    const r = run(false), l = r.lines();
    l[1] = l[1]!.slice(0, 20);
    r.put(l);
    expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
    expect(await cli(r)).toBe(1);
  });
  test("a middle line cut mid-write is TAMPERED even when the final line is also torn", async () => {
    const r = run(false), l = r.lines();
    l[1] = l[1]!.slice(0, 20);
    writeFileSync(evPath(r), l.join("\n") + "\n" + '{"v":1,"seq":99');
    expect(await cli(r)).toBe(1);
  });
  test("an unparseable final line that ends in a newline is TAMPERED", async () => {
    const r = run(false);
    appendFileSync(evPath(r), '{"v":1,"seq":99,"type":"log.app\n');
    expect(await cli(r)).toBe(1);
  });
  test("an honest log ending in a newline is VERIFIED rc 0, and a parseable last line missing its newline is not downgraded", async () => {
    const r = run(false);
    expect(await cli(r)).toBe(0);
    writeFileSync(evPath(r), readFileSync(evPath(r), "utf8").replace(/\n$/, ""));
    expect(await cli(r)).toBe(0);
  });
  test("an unterminated tail the writer could not have cut (leading whitespace, a raw tab or CR, or a whole line with trailing whitespace) is TAMPERED rc 1", async () => {
    const r = run(false), orig = readFileSync(evPath(r), "utf8"), whole = orig.replace(/\n$/, "");
    const shapes: Record<string, string> = { tornLeadingSpace: orig + ' {"v":1,"seq":99', tornTab: orig + '{"v":1,\t"seq":99', tornCr: orig + '{"v":1,"seq":99\r', wholeTrailingSpace: whole + " ", wholeTrailingCr: whole + "\r" };
    for (const [name, text] of Object.entries(shapes)) {
      writeFileSync(evPath(r), text);
      expect([name, await cli(r)]).toEqual([name, 1]);
    }
  });
});

describe("resume repairs a torn tail before the seal", () => {
  /** run.started, a crash that leaves a torn final line, then a resume (new SupervisorLog), then the seal. */
  function resumed(): { dir: string; path: string; ev: string } {
    const id = `e10-ls-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl");
    mkdirSync(dir, { recursive: true });
    new SupervisorLog(ev, id).append("run.started", null, { provider: "claude" });
    appendFileSync(ev, '{"v":1,"seq":1,"type":"stage.sta'); // crash mid-append
    const log = new SupervisorLog(ev, id); // resume: EventLog truncates the torn tail
    log.append("run.resumed", null, {});
    const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", events_sha256: sha(readFileSync(ev)), time: { wall_s: 0, stages: {} }, log_seal: true };
    const hash = receiptSha256(body as never);
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(id, hash) }, null, 2));
    log.append("receipt.sealed", "seal", { receipt_sha256: hash });
    log.verify();
    log.append("run.completed", null, {});
    log.sealLog();
    return { dir, path: join(dir, "receipt.json"), ev };
  }
  test("the harness-owned truncation of a torn tail does not read TAMPERED: the resumed run verifies and the log holds no torn line", async () => {
    const r = resumed();
    const raw = readFileSync(r.ev, "utf8");
    expect(raw).not.toContain("stage.sta");
    expect(raw.endsWith("\n")).toBe(true);
    expect((await verifyReceipt(r.path)).verdict).toBe("VERIFIED");
  });
  test("a real mid-log edit after the resume still reads TAMPERED", async () => {
    const r = resumed();
    writeFileSync(r.ev, readFileSync(r.ev, "utf8").replace('"claude"', '"claudX"'));
    expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
  });
  test("deleting sealed history after the resume still reads TAMPERED", async () => {
    const r = resumed();
    const l = readFileSync(r.ev, "utf8").trim().split("\n");
    writeFileSync(r.ev, [l[0], ...l.slice(2)].join("\n") + "\n");
    expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
  });
});

/** A cancelled run that was resumed: two run.completed + log.sealed pairs. "reseal" = cancelled before sealing, resume seals (receipt.sealed lands after the first pair);
 *  "publish" = sealed first, cancelled in publish, resumePublish appends a second pair after the receipt.sealed. */
function resumed(mode: "reseal" | "publish", cancelled = true): ReturnType<typeof run> {
  const id = `e10-ls-${n++}`, dir = join(root, "runs", id), ev = join(dir, "events.jsonl");
  mkdirSync(dir, { recursive: true });
  const log = new SupervisorLog(ev, id);
  log.append("run.started", null, { provider: "claude" });
  const bound = sha(readFileSync(ev));
  const seal = (): void => {
    const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", events_sha256: bound, time: { wall_s: 0, stages: {} }, log_seal: true };
    const hash = receiptSha256(body as never);
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: hash, verification: signReceipt(id, hash) }, null, 2));
    log.append("receipt.sealed", "seal", { receipt_sha256: hash });
  };
  const cancel = (): void => { log.append("run.completed", null, { verdict: "FAILED", ...(cancelled ? { cancelled: true } : {}) }); log.sealLog(); };
  if (mode === "reseal") { cancel(); seal(); } else { seal(); cancel(); }
  log.append("run.completed", null, {});
  log.sealLog();
  const lines = () => readFileSync(ev, "utf8").trim().split("\n");
  return { dir, path: join(dir, "receipt.json"), lines, put: (l) => writeFileSync(ev, l.join("\n") + "\n") };
}
describe("cancel then resume: the LAST run.completed pair is the one checked", () => {
  const isType = (l: string, t: string): boolean => JSON.parse(l).type === t;
  const edit = (r: ReturnType<typeof run>, t: string, f: (e: { data: Record<string, unknown> }) => void): void => {
    const l = r.lines(), i = l.findLastIndex((x) => isType(x, t)), e = JSON.parse(l[i]!);
    f(e);
    r.put(l.map((x, j) => (j === i ? JSON.stringify(e) : x)));
  };
  for (const mode of ["single", "reseal", "publish"] as const) {
    test(`${mode}: A4x forged run.completed with receipt.sealed moved to the tail is TAMPERED, not UNCHECKED`, async () => {
      const r = mode === "single" ? run(false) : resumed(mode);
      edit(r, "run.completed", (e) => { e.data = { verdict: "VERIFIED", pr_url: "https://evil.example/pr/1", not_proven: [] }; });
      const l = r.lines(), i = l.findLastIndex((x) => isType(x, "receipt.sealed")), moved = [...l.slice(0, i), ...l.slice(i + 1), l[i]!];
      r.put(moved.map((x, j) => JSON.stringify({ ...JSON.parse(x), seq: j })));
      const v = await verifyReceipt(r.path);
      expect(v.verdict).toBe("TAMPERED");
      expect(v.reasons.join(" ")).not.toContain("no run.completed");
    });
    test(`${mode}: final run.completed retyped to worker.note is TAMPERED`, async () => {
      const r = mode === "single" ? run(false) : resumed(mode);
      edit(r, "run.completed", (e) => { (e as unknown as { type: string }).type = "worker.note"; });
      expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
    });
    test(`${mode}: final run.completed deleted (final log.sealed kept, seq renumbered) is TAMPERED`, async () => {
      const r = mode === "single" ? run(false) : resumed(mode), l = r.lines(), i = l.findLastIndex((x) => isType(x, "run.completed"));
      r.put([...l.slice(0, i), ...l.slice(i + 1)].map((x, j) => JSON.stringify({ ...JSON.parse(x), seq: j })));
      expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
    });
  }
  test("a validly sealed but non-cancelled run.completed before this receipt.sealed is TAMPERED, not UNCHECKED", async () => {
    const r = resumed("reseal", false), l = r.lines();
    r.put(l.slice(0, l.findIndex((x) => isType(x, "receipt.sealed")) + 1)); // keeps the valid first pair, drops the resumed end
    const v = await verifyReceipt(r.path);
    expect(v.verdict).toBe("TAMPERED");
    expect(v.reasons.join(" ")).toContain("not a cancelled run");
  });
  for (const mode of ["reseal", "publish"] as const) {
    test(`${mode}: honest resumed run is VERIFIED`, async () => {
      expect((await verifyReceipt(resumed(mode).path)).verdict).toBe("VERIFIED");
    });
    test(`${mode}: final run.completed edited is TAMPERED`, async () => {
      const r = resumed(mode);
      edit(r, "run.completed", (e) => { e.data = { verdict: "FAILED", not_proven: ["FORGED"] }; });
      expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
    });
    test(`${mode}: tail after receipt.sealed deleted is UNCHECKED, not VERIFIED`, async () => {
      const r = resumed(mode), l = r.lines();
      r.put(l.slice(0, l.findLastIndex((x) => isType(x, "receipt.sealed")) + 1));
      expect((await verifyReceipt(r.path)).verdict).toBe("UNCHECKED");
    });
    test(`${mode}: final log.sealed signature forged is TAMPERED`, async () => {
      const r = resumed(mode);
      edit(r, "log.sealed", (e) => { e.data["sig"] = "AAAA"; });
      expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
    });
    test(`${mode}: final log.sealed deleted is TAMPERED`, async () => {
      const r = resumed(mode);
      r.put(r.lines().slice(0, -1));
      expect((await verifyReceipt(r.path)).verdict).toBe("TAMPERED");
    });
  }
});

describe("P12-08c SUPERVISOR_ONLY", () => {
  test("a worker line of type deep.started is dropped by ingest; the supervisor append still lands", () => {
    const dir = join(root, "runs", `e10-so-${n++}`);
    mkdirSync(dir, { recursive: true });
    const log = new SupervisorLog(join(dir, "events.jsonl"), "so1");
    log.append("run.started", null, {});
    expect(log.ingest(JSON.stringify({ type: "deep.started", stage: "deep", data: { pid: 1 } }))).toBeNull();
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).not.toContain("deep.started");
    log.append("deep.started", "deep", { pid: 2 });
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain("deep.started");
  });
});

// TEN-GATES-16: a moved HEAD is drift only when it touched a path the sealed diff touched.
describe("TEN-GATES-16 head drift by sealed path overlap", () => {
  const vcs = (cwd: string, ...a: string[]): string => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).stdout.toString().trim();
  const sh = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");
  function sealed(repo: string, id: string, baseOf: (head: string) => string | undefined = () => vcs(repo, "rev-parse", "HEAD~1")): void {
    const head = vcs(repo, "rev-parse", "HEAD"), base = baseOf(head);
    const body = { schema: "loki.v10.receipt/1", run_id: id, verdict: "VERIFIED", events_sha256: sh(""), time: { wall_s: 0, stages: {} }, ...(base === undefined ? {} : { base_sha: base }), head_sha: head };
    const dir = join(repo, ".loki", "runs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: receiptSha256(body as never), verification: { jwt: null, kid: null } }));
  }
  async function verify(repo: string, id: string): Promise<{ code: number; out: string }> {
    const out: string[] = [], w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    try { return { code: await main([id, "--allow-unsigned"], { runsRoot: join(repo, ".loki", "runs") }), out: out.join("") }; } finally { process.stdout.write = w; }
  }
  function mk(): string {
    const repo = mkdtempSync(join(root, "g16-"));
    vcs(repo, "init", "-q"); writeFileSync(join(repo, "base"), "0"); vcs(repo, "add", "base"); vcs(repo, "commit", "-qm", "base");
    writeFileSync(join(repo, "a.ts"), "1"); vcs(repo, "add", "a.ts"); vcs(repo, "commit", "-qm", "sealed work");
    return repo;
  }
  test("control: HEAD equals head_sha verifies OK", async () => {
    const repo = mk(); sealed(repo, "r1");
    expect((await verify(repo, "r1")).code).toBe(0);
  });
  test("amend on a sealed path: drift naming the path", async () => {
    const repo = mk(); sealed(repo, "r2");
    writeFileSync(join(repo, "a.ts"), "2"); vcs(repo, "commit", "-qa", "--amend", "-m", "sealed work v2");
    const r = await verify(repo, "r2");
    expect(r.code).toBe(2);
    expect(r.out.includes("a.ts")).toBe(true);
  });
  test("unrelated later commit keeps OK; overlapping later commit is drift", async () => {
    const repo = mk(); sealed(repo, "r3");
    writeFileSync(join(repo, "other.md"), "x"); vcs(repo, "add", "other.md"); vcs(repo, "commit", "-qm", "docs");
    expect((await verify(repo, "r3")).code).toBe(0);
    writeFileSync(join(repo, "a.ts"), "3"); vcs(repo, "commit", "-qam", "touch sealed");
    const r = await verify(repo, "r3");
    expect(r.code).toBe(2);
    expect(r.out.includes("a.ts")).toBe(true);
  });
  test("a sealed path touched then reverted in the later range is not drift", async () => {
    const repo = mk(); sealed(repo, "r4");
    writeFileSync(join(repo, "a.ts"), "9"); vcs(repo, "commit", "-qam", "t");
    writeFileSync(join(repo, "a.ts"), "1"); vcs(repo, "commit", "-qam", "revert");
    expect((await verify(repo, "r4")).code).toBe(0);
  });
  const unrelated = (repo: string): void => { writeFileSync(join(repo, "other.md"), "x"); vcs(repo, "add", "other.md"); vcs(repo, "commit", "-qm", "docs"); };
  test("fail-safe: empty sealed diff (base == head) plus an unrelated commit is drift", async () => {
    const repo = mk(); sealed(repo, "r5", (h) => h); unrelated(repo);
    expect((await verify(repo, "r5")).code).toBe(2);
  });
  test("fail-safe: absent base_sha plus an unrelated commit is drift", async () => {
    const repo = mk(); sealed(repo, "r6", () => undefined); unrelated(repo);
    expect((await verify(repo, "r6")).code).toBe(2);
  });
  test("fail-safe: non-hex base_sha plus an unrelated commit is drift", async () => {
    const repo = mk(); sealed(repo, "r7", () => "not-a-sha"); unrelated(repo);
    expect((await verify(repo, "r7")).code).toBe(2);
  });
});
