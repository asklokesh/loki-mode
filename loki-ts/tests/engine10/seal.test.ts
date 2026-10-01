// loki-ts/tests/engine10/seal.test.ts
//
// E-10 wall check (docs/v10/ENGINE.md sections 9 and 16). Signing goes through
// findIsolatedPython3 with -I (never -S) and autonomy/receipt_jwt.py. The JWT is
// verified in Python against the PUBLIC key only, and receipt_sha256 is
// recomputed in Python from receipt.json, so a TS canonicalizer bug cannot
// pass by agreeing with itself.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { main as verifyMain, verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { commitStage, DEEP_NOT_PROVEN, renderReceiptMd, SIGNING_UNAVAILABLE, sealStage } from "../../src/engine10/stages/seal.ts";
import type { EventType, Receipt, RunContext, StageName } from "../../src/engine10/types.ts";
import { _setIsolatedPythonFixedForTests } from "../../src/util/python.ts";
import { REPO_ROOT } from "../../src/util/paths.ts";
import { RECEIPT_SIGNER_BASENAME } from "../../src/util/receipt_signer.ts";
const PRE_KEY_FILE = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];

const AUTONOMY = resolve(REPO_ROOT, "autonomy");
let root = "";
let cryptoPy = "";
const REAL_HOME = process.env["HOME"];

