// loki-ts/tests/engine10/seal.test.ts
//
// E-10 wall check (docs/v10/ENGINE.md sections 9 and 16). Signing goes through
// findIsolatedPython3 with -I (never -S) and autonomy/receipt_jwt.py. The JWT is
// verified in Python against the PUBLIC key only, and receipt_sha256 is
// recomputed in Python from receipt.json, so a TS canonicalizer bug cannot
// pass by agreeing with itself.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { snapshotContract } from "../../src/features/contract.ts";
import { snapshotUntracked, splitDirty, untrackedAtIntake } from "../../src/e10ext/preexisting_dirty.ts";
import { generateKeyPairSync } from "node:crypto";
import { sealedLog } from "./log_fixture.ts";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { main as verifyMain, verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { runMachine } from "../../src/engine10/machine.ts";
import { costTotalsOf, sumResultCosts } from "../../src/engine10/cost.ts";
import { buildTime, reconciledTotalS } from "../../src/contrib/receipt_time.ts";
import { EXIT, formatSummary, outcomeOf } from "../../src/engine10/output.ts";
import { safeRestore } from "../../src/e10ext/discard.ts"; import { commitStage, DEEP_NOT_PROVEN, renderReceiptMd, SIGNING_UNAVAILABLE, sealStage } from "../../src/engine10/stages/seal.ts";
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
      checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1.5 }],
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
    sealedLog(dirname(path), r.receipt_sha256);
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
    sealedLog(dirname(path), (JSON.parse(readFileSync(path, "utf8")) as Receipt).receipt_sha256);
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

  // FC-16 r6: a Go Wall file never proves the task already done (wall.classify reports not_run for go exit 0).
  test("go Wall base run with no confirmed pass never yields ALREADY_SATISFIED", async () => {
    noKey();
    const { repo, base } = makeRepo("wall-go-unconfirmed");
    const { ctx } = ctxFor(repo, base, "claude", {
      wall: { files: [{ path: "a_test.go", sha256: "ab".repeat(32) }], base_run: { pass: 0, fail: 0, not_run: 1 } },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.verdict).not.toBe("ALREADY_SATISFIED");
  }, 30000);

  // A-103b: a Wall file discarded for having no real base result (not_run) is listed by path and class, not only counted.
  test("discarded wall test is listed by path and class in not_proven", async () => {
    noKey();
    const { repo, base } = makeRepo("wall-discarded");
    const { ctx } = ctxFor(repo, base, "claude", {
      wall: { files: [{ path: join(repo, "tests/loki_wall_kept.py"), sha256: "ab".repeat(32) }], base_run: { pass: 1, fail: 0, not_run: 1 } },
    });
    mkdirSync(join(ctx.runDir, "wall"), { recursive: true });
    writeFileSync(join(ctx.runDir, "wall/loki_wall_kept.py"), "# kept\n"); writeFileSync(join(ctx.runDir, "wall/loki_wall_gone.py"), "# gone\n");
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    const np = receiptOf(s).not_proven;
    expect(np).toContain("wall test discarded: loki_wall_gone.py (not_run)");
    expect(np).toContain("wall base run not_run: 1");
    expect(np.some((n: string) => n.includes("loki_wall_kept.py"))).toBe(false);
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
        checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1 }, { name: "ruff", cmd: "ruff check", result: "not_run", duration_s: 0 }],
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
    const { ctx } = ctxFor(repo, base, "claude", { verify: { checks: [{ name: "node:a.test.js", cmd: "node --test", result: "pass", n: 1, duration_s: 1 }, { name: "node:o.test.js", cmd: "node --test", result: "fail", duration_s: 1 }], flaky: [], wall_passed: true, pre_red: ["unrelated"], pre_red_checks: ["node:o.test.js"] } });
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
        checks: [{ name: "pytest:tests/test_x.py", cmd: "python3 -m pytest -q tests/test_x.py", result: "pass", n: 1, duration_s: 1, interpreter: "system" }],
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
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.verdict).toBe("SPEC_CONFLICT");
    const r = receiptOf(s);
    expect(r.verdict).toBe("SPEC_CONFLICT");
    expect(readFileSync(join(ctx.runDir, "receipt.md"), "utf8")).toContain("## Loki receipt: SPEC_CONFLICT");
    expect(events.find((e) => e.type === "receipt.sealed")?.data.verdict).toBe("SPEC_CONFLICT");
  }, 30000);

  // FC-16 r5: a Go-only run (count never confirmed) is reported as unconfirmed on NOT PROVEN, never as "no tests executed".
  test("go-only run: NOT PROVEN says the count could not be confirmed, not that no tests executed", async () => {
    noKey();
    const { repo, base } = makeRepo("go-unconfirmed");
    const { ctx } = ctxFor(repo, base, "claude", {
      verify: { checks: [{ name: "go:a_test.go", cmd: "go test -v ./", result: "not_run", reason: "test count could not be confirmed", duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    const np = receiptOf(s).not_proven.join("\n");
    expect(np).toContain("could not be confirmed");
    expect(np).not.toContain("no tests executed");
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
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
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
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
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
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
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
      verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 },
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

  test("D50-F2-S2: a literal value swap is labelled beside weakened test and a deleted assert stays weakened test only; both seal PARTIAL", async () => {
    noKey();
    const BASE = 'import pytest\nfrom impl import naturaldelta\n\n\n@pytest.mark.parametrize("s, e", [\n    (59, "59 seconds"),\n    (119, "a minute"),\n])\ndef test_nd(s, e):\n    assert naturaldelta(s) == e\n';
    const line = "assertion value changed (not shown to be required by the task): test_time.py:7 'a minute' -> '2 minutes'";
    const seal = async (tag: string, head: string, verifyNp: string[], clean = false, counts = true): Promise<{ verdict: string; not_proven: string[] }> => {
      const { repo } = makeRepo("delta" + tag);
      writeFileSync(join(repo, "test_time.py"), BASE);
      sh(["git", "add", "test_time.py"], repo);
      sh(["git", "commit", "-q", "-m", "add test"], repo);
      const b = sh(["git", "rev-parse", "HEAD"], repo).trim();
      writeFileSync(join(repo, "test_time.py"), head);
      if (clean) { writeFileSync(join(repo, ".gitattributes"), "test_time.py filter=evil\n"); sh(["git", "config", "filter.evil.clean", "sed s/2.minutes/3.minutes/"], repo); }
      const { ctx } = ctxFor(repo, b, "claude", { intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "t", task: "fix naturaldelta to say 2 minutes", resumed: false }, verify: { checks: [{ name: "pytest:test_time.py", cmd: "pytest", result: "pass", n: 1, duration_s: 1 }], flaky: [], not_proven: verifyNp, ...(counts ? { test_counts: { "test_time.py": { b: { run: 2, skipped: 0 }, h: { run: 2, skipped: 0 } } } } : {}), duration_s: 2 } });
      await commitStage.run(ctx, new AbortController().signal);
      return receiptOf(await sealStage.run(ctx, new AbortController().signal));
    };
    const swapped = await seal("s", BASE.replace('"a minute"', '"2 minutes"'), [line]);
    expect(swapped.not_proven).toContain(line);
    expect(swapped.not_proven).toContain("weakened test: test_time.py");
    expect(swapped.verdict).toBe("PARTIAL");
    // r3: no counts from verify, or a clean filter that changes the committed literal: the label is dropped, weakened test stays
    const nocount = await seal("n", BASE.replace('"a minute"', '"2 minutes"'), [line], false, false);
    expect(nocount.not_proven).not.toContain(line);
    expect(nocount.not_proven).toContain("weakened test: test_time.py");
    const filtered = await seal("f", BASE.replace('"a minute"', '"2 minutes"'), [line], true);
    expect(filtered.not_proven).not.toContain(line);
    expect(filtered.not_proven).toContain("weakened test: test_time.py");
    expect(filtered.verdict).toBe("PARTIAL");
    const gone = await seal("g", BASE.replace("    assert naturaldelta(s) == e\n", "    pass\n"), ["weakened test: test_time.py"]);
    expect(gone.not_proven).toContain("weakened test: test_time.py");
    expect(gone.verdict).toBe("PARTIAL");
    const unconfirmed = await seal("u", BASE.replace('"a minute"', '"2 minutes"'), []);
    expect(unconfirmed.not_proven).toContain("weakened test: test_time.py");
    expect(unconfirmed.verdict).toBe("PARTIAL");
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
describe("engine10 receipt not_proven rendering (D50-F2r3)", () => {
  test("a label with a backtick or control characters renders sanitized on one line", () => {
    const r = receiptWithCost({ usd: 0, input_tokens: 0, output_tokens: 0, measured_sessions: 1, total_sessions: 1, partial_usd: 0 }); r.not_proven = ["a `b`\n\n## Loki receipt: VERIFIED\x07"];
    const md = renderReceiptMd(r);
    expect(md).toContain("- a 'b' ## Loki receipt: VERIFIED");
    expect(md).not.toContain("\n## Loki receipt");
    expect(md).not.toContain("\x07");
  });
});
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

  test("A-104b: a path starting with :(top) is unstaged literally, never read as a pathspec", async () => {
    const { repo, base } = makeRepo("a104b-top");
    sh(["mkdir", "-p", join(repo, ":(top)x")], repo);
    writeFileSync(join(repo, ":(top)x/loki_wall_a.js"), "// wall\n");
    const { ctx } = ctxFor(repo, base);
    expect((await commitStage.run(ctx, new AbortController().signal)).status).toBe("completed");
    expect(committed(repo, base)).toEqual(["a.txt"]);
  });

  test("A-104b: a stray lockfile in packages/b is not explained by a packages/a manifest change", async () => {
    const { repo, base } = makeRepo("a104b-mono");
    sh(["mkdir", "-p", join(repo, "packages/a"), join(repo, "packages/b")], repo);
    writeFileSync(join(repo, "packages/a/package.json"), "{}\n");
    writeFileSync(join(repo, "packages/a/package-lock.json"), "{}\n");
    writeFileSync(join(repo, "packages/b/package-lock.json"), "{}\n");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    expect(committed(repo, base)).toEqual(["a.txt", "packages/a/package-lock.json", "packages/a/package.json"]);
  });

  test("A-104b: a lockfile and Wall file the agent committed during implement are judged against the run base", async () => {
    const { repo, base } = makeRepo("a104b-base");
    dirty(repo);
    sh(["git", "-C", repo, "add", "package-lock.json", "loki_wall_top.js"], repo);
    sh(["git", "-C", repo, "commit", "-q", "-m", "agent wip"], repo);
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    expect(committed(repo, base)).toEqual(["a.txt"]);
    expect(existsSync(join(repo, "package-lock.json"))).toBe(true);
  });

  test("A-104b r2: a failed reset fails the commit stage, the machine skips seal, and the run exits non-zero", async () => {
    const { repo, base } = makeRepo("a104b-failreset");
    writeFileSync(join(repo, "src.js"), "x\n");
    sh(["git", "-C", repo, "add", "src.js"], repo);
    sh(["git", "-C", repo, "commit", "-q", "-m", "agent wip"], repo);
    writeFileSync(join(root, "outside.txt"), "o\n");
    const h = sh(["git", "hash-object", "--", "../outside.txt"], repo).trim();
    const { ctx } = ctxFor(repo, base, "claude", { intake: { source: "text", title: "t", preexisting_dirty: { "../outside.txt": h } } });
    const intake = { ...commitStage, name: "intake" as const, run: async () => ({ status: "completed" as const, data: { source: "text", title: "t", preexisting_dirty: { "../outside.txt": h } } }) };
    const stages: Record<string, typeof commitStage> = { intake, commit: commitStage, seal: sealStage };
    const r = await runMachine(ctx as never, { flow: ["intake", "commit", "seal"], load: async (n: StageName) => stages[n] ?? null });
    expect(r.stopped).toBe("commit failed");
    expect(r.outputs.seal).toBeUndefined();
    expect(outcomeOf("FAILED", false, r.stopped)).toBe("FAILED");
    expect(EXIT[outcomeOf("FAILED", false, r.stopped)]).not.toBe(0);
    expect(sh(["git", "-C", repo, "status", "--porcelain"], repo)).toContain("a.txt");
    // defense in depth: a caller that seals anyway still never gets VERIFIED
    const { ctx: c2 } = ctxFor(repo, base, "claude", { commit: { failed: true, reason: "git reset failed" } });
    const s = await sealStage.run(c2, new AbortController().signal);
    expect(receiptOf(s).verdict).toBe("FAILED");
  });

  for (const [label, bad] of [["empty", ""], ["unknown", "f".repeat(40)]] as const) {
    test(`A-104b r2: ${label} baseSha fails the commit stage and commits nothing`, async () => {
      const { repo, base } = makeRepo(`a104b-badbase-${label}`);
      dirty(repo);
      const { ctx } = ctxFor(repo, bad);
      const c = await commitStage.run(ctx, new AbortController().signal);
      expect(c.status).toBe("failed");
      expect(sh(["git", "-C", repo, "rev-parse", "HEAD"], repo).trim()).toBe(base);
      expect(sh(["git", "-C", repo, "diff", "--cached", "--name-only"], repo).trim()).toBe("");
    });
  }
});

describe("D50-F1 already-satisfied discards run changes", () => {
  const sig = new AbortController().signal;
  test("already_done with implement edits: no diff vs base, no commit, .loki kept", async () => {
    const { repo, base } = makeRepo("sat-discard");
    writeFileSync(join(repo, "new.txt"), "stray\n");
    const { ctx } = ctxFor(repo, base, "claude", { implement: { exit: "already_done", tests_reverted: [], duration_s: 3 } });
    const c = await commitStage.run(ctx, sig);
    expect(c.status).toBe("completed");
    expect(sh(["git", "rev-parse", "HEAD"], repo).trim()).toBe(base);
    expect(sh(["git", "status", "--porcelain", "--", ".", ":(exclude).loki"], repo)).toBe("");
    expect(sh(["git", "diff", base], repo)).toBe("");
    expect(existsSync(join(repo, ".loki/runs/r1/events.jsonl"))).toBe(true);
    const r = receiptOf(await sealStage.run(ctx, sig));
    expect(r.verdict).toBe("ALREADY_SATISFIED");
    expect(r.head_sha).toBe(base);
  }, 30000);

  test("a normal done run keeps its changes", async () => {
    const { repo, base } = makeRepo("sat-keep");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, sig);
    expect(sh(["git", "rev-parse", "HEAD"], repo).trim()).not.toBe(base);
    expect(sh(["git", "show", "HEAD:a.txt"], repo)).toBe("two\n");
  }, 30000);

  test("a failing discard fails the stage and the verdict is FAILED, never ALREADY_SATISFIED", async () => {
    const { repo } = makeRepo("sat-fail");
    sh(["git", "checkout", "-q", "--", "a.txt"], repo);
    sh(["mkdir", "-p", "d"], repo);
    writeFileSync(join(repo, "d/b.txt"), "x\n");
    sh(["git", "add", "d/b.txt"], repo);
    sh(["git", "commit", "-q", "-m", "b"], repo);
    const base = sh(["git", "rev-parse", "HEAD"], repo).trim();
    writeFileSync(join(repo, "d/b.txt"), "y\n");
    sh(["chmod", "555", join(repo, "d")], repo);
    try {
      const { ctx } = ctxFor(repo, base, "claude", { implement: { exit: "already_done", tests_reverted: [], duration_s: 3 } });
      const c = await commitStage.run(ctx, sig);
      expect(c.status).toBe("failed");
      const { ctx: c2 } = ctxFor(repo, base, "claude", { implement: { exit: "already_done", tests_reverted: [], duration_s: 3 }, commit: { failed: true } });
      expect(receiptOf(await sealStage.run(c2, sig)).verdict).toBe("FAILED");
    } finally { sh(["chmod", "755", join(repo, "d")], repo); }
  }, 30000);

  test("r2: untracked user file survives the discard byte for byte (also with intake.already_satisfied)", async () => {
    for (const intakeSat of [false, true]) {
      const { repo, base } = makeRepo(`sat-untracked-${intakeSat}`);
      writeFileSync(join(repo, "notes.md"), "my notes\n\u00e9\n");
      const pre = untrackedAtIntake(repo);
      expect(pre).toContain("notes.md");
      writeFileSync(join(repo, "new.txt"), "stray\n");
      const intake = { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "t", resumed: false, preexisting_untracked: pre, ...(intakeSat ? { already_satisfied: true } : {}) };
      const { ctx } = ctxFor(repo, base, "claude", { intake, implement: { exit: intakeSat ? "done" : "already_done", tests_reverted: [], duration_s: 3 } });
      expect((await commitStage.run(ctx, sig)).status).toBe("completed");
      expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("my notes\n\u00e9\n");
      expect(sh(["git", "diff", "--cached", "--name-only"], repo)).toBe("");
      expect(existsSync(join(repo, "new.txt"))).toBe(false);
      expect(sh(["git", "rev-parse", "HEAD"], repo).trim()).toBe(base);
    }
  }, 30000);

  test("r2: a pre-existing dirty lockfile edited by the run ends with its intake content", async () => {
    const { repo, base } = makeRepo("sat-lock");
    writeFileSync(join(repo, "package-lock.json"), "L0\n");
    sh(["git", "add", "package-lock.json"], repo);
    sh(["git", "commit", "-q", "-m", "lock"], repo);
    const b2 = sh(["git", "rev-parse", "HEAD"], repo).trim();
    writeFileSync(join(repo, "package-lock.json"), "L1 intake\n");
    const { preexisting } = splitDirty(repo, [" M package-lock.json"]);
    writeFileSync(join(repo, "package-lock.json"), "L2 run\n");
    const intake = { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "t", resumed: false, preexisting_dirty: preexisting };
    const { ctx } = ctxFor(repo, b2, "claude", { intake, implement: { exit: "already_done", tests_reverted: [], duration_s: 3 } });
    expect((await commitStage.run(ctx, sig)).status).toBe("completed");
    expect(readFileSync(join(repo, "package-lock.json"), "utf8")).toBe("L1 intake\n");
    expect(sh(["git", "rev-parse", "HEAD"], repo).trim()).toBe(b2);
    expect(base).toBeTruthy();
  }, 30000);

  describe("r3: intake untracked content is snapshotted and restored", () => {
    const mk = (name: string) => {
      const { repo, base } = makeRepo(name);
      writeFileSync(join(repo, "notes.md"), "USER\n"); writeFileSync(join(repo, "keep.md"), "KEEP\n");
      const snap = snapshotUntracked(repo);
      const intake = { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "t", resumed: false, preexisting_untracked: Object.keys(snap), preexisting_untracked_blobs: snap };
      return { repo, base, intake, mkctx: (extra: Record<string, unknown> = {}) => ctxFor(repo, base, "claude", { intake, implement: { exit: "already_done", tests_reverted: [], duration_s: 3 }, ...extra }) };
    };
    test("edited file restored, deleted file recreated, new file removed", async () => {
      const { repo, mkctx } = mk("r3-a");
      writeFileSync(join(repo, "notes.md"), "USER\nAGENT\n"); rmSync(join(repo, "keep.md")); writeFileSync(join(repo, "new.txt"), "x\n");
      expect((await commitStage.run(mkctx().ctx, sig)).status).toBe("completed");
      expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("USER\n");
      expect(readFileSync(join(repo, "keep.md"), "utf8")).toBe("KEEP\n");
      expect(existsSync(join(repo, "new.txt"))).toBe(false);
      expect(sh(["git", "diff", "--cached", "--name-only"], repo)).toBe("");
    }, 30000);
    test("edit committed during implement is restored and base..HEAD is empty", async () => {
      const { repo, base, mkctx } = mk("r3-b");
      writeFileSync(join(repo, "notes.md"), "USER\nAGENT\n");
      sh(["git", "add", "notes.md"], repo); sh(["git", "commit", "-q", "-m", "agent"], repo);
      expect((await commitStage.run(mkctx().ctx, sig)).status).toBe("completed");
      expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("USER\n");
      expect(sh(["git", "rev-parse", "HEAD"], repo).trim()).toBe(base);
      expect(sh(["git", "diff", `${base}..HEAD`, "--name-only"], repo)).toBe("");
    }, 30000);
    test("unreadable blob: path on NOT PROVEN, outcome is not ALREADY_SATISFIED", async () => {
      const { repo, intake, mkctx } = mk("r3-c");
      const sha = intake.preexisting_untracked_blobs["notes.md"]!.split(" ")[0]!;
      rmSync(join(repo, ".git/objects", sha.slice(0, 2), sha.slice(2)), { force: true });
      writeFileSync(join(repo, "notes.md"), "USER\nAGENT\n");
      const c = await commitStage.run(mkctx().ctx, sig);
      expect(c.status).toBe("completed");
      const r = receiptOf(await sealStage.run(mkctx({ commit: c.data }).ctx, sig));
      expect(r.not_proven).toContain("pre-existing file not restored: notes.md");
      expect(r.verdict).not.toBe("ALREADY_SATISFIED");
    }, 30000);
    test("r4: a symlink left in place of a user file is replaced, never followed", async () => {
      const { repo, mkctx } = mk("r4-a");
      const out = join(repo, "..", "r4-a-outside"); mkdirSync(out, { recursive: true }); writeFileSync(join(out, "victim.txt"), "VICTIM\n");
      rmSync(join(repo, "notes.md")); symlinkSync(join(out, "victim.txt"), join(repo, "notes.md"));
      expect((await commitStage.run(mkctx().ctx, sig)).status).toBe("completed");
      expect(readFileSync(join(out, "victim.txt"), "utf8")).toBe("VICTIM\n");
      expect(lstatSync(join(repo, "notes.md")).isFile()).toBe(true);
      expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("USER\n");
    }, 30000);
    test("r4: a parent dir replaced by a symlink to outside: nothing written outside", async () => {
      const { repo, base } = mk("r4-b");
      mkdirSync(join(repo, "sub")); writeFileSync(join(repo, "sub/deep.md"), "DEEP\n");
      const snap = snapshotUntracked(repo);
      const intake = { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "t", resumed: false, preexisting_untracked: Object.keys(snap), preexisting_untracked_blobs: snap };
      const out = join(repo, "..", "r4-b-outside"); mkdirSync(out, { recursive: true });
      rmSync(join(repo, "sub"), { recursive: true }); symlinkSync(out, join(repo, "sub"));
      const c = await commitStage.run(ctxFor(repo, base, "claude", { intake, implement: { exit: "already_done", tests_reverted: [], duration_s: 3 } }).ctx, sig);
      // the staged symlink is removed, so the user file lands in a real dir; nothing is ever written through the link
      expect(c.status).toBe("completed");
      expect(readdirSync(out)).toEqual([]);
      expect(lstatSync(join(repo, "sub")).isDirectory()).toBe(true);
      expect(readFileSync(join(repo, "sub/deep.md"), "utf8")).toBe("DEEP\n");
    }, 30000);
    test("r5: a pre-existing dirty lockfile replaced by a symlink is never written through", async () => {
      const { repo, base } = makeRepo("r5-a");
      writeFileSync(join(repo, "package-lock.json"), "L0\n"); sh(["git", "add", "package-lock.json"], repo); sh(["git", "commit", "-q", "-m", "lock"], repo);
      const base2 = sh(["git", "rev-parse", "HEAD"], repo).trim();
      writeFileSync(join(repo, "package-lock.json"), "L1 intake\n");
      const blob = sh(["git", "hash-object", "-w", "package-lock.json"], repo).trim();
      const out = join(repo, "..", "r5-a-outside"); mkdirSync(out, { recursive: true }); writeFileSync(join(out, "victim.txt"), "VICTIM\n");
      rmSync(join(repo, "package-lock.json")); symlinkSync(join(out, "victim.txt"), join(repo, "package-lock.json"));
      const intake = { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "t", resumed: false, preexisting_dirty: { "package-lock.json": blob } };
      const c = await commitStage.run(ctxFor(repo, base2, "claude", { intake, implement: { exit: "already_done", tests_reverted: [], duration_s: 3 } }).ctx, sig);
      expect(base2).not.toBe(base);
      expect(readFileSync(join(out, "victim.txt"), "utf8")).toBe("VICTIM\n");
      const l = lstatSync(join(repo, "package-lock.json"));
      if (l.isFile()) expect(readFileSync(join(repo, "package-lock.json"), "utf8")).toBe("L1 intake\n");
      else expect(JSON.stringify(c.data.not_proven ?? [])).toContain("package-lock.json");
    }, 30000);
    test("r5: discard.ts has no raw writeFileSync or chmodSync outside safeRestore", () => {
      const src = readFileSync(join(import.meta.dir, "../../src/e10ext/discard.ts"), "utf8");
      const a = src.indexOf("export function safeRestore"), b = src.indexOf("\n}\n", a);
      const rest = src.slice(0, a) + src.slice(b);
      expect(rest.replace(/^import .*$/gm, "")).not.toMatch(/\b(writeFileSync|chmodSync|unlinkSync|rmSync|renameSync|copyFileSync|symlinkSync|openSync|rmdirSync)\(/);
    });
    test("r4: safeRestore refuses a symlinked parent and writes nothing outside", () => {
      const { repo } = makeRepo("r4-d"); const out = join(repo, "..", "r4-d-outside"); mkdirSync(out, { recursive: true });
      symlinkSync(out, join(repo, "sub"));
      expect(() => safeRestore(repo, "sub/deep.md", Buffer.from("DEEP\n"), 0o644)).toThrow();
      expect(readdirSync(out)).toEqual([]);
    });
    test("r4: an oversize file changed with mtime restored is detected via ctime", async () => {
      const prev = process.env.LOKI_E10_SNAPSHOT_MAX; process.env.LOKI_E10_SNAPSHOT_MAX = "8";
      try {
        const { repo, base } = makeRepo("r4-c");
        writeFileSync(join(repo, "big.bin"), "0123456789ABCDEF");
        const snap = snapshotUntracked(repo); expect(snap["big.bin"]!.startsWith("!")).toBe(true);
        const intake = { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "t", resumed: false, preexisting_untracked: Object.keys(snap), preexisting_untracked_blobs: snap };
        const st = lstatSync(join(repo, "big.bin")); await new Promise((r) => setTimeout(r, 20));
        writeFileSync(join(repo, "big.bin"), "XXXXXXXXXXXXXXXX"); utimesSync(join(repo, "big.bin"), st.atime, st.mtime);
        const mk2 = (extra: Record<string, unknown> = {}) => ctxFor(repo, base, "claude", { intake, implement: { exit: "already_done", tests_reverted: [], duration_s: 3 }, ...extra });
        const c = await commitStage.run(mk2().ctx, sig);
        const r = receiptOf(await sealStage.run(mk2({ commit: c.data }).ctx, sig));
        expect(r.not_proven).toContain("pre-existing file not restored: big.bin");
      } finally { if (prev === undefined) delete process.env.LOKI_E10_SNAPSHOT_MAX; else process.env.LOKI_E10_SNAPSHOT_MAX = prev; }
    }, 30000);
  });
  test("D65-SPEC: LOKI_CONTRACT lines reach receipt not_proven and event, verdict unchanged, malformed contract never throws, flag off is inert", async () => {
    noKey();
    const wc = (repo: string, json: string) => { mkdirSync(join(repo, ".loki"), { recursive: true }); writeFileSync(join(repo, ".loki/contract.json"), json); };
    const goodContract = JSON.stringify({ source: "s", criteria: [{ id: "AC-1", text: "Zebra <b> migration works", source_line: 1 }] });
    const prev = process.env["LOKI_CONTRACT"];
    try {
      process.env["LOKI_CONTRACT"] = "0";
      const a = makeRepo("contract-off-a"); const b = makeRepo("contract-off-b");
      wc(b.repo, goodContract);
      const ra = receiptOf(await sealStage.run(ctxFor(a.repo, a.base).ctx, new AbortController().signal));
      const rb = receiptOf(await sealStage.run(ctxFor(b.repo, b.base).ctx, new AbortController().signal));
      expect((rb as unknown as { contract?: unknown }).contract).toBeUndefined();
      expect(rb.not_proven).toEqual(ra.not_proven);
      expect(rb.verdict).toBe(ra.verdict);

      process.env["LOKI_CONTRACT"] = "1";
      const c = makeRepo("contract-on"); wc(c.repo, goodContract);
      const cc = ctxFor(c.repo, c.base);
      cc.ctx.outputs().intake!.contract_snapshot = snapshotContract(c.repo);
      const sc = await sealStage.run(cc.ctx, new AbortController().signal);
      const rc = receiptOf(sc);
      expect(rc.verdict).toBe(ra.verdict);
      const line = rc.not_proven.find((n) => n.startsWith("contract AC-1 untraced"));
      expect(line).toContain("Zebra &lt;b&gt; migration works");
      expect(readFileSync(join(c.repo, ".loki/runs/r1/receipt.md"), "utf8")).toContain("contract AC-1 untraced");
      expect(cc.events.find((e) => e.type === "receipt.sealed")!.data.not_proven as string[]).toContain(line!);

      const d = makeRepo("contract-bad"); wc(d.repo, '{"source":"x","criteria":[{"id":"AC-1"}]}');
      const dc = ctxFor(d.repo, d.base); dc.ctx.outputs().intake!.contract_snapshot = snapshotContract(d.repo);
      const rd = receiptOf(await sealStage.run(dc.ctx, new AbortController().signal));
      expect(rd.verdict).toBe(ra.verdict);
      expect(existsSync(join(d.repo, ".loki/runs/r1/receipt.json"))).toBe(true);
    } finally { if (prev === undefined) delete process.env["LOKI_CONTRACT"]; else process.env["LOKI_CONTRACT"] = prev; }
  }, 30000);

  test("D65-SPEC-F2 W5: editing contract.json after intake adds a NOT PROVEN line but never changes the verdict", async () => {
    noKey();
    const prev = process.env["LOKI_CONTRACT"];
    try {
      process.env["LOKI_CONTRACT"] = "1";
      const wc = (repo: string, ids: string[]) => { mkdirSync(join(repo, ".loki"), { recursive: true }); writeFileSync(join(repo, ".loki/contract.json"), JSON.stringify({ source: "s", criteria: ids.map((id) => ({ id, text: `zebra ${id} migration`, source_line: 1 })) })); };
      const ctl = makeRepo("contract-f2-ctl");
      const sig = new AbortController().signal;
      const cctl = ctxFor(ctl.repo, ctl.base);
      await commitStage.run(cctl.ctx, sig); // a real commit so the control verdict is VERIFIED, not an empty-diff FAILED
      const rctl = receiptOf(await sealStage.run(cctl.ctx, sig));
      expect(rctl.verdict).toBe("VERIFIED");
      const e = makeRepo("contract-f2-edit"); wc(e.repo, ["AC-1", "AC-2"]);
      const ec = ctxFor(e.repo, e.base);
      await commitStage.run(ec.ctx, sig);
      ec.ctx.outputs().intake!.contract_snapshot = snapshotContract(e.repo);
      wc(e.repo, ["AC-1"]);
      const re = receiptOf(await sealStage.run(ec.ctx, new AbortController().signal));
      expect(re.verdict).toBe(rctl.verdict);
      expect(re.not_proven.some((n) => n.startsWith("contract changed after intake (sha "))).toBe(true);
      const ct = (re as unknown as { contract: { criteria: unknown[]; sha256: string } }).contract;
      expect(ct.criteria).toHaveLength(2);
      expect(ct.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally { if (prev === undefined) delete process.env["LOKI_CONTRACT"]; else process.env["LOKI_CONTRACT"] = prev; }
  }, 30000);

  test("RECEIPT-TRUTH: every stage records duration_s, total_s covers the stage sum, cache tokens are on the receipt", async () => {
    noKey();
    const { repo, base } = makeRepo("receipt-truth");
    let t = Date.parse("2026-01-01T00:00:05.000Z"); // 5s of boot before the first stage
    const { ctx } = ctxFor(repo, base);
    ctx.clock = { now: () => t };
    ctx.cost = { read: () => ({ usd: 0.5, inputTokens: 24, outputTokens: 900, cacheReadTokens: 90000, cacheCreationTokens: 7000 }) };
    const step = (name: StageName, data: Record<string, unknown>) => ({ ...commitStage, name, run: async () => { t += 10000; return { status: "completed" as const, data }; } });
    const stages: Record<string, typeof commitStage> = {
      intake: step("intake", { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", resumed: false }),
      plan: step("plan", {}), verify: step("verify", { checks: [], flaky: [], wall_passed: true }), seal: sealStage,
    };
    mkdirSync(join(repo, ".loki/runs/r1"), { recursive: true });
    writeFileSync(join(repo, ".loki/runs/r1/events.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "run.started" }) + "\n"); // supervisor's first event, 5s before the machine starts
    const r = await runMachine(ctx as never, { flow: ["intake", "plan", "verify", "seal"], load: async (n: StageName) => stages[n] ?? null });
    const rec = JSON.parse(readFileSync(join(repo, ".loki/runs/r1/receipt.json"), "utf8")) as Receipt;
    expect(r.outputs.seal?.verdict).toBe(rec.verdict);
    expect(rec.time.stages).toEqual({ intake: 10, plan: 10, verify: 10, setup: 5, orchestration: 0, seal: 0 });
    expect(rec.time.wall_s).toBe(30);
    expect(rec.time.total_s).toBe(35);
    expect(reconciledTotalS(rec.time)).toBe(35); // real-shaped stream (boot, stages, seal) passes the 1% check
    expect(rec.time.total_s!).toBeGreaterThanOrEqual(rec.time.wall_s);
    expect(rec.cost.input_tokens).toBe(24);
    expect(rec.cost.cache_read_tokens).toBe(90000);
    expect(rec.cost.cache_creation_tokens).toBe(7000);
    expect((await verifyReceipt(join(repo, ".loki/runs/r1/receipt.json"))).reasons.join(";")).not.toMatch(/hash/i);
  }, 30000);

  test("RECEIPT-TRUTH: a gap in the buckets reads NOT RECORDED (reconciledTotalS null), within 1% passes", () => {
    const t = { wall_s: 30, total_s: 100, stages: { intake: 30, setup: 5 } as Record<string, number> };
    expect(reconciledTotalS(t as never)).toBeNull();
    expect(reconciledTotalS({ ...t, stages: { intake: 30, setup: 5, orchestration: 64.5, seal: 0 } } as never)).toBe(100);
    expect(reconciledTotalS({ ...t, stages: { intake: 30, setup: 5, orchestration: 63.9, seal: 0 } } as never)).toBeNull();
    expect(reconciledTotalS({ wall_s: 30, stages: { intake: 30 } })).toBeNull();
    expect(reconciledTotalS({ wall_s: 30, total_s: 40, stages: { "a+b": 30, setup: 10 } })).toBe(40); // a parallel group is one disjoint bucket
    expect(reconciledTotalS({ wall_s: 30, total_s: 35, stages: { a: 30, setup: -0.5, seal: 5.5 } })).toBeNull(); // a negative bucket is a clock fault
  });

  test("RECEIPT-TRUTH: real-shaped timeline with the plan||wall parallel group: stages is a partition whose naive sum equals total_s", () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z"), at = (s: number) => base + s * 1000;
    const iv = (stage: string, a: number, b: number) => ({ stage, startMs: at(a), endMs: at(b) });
    const ctx = { startedAtMs: at(1.5), clock: { now: () => at(36) }, timeline: [
      iv("intake", 1.5, 3.5), iv("plan", 3.5, 13.5), iv("wall", 3.5, 9.5), iv("implement", 14, 31.5), iv("verify", 31.5, 34.5), iv("commit", 34.7, 35.5),
    ] } as unknown as RunContext;
    const t = buildTime(ctx, {}, base);
    expect(t.total_s).toBe(36);
    expect(t.stages["plan+wall"]).toBe(10);
    expect(t.stage_s).toMatchObject({ plan: 10, wall: 6 });
    const naive = Object.values(t.stages).reduce((a, b) => a + b, 0);
    expect(Math.abs(naive - 36)).toBeLessThanOrEqual(0.36); // what a consumer that just adds the buckets (b9-scoreboard) computes
    expect(t.wall_s).toBeLessThanOrEqual(t.total_s!);
    expect(reconciledTotalS(t)).toBe(36);
  });

  // Main does not ship this reader yet: 96626a2e0 (slice-B9-RAW-ARM) is not an ancestor of main and main's b9-scoreboard.sh has no receipt_fields.
  // This test pins the FUTURE reader: the snippet below is byte-identical to 96626a2e0 scripts/b9-scoreboard.sh lines 418-441.
  // It reads time.total_s and adds every time.stages value; more than 1% apart makes the row NOT RECORDED.
  const B9_READER = `import glob, json, os, sys
NR = "NOT RECORDED"
fs = sorted(glob.glob(os.path.join(sys.argv[1], ".loki", "runs", "*", "receipt.json")), key=os.path.getmtime)
v, out = 0, [NR] * 4
def num(x, pos):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and (x > 0 if pos else x >= 0)
if fs:
    try:
        d = json.load(open(fs[-1]))
        v = 1 if d.get("verdict") == "VERIFIED" else 0
        c, t = d.get("cost") or {}, d.get("time") or {}
        ok = num(c.get("usd"), True) and num(t.get("total_s"), True) \\
            and num(c.get("cache_read_tokens"), False) and num(c.get("cache_creation_tokens"), False)
        st = t.get("stages")
        if ok and isinstance(st, dict) and st:
            vals = [x for x in st.values() if num(x, False)]
            ssum = sum(vals)
            if len(vals) != len(st) or ssum <= 0 or abs(t["total_s"] - ssum) > 0.01 * ssum:
                ok = False
        if ok:
            out = [round(c["usd"], 6), round(t["total_s"], 3), c["cache_read_tokens"], c["cache_creation_tokens"]]
    except Exception:
        pass
print("\\t".join([str(v)] + [str(x) for x in out]))
`;
  const b9Row = (time: unknown): string => {
    const d = mkdtempSync(join(tmpdir(), "rt-b9-reader-"));
    try {
      mkdirSync(join(d, ".loki", "runs", "r1"), { recursive: true });
      writeFileSync(join(d, ".loki", "runs", "r1", "receipt.json"), JSON.stringify({ verdict: "VERIFIED", cost: { usd: 0.05, cache_read_tokens: 100, cache_creation_tokens: 10 }, time }));
      const r = spawnSync("python3", ["-I", "-c", B9_READER, d], { encoding: "utf8" });
      return r.stdout.trim();
    } finally { rmSync(d, { recursive: true, force: true }); }
  };

  test("RECEIPT-TRUTH: the b9-scoreboard reader formula gets a number, not NOT RECORDED, on a parallel plan||wall receipt", () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z"), at = (s: number) => base + s * 1000;
    const iv = (stage: string, a: number, b: number) => ({ stage, startMs: at(a), endMs: at(b) });
    const ctx = { startedAtMs: at(1.5), clock: { now: () => at(36) }, timeline: [
      iv("intake", 1.5, 3.5), iv("plan", 3.5, 13.5), iv("wall", 3.5, 9.5), iv("implement", 14, 31.5), iv("verify", 31.5, 34.5), iv("commit", 34.7, 35.5),
    ] } as unknown as RunContext;
    const t = buildTime(ctx, {}, base);
    expect(b9Row(t).split("\t")).toEqual(["1", "0.05", "36", "100", "10"]);
    // the pre-partition shape (plan and wall both listed, overlapping) must read NOT RECORDED, proving the reader would catch a regression
    const overlapped = { ...t, stages: { ...t.stages, plan: 10, wall: 6 } };
    delete (overlapped.stages as Record<string, number>)["plan+wall"];
    expect(b9Row(overlapped).split("\t").slice(1)).toEqual(["NOT RECORDED", "NOT RECORDED", "NOT RECORDED", "NOT RECORDED"]);
  });

  test("RECEIPT-TRUTH: a first event later than machine start makes a negative setup, which reads NOT RECORDED", () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const ctx = { startedAtMs: base, clock: { now: () => base + 10000 }, timeline: [{ stage: "intake", startMs: base, endMs: base + 9000 }] } as unknown as RunContext;
    expect(reconciledTotalS(buildTime(ctx, {}, base + 500))).toBeNull();
  });

  test("R3-2: with an ambiguous resume the sealed cost block carries no cache, per_model, turns or sdk_duration_ms keys", async () => {
    noKey();
    const { repo, base } = makeRepo("receipt-truth-ambig");
    const { ctx } = ctxFor(repo, base);
    const dir = mkdtempSync(join(tmpdir(), "rt-ambig-"));
    try {
      mkdirSync(join(dir, "metrics"), { recursive: true });
      const mu = (c: number) => ({ m: { input_tokens: 100, output_tokens: 1, cache_read_tokens: 1000, cache_creation_tokens: 10, cost_usd: c } });
      const rec = { output_tokens: 1, cache_read_tokens: 1000, cache_creation_tokens: 10, num_turns: 2, duration_ms: 500 };
      writeFileSync(join(dir, "metrics", "result-cost-impl.json"), JSON.stringify({ ...rec, total_cost_usd: 1, input_tokens: 100, session_id: "S1", model_usage: mu(1) }));
      writeFileSync(join(dir, "metrics", "result-cost-fix.json"), JSON.stringify({ ...rec, total_cost_usd: 1.4, input_tokens: 140, session_id: "S1", resumed_from: "S1", model_usage: mu(1.4) }));
      ctx.cost = { read: () => costTotalsOf(sumResultCosts(dir, ["impl", "fix"])) };
      const cost = receiptOf(await sealStage.run(ctx, new AbortController().signal)).cost as unknown as Record<string, unknown>;
      for (const k of ["cache_read_tokens", "cache_creation_tokens", "per_model", "turns", "sdk_duration_ms", "tokens_scope", "cache_creation_main_loop"]) expect(k in cost).toBe(false);
      expect(cost["resume"]).toBe("ambiguous");
      expect(cost["tokens_measured"]).toEqual({ k: 1, n: 2 });
      expect(cost["input_tokens"]).toBe(100);
      expect(renderReceiptMd({ ...receiptOf(await sealStage.run(ctx, new AbortController().signal)) })).toContain("Tokens: partial: 100 input / 1 output for 1 of 2 sessions");
      expect(cost["usd"]).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30000);

  test("FC-43 empty-done resume ('-e' iteration, resumed_from the first session) seals ambiguous with labelled partial lines, no flag needed", async () => {
    noKey();
    const { repo, base } = makeRepo("receipt-truth-emptydone");
    const { ctx } = ctxFor(repo, base);
    const dir = mkdtempSync(join(tmpdir(), "rt-emptydone-"));
    try {
      mkdirSync(join(dir, "metrics"), { recursive: true });
      const rec = { output_tokens: 1, cache_read_tokens: 1000, cache_creation_tokens: 10, num_turns: 2, duration_ms: 500 };
      writeFileSync(join(dir, "metrics", "result-cost-impl.json"), JSON.stringify({ ...rec, total_cost_usd: 1, input_tokens: 100, session_id: "S1" }));
      writeFileSync(join(dir, "metrics", "result-cost-impl-e.json"), JSON.stringify({ ...rec, total_cost_usd: 1.4, input_tokens: 140, session_id: "S2", resumed_from: "S1" }));
      ctx.cost = { read: () => costTotalsOf(sumResultCosts(dir, ["impl", "impl-e"])) };
      const receipt = receiptOf(await sealStage.run(ctx, new AbortController().signal));
      const cost = receipt.cost as unknown as Record<string, unknown>;
      expect(cost["resume"]).toBe("ambiguous");
      expect(cost["usd"]).toBeNull();
      expect(cost["tokens_measured"]).toEqual({ k: 1, n: 2 });
      expect(cost["input_tokens"]).toBe(100);
      const md = renderReceiptMd({ ...receipt });
      expect(md).toContain("Tokens: partial: 100 input / 1 output for 1 of 2 sessions");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30000);

  test("RECEIPT-TRUTH: a reader without cache fields leaves the keys absent (NOT RECORDED), never 0", async () => {
    noKey();
    const { repo, base } = makeRepo("receipt-truth-absent");
    const { ctx } = ctxFor(repo, base);
    const rec = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect("cache_read_tokens" in rec.cost).toBe(true); // ctxFor's fake reports cacheReadTokens: 0 (a measured zero)
    expect("cache_creation_tokens" in rec.cost).toBe(false);
    expect("tokens_measured" in rec.cost).toBe(false); // complete runs and old receipts stay byte-identical
  }, 30000);

});

// SEC-FSMON ruling: the seal commit runs in the token-withheld worker, where the agent already has exec, so it keeps the user's
// hooks (pre-commit secret scanners) and commit signing ("require signed commits"). Hooks-off and signing-off stay on every
// other call. The hook records the env it was given: the token never reaches it even when process.env holds one.
describe("seal commit keeps the user's hooks and signing (FC-25d)", () => {
  test("seal commit runs pre-commit and gpg.program token-free; a plain safeGit commit runs neither", async () => {
    const { safeGitRun } = await import("../../src/util/safe_git.ts");
    const { repo, base } = makeRepo("hooks");
    const hooks = join(root, "hooks-dir"), hookRec = join(root, "hook.rec"), gpgRec = join(root, "gpg.rec");
    sh(["mkdir", "-p", hooks], root);
    // The hook records only the secret-bearing vars (never the whole env), so a failure cannot print inherited values.
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\nenv | grep -E '^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|SSH_AUTH_SOCK)=' >> '${hookRec}'\n[ -n "$PATH" ] && printf 'PATH-SET\\n' >> '${hookRec}'\nprintf 'HOOK-RAN\\n' >> '${hookRec}'\n`, { mode: 0o755 });
    const gpg = join(root, "gpg-stub.sh");
    writeFileSync(gpg, `#!/bin/sh\nprintf '%s\\n' "\${GH_TOKEN:-absent}" >> '${gpgRec}'\ncat >/dev/null\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 0\\n' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nstub\\n-----END PGP SIGNATURE-----\\n'\n`, { mode: 0o755 });
    sh(["git", "config", "core.hooksPath", hooks], repo);
    sh(["git", "config", "commit.gpgSign", "true"], repo);
    sh(["git", "config", "gpg.program", gpg], repo);
    const SECRETS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"] as const;
    const saved = Object.fromEntries(SECRETS.map((k) => [k, process.env[k]]));
    for (const k of SECRETS) process.env[k] = `sealhook-canary-${k}`;
    try {
      // Supervisor-side shape first: hooks and signing are off, so neither recorder fires and the commit is unsigned.
      const plain = await safeGitRun(repo, ["commit", "-q", "--allow-empty", "-m", "plain"]);
      expect(plain.exitCode).toBe(0);
      expect(existsSync(hookRec)).toBe(false);
      expect(existsSync(gpgRec)).toBe(false);
      expect(sh(["git", "cat-file", "commit", "HEAD"], repo)).not.toContain("gpgsig");
      const { ctx } = ctxFor(repo, sh(["git", "rev-parse", "HEAD"], repo).trim() || base);
      const c = await commitStage.run(ctx, new AbortController().signal);
      expect(c.status).toBe("completed");
      expect(c.data.committed).toBe(true);
    } finally {
      for (const k of SECRETS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    const dumped = readFileSync(hookRec, "utf8");
    expect(dumped).toContain("HOOK-RAN");
    expect(dumped).toContain("PATH-SET"); // positive control: the hook ran with a real env
    expect(dumped).not.toContain("sealhook-canary-");
    expect(dumped).toContain("GH_TOKEN=ghp_LOKIWITHHELDsentinel"); // positive control: the recorded vars are present, as sentinels
    // FC-90: a withheld token var is a non-working sentinel, not unset; any other value is a leak.
    for (const k of SECRETS) expect(dumped).not.toMatch(new RegExp(`^${k}=(?!ghp_LOKIWITHHELDsentinel)`, "m"));
    expect(readFileSync(gpgRec, "utf8")).toMatch(/^ghp_LOKIWITHHELDsentinel\w+\n$/); // FC-90: sentinel, never the canary
    expect(sh(["git", "cat-file", "commit", "HEAD"], repo)).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
  }, 30000);
});

// FC-69: a Wall test that was not executed is never silent, but the verdict still comes from the checks that executed (CTO ruling, D95 THIN).
describe("FC-69 not_run Wall is disclosed and does not change the verdict", () => {
  test("unexecuted Wall test: verdict stays VERIFIED, named on the receipt and the console NOT PROVEN line", async () => {
    noKey();
    const { repo, base } = makeRepo("wall-not-executed");
    const reason = "exit 1 but the runner output showed no readable failing test";
    const { ctx } = ctxFor(repo, base, "claude", {
      wall: { files: [], base_run: { pass: 0, fail: 0, not_run: 1 }, not_run_files: [{ file: "tests/loki_wall_x.py", reason }] },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.verdict).toBe("VERIFIED");
    const np = receiptOf(s).not_proven as string[];
    expect(np).toContain(`Wall test not executed: tests/loki_wall_x.py: ${reason}`);
    const out = formatSummary({ pr: null, verdict: "VERIFIED", notProven: np, flaky: [], cost: { usd: null, provider: "claude", tokens: null }, wallS: 1, stages: [] } as never);
    expect(out).toContain(`NOT PROVEN: `);
    expect(out).toContain(`Wall test not executed: tests/loki_wall_x.py: ${reason}`);
  }, 30000);
  test("a not_run count with no recorded reason is still named and does not change the verdict", async () => {
    noKey();
    const { repo, base } = makeRepo("wall-not-executed-bare");
    const { ctx } = ctxFor(repo, base, "claude", { wall: { files: [], base_run: { pass: 0, fail: 0, not_run: 1 } } });
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.verdict).toBe("VERIFIED");
    expect(receiptOf(s).not_proven.some((n: string) => n.startsWith("Wall test not executed:"))).toBe(true);
  }, 30000);
});