function sh(argv: string[], cwd: string, env: Record<string, string> = {}): string {
  const p = Bun.spawnSync({ cmd: argv, cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} -> ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function makeRepo(name: string): { repo: string; base: string } {
  const repo = join(root, name);
  sh(["mkdir", "-p", repo], root);
  sh(["git", "init", "-q", "-b", "main"], repo);
  sh(["git", "config", "user.name", "seal-test"], repo);
  sh(["git", "config", "user.email", "seal@test.invalid"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(["git", "add", "a.txt"], repo);
  sh(["git", "commit", "-q", "-m", "base"], repo);
  const base = sh(["git", "rev-parse", "HEAD"], repo).trim();
  writeFileSync(join(repo, "a.txt"), "two\n");
  sh(["mkdir", "-p", ".loki/runs/r1"], repo);
  writeFileSync(join(repo, ".loki/runs/r1/events.jsonl"), JSON.stringify({ v: 1, seq: 0, ts: "2026-01-01T00:00:00.000Z", run: "r1", type: "run.started", stage: null, data: {} }) + "\n");
  return { repo, base };
}

function ctxFor(repo: string, base: string, provider = "claude", over: Partial<Record<StageName, Record<string, unknown>>> = {}) {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const outputs: Partial<Record<StageName, Record<string, unknown>>> = {
    intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "fix café bug", resumed: false },
    wall: { files: [{ path: "tests/loki_wall_café.py", sha256: "cd".repeat(32) }] },
    implement: { exit: "done", tests_reverted: [], duration_s: 3, iteration_id: "e10-r1-impl" },
    verify: {
      checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1.5 }],
      flaky: [], wall_passed: true, duration_s: 2,
    },
    ...over,
  };
  const ctx: RunContext = {
    runId: "r1", repoDir: repo, runDir: join(repo, ".loki/runs/r1"), baseSha: base, branch: "loki/r1",
    provider, model: "mödel", deep: false, capS: 900,
    emit: (type: EventType, _s: StageName | null, data: Record<string, unknown>) => { events.push({ type, data }); },
    sessions: { run: async () => { throw new Error("no sessions in seal"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }) },
    clock: { now: () => 0 },
    outputs: () => outputs,
  };
  return { ctx, events };
}

const noKey = () => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "nokey", "k.pem"); }; // a throwaway auto-generated key, never the real ~/.loki
const receiptOf = (s: { data: Record<string, unknown> }) => JSON.parse(readFileSync(s.data.receipt_path as string, "utf8")) as Receipt;
// Python recompute of receipt_sha256 plus JWT verification against the public JWK.
const VERIFY_PY = `
import sys, json, hashlib
sys.path.insert(0, sys.argv[1])
from cryptography.hazmat.primitives import serialization
from receipt_jwt import public_jwk, verify_attestation
r = json.load(open(sys.argv[2]))
body = {k: v for k, v in r.items() if k not in ("verification", "receipt_sha256")}
h = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
pub = serialization.load_pem_public_key(open(sys.argv[3], "rb").read())
ok, claims = verify_attestation(r["verification"]["jwt"], {"keys": [public_jwk(pub)]})
print(json.dumps({"hash": h, "ok": ok, "claims": claims}))
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loki-seal-test."));
  for (const c of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3",
    ...(process.env["PATH"] ?? "").split(":").filter((d) => d.startsWith("/")).map((d) => `${d}/python3`)]) {
    // Bun.spawnSync throws ENOENT on Linux for a missing path (macOS returns non-zero), so skip absent candidates.
    if (!existsSync(c)) continue;
    const p = Bun.spawnSync({ cmd: [c, "-I", "-c", "import cryptography"], stdout: "ignore", stderr: "ignore", env: process.env });
    if (p.exitCode === 0) { cryptoPy = c; break; }
  }
});
beforeEach(() => noKey()); // default to a throwaway key for every test; tests override as needed
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
afterEach(() => {
  _setIsolatedPythonFixedForTests(null);
  process.env["HOME"] = REAL_HOME;
  if (PRE_KEY_FILE === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = PRE_KEY_FILE; // restore the preload default (E-154b)
  delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
});

describe("engine10 seal", () => {
  test("signed: JWT verifies through verify_attestation and the hash recomputes", async () => {
    // Fail loudly rather than skip: a skip here would be a false green.
    expect(cryptoPy).not.toBe("");
    _setIsolatedPythonFixedForTests([cryptoPy]);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyFile = join(root, "k.pem");
    const pubFile = join(root, "k.pub.pem");
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    writeFileSync(pubFile, publicKey.export({ type: "spki", format: "pem" }) as string);
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;

    const { repo, base } = makeRepo("signed");
    const { ctx, events } = ctxFor(repo, base);
    const c = await commitStage.run(ctx, new AbortController().signal);
    expect(c.status).toBe("completed");
    const log = sh(["git", "log", "-1", "--format=%B"], repo);
    expect(log).toContain("loki: fix café bug");
    expect(log).toContain("Loki-Run: r1");
    expect(sh(["git", "status", "--porcelain", "--", "a.txt"], repo)).toBe("");
    expect(sh(["git", "ls-files", ".loki"], repo)).toBe("");

    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.status).toBe("completed");
    expect(s.data.signed).toBe(true);
    expect(s.data.verdict).toBe("VERIFIED");
    const path = s.data.receipt_path as string;
    const r = JSON.parse(readFileSync(path, "utf8")) as Receipt;
    expect(r.head_sha).not.toBe(base);
    expect(r.base_sha).toBe(base);
    expect(r.verification.kid).toBeTruthy();

    const out = JSON.parse(sh([cryptoPy, "-I", "-c", VERIFY_PY, AUTONOMY, path, pubFile], root));
    expect(out.hash).toBe(r.receipt_sha256);
    expect(out.ok).toBe(true);
    expect(out.claims.receipt_sha256).toBe(r.receipt_sha256);
    expect(out.claims.run_id).toBe("r1");
    const ev = events.find((e) => e.type === "receipt.sealed");
    expect(ev?.data.signed).toBe(true);
    expect(ev?.data.receipt_sha256).toBe(r.receipt_sha256);
  }, 30000);

  test("E-69: a partial ctx.cost.read() reaches the receipt's measured/total/partial fields", async () => {
    noKey();
    const { repo, base } = makeRepo("partial-cost");
    const { ctx } = ctxFor(repo, base);
    ctx.cost = { read: () => ({ usd: null, inputTokens: 1200, outputTokens: 200, cacheReadTokens: 0, measuredCount: 1, totalCount: 2, partialUsd: 0.125 }) };
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.cost.usd).toBeNull();
    expect(r.cost.measured_sessions).toBe(1);
    expect(r.cost.total_sessions).toBe(2);
    expect(r.cost.partial_usd).toBe(0.125);
  }, 30000);

  test("A-121 G5: clean HOME, no key env: seal auto-generates a 0600 key, signs, verify reports VERIFIED, one flipped byte is TAMPERED", async () => {
    const home = join(root, "clean-home");
    mkdirSync(home);
    process.env["HOME"] = home; // throwaway: the real ~/.loki is never touched
    delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
    delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; // exercises the default ~/.loki path; afterEach restores the preload default
    const { repo, base } = makeRepo("clean-home-repo");
    const { ctx, events } = ctxFor(repo, base, "codex");
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.signed).toBe(true);
    expect(String(s.data.summary)).toContain("SIGNED");
    const keyFile = join(home, ".loki", "keys", RECEIPT_SIGNER_BASENAME);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(keyFile)).mode & 0o777).toBe(0o700);
    const path = s.data.receipt_path as string;
    const r = JSON.parse(readFileSync(path, "utf8")) as Receipt;
    expect(r.not_proven).not.toContain(SIGNING_UNAVAILABLE);
    // The private key never appears in the receipt, receipt.md, the events, or the verify output.
    const secret = readFileSync(keyFile, "utf8").split("\n").filter((l) => l && !l.startsWith("-----"))[0]!;
    const out: string[] = [];
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    try { expect(await verifyMain(["r1"], { runsRoot: dirname(ctx.runDir) })).toBe(0); } finally { process.stdout.write = w; }
    expect(out.join("")).toContain("attestation: VERIFIED");
    for (const text of [readFileSync(path, "utf8"), readFileSync(join(ctx.runDir, "receipt.md"), "utf8"), JSON.stringify(events), out.join("")]) expect(text).not.toContain(secret);
    expect((await verifyReceipt(path)).verdict).toBe("VERIFIED");
    // A second seal reuses the same key (same kid).
    const s2 = await sealStage.run(ctx, new AbortController().signal);
    expect(receiptOf(s2).verification.kid).toBe(r.verification.kid);
    // Flip one byte of a signed field: not verified.
    writeFileSync(path, readFileSync(path, "utf8").replace(`"provider": "codex"`, `"provider": "codey"`));
    expect((await verifyReceipt(path)).verdict).toBe("TAMPERED");
  }, 30000);

  test("A-121: a retired public key still verifies, an unknown kid is UNCHECKED, never TAMPERED", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyFile = join(root, "rot", "k.pem");
    mkdirSync(dirname(keyFile));
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    const retired = join(root, "rot", "old.pub.pem");
    writeFileSync(retired, publicKey.export({ type: "spki", format: "pem" }) as string);
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    const { repo, base } = makeRepo("rotation");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    const path = (await sealStage.run(ctx, new AbortController().signal)).data.receipt_path as string;
    // Rotate: a new active key, the old one retired.
    const rotated = join(root, "rot", "new.pem");
    writeFileSync(rotated, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = rotated;
    const other = await verifyReceipt(path); // sealed with A, verified with only B
    expect(other.verdict).toBe("UNCHECKED");
    expect(other.reasons.join(" ")).toContain((JSON.parse(readFileSync(path, "utf8")) as Receipt).verification.kid!);
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "rot", "missing", "k.pem"); // no key at all
    expect((await verifyReceipt(path)).verdict).toBe("UNCHECKED");
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = rotated;
    // A known kid with a flipped signature byte stays TAMPERED; a non-string jwt is UNCHECKED, not a crash.
    const good = JSON.parse(readFileSync(path, "utf8")) as Receipt;
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    copyFileSync(join(dirname(path), "events.jsonl"), join(root, "rot", "events.jsonl")); // A-117: verify reads the log beside the receipt
    const badSig = join(root, "rot", "badsig.json");
    const jwt = good.verification.jwt!;
    writeFileSync(badSig, JSON.stringify({ ...good, verification: { ...good.verification, jwt: jwt.slice(0, -2) + (jwt.endsWith("AA") ? "BB" : "AA") } }));
    expect((await verifyReceipt(badSig)).verdict).toBe("TAMPERED");
    const numJwt = join(root, "rot", "num.json");
    writeFileSync(numJwt, JSON.stringify({ ...good, verification: { jwt: 123, kid: null } }));
    expect((await verifyReceipt(numJwt)).verdict).toBe("UNCHECKED");
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = rotated;
    process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"] = retired;
    try { expect((await verifyReceipt(path)).verdict).toBe("VERIFIED"); } finally { delete process.env["LOKI_RECEIPT_RETIRED_PUBKEYS"]; }
  }, 30000);

  test("A-121 interop: a Python-generated key signs in TS and receipt_jwt.py verifies it, and TS reads the same kid", async () => {
    if (!cryptoPy) { console.log("SKIP: no python3 with cryptography: Python interop not measured here"); return; }
    const keyFile = join(root, "py", "k.pem");
    const pyOut = JSON.parse(sh([cryptoPy, "-I", "-c", `
import sys, json
sys.path.insert(0, sys.argv[1])
import os
os.environ["LOKI_RECEIPT_SIGNING_KEY_FILE"] = sys.argv[2]
from receipt_jwt import load_signing_key, public_jwk
k, kid = load_signing_key()
print(json.dumps({"kid": kid, "jwk": public_jwk(k.public_key())}))`, AUTONOMY, keyFile], root));
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    const { repo, base } = makeRepo("interop");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.verification.kid).toBe(pyOut.kid);
    const v = JSON.parse(sh([cryptoPy, "-I", "-c", `
import sys, json
sys.path.insert(0, sys.argv[1])
from receipt_jwt import verify_attestation
ok, c = verify_attestation(sys.argv[2], {"keys": [json.loads(sys.argv[3])]})
print(json.dumps({"ok": ok, "c": c}))`, AUTONOMY, r.verification.jwt!, JSON.stringify(pyOut.jwk)], root));
    expect(v.ok).toBe(true);
    expect(v.c.receipt_sha256).toBe(r.receipt_sha256);
  }, 30000);

  test("TS-generated key file loads in receipt_jwt.py with the same kid (same PEM format)", async () => {
    if (!cryptoPy) { console.log("SKIP: no python3 with cryptography: Python interop not measured here"); return; }
    const keyFile = join(root, "ts-gen", "k.pem");
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    const { repo, base } = makeRepo("tsgen");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    const kid = sh([cryptoPy, "-I", "-c", `
import sys, os
sys.path.insert(0, sys.argv[1])
os.environ["LOKI_RECEIPT_SIGNING_KEY_FILE"] = sys.argv[2]
from receipt_jwt import load_signing_key
print(load_signing_key(auto_generate=False)[1])`, AUTONOMY, keyFile], root).trim();
    expect(kid).toBe(r.verification.kid!);
  }, 30000);

  test("empty diff without the already-done marker seals FAILED, never VERIFIED", async () => {
    noKey();
    const { repo, base } = makeRepo("empty");
    sh(["git", "checkout", "-q", "--", "a.txt"], repo);
    const { ctx } = ctxFor(repo, base);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.verdict).toBe("FAILED");
    // A commit that only touches .loki/ is still an empty diff.
    sh(["git", "add", "-f", ".loki/runs/r1/events.jsonl"], repo);
    sh(["git", "commit", "-q", "-m", "loki only"], repo);
    expect(sh(["git", "rev-parse", "HEAD"], repo).trim()).not.toBe(base);
    expect((await sealStage.run(ctx, new AbortController().signal)).data.verdict).toBe("FAILED");
    // The LOKI_ALREADY_DONE marker (exit already_done) is the only way an empty diff is not FAILED.
    const done = ctxFor(repo, base, "claude", { implement: { exit: "already_done", tests_reverted: [], duration_s: 1 } });
    expect((await sealStage.run(done.ctx, new AbortController().signal)).data.verdict).toBe("ALREADY_SATISFIED");
  }, 30000);

  // D42 (3)/B1 (r2): wall.ts's own not_run can never seal ALREADY_SATISFIED, and it must show up on
  // NOT PROVEN -- {pass:1, fail:0, not_run:1} is a base run that never proved the task was already done.
  test("wall base_run.not_run refuses ALREADY_SATISFIED and lands on NOT PROVEN", async () => {
    noKey();
    const { repo, base } = makeRepo("wall-not-run");
    const { ctx } = ctxFor(repo, base, "claude", {
      wall: { files: [{ path: "tests/loki_wall_x.py", sha256: "ab".repeat(32) }], base_run: { pass: 1, fail: 0, not_run: 1 } },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.verdict).not.toBe("ALREADY_SATISFIED");
    expect(receiptOf(s).not_proven).toContain("wall base run not_run: 1");
  }, 30000);

  // E-66 review finding 4: an ALREADY_SATISFIED (no-change) verdict must carry the evidence that
  // justified it in the receipt itself, not just in intake's own stage output -- the receipt is
  // what a reviewer or Seal check actually reads.
  test("evidence-confirmed already-satisfied carries its evidence into the receipt", async () => {
    noKey();
    const { repo, base } = makeRepo("evidence");
    const EVIDENCE = ["search-command.ts:1 already implemented", "src/search-command.ts: search", "CHANGELOG.md: Global Search"];
    const { ctx } = ctxFor(repo, base, "claude", {
      intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "add search", resumed: false, already_satisfied: true, evidence: EVIDENCE },
    });
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.status).toBe("completed");
    expect(s.data.verdict).toBe("ALREADY_SATISFIED");
    const r = receiptOf(s);
    expect(r.evidence).toEqual(EVIDENCE);
    const md = readFileSync(join(ctx.runDir, "receipt.md"), "utf8");
    for (const e of EVIDENCE) expect(md).toContain(e);
  }, 30000);

  test("a normal VERIFIED run carries no evidence: the field is empty, not omitted", async () => {
    noKey();
    const { repo, base } = makeRepo("no-evidence");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.evidence).toEqual([]);
  }, 30000);

  test("diff_sha256 does not depend on repo diff or color config", async () => {
    noKey();
    const { repo, base } = makeRepo("cfg");
    writeFileSync(join(repo, "zé.txt"), "new\n");
    writeFileSync(join(repo, "b.bin"), Buffer.from([0, 1, 2, 255]));
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    const h1 = receiptOf(await sealStage.run(ctx, new AbortController().signal)).diff_sha256;
    writeFileSync(join(root, "order.txt"), "zé.txt\nb.bin\na.txt\n");
    for (const [k, v] of [["diff.noprefix", "true"], ["color.ui", "always"], ["color.diff", "always"], ["core.quotepath", "true"],
      ["diff.renames", "copies"], ["core.abbrev", "7"], ["diff.orderFile", join(root, "order.txt")], ["diff.mnemonicPrefix", "true"]]) {
      sh(["git", "config", k!, v!], repo);
    }
    const h2 = receiptOf(await sealStage.run(ctx, new AbortController().signal)).diff_sha256;
    expect(h2).toBe(h1);
  }, 30000);

  test("off-table intake keys go on NOT PROVEN when absent; verify's own not_proven is a trusted section 4 key (E-98a B1)", async () => {
    noKey();
    const { repo, base } = makeRepo("keys");
    const { ctx } = ctxFor(repo, base, "claude", {
      intake: { source: "issue", task_sha256: "ab".repeat(32) },
      implement: { exit: "done", tests_reverted: [] },
      verify: {
        checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1 }, { name: "ruff", cmd: "ruff check", result: "not_run", duration_s: 0 }],
        flaky: [], not_proven: ["tests ran on the system interpreter"],
      },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.task.source).toBe("issue");
    expect(r.not_proven).toContain("not run: ruff");
    expect(r.not_proven).toContain("tests ran on the system interpreter");
    for (const n of ["repo not recorded by intake", "resume state not recorded by intake", "wall result not recorded by verify",
      "cost not measured (no iteration ids recorded)"]) expect(r.not_proven).toContain(n);
    expect(r.verdict).toBe("PARTIAL");
    const noSrc = ctxFor(repo, base, "claude", { intake: { task_sha256: "ab".repeat(32) } });
    expect(receiptOf(await sealStage.run(noSrc.ctx, new AbortController().signal)).not_proven).toContain("task source not recorded by intake");
  }, 30000);

  test("A-112: verify pre_red ids list as `pre red: <id>` and do not downgrade VERIFIED", async () => {
    noKey();
    const { repo, base } = makeRepo("prered");
    const { ctx } = ctxFor(repo, base, "claude", { verify: { checks: [{ name: "node:a.test.js", cmd: "node --test", result: "pass", duration_s: 1 }, { name: "node:o.test.js", cmd: "node --test", result: "fail", duration_s: 1 }], flaky: [], wall_passed: true, pre_red: ["unrelated"], pre_red_checks: ["node:o.test.js"] } });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.not_proven).toContain("pre red: unrelated");
    expect(r.verdict).toBe("VERIFIED");
    expect(r.checks.find((c) => c.name === "node:o.test.js")?.result).toBe("fail"); // never recorded as pass
  }, 30000);

  // E-98a B1: verify passing every check must not seal VERIFIED when verify itself flagged a
  // system-interpreter run. Red on pre-B1 code: verdictOf never looked at o.verify.not_proven,
  // so this sealed VERIFIED with no "tests ran on the system interpreter" line in the receipt.
  test("E-98a B1: all checks pass but verify reports a system interpreter: never VERIFIED, line carried", async () => {
    noKey();
    const { repo, base } = makeRepo("system-interp");
    const { ctx } = ctxFor(repo, base, "claude", {
      verify: {
        checks: [{ name: "pytest:tests/test_x.py", cmd: "python3 -m pytest -q tests/test_x.py", result: "pass", duration_s: 1, interpreter: "system" }],
        flaky: [], wall_passed: true, not_proven: ["tests ran on the system interpreter"],
      },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.not_proven).toContain("tests ran on the system interpreter");
    expect(r.verdict).not.toBe("VERIFIED");
  }, 30000);

  // E-116: real-seal SPEC_CONFLICT coverage, driven through sealStage.run (not a copy of
  // verdictOf's logic like machine.test.ts's fake seal stage at seal.ts:110). Each case is
  // built so the diff is non-empty and every other verdictOf branch (already-satisfied,
  // empty diff, failing/not-run checks) would otherwise resolve to something other than
  // SPEC_CONFLICT, so a seal.ts that dropped the spec_conflict branch flips these red.
  test("E-116: implement exits spec_conflict, verify passes: seal still reports SPEC_CONFLICT", async () => {
    noKey();
    const { repo, base } = makeRepo("spec-conflict-verify-pass");
    const { ctx, events } = ctxFor(repo, base, "claude", {
      implement: { exit: "spec_conflict", spec_conflict_reason: "the task contradicts the Wall tests", tests_reverted: [], duration_s: 2 },
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.verdict).toBe("SPEC_CONFLICT");
    const r = receiptOf(s);
    expect(r.verdict).toBe("SPEC_CONFLICT");
    expect(readFileSync(join(ctx.runDir, "receipt.md"), "utf8")).toContain("## Loki receipt: SPEC_CONFLICT");
    expect(events.find((e) => e.type === "receipt.sealed")?.data.verdict).toBe("SPEC_CONFLICT");
  }, 30000);

  test("E-116: implement exits spec_conflict, verify fails through fix rounds and is still failing: seal still reports SPEC_CONFLICT", async () => {
    noKey();
    const { repo, base } = makeRepo("spec-conflict-verify-fail");
    // outputs() is keyed by stage name, so a fix round's re-run of verify overwrites the
    // earlier one; this is that final, still-failing verify state.
    const { ctx, events } = ctxFor(repo, base, "claude", {
      implement: { exit: "spec_conflict", spec_conflict_reason: "the task contradicts the Wall tests", tests_reverted: [], duration_s: 2 },
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "fail", duration_s: 1 }], flaky: [], wall_passed: false, duration_s: 1 },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.verdict).toBe("SPEC_CONFLICT");
    const r = receiptOf(s);
    expect(r.verdict).toBe("SPEC_CONFLICT");
    expect(readFileSync(join(ctx.runDir, "receipt.md"), "utf8")).toContain("## Loki receipt: SPEC_CONFLICT");
    expect(events.find((e) => e.type === "receipt.sealed")?.data.verdict).toBe("SPEC_CONFLICT");
  }, 30000);

  test("E-116: implement exits spec_conflict, fix rounds bring verify to all-pass: verdict is never upgraded to VERIFIED", async () => {
    noKey();
    const { repo, base } = makeRepo("spec-conflict-fix-recovers");
    // Same shape as the passing case above, but named for the scenario that actually
    // distinguishes SPEC_CONFLICT from a normal run: fix rounds made verify green, and
    // without the spec_conflict branch checked first, verdictOf would return VERIFIED.
    const { ctx } = ctxFor(repo, base, "claude", {
      implement: { exit: "spec_conflict", spec_conflict_reason: "the task contradicts the Wall tests", tests_reverted: [], duration_s: 2 },
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.verdict).toBe("SPEC_CONFLICT");
    expect(r.verdict).not.toBe("VERIFIED");
  }, 30000);

  // E-120: implement.ts produces spec_conflict_reason (implement.test.ts:153); seal.ts now
  // carries it into receipt.json (outputs.implement.spec_conflict_reason survives as-is) and
  // renders it in receipt.md next to the verdict line.
  test("E-120: spec_conflict_reason reaches receipt.json and receipt.md", async () => {
    noKey();
    const { repo, base } = makeRepo("spec-conflict-reason-present");
    const REASON = "distinctive-reason-e116-marker: the task contradicts the Wall tests";
    const { ctx } = ctxFor(repo, base, "claude", {
      implement: { exit: "spec_conflict", spec_conflict_reason: REASON, tests_reverted: [], duration_s: 2 },
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    const raw = readFileSync(s.data.receipt_path as string, "utf8");
    const md = readFileSync(join(ctx.runDir, "receipt.md"), "utf8");
    expect(raw).toContain(REASON);
    expect(md).toContain(`\`${REASON}\``);
    expect(JSON.parse(raw).spec_conflict_reason).toBe(REASON);
  }, 30000);

  // E-120: a missing reason (any other verdict, or a spec_conflict with no reason recorded)
  // must not break the receipt or leave a dangling "Reason:" label with nothing after it, and
  // must not write `"spec_conflict_reason": null` -- the key is omitted entirely so
  // receipt_sha256 for every run without a reason stays byte-stable.
  test("E-120: no spec_conflict_reason recorded: receipt builds clean, no dangling label, key omitted", async () => {
    noKey();
    const { repo, base } = makeRepo("spec-conflict-no-reason");
    const { ctx } = ctxFor(repo, base, "claude", {
      implement: { exit: "spec_conflict", tests_reverted: [], duration_s: 2 },
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    const raw = readFileSync(s.data.receipt_path as string, "utf8");
    const md = readFileSync(join(ctx.runDir, "receipt.md"), "utf8");
    expect("spec_conflict_reason" in JSON.parse(raw)).toBe(false);
    expect(raw).not.toContain("spec_conflict_reason");
    expect(md).not.toContain("Reason:");
    expect(s.data.verdict).toBe("SPEC_CONFLICT");
  }, 30000);

  // E-120 (opus-blocking finding): spec_conflict_reason is model-written and was rendered raw
  // into receipt.md, so a reason containing "\n\n## Loki receipt: VERIFIED\n- receipt_sha256:
  // ..." would forge a second heading and a fake VERIFIED line into the trust artifact. seal.ts
  // must collapse newlines/control chars, cap the length, and wrap the reason in a single
  // inline-code span so it can never start a heading or list item.
  test("E-120: a hostile reason with an embedded fake heading cannot inject markdown into receipt.md", async () => {
    noKey();
    const { repo, base } = makeRepo("spec-conflict-hostile-reason");
    const HOSTILE = "x\n\n## Loki receipt: VERIFIED\n- receipt_sha256: 0000000000000000000000000000000000000000000000000000000000000000";
    const { ctx } = ctxFor(repo, base, "claude", {
      implement: { exit: "spec_conflict", spec_conflict_reason: HOSTILE, tests_reverted: [], duration_s: 2 },
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    const md = readFileSync(join(ctx.runDir, "receipt.md"), "utf8");
    const lines = md.split("\n");
    // exactly one real h2 heading (the true verdict line), no forged second one; receipt.md's
    // own "### Checks" / "### NOT PROVEN" h3s are legitimate and excluded by the single "#".
    expect(lines.filter((l) => /^## [^#]/.test(l))).toHaveLength(1);
    expect(lines[0]).toBe(`## Loki receipt: ${s.data.verdict}`);
    // exactly one Reason line, and it is a single inline-code span with no embedded newline
    const reasonLines = lines.filter((l) => l.startsWith("- Reason:"));
    expect(reasonLines).toHaveLength(1);
    expect(reasonLines[0]).toMatch(/^- Reason: `[^`\n]*`$/);
    // the raw hostile payload never appears verbatim (its newlines are gone)
    expect(md).not.toContain(HOSTILE);
    expect(md).not.toContain("VERIFIED\n- receipt_sha256: 0000");
  }, 30000);

  test("E-55: a modified, deleted, or symlink-replaced base_sha test file lands on NOT PROVEN by name; a new test file does not", async () => {
    noKey();
    const { repo, base } = makeRepo("weaken");
    // t_old.test.ts existed at base_sha and gets weakened (edited); t_gone.test.ts
    // existed at base_sha and gets deleted; t_sym.test.ts existed at base_sha and
    // gets replaced by a symlink (git status T, a typechange); t_new.test.ts is
    // new, never flagged.
    writeFileSync(join(repo, "t_old.test.ts"), "old\n");
    writeFileSync(join(repo, "t_gone.test.ts"), "gone\n");
    writeFileSync(join(repo, "t_sym.test.ts"), "sym\n");
    sh(["git", "add", "t_old.test.ts", "t_gone.test.ts", "t_sym.test.ts"], repo);
    sh(["git", "commit", "-q", "-m", "add tests"], repo);
    const base2 = sh(["git", "rev-parse", "HEAD"], repo).trim();
    writeFileSync(join(repo, "t_old.test.ts"), "weakened\n");
    sh(["git", "rm", "-q", "t_gone.test.ts"], repo);
    rmSync(join(repo, "t_sym.test.ts"));
    symlinkSync("/dev/null", join(repo, "t_sym.test.ts"));
    writeFileSync(join(repo, "t_new.test.ts"), "new\n");
    const { ctx } = ctxFor(repo, base2);
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.not_proven).toContain("weakened test: t_old.test.ts");
    expect(r.not_proven).toContain("weakened test: t_gone.test.ts");
    expect(r.not_proven).toContain("weakened test: t_sym.test.ts");
    expect(r.not_proven.some((n) => n.includes("t_new.test.ts"))).toBe(false);
    // Editing a.txt, a non-test file, never lands on NOT PROVEN by this check.
    expect(r.not_proven.some((n) => n.includes("a.txt"))).toBe(false);
  }, 30000);

  test("A-119: a renamed test file (with or without a content change) is NOT VERIFIED; an honest source-only fix stays VERIFIED", async () => {
    noKey();
    const seal = async (tag: string, edit: (repo: string) => void): Promise<{ verdict: string; not_proven: string[] }> => {
      const { repo } = makeRepo("rename" + tag);
      writeFileSync(join(repo, "sum.test.js"), "expect 6\n");
      sh(["git", "add", "sum.test.js"], repo);
      sh(["git", "commit", "-q", "-m", "add test"], repo);
      const b = sh(["git", "rev-parse", "HEAD"], repo).trim();
      edit(repo);
      const { ctx } = ctxFor(repo, b);
      await commitStage.run(ctx, new AbortController().signal);
      return receiptOf(await sealStage.run(ctx, new AbortController().signal));
    };
    const weakened = await seal("w", (r) => { sh(["git", "mv", "sum.test.js", "sum.spec.test.js"], r); writeFileSync(join(r, "sum.spec.test.js"), "expect 5\n"); });
    expect(weakened.not_proven).toContain("weakened test: sum.test.js");
    expect(weakened.verdict).not.toBe("VERIFIED");
    const pure = await seal("p", (r) => { sh(["git", "mv", "sum.test.js", "sum.spec.test.js"], r); });// a pure rename is still a test edit: PARTIAL by decision
    expect(pure.verdict).not.toBe("VERIFIED");
    const honest = await seal("h", (r) => { writeFileSync(join(r, "a.txt"), "fixed\n"); });
    expect(honest.verdict).toBe("VERIFIED");
  }, 30000);

  test("an unusable key: signed false, SIGNING_UNAVAILABLE on NOT PROVEN, hash still recomputes", async () => {
    const keyFile = join(root, "k2.pem");
    writeFileSync(keyFile, "not a pem\n", { mode: 0o600 });
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = keyFile;
    const { repo, base } = makeRepo("nosign");
    const { ctx, events } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.signed).toBe(false);
    expect(String(s.data.summary)).toContain("UNSIGNED");
    const r = receiptOf(s);
    expect(r.verification).toEqual({ jwt: null, kid: null });
    expect(r.not_proven).toContain(SIGNING_UNAVAILABLE);
    expect(readFileSync(join(ctx.runDir, "receipt.md"), "utf8")).toContain("UNSIGNED");
    expect(events.find((e) => e.type === "receipt.sealed")?.data.signed).toBe(false);
    expect((await verifyReceipt(s.data.receipt_path as string)).verdict).toBe("UNSIGNED");
    expect(readFileSync(keyFile, "utf8")).toBe("not a pem\n"); // an invalid key is never overwritten
  }, 30000);
});

// E-69: renderReceiptMd is pure, so the three cost states are tested directly against a
// fabricated receipt rather than driving the full git/signing pipeline for each one.
function receiptWithCost(cost: Receipt["cost"]): Receipt {
  return {
    schema: "loki.v10.receipt/1", run_id: "r1", task: { source: "text", sha256: "ab".repeat(32) }, repo: "o/r",
    base_sha: "b".repeat(40), head_sha: "h".repeat(40), tree: "t".repeat(40), diff_sha256: "d".repeat(64),
    wall: { files: [], passed: null }, checks: [], not_proven: [], verdict: "PARTIAL", evidence: [], cost,
    time: { wall_s: 10, stages: {} }, provider: "claude", model: "sonnet", resumed: false,
    events_sha256: "e".repeat(64), receipt_sha256: "r".repeat(64), verification: { jwt: null, kid: null },
  };
}
describe("engine10 receipt cost line (E-69)", () => {
  test("fully measured renders the plain $X.XXXX line", () => {
    const md = renderReceiptMd(receiptWithCost({ usd: 0.3, input_tokens: 1000, output_tokens: 200, measured_sessions: 2, total_sessions: 2, partial_usd: 0.3 }));
    expect(md).toContain("Cost: $0.3000");
    expect(md).not.toContain("partial");
  });

  test("not measured (zero sessions priced) renders \"not measured\", never $0.00", () => {
    const md = renderReceiptMd(receiptWithCost({ usd: null, input_tokens: 0, output_tokens: 0, measured_sessions: 0, total_sessions: 2, partial_usd: 0 }));
    expect(md).toContain("Cost: not measured");
    expect(md).not.toContain("$0.00");
    expect(md).not.toContain("partial");
  });

  test("partial (some sessions priced) renders \"partial: $X for N of M sessions\"", () => {
    const md = renderReceiptMd(receiptWithCost({ usd: null, input_tokens: 1000, output_tokens: 200, measured_sessions: 1, total_sessions: 2, partial_usd: 0.125 }));
    expect(md).toContain("Cost: partial: $0.1250 for 1 of 2 sessions");
    expect(md).not.toContain("$0.00");
  });
});

describe("A-104 commit only the fix (G2)", () => {
  const committed = (repo: string, base: string) => sh(["git", "-C", repo, "diff", "--name-only", base, "HEAD"], repo).trim().split("\n").filter(Boolean);
  const dirty = (repo: string) => {
    sh(["mkdir", "-p", join(repo, "tests")], repo);
    writeFileSync(join(repo, "tests/loki_wall_café.js"), "// wall\n");
    writeFileSync(join(repo, "loki_wall_top.js"), "// wall\n");
    writeFileSync(join(repo, "package-lock.json"), "{}\n");
  };

  test("Wall files and a new lockfile are left out when no manifest changed", async () => {
    const { repo, base } = makeRepo("a104-lock");
    dirty(repo);
    const { ctx } = ctxFor(repo, base);
    expect((await commitStage.run(ctx, new AbortController().signal)).status).toBe("completed");
    expect(committed(repo, base)).toEqual(["a.txt"]);
    expect(existsSync(join(repo, "tests/loki_wall_café.js"))).toBe(true);
  });

  test("a lockfile that changed with its manifest is committed", async () => {
    const { repo, base } = makeRepo("a104-manifest");
    dirty(repo);
    writeFileSync(join(repo, "package.json"), "{}\n");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    expect(committed(repo, base)).toEqual(["a.txt", "package-lock.json", "package.json"]);
  });

  test("a lockfile already at base and modified is committed", async () => {
    const { repo } = makeRepo("a104-tracked");
    writeFileSync(join(repo, "go.sum"), "x\n");
    sh(["git", "-C", repo, "add", "go.sum"], repo);
    sh(["git", "-C", repo, "commit", "-q", "-m", "lock"], repo);
    const base = sh(["git", "-C", repo, "rev-parse", "HEAD"], repo).trim();
    writeFileSync(join(repo, "go.sum"), "y\n");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    expect(committed(repo, base)).toEqual(["a.txt", "go.sum"]);
  });
});
