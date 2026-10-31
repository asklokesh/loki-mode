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
import { createHash, generateKeyPairSync } from "node:crypto";
import { STEER_MAX_BYTES, withSteer } from "../../src/util/steer.ts";
import { intentRevisionsBlock, sealAccuracyLine, SEAL_ACCURACY_NOT_MEASURED } from "../../src/util/run_outputs.ts";
import { appendReceiptFact } from "../../src/util/pr_lessons.ts";
import { sealedLog } from "./log_fixture.ts";
import { copyFileSync, linkSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process"; import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backstopCommit } from "../../src/e10ext/commit_filter.ts"; import { sealDrift } from "../../src/util/seal_drift.ts";
import { reviewExtraLimitS } from "../../src/engine10/stages/xreview.ts";
import { main as verifyMain, verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { hasFailures, runMachine } from "../../src/engine10/machine.ts";
import { costTotalsOf, sumResultCosts } from "../../src/engine10/cost.ts";
import { buildTime, reconciledTotalS } from "../../src/contrib/receipt_time.ts";
import { hooks } from "../../src/engine10/hooks.ts";
import { readRunHistory, type RunOutcome } from "../../src/runner/router/history.ts";
import { repoKey } from "../../src/engine10/cache.ts";
import { readOriginUrl } from "../../src/util/engine_origin.ts";
import { computeKey, shallowDirs } from "../../src/project_model/gather.ts";
import { EXIT, formatSummary, outcomeOf, reasonOf } from "../../src/engine10/output.ts";
import { safeRestore } from "../../src/e10ext/discard.ts"; import { addedSymlinkNotes } from "../../src/util/base_guard.ts"; import { verifyStage } from "../../src/engine10/stages/verify.ts"; import { commitStage, renderReceiptMd, SIGNING_UNAVAILABLE, sealStage, EXTERNAL_NO_WALL } from "../../src/engine10/stages/seal.ts";
import type { EventType, Receipt, RunContext, StageName } from "../../src/engine10/types.ts";
import { _setIsolatedPythonFixedForTests } from "../../src/util/python.ts";
import { REPO_ROOT } from "../../src/util/paths.ts"; import { getVersion } from "../../src/version.ts";
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
  test("P12-09c: router request counts include archived quota attempts exactly once", async () => {
    const { repo, base } = makeRepo("p1209c-router");
    mkdirSync(join(repo, ".loki", "metrics"), { recursive: true });
    const rec = (n: number) => JSON.stringify({ total_cost_usd: 1, input_tokens: 5, output_tokens: 5, model: "m", requests_total: n, requests_over_100k: 0 });
    writeFileSync(join(repo, ".loki", "metrics", "result-cost-e10-r1-impl.json"), rec(5));
    writeFileSync(join(repo, ".loki", "metrics", "result-cost-e10-r1-impl-q1.json"), rec(3));
    const prev = process.env["LOKI_ROUTER"]; process.env["LOKI_ROUTER"] = "1";
    try {
      const { ctx } = ctxFor(repo, base);
      const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
      expect((r as unknown as { route: { requests_total: number } }).route.requests_total).toBe(8);
    } finally { if (prev === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = prev; }
  });
  test("a headless ambiguous run seals the intake assumptions in the receipt; a clear run omits the field", async () => {
    noKey();
    const { repo, base } = makeRepo("assumptions");
    const withA = ctxFor(repo, base, "claude", { intake: { source: "text", task_sha256: "ab".repeat(32), assumptions: ["a1", "a2"] } });
    expect(receiptOf(await sealStage.run(withA.ctx, new AbortController().signal)).assumptions).toEqual(["a1", "a2"]);
    const clear = ctxFor(repo, base);
    expect("assumptions" in receiptOf(await sealStage.run(clear.ctx, new AbortController().signal))).toBe(false);
  }, 30000);
  test("atomic receipt: receipt.json and receipt.md are replaced by rename, never truncated in place", async () => {
    const { repo, base } = makeRepo("atomic-receipt");
    const { ctx } = ctxFor(repo, base);
    mkdirSync(ctx.runDir, { recursive: true });
    // A hard link shares the inode: an in-place write (the old behavior) would rewrite it; temp + rename leaves it intact.
    for (const f of ["receipt.json", "receipt.md"]) { writeFileSync(join(ctx.runDir, f), "OLD"); linkSync(join(ctx.runDir, f), join(ctx.runDir, `${f}.witness`)); }
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.status).toBe("completed");
    expect(readFileSync(join(ctx.runDir, "receipt.json.witness"), "utf8")).toBe("OLD");
    expect(readFileSync(join(ctx.runDir, "receipt.md.witness"), "utf8")).toBe("OLD");
    const raw = readFileSync(join(ctx.runDir, "receipt.json"), "utf8");
    expect((JSON.parse(raw) as { receipt_sha256: string }).receipt_sha256).toBe(s.data.receipt_sha256 as string);
    expect(readdirSync(ctx.runDir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
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

  // FC-EXTERNAL-SEAL-WITHOUT-WALL-VERIFIED (rev-a B7, CoS gaps 1 and 2): wall.files = [] is what the no_runner skip, the no_interpreter skip and an all-not_run Wall emit.
  test("an external diff whose Wall emitted files [] with a passing pre-existing check is PARTIAL with the EXTERNAL_NO_WALL line", async () => {
    noKey();
    const { repo, base } = makeRepo("ext-empty-wall");
    const { ctx } = ctxFor(repo, base, "claude", { implement: { exit: "external", tests_reverted: [], duration_s: 0 }, wall: { files: [], no_runner: true } });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.verdict).toBe("PARTIAL");
    expect(r.not_proven).toContain(EXTERNAL_NO_WALL);
  }, 30000);

  test("an external diff whose every Wall file came back not_run is never VERIFIED", async () => {
    noKey();
    const { repo, base } = makeRepo("ext-all-not-run");
    const { ctx } = ctxFor(repo, base, "claude", { implement: { exit: "external", tests_reverted: [], duration_s: 0 }, wall: { files: [], base_run: { pass: 0, fail: 0, not_run: 2 } } });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.verdict).not.toBe("VERIFIED");
    expect(r.not_proven).toContain(EXTERNAL_NO_WALL);
  }, 30000);

  test("an external diff with a Wall file that ran carries no EXTERNAL_NO_WALL line", async () => {
    noKey();
    const { repo, base } = makeRepo("ext-wall-ran");
    const { ctx } = ctxFor(repo, base, "claude", { implement: { exit: "external", tests_reverted: [], duration_s: 0 } });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.not_proven).not.toContain(EXTERNAL_NO_WALL);
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

  test("TEN-COST-11 r3: ctx.sessionIds feeds the cost read and clears the cost-not-measured note", async () => {
    noKey();
    const { repo, base } = makeRepo("session-ids");
    const { ctx } = ctxFor(repo, base);
    let got: string[] = [];
    ctx.cost = { read: (_d, ids) => { got = ids; return { usd: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }; } };
    ctx.sessionIds = () => ["x-wall", "x-wall-r2"];
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(got).toEqual(expect.arrayContaining(["x-wall", "x-wall-r2"]));
    expect(r.not_proven.join("|")).not.toContain("cost not measured");
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
    const noOrigin = ctxFor(repo, base, "claude", { intake: { source: "issue", repo: null, resumed: false, task_sha256: "ab".repeat(32) } });
    const nr = receiptOf(await sealStage.run(noOrigin.ctx, new AbortController().signal)).not_proven;
    expect(nr).toContain("repo identity unknown: the repo has no origin remote (run: git remote add origin <url>)");
    expect(nr).not.toContain("repo not recorded by intake");
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

  test("FC-PR-BODY-PUBLIC-HYGIENE: pre_red is set only on a FAILED check named in pre_red_checks", async () => {
    noKey();
    const { repo, base } = makeRepo("prered-flag");
    const chk = (name: string, result: string) => ({ name, cmd: "node --test", result, n: 1, duration_s: 1 });
    const { ctx } = ctxFor(repo, base, "claude", { verify: { checks: [chk("listed-fail", "fail"), chk("listed-pass", "pass"), chk("unlisted-fail", "fail")], flaky: [], wall_passed: true, pre_red: [], pre_red_checks: ["listed-fail", "listed-pass"] } });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    const flag = (n: string) => r.checks.find((c) => c.name === n)?.pre_red;
    expect(flag("listed-fail")).toBe(true);
    expect(flag("listed-pass")).toBeUndefined();
    expect(flag("unlisted-fail")).toBeUndefined();
  }, 30000);

  test("FC-ZERO-ON-BASE: a not_run check listed in verify.skipped_on_base is not NOT PROVEN; an unlisted not_run still is", async () => {
    noKey();
    const { repo, base } = makeRepo("zerobase");
    const mk = (skipped: string[]) => ({ verify: { checks: [{ name: "node:a.test.js", cmd: "node --test", result: "pass", n: 1, duration_s: 1 }, { name: "node:skip.test.js", cmd: "node --test", result: "not_run", duration_s: 1 }, { name: "node:other.test.js", cmd: "node --test", result: "not_run", duration_s: 1 }], flaky: [], wall_passed: true, skipped_on_base: skipped } });
    const { ctx } = ctxFor(repo, base, "claude", mk(["node:skip.test.js"]));
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.not_proven).not.toContain("not run: node:skip.test.js");
    expect(r.not_proven).toContain("not run: node:other.test.js"); expect(r.not_proven).toContain("skipped by the repo on base and head: node:skip.test.js");
  }, 30000);

  describe("FC-REPO-SKIPPED-TEST-DOWNGRADES", () => {
    const pass = { name: "node:a.test.js", cmd: "node --test", result: "pass", n: 1, duration_s: 1 };
    const skip = { name: "node:skip.test.js", cmd: "node --test", result: "not_run", reason: "no tests executed (ran 0 tests, empty or all skipped)", duration_s: 1 };
    const run = async (name: string, verify: Record<string, unknown>, over: Record<string, unknown> = {}) => {
      noKey();
      const { repo, base } = makeRepo(name);
      const { ctx } = ctxFor(repo, base, "claude", { verify: { checks: [pass, skip], flaky: [], wall_passed: true, ...verify }, ...over });
      await commitStage.run(ctx, new AbortController().signal);
      return receiptOf(await sealStage.run(ctx, new AbortController().signal));
    };
    test("control: a not_run check verify did not measure as skipped on base still makes the verdict PARTIAL", async () => {
      expect((await run("rsk-control", {})).verdict).toBe("PARTIAL");
    }, 30000);
    test("a measured repo skip (listed in skipped_on_base) does not downgrade; it stays in the receipt as not_run + repo_skipped, with the non-blocking note", async () => {
      const r = await run("rsk-ok", { skipped_on_base: [skip.name] });
      expect(r.verdict).toBe("VERIFIED");
      expect(r.checks.find((c: { name: string }) => c.name === skip.name)).toMatchObject({ result: "not_run", repo_skipped: true });
      expect(r.checks.find((c: { name: string }) => c.name === pass.name)!.repo_skipped).toBeUndefined();
      expect(r.not_proven).toContain("skipped by the repo on base and head: node:skip.test.js");
      expect(r.not_proven).not.toContain("not run: node:skip.test.js");
    }, 30000);
    test("negative: another not_run that is not listed still downgrades", async () => {
      const r = await run("rsk-other", { skipped_on_base: [skip.name], checks: [pass, skip, { ...skip, name: "node:other.test.js" }] });
      expect(r.verdict).toBe("PARTIAL"); expect(r.not_proven).toContain("not run: node:other.test.js");
    }, 30000);
    test("negative: with the skip excused and no executed passing n>0 check (FC-16) the verdict is not VERIFIED", async () => {
      const r = await run("rsk-noproof", { skipped_on_base: [skip.name], checks: [skip] });
      expect(r.verdict).not.toBe("VERIFIED");
    }, 30000);
    test("negative: a Wall file named in skipped_on_base is never excused (an all-skipped Wall stays not proven)", async () => {
      const r = await run("rsk-wall", { skipped_on_base: ["node:tests/skip.test.js"], checks: [pass, { ...skip, name: "node:tests/skip.test.js" }] }, { wall: { files: [{ path: "tests/skip.test.js", sha256: "cd".repeat(32) }] } });
      expect(r.verdict).toBe("PARTIAL"); expect(r.not_proven).toContain("not run: node:tests/skip.test.js");
      expect(r.checks.find((c: { name: string }) => c.name === "node:tests/skip.test.js")!.repo_skipped).toBeUndefined();
    }, 30000);
    test("negative: a failing check is never excused by skipped_on_base", async () => {
      const r = await run("rsk-fail", { skipped_on_base: [skip.name], checks: [pass, { ...skip, result: "fail" }] });
      expect(r.verdict).toBe("FAILED");
    }, 30000);
  });

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

  // FC-SEAL-NA-AS-UNPROVEN: N/A and "not selected by risk tier" are visible but are not gaps; a real gap still downgrades.
  describe("FC-SEAL-NA-AS-UNPROVEN", () => {
    const pass = { name: "pytest:tests/test_x.py", cmd: "pytest -q tests/test_x.py", result: "pass", n: 1, duration_s: 1 };
    const run = async (name: string, verify: Record<string, unknown>) => {
      noKey();
      const { repo, base } = makeRepo(name);
      const { ctx } = ctxFor(repo, base, "claude", { verify: { checks: [pass], flaky: [], wall_passed: true, ...verify } });
      await commitStage.run(ctx, new AbortController().signal);
      const s = await sealStage.run(ctx, new AbortController().signal);
      return { r: receiptOf(s), md: readFileSync(join(ctx.runDir, "receipt.md"), "utf8") };
    };
    const risk = (tier: string, selected: string[], deferred: string[]) => ({ tier, checks_selected: selected, checks_deferred: deferred });
    test("verify's not_applicable lands under N/A, not NOT PROVEN, and does not downgrade", async () => {
      const { r, md } = await run("na-visible", { not_applicable: ["full suite: package claude-code-repo defines no test command"], risk: risk("low", ["targeted tests", "lint of changed files"], ["full test command", "reviewer", "council", "security scan"]) });
      expect(r.not_applicable).toContain("full suite: package claude-code-repo defines no test command");
      expect(r.not_proven.join("|")).not.toContain("defines no test command");
      expect(md).toContain("### N/A");
      expect(md.split("### NOT PROVEN")[1]!.split("### N/A")[0]).not.toContain("defines no test command");
    }, 30000);
    test("low tier: deep items are 'not selected by risk tier', not NOT PROVEN", async () => {
      const { r } = await run("na-low", { risk: risk("low", ["targeted tests", "lint of changed files"], ["full test command", "reviewer", "council", "security scan"]) });
      for (const i of ["full suite", "app boot", "council", "security scan"]) { expect(r.not_proven).not.toContain(i); expect(r.not_applicable).toContain(`not selected by risk tier: ${i}`); }
    }, 30000);
    test("high tier: a selected check that did not run stays NOT PROVEN; an executed full suite is dropped", async () => {
      const sel = ["targeted tests", "lint of changed files", "full test command", "full suite", "council", "security scan"];
      const a = await run("na-high", { risk: risk("high", sel, ["council", "security scan", "full test command", "full suite"]) });
      for (const i of ["full suite", "council", "security scan"]) expect(a.r.not_proven).toContain(i);
      const b = await run("na-high-full", { risk: risk("high", sel, ["council", "security scan"]), checks: [pass, { name: "full suite: pytest", cmd: "pytest", result: "pass", n: 3, duration_s: 1 }] });
      expect(b.r.not_proven).not.toContain("full suite"); expect(b.r.not_proven).toContain("council");
    }, 60000);
    test("no usable risk record keeps every deep item NOT PROVEN (fail-safe)", async () => {
      const { r } = await run("na-norisk", {});
      for (const i of ["full suite", "app boot", "council", "security scan"]) expect(r.not_proven).toContain(i);
      expect(r.not_applicable).toBeUndefined();
    }, 30000);
    test("a real unproven item still downgrades and stays under NOT PROVEN", async () => {
      const { r } = await run("na-real", { not_proven: ["tests ran on the system interpreter"], not_applicable: ["full suite: package p defines no test command"] });
      expect(r.verdict).not.toBe("VERIFIED"); expect(r.not_proven).toContain("tests ran on the system interpreter");
    }, 30000);
  });

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

  // never-worse-than-raw floor: repo checks pass, a Loki gate failed for a harness reason -> PARTIAL, owner harness, tree delivered.
  const floorRun = async (name: string, wallOwner: "harness" | undefined) => {
    const { repo, base } = makeRepo(name);
    const { ctx } = ctxFor(repo, base, "claude", {
      verify: { checks: [
        { name: "pytest", cmd: "pytest -q", result: "pass", n: 3, duration_s: 1 },
        { name: "wall:loki_wall_a.py", cmd: "python3 -m pytest loki_wall_a.py", result: "fail", ...(wallOwner ? { owner: wallOwner } : {}), duration_s: 1 },
      ], flaky: [], wall_passed: false, duration_s: 1 },
    });
    const c = await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    return { c, s, r: receiptOf(s) };
  };
  test("floor: a harness-owned gate failure with passing repo checks seals PARTIAL with owner harness and a delivered commit", async () => {
    const { c, r } = await floorRun("floor-harness", "harness");
    expect(c.status).toBe("completed");
    expect(r.verdict).toBe("PARTIAL");
    const w = r.checks.find((k) => k.name.startsWith("wall:"))!;
    expect(w.result).toBe("not_run");
    expect(w.owner).toBe("harness");
  }, 30000);
  test("floor: a code-owned gate failure is still FAILED and carries no owner", async () => {
    const { r } = await floorRun("floor-code", undefined);
    expect(r.verdict).toBe("FAILED");
    expect(r.checks.find((k) => k.name.startsWith("wall:"))!.owner).toBeUndefined();
  }, 30000);
  test("floor: a genuinely failing check run through verify then seal is FAILED and carries no owner", async () => {
    const { repo, base } = makeRepo("floor-real-verify");
    writeFileSync(join(repo, "broken.sh"), "if [ -z \"$x\" ]\n  echo unterminated\n");
    const { ctx } = ctxFor(repo, base, "claude", { verify: {} });
    const v = await verifyStage.run(ctx, new AbortController().signal);
    const bash = (v.data.checks as { name: string; result: string; owner?: string }[]).find((k) => k.name === "lint:bash-n")!;
    expect(bash.result).toBe("fail");
    expect(bash.owner).toBeUndefined();
    const { ctx: sctx } = ctxFor(repo, base, "claude", { verify: v.data });
    await commitStage.run(sctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(sctx, new AbortController().signal));
    expect(r.verdict).toBe("FAILED");
    const k = r.checks.find((c) => c.name === "lint:bash-n")!;
    expect(k.result).toBe("fail");
    expect(k.owner).toBeUndefined();
  }, 30000);
  test("floor: reasonOf never names a harness-owned failed check, and still names a code-owned one", () => {
    const ev = (checks: unknown[]) => [{ v: 1, seq: 0, ts: "t", run: "r", type: "stage.completed", stage: "verify", data: { checks } }] as never;
    const harness = { name: "wall:w.py", result: "fail", first_error: "collect error", owner: "harness" }, code = { name: "pytest", result: "fail", first_error: "assert 1 == 2" };
    expect(reasonOf(ev([harness, code]), false, null, "FAILED")).toBe("pytest failed: assert 1 == 2");
    expect(reasonOf(ev([harness]), false, null, "PARTIAL") ?? "").not.toContain("wall:w.py failed");
    expect(reasonOf(ev([code]), false, null, "FAILED")).toBe("pytest failed: assert 1 == 2");
  });
  test("floor: a harness-owned failure feeds no fix round and no stall", () => {
    const v = (owner?: string) => ({ checks: [{ name: "w", result: "fail", ...(owner ? { owner } : {}) }], failures_grouped: [{ signature: "w", count: 1, sample: "" }] });
    expect(hasFailures(v("harness"))).toBe(false);
    expect(hasFailures(v())).toBe(true);
  });

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

  test("FC-WALL-PHANTOM-PATH: a symlink added by the change lands on NOT PROVEN by name; a regular new file and a plan-requested link do not", async () => {
    noKey();
    const { repo, base } = makeRepo("symadd");
    symlinkSync("a.txt", join(repo, "alias_dir"));
    writeFileSync(join(repo, "plain.txt"), "x\n");
    const { ctx } = ctxFor(repo, base);
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.not_proven.some((n) => n.startsWith("symlink added by the change") && n.endsWith("alias_dir"))).toBe(true);
    expect(r.not_proven.some((n) => n.includes("plain.txt"))).toBe(false);
    expect(r.verdict).not.toBe("VERIFIED");
    const meta = ":000000 120000 " + "0".repeat(40) + " " + "1".repeat(40) + " A";
    expect(addedSymlinkNotes([meta, "l"], null)).toHaveLength(1);
    expect(addedSymlinkNotes([meta, "l"], "Add a symlink l for compatibility")).toEqual([]);
    expect(addedSymlinkNotes([":120000 000000 " + "1".repeat(40) + " " + "0".repeat(40) + " D", "l"], null)).toEqual([]);
    const z = "0".repeat(40), o1 = "1".repeat(40);
    expect(addedSymlinkNotes([":120000 120000 " + o1 + " " + z + " M", "l"], null)).toEqual([]); // a retargeted link is not an added one
    expect(addedSymlinkNotes([":100644 120000 " + o1 + " " + z + " T", "l"], null)).toHaveLength(1); // a regular file became a link
    expect(addedSymlinkNotes([":120000 100644 " + o1 + " " + z + " T", "l"], null)).toEqual([]);
    for (const neg of ["do not add a symlink", "No symlink here", "Do it without a symlink"]) expect(addedSymlinkNotes([meta, "l"], neg)).toHaveLength(1);
    expect(addedSymlinkNotes([meta, "l"], "Create an alias for the old name")).toHaveLength(1); // alias is not an escape
    expect(addedSymlinkNotes([meta, "l"], "Do not use a symlink. Later, add a symlink at l.")).toEqual([]);
    const sub = ":000000 160000 " + z + " " + o1 + " A";
    expect(addedSymlinkNotes([sub, "vendor/x"], null)).toHaveLength(1);
    expect(addedSymlinkNotes([sub, "vendor/x"], "Add the x submodule")).toEqual([]);
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
describe("not sealed verdict text", () => {
  test("not sealed names check", async () => {
    const { firstFileLineAnchor } = await import("../../src/util/check_result.ts");
    const out = "FAIL src/a.test.ts\n  at src/a.ts:42:7\n";
    const anchor = firstFileLineAnchor(out) ?? undefined;
    const ev = [{ v: 1, seq: 0, ts: "t", run: "r", type: "stage.completed", stage: "verify", data: { checks: [{ name: "bun:unit", result: "fail", first_error: "FAIL src/a.test.ts", anchor }] } }] as never;
    const reason = reasonOf(ev, false, null, "PARTIAL");
    expect(reason).toBe("bun:unit failed: FAIL src/a.test.ts (at src/a.ts:42)");
    expect(formatSummary({ pr: null, verdict: "PARTIAL", reason, notProven: [], flaky: [], cost: { usd: 0, provider: "claude", tokens: 0 }, wallS: 1, stages: [] })).toContain("bun:unit failed");
  });
});

describe("failing-check anchor is linear", () => {
  test("64KB of pathological path-like output returns fast and a normal anchor still resolves", async () => {
    const { firstFileLineAnchor } = await import("../../src/util/check_result.ts");
    const bad = "a/".repeat(32768);
    let t0 = performance.now();
    expect(firstFileLineAnchor(bad)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
    const mixed = bad.slice(0, 65000) + "\nsrc/a.ts:12\n";
    t0 = performance.now();
    expect(firstFileLineAnchor(mixed)).toBe("src/a.ts:12");
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
describe("FC-PR-BODY-PUBLIC-HYGIENE receipt.md base-red label", () => {
  test("a pre_red failing check reads already failing on base; a plain fail does not", () => {
    const r = receiptWithCost({ usd: 0, input_tokens: 0, output_tokens: 0, measured_sessions: 1, total_sessions: 1, partial_usd: 0 });
    r.checks = [
      { name: "lint:shellcheck", cmd: "shellcheck a.sh", result: "fail", duration_s: 1, provenance: "exogenous", pre_red: true },
      { name: "unit", cmd: "bun test", result: "fail", duration_s: 1, provenance: "exogenous" },
    ];
    const md = renderReceiptMd(r);
    expect(md).toContain("- fail (already failing on base, not caused by this change): lint:shellcheck");
    expect(md).toContain("- fail: unit (");
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
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\nenv | grep -E '^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|SSH_AUTH_SOCK)=' >> '${hookRec}'\nenv | grep sealhook-canary- | cut -d= -f1 | sed 's/^/CANARY-NAME:/' >> '${hookRec}'\n[ -n "$PATH" ] && printf 'PATH-SET\\n' >> '${hookRec}'\nprintf 'HOOK-RAN\\n' >> '${hookRec}'\n`, { mode: 0o755 });
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
    // The canary must not survive under ANY name (a copy such as LOKI_STASHED_TOKEN): the hook lists names only, never values.
    expect(dumped.split("\n").filter((l) => l.startsWith("CANARY-NAME:"))).toEqual([]);
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

// TEN-GATES-02 (FC-AGENT-PROOF, D104): VERIFIED needs agent-independent proof; a test file the run ADDED is agent-authored evidence only.
describe("TEN-GATES-02 seal requires agent-independent proof", () => {
  const AGENT_ONLY = "only agent-authored tests executed (no agent-independent proof)";
  async function sealWith(name: string, preexisting: boolean, env: Record<string, string> = {}, editOld = false) {
    noKey();
    const { repo, base: b0 } = makeRepo(name);
    let base = b0;
    mkdirSync(join(repo, "tests"), { recursive: true });
    if (preexisting) { // commit the test at base, then keep the run diff to a.txt only (an edited old test would be a weakened test)
      writeFileSync(join(repo, "tests/test_x.py"), "def test_x():\n    assert True\n");
      sh(["git", "add", "tests/test_x.py"], repo); sh(["git", "commit", "-q", "-m", "old test"], repo); base = sh(["git", "rev-parse", "HEAD"], repo).trim();
      if (editOld) writeFileSync(join(repo, "tests/test_x.py"), "def test_x():\n    assert 1\n"); // status M in the run diff, never A
    } else writeFileSync(join(repo, "tests/test_x.py"), "def test_x():\n    assert True\n");
    const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const { ctx } = ctxFor(repo, base, "claude", { wall: { files: [] }, verify: { checks: [{ name: "pytest:tests/test_x.py", cmd: "pytest -q tests/test_x.py", result: "pass", n: 1, duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 1 } });
      await commitStage.run(ctx, new AbortController().signal);
      const s = await sealStage.run(ctx, new AbortController().signal);
      return { s, r: receiptOf(s), md: readFileSync(join(ctx.runDir, "receipt.md"), "utf8") };
    } finally { for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  test("only a check on a test file ADDED in the diff passed, no Wall: PARTIAL with the agent-only NOT PROVEN line", async () => {
    const { s, r, md } = await sealWith("gates02-added", false);
    expect(s.data.verdict).toBe("PARTIAL");
    expect(r.not_proven).toContain(AGENT_ONLY);
    expect(r.not_proven).not.toContain("no tests executed");
    expect(r.checks).toEqual([{ name: "pytest:tests/test_x.py", cmd: "pytest -q tests/test_x.py", result: "pass", duration_s: 1, provenance: "agent_authored", n: 1 }]); // n carried so verify --require-exogenous can see executed proof (TEN-GATES-03-F1)
    expect(md).toContain("### Agent-independent checks\n- none\n");
    expect(md).toContain("### Agent-authored / advisory checks\n- pass: pytest:tests/test_x.py");
    expect(md).not.toContain("### Checks");
  }, 30000);
  test("the same check on a PRE-EXISTING test file: VERIFIED, provenance exogenous", async () => {
    const { s, r, md } = await sealWith("gates02-preexisting", true);
    expect(s.data.verdict).toBe("VERIFIED");
    expect(r.not_proven).not.toContain(AGENT_ONLY);
    expect(r.checks[0]!.provenance).toBe("exogenous");
    expect(md).toContain("### Agent-independent checks\n- pass: pytest:tests/test_x.py");
    expect(md).toContain("### Agent-authored / advisory checks\n- none\n");
  }, 30000);
  test("TEN-GATES-17: a PRE-EXISTING test edited in the run (status M) is agent_authored, advisory; verify --require-exogenous exits 4", async () => {
    const { s, r } = await sealWith("gates17-edited-old", true, {}, true);
    expect(r.checks[0]!.provenance).toBe("agent_authored");
    expect(r.not_proven).toContain("weakened test: tests/test_x.py"); // the A-119 edit rule still caps it
    expect(r.not_proven).toContain(AGENT_ONLY);
    expect(s.data.verdict).toBe("PARTIAL");
    sealedLog(dirname(s.data.receipt_path as string), r.receipt_sha256);
    const w = process.stdout.write.bind(process.stdout); process.stdout.write = (() => true) as typeof process.stdout.write;
    let rc = -1; try { rc = await verifyMain(["r1", "--require-exogenous"], { runsRoot: dirname(dirname(s.data.receipt_path as string)) }); } finally { process.stdout.write = w; }
    expect(rc).toBe(4);
  }, 30000);
  test("LOKI_EXOGENOUS_PROOF=0 restores the old verdict (VERIFIED) and only the opt-out (\"00\" or \"false\" stay on)", async () => {
    expect((await sealWith("gates02-optout", false, { LOKI_EXOGENOUS_PROOF: "0" })).s.data.verdict).toBe("VERIFIED");
    expect((await sealWith("gates02-optout-00", false, { LOKI_EXOGENOUS_PROOF: "00" })).s.data.verdict).toBe("PARTIAL");
    expect((await sealWith("gates02-optout-1", false, { LOKI_EXOGENOUS_PROOF: "1" })).s.data.verdict).toBe("PARTIAL");
  }, 60000);
  test("a receipt with provenance still verifies end to end through loki verify (hash covers the additive key)", async () => {
    const { s, r } = await sealWith("gates02-roundtrip", true);
    sealedLog(dirname(s.data.receipt_path as string), r.receipt_sha256);
    expect((await verifyReceipt(s.data.receipt_path as string)).verdict).toBe("VERIFIED");
    // the real `loki verify --require-exogenous` entry reads the provenance seal recorded (TEN-GATES-03 consumer)
    const out: string[] = [], w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    let rc = -1; try { rc = await verifyMain(["r1", "--require-exogenous"], { runsRoot: dirname(dirname(s.data.receipt_path as string)) }); } finally { process.stdout.write = w; }
    expect(rc).toBe(0);
    expect(out.join("")).toContain("agent-independent: 1 of 1 passing checks");
  }, 30000);
  test("receipt.md sections: exogenous and independent are agent-independent; agent_authored, llm_judge and an unknown value are advisory (fail closed)", () => {
    const c = (name: string, provenance: string) => ({ name, cmd: "x", result: "pass" as const, duration_s: 1, provenance }) as Receipt["checks"][number];
    const md = renderReceiptMd({ ...receiptWithCost({ usd: 0, input_tokens: 0, output_tokens: 0, measured_sessions: 0, total_sessions: 0, partial_usd: 0 } as Receipt["cost"]), checks: [c("lint", "exogenous"), c("pytest:w.py", "independent"), c("pytest:n.py", "agent_authored"), c("council", "llm_judge"), c("odd", "bogus")] });
    const [indep, adv] = md.split("### Agent-authored / advisory checks");
    expect(indep).toContain("- pass: lint ");
    expect(indep).toContain("- pass: pytest:w.py ");
    for (const n of ["pytest:n.py", "council", "odd"]) { expect(indep).not.toContain(`- pass: ${n} `); expect(adv).toContain(`- pass: ${n} `); }
  });
  test("a receipt without provenance (older seal) renders the single ### Checks section unchanged", () => {
    const md = renderReceiptMd({ ...receiptWithCost({ usd: 0, input_tokens: 0, output_tokens: 0, measured_sessions: 0, total_sessions: 0, partial_usd: 0 } as Receipt["cost"]), checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1 }] });
    expect(md).toContain("### Checks\n- pass: pytest (`pytest -q`, 1s)\n");
    expect(md).not.toContain("Agent-independent");
  });
});

describe("v11.7 LESSONS: sealed run becomes a receipt fact", () => {
  const factFor = async (name: string, env?: string) => {
    const { repo, base } = makeRepo(name);
    const { ctx } = ctxFor(repo, base);
    if (env !== undefined) process.env["LOKI_AUTO_LEARN_PR"] = env;
    try {
      await commitStage.run(ctx, new AbortController().signal);
      const s = await sealStage.run(ctx, new AbortController().signal);
      return { repo, s, r: receiptOf(s) };
    } finally { delete process.env["LOKI_AUTO_LEARN_PR"]; }
  };
  test("writes a cited fact after the receipt; receipt hash re-verifies and is unchanged", async () => {
    const { repo, s, r } = await factFor("learn-on");
    const j = JSON.parse(readFileSync(join(repo, ".loki/memory/semantic/pr-lessons.json"), "utf8")) as { lessons: Array<Record<string, any>> };
    expect(j.lessons.length).toBe(1);
    expect(j.lessons[0]!.kind).toBe("receipt");
    expect(j.lessons[0]!.justified_by).toEqual({ run_id: "r1", receipt_sha256: r.receipt_sha256, verdict: "VERIFIED" });
    sealedLog(dirname(s.data.receipt_path as string), r.receipt_sha256);
    expect((await verifyReceipt(s.data.receipt_path as string)).verdict).toBe("VERIFIED");
  }, 30000);
  test("LOKI_AUTO_LEARN_PR=0 writes no fact; appending a fact leaves receipt bytes unchanged", async () => {
    const on = await factFor("learn-hash-on");
    const rp = on.s.data.receipt_path as string;
    const before = createHash("sha256").update(readFileSync(rp)).digest("hex");
    appendReceiptFact(on.repo, { runId: "r-other", verdict: "VERIFIED", receiptSha256: "a".repeat(64), title: "x" });
    expect(createHash("sha256").update(readFileSync(rp)).digest("hex")).toBe(before);
    const off = await factFor("learn-off", "0");
    expect(existsSync(join(off.repo, ".loki/memory/semantic/pr-lessons.json"))).toBe(false);
  }, 60000);

  // P12-02: an intent revision consumed after the Wall was authored stales it; Seal refuses until the Wall is re-authored.
  // Revisions come from machine memory (ctx.intentRevisions), never the agent-writable repo file.
  const rv = (rev: number, at: number) => ({ rev, source: "chat", actor: "alice", sha: `${rev}`.repeat(64).slice(0, 64), at });
  const withRevs = (name: string, revs: ReturnType<typeof rv>[], timeline?: RunContext["timeline"]) => {
    noKey();
    const { repo, base } = makeRepo(name);
    const { ctx } = ctxFor(repo, base);
    ctx.intentRevisions = revs; ctx.timeline = timeline ?? [{ stage: "wall", startMs: 2000, endMs: 2500 }];
    return ctx;
  };
  test("revision after wall blocks seal", async () => {
    const ctx = withRevs("rev-after-wall", [rv(1, 3000)]);
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.status).toBe("failed");
    expect(s.reason).toContain("arrived after the Wall was frozen");
    expect(s.reason).toContain("Rerun with the new intent");
    expect(existsSync(join(ctx.runDir, "receipt.json"))).toBe(false);
    ctx.timeline = [{ stage: "wall", startMs: 2000, endMs: 2500 }, { stage: "wall", startMs: 3100, endMs: 3500 }]; // re-authored after the revision
    expect((await sealStage.run(ctx, new AbortController().signal)).status).toBe("completed");
  }, 30000);
  test("agent tampering with the repo revisions file cannot suppress staleness or the receipt list", async () => {
    for (const how of ["backdate", "truncate", "symlink"]) {
      const ctx = withRevs(`rev-tamper-${how}`, [rv(1, 3000)]);
      const f = join(ctx.repoDir, ".loki/intent-revisions.jsonl");
      if (how === "backdate") writeFileSync(f, JSON.stringify({ rev: 1, consumed_at: new Date(10).toISOString() }) + "\n");
      else if (how === "truncate") writeFileSync(f, "");
      else symlinkSync("/dev/null", f);
      await commitStage.run(ctx, new AbortController().signal);
      expect((await sealStage.run(ctx, new AbortController().signal)).status).toBe("failed");
    }
    const ok = withRevs("rev-tamper-receipt", [rv(1, 1000)]); // pre-Wall, so seal completes; the file is /dev/null yet the receipt still lists it
    symlinkSync("/dev/null", join(ok.repoDir, ".loki/intent-revisions.jsonl"));
    await commitStage.run(ok, new AbortController().signal);
    expect(receiptOf(await sealStage.run(ok, new AbortController().signal)).intent_revisions?.map((r) => r.rev)).toEqual([1]);
  }, 60000);
  test("pre-wall revision does not block seal; one at or after the Wall start tick is stale", async () => {
    const ctx = withRevs("rev-before-wall", [rv(1, 1800), rv(2, 1999)]);
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.status).toBe("completed");
    expect(receiptOf(s).intent_revisions?.map((r) => r.rev)).toEqual([1, 2]);
    ctx.intentRevisions = [rv(3, 2001)]; // after the Wall STARTED (it ended later at 2500): the boundary is the start
    expect((await sealStage.run(ctx, new AbortController().signal)).status).toBe("failed");
    ctx.intentRevisions = [rv(4, 2000)]; // the same tick as the Wall start is late too
    expect((await sealStage.run(ctx, new AbortController().signal)).status).toBe("failed");
  }, 30000);
  test("a steer still pending in HUMAN_INPUT.md at seal refuses and is recorded", async () => {
    const ctx = withRevs("rev-pending", []);
    writeFileSync(join(ctx.repoDir, ".loki/HUMAN_INPUT.md"), "## Operator directive rev 1 (2026-10-15T00:00:01Z) actor=alice source=chat\nmore\n");
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.status).toBe("failed");
    expect(s.reason).toContain("arrived after the Wall was frozen");
    expect(ctx.intentRevisions?.map((r) => r.rev)).toEqual([1]);
  }, 30000);
  // Unconsumable steers must fail closed: an unwritable logs dir or an oversize file leaves no revision record by the old path.
  const HDR = "## Operator directive rev 1 (2026-10-15T00:00:01Z) actor=alice source=chat\n";
  const refuses = async (ctx: RunContext, why: string, remedy: string) => { await commitStage.run(ctx, new AbortController().signal); const r = await sealStage.run(ctx, new AbortController().signal); expect(r.status).toBe("failed"); expect(r.reason).toBe(`a steer in .loki/HUMAN_INPUT.md could not be applied (${why}); this run cannot be sealed. ${remedy} A steer left in place is read after the Wall starts and blocks the next run too: delete .loki/HUMAN_INPUT.md and re-run with loki "<task with the steer folded in>".`); expect(existsSync(join(ctx.runDir, "receipt.json"))).toBe(false); };
  test("logs path is a regular file: a steer at implement refuses the seal", async () => {
    const ctx = withRevs("rev-logs-file-impl", []);
    writeFileSync(join(ctx.repoDir, ".loki/logs"), "not a dir");
    writeFileSync(join(ctx.repoDir, ".loki/HUMAN_INPUT.md"), `${HDR}change\n`);
    expect(withSteer({ stage: "implement", brief: "b" }, ctx.repoDir, ctx.intentRevisions).brief).toBe("b"); // not injected, but recorded as unapplied
    await refuses(ctx, "logs dir unwritable or file unreadable", "Make .loki/logs a writable directory. A steer that was already claimed is archived as .loki/logs/human-input-*.md; one still at .loki/HUMAN_INPUT.md is unreadable, so delete it.");
  }, 30000);
  test("logs path is a regular file: a late steer refuses the seal", async () => {
    const ctx = withRevs("rev-logs-file-late", []);
    writeFileSync(join(ctx.repoDir, ".loki/logs"), "not a dir");
    writeFileSync(join(ctx.repoDir, ".loki/HUMAN_INPUT.md"), `${HDR}late\n`);
    await refuses(ctx, "logs dir unwritable or file unreadable", "Make .loki/logs a writable directory. A steer that was already claimed is archived as .loki/logs/human-input-*.md; one still at .loki/HUMAN_INPUT.md is unreadable, so delete it.");
  }, 30000);
  test("an oversize late steer refuses the seal", async () => {
    const ctx = withRevs("rev-oversize-late", []);
    writeFileSync(join(ctx.repoDir, ".loki/HUMAN_INPUT.md"), `${HDR}${"x".repeat(STEER_MAX_BYTES + 1)}`);
    await refuses(ctx, "over 1 MiB", "The oversize file was moved to .loki/logs/.");
  }, 30000);
  test("an oversize steer at implement refuses the seal", async () => {
    const ctx = withRevs("rev-oversize-impl", []);
    writeFileSync(join(ctx.repoDir, ".loki/HUMAN_INPUT.md"), `${HDR}${"x".repeat(STEER_MAX_BYTES + 1)}`);
    withSteer({ stage: "implement", brief: "b" }, ctx.repoDir, ctx.intentRevisions);
    rmSync(join(ctx.repoDir, ".loki/logs"), { recursive: true, force: true });
    await refuses(ctx, "over 1 MiB", "The oversize file was moved to .loki/logs/.");
  }, 30000);
  test("a symlinked steer file refuses the seal with a truthful reason", async () => {
    const ctx = withRevs("rev-symlink", []);
    symlinkSync("/dev/null", join(ctx.repoDir, ".loki/HUMAN_INPUT.md"));
    await refuses(ctx, "symlink", "The symlink was removed.");
  }, 30000);
  test("a directory at HUMAN_INPUT.md refuses the seal naming that path", async () => {
    const ctx = withRevs("rev-dir", []);
    mkdirSync(join(ctx.repoDir, ".loki/HUMAN_INPUT.md"));
    await refuses(ctx, "not a regular file", "It is a directory or special file.");
  }, 30000);
  test("intentRevisionsBlock omits unapplied records", () => {
    expect(intentRevisionsBlock([rv(1, 1), { ...rv(0, 2), unapplied: true, reason: "x" }]).intent_revisions?.map((r) => r.rev)).toEqual([1]);
    expect(intentRevisionsBlock([{ ...rv(0, 2), unapplied: true, reason: "x" }])).toEqual({});
  });
  test("receipt lists revisions", async () => {
    const ctx = withRevs("rev-receipt", [rv(1, 1800), rv(2, 1900)]);
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.intent_revisions).toEqual([{ rev: 1, source: "chat", actor: "alice", sha: "1".repeat(64) }, { rev: 2, source: "chat", actor: "alice", sha: "2".repeat(64) }]);
  }, 30000);
});

// P12-32b-c: the history row is keyed on the model that actually ran, and on escalation only the final rung records.
describe("seal records routing history under the model that ran (P12-32b-c)", () => {
  async function sealRows(name: string, over: Partial<Record<StageName, Record<string, unknown>>>): Promise<RunOutcome[]> {
    const { repo, base } = makeRepo(name);
    writeFileSync(join(repo, "package.json"), "{}");
    const cite = ["package.json"];
    const pkg = { name: "p0", root: ".", runner: "vitest", commands: { test: null, lint: null, build: null, start: null }, ui: { present: false, boot: null, cite }, cite };
    const m = { schema: "loki.v10.project/1", status: "ok", workspaceKind: "single", workspaceCite: cite, packages: [pkg], fingerprintFiles: cite, key: computeKey(repo, cite, shallowDirs(repo)) };
    writeFileSync(join(repo, ".loki", "project.json"), JSON.stringify(m));
    const home = join(root, `${name}-home`);
    mkdirSync(home, { recursive: true });
    const prevHome = process.env["HOME"], prevPrev = process.env["LOKI_COST_PREVIEW"], prevTime = hooks.time;
    process.env["HOME"] = home; delete process.env["LOKI_COST_PREVIEW"];
    hooks.time = { build: () => ({ wall_s: 5, stages: {} }) as never, firstEventMs: () => null, reconciled: () => 5 };
    try {
      const { ctx } = ctxFor(repo, base, "claude", over);
      ctx.cost = { read: () => ({ usd: 0.5, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }) };
      await commitStage.run(ctx, new AbortController().signal);
      await sealStage.run(ctx, new AbortController().signal);
      return readRunHistory(repoKey(readOriginUrl(repo), repo));
    } finally {
      hooks.time = prevTime;
      if (prevHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = prevHome;
      if (prevPrev !== undefined) process.env["LOKI_COST_PREVIEW"] = prevPrev;
    }
  }
  const impl = (extra: Record<string, unknown>) => ({ exit: "done", tests_reverted: [], duration_s: 3, iteration_id: "e10-r1-impl", ...extra });

  test("the recorded executor is the routed implement model, not the run model", async () => {
    const rows = await sealRows("hist-ran", { implement: impl({ model: "claude-haiku-4-5", route_model: "claude-haiku-4-5" }) });
    expect(rows.map((r) => r.executor)).toEqual(["haiku"]);
  }, 30000);

  test("a haiku implement followed by a sonnet fix writes one row, the final rung", async () => {
    const rows = await sealRows("hist-esc", { implement: impl({ model: "claude-haiku-4-5", route_model: "claude-haiku-4-5" }), fix: { round: 1, model: "claude-sonnet-4-6" } });
    expect(rows.map((r) => r.executor)).toEqual(["sonnet"]);
  }, 30000);
});

describe("medium default review at seal", () => {
  const risk = { tier: "medium", checks_selected: ["targeted tests", "lint of changed files", "full test command", "one reviewer"], checks_deferred: ["one reviewer"] };
  const setup = (name: string, sleepS: number, text = "VERDICT: PASS") => {
    const { repo, base } = makeRepo(name);
    writeFileSync(join(repo, "src.js"), "x\n"); sh(["git", "add", "src.js"], repo); sh(["git", "commit", "-q", "-m", "agent wip"], repo);
    mkdirSync(join(repo, ".loki", "state"), { recursive: true }); writeFileSync(join(repo, ".loki", "state", "risk-tier.json"), JSON.stringify({ tier: "medium" }));
    const stub = join(repo, "..", `${name}-claude`); writeFileSync(stub, `#!/bin/sh\nsleep ${sleepS}\nprintf '%s\\n' '{"type":"result","result":"${text}"}'\n`); chmodSync(stub, 0o755);
    const { ctx } = ctxFor(repo, base, "claude", { verify: { checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", n: 1, duration_s: 1 }], flaky: [], wall_passed: true, duration_s: 2, risk } });
    return { ctx, stub };
  };
  const withEnv = async (stub: string, extra: Record<string, string>, f: () => Promise<void>) => {
    const keys = ["LOKI_REVIEW_PROVIDER", "LOKI_XVENDOR_DEFAULT", "LOKI_CLAUDE_CLI", "LOKI_E10_REVIEW_BOX_S"], saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    process.env["LOKI_CLAUDE_CLI"] = stub; Object.assign(process.env, extra); noKey();
    try { await f(); } finally { keys.forEach((k, i) => { const v = saved[i]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
  };
  const sealed = async (ctx: RunContext, limitS: number) => {
    const o = ctx.outputs(), stages: Record<string, typeof sealStage> = { seal: { ...sealStage, limitS } };
    for (const n of ["intake", "wall", "implement", "verify"] as const) stages[n] = { name: n, targetS: 1, limitS: 5, run: async () => ({ status: "completed" as const, data: o[n] ?? {} }) };
    return runMachine(ctx as never, { flow: ["intake", "wall", "implement", "verify", "seal"], load: async (n: StageName) => stages[n] ?? null });
  };
  test("slow reviewer keeps receipt: a review longer than seal's own limit still seals, and the receipt names it", async () => {
    const { ctx, stub } = setup("slowrev", 3);
    await withEnv(stub, { LOKI_E10_REVIEW_BOX_S: "30" }, async () => {
      const r = await sealed(ctx, 1);
      expect(r.outputs.seal).toBeDefined();
      const rc = receiptOf({ data: r.outputs.seal as Record<string, unknown> }) as unknown as { review?: Record<string, unknown> };
      expect(rc.review).toEqual({ provider: "claude", vendor_differs: false, same_vendor: true, defaulted: true, level: "pass", ran: "reviewer (sonnet)" });
    });
  }, 60000);
  test("slow reviewer keeps receipt: a review past its box is not_run, seal still writes the receipt", async () => {
    const { ctx, stub } = setup("slowrev-box", 5);
    await withEnv(stub, { LOKI_E10_REVIEW_BOX_S: "1" }, async () => {
      const r = await sealed(ctx, 1);
      expect(r.outputs.seal).toBeDefined();
      const rc = receiptOf({ data: r.outputs.seal as Record<string, unknown> }) as unknown as { review?: Record<string, unknown> };
      expect(rc.review?.level).toBe("not_run");
    });
  }, 60000);
  test("slow reviewer keeps receipt: a non-exec wrapper is killed as a group within the box and leaves no grandchild", async () => {
    const { ctx, stub } = setup("wrap", 0), pidf = `${stub}.pid`;
    writeFileSync(stub, `#!/bin/sh\nsleep 45 &\necho $! > ${pidf}\nwait\necho VERDICT: PASS\n`);
    await withEnv(stub, { LOKI_E10_REVIEW_BOX_S: "1" }, async () => {
      const t0 = Date.now(), r = await sealed(ctx, 1);
      expect(r.outputs.seal).toBeDefined();
      expect(Date.now() - t0).toBeLessThan(25000);
      const rc = receiptOf({ data: r.outputs.seal as Record<string, unknown> }) as unknown as { review?: Record<string, unknown> };
      expect(rc.review?.level).toBe("not_run");
      expect(() => process.kill(Number(readFileSync(pidf, "utf8").trim()), 0)).toThrow();
    });
  }, 60000);
  test("slow reviewer keeps receipt: a run with little time left before the backstop spawns no review and clamps seal's extra limit", async () => {
    const { ctx, stub } = setup("lowtime", 0), mark = `${stub}.ran`;
    writeFileSync(stub, `#!/bin/sh\ntouch ${mark}\nprintf '%s\\n' '{"type":"result","result":"VERDICT: PASS"}'\n`);
    await withEnv(stub, {}, async () => {
      expect(reviewExtraLimitS(ctx)).toBe(330);
      ctx.capS = 100; expect(reviewExtraLimitS(ctx)).toBeLessThan(100); expect(reviewExtraLimitS(ctx)).toBeGreaterThan(0);
      ctx.capS = 60; expect(reviewExtraLimitS(ctx)).toBe(0);
      const s = await sealStage.run(ctx, new AbortController().signal), rc = receiptOf(s) as unknown as { review?: Record<string, unknown> };
      expect(existsSync(mark)).toBe(false);
      expect(rc.review?.level).toBe("not_run");
      expect(receiptOf(s).not_proven.join(" | ")).toContain("insufficient run time");
    });
  }, 60000);
  test("reviewer cost: a reviewer's reported cost is in the seal and the run total; an unreported one keeps usd null and is listed as missing", async () => {
    const run = async (name: string, body: string) => {
      const c = setup(name, 0); writeFileSync(c.stub, `#!/bin/sh\nprintf '%s\\n' '${body}'\n`);
      let ids: string[] = [], missing: string[] = [];
      c.ctx.sessionIds = () => ["e10-r1-impl"];
      mkdirSync(join(c.ctx.repoDir, ".loki", "metrics"), { recursive: true });
      writeFileSync(join(c.ctx.repoDir, ".loki", "metrics", "result-cost-e10-r1-impl.json"), JSON.stringify({ total_cost_usd: 1, input_tokens: 10, output_tokens: 5, model: "m" }));
      c.ctx.cost = { read: (d, i) => { ids = i; const r = sumResultCosts(join(d, ".loki"), i); missing = r.missing; return r as never; } };
      let rc = {} as { cost?: Record<string, unknown> };
      await withEnv(c.stub, {}, async () => { rc = receiptOf(await sealStage.run(c.ctx, new AbortController().signal)) as never; });
      return { ids, missing, cost: rc.cost ?? {} };
    };
    const known = await run("rc-known", '{"type":"result","result":"VERDICT: PASS","total_cost_usd":0.5,"usage":{"input_tokens":100,"output_tokens":40},"modelUsage":{"claude-sonnet-x":{}}}');
    expect(known.ids).toContain("r1-xreview-claude");
    expect(known.missing).toEqual([]);
    expect(known.cost["usd"]).toBeCloseTo(1.5, 6);
    expect(known.cost["measured_sessions"]).toBe(2);
    const unknown = await run("rc-unknown", '{"type":"result","result":"VERDICT: PASS"}');
    expect(unknown.ids).toContain("r1-xreview-claude");
    expect(unknown.missing).toEqual(["r1-xreview-claude"]);
    expect(unknown.cost["usd"]).toBeNull();
    expect(unknown.cost["partial_usd"]).toBe(1);
  }, 60000);
  test("seal passes reviewRan through: a default review that ran credits one reviewer, an opt-out does not", async () => {
    const a = setup("rr-on", 0), b = setup("rr-off", 0);
    const notProven = async (c: typeof a, env: Record<string, string>) => { let np: string[] = []; await withEnv(c.stub, env, async () => { const s = await sealStage.run(c.ctx, new AbortController().signal); np = receiptOf(s).not_proven; }); return np.join(" | "); };
    expect(await notProven(a, {})).not.toContain("one reviewer");
    expect(await notProven(b, { LOKI_REVIEW_PROVIDER: "none" })).toContain("one reviewer");
  }, 60000);
  test("a failed model review plus a hygiene finding keeps the reviewer in NOT PROVEN; the artifact is an observation, never a not-proven claim", async () => {
    const c = setup("hyg-seal", 0), repo = join(c.stub, "..", "hyg-seal");
    mkdirSync(join(repo, "__pycache__"), { recursive: true }); writeFileSync(join(repo, "__pycache__", "m.pyc"), "b");
    sh(["git", "add", "-f", "__pycache__/m.pyc"], repo); sh(["git", "commit", "-q", "-m", "art"], repo);
    writeFileSync(c.stub, "#!/bin/sh\nexit 1\n");
    await withEnv(c.stub, {}, async () => {
      const s = await sealStage.run(c.ctx, new AbortController().signal), rc = receiptOf(s) as unknown as { not_proven: string[]; review?: Record<string, unknown> };
      expect(rc.not_proven.join(" | ")).toContain("one reviewer"); // deterministic hygiene never earns reviewer credit
      expect(rc.not_proven.join(" | ")).not.toContain("committed build or cache artifact");
      expect(rc.review?.observations).toEqual(["committed build or cache artifact: __pycache__/m.pyc"]);
      expect(rc.review?.ran).toBe("deterministic check");
    });
  }, 60000);
  // FC-FULL-SUITE-EXIT-CODED-SCRIPT: claude-code#81826 sealed PARTIAL on a proven change because the full suite was a CI checker script
  const seal2 = async (name: string, full: Record<string, unknown>) => {
    const { repo, base } = makeRepo(name);
    writeFileSync(join(repo, "src.js"), "x\n"); sh(["git", "add", "src.js"], repo); sh(["git", "commit", "-q", "-m", "agent wip"], repo);
    mkdirSync(join(repo, ".loki", "state"), { recursive: true }); writeFileSync(join(repo, ".loki", "state", "risk-tier.json"), JSON.stringify({ tier: "medium" }));
    const stub = join(repo, "..", `${name}-claude`); writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' '{"type":"result","result":"VERDICT: PASS"}'\n`); chmodSync(stub, 0o755);
    const checks = [{ name: "node:tests/wall.test.ts", cmd: "node --test tests/wall.test.ts", result: "pass", n: 7, duration_s: 1 }, { cmd: "x", duration_s: 1, ...full }];
    const { ctx } = ctxFor(repo, base, "claude", { verify: { checks, flaky: [], wall_passed: true, duration_s: 2, risk } });
    let out: { verdict: unknown; np: string[] } = { verdict: null, np: [] };
    await withEnv(stub, {}, async () => { const s = await sealStage.run(ctx, new AbortController().signal); out = { verdict: s.data.verdict, np: receiptOf(s).not_proven }; });
    return out;
  };
  test("a Wall pass with n>0 plus an exit-coded full suite seals VERIFIED and the review credits one reviewer", async () => {
    const r = await seal2("fc-exit-coded", { name: "full suite: repo-root", cmd: "python3 .github/scripts/check_workflow_hardening.py", result: "pass", count: "n/a (exit-coded check, not a test runner)" });
    expect(r.np.join(" | ")).not.toContain("full suite");
    expect(r.np.join(" | ")).not.toContain("one reviewer");
    expect(r.verdict).toBe("VERIFIED");
  }, 60000);
  test("control: the same run with an UNMEASURED framework full suite stays PARTIAL and the reviewer is not credited", async () => {
    const r = await seal2("fc-unmeasured", { name: "full suite: repo-root", cmd: "python3 -m pytest", result: "not_run", reason: "executed count unmeasured (Loki could not parse the runner summary, harness-owned)" });
    expect(r.verdict).toBe("PARTIAL");
    expect(r.np.join(" | ")).toContain("one reviewer");
  }, 60000);
});

describe("FC-VERIFIED-PR-WITHOUT-ITS-TEST a VERIFIED run publishes the sealed Wall that passed", () => {
  const REL = "tests/loki_wall_x.test.ts", NAME = `bun:${REL}`, SEALED = 'import { test, expect } from "bun:test"; test("ok", () => expect(1).toBe(1));\n', AGENT = "// agent edited it\n";
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const git = (repo: string, ...a: string[]): string => sh(["git", ...a], repo);
  /** Repo with a product change (a.txt), the Wall file in the tree (agent bytes), its sealed copy under runDir/wall, and verify outputs for it. */
  async function run(name: string, o: { sealedSha?: string; result?: string; target?: string[]; verifyNotProven?: string[]; env?: Record<string, string>; productEdit?: boolean } = {}) {
    noKey();
    const { repo, base } = makeRepo(name);
    if (o.productEdit === false) git(repo, "checkout", "--", "a.txt");
    mkdirSync(join(repo, "tests"), { recursive: true }); writeFileSync(join(repo, REL), AGENT);
    const { ctx } = ctxFor(repo, base, "claude", {
      wall: { files: [{ path: join(repo, REL), sha256: o.sealedSha ?? sha(SEALED) }], base_run: { pass: 0, fail: 1, not_run: 0 } },
      verify: { checks: [{ name: NAME, cmd: `bun test ${REL}`, result: o.result ?? "pass", n: 2, duration_s: 1 }], target_checks: o.target ?? [NAME], flaky: [], wall_passed: (o.result ?? "pass") === "pass", duration_s: 1, ...(o.verifyNotProven ? { not_proven: o.verifyNotProven } : {}) },
    });
    mkdirSync(join(ctx.runDir, "wall"), { recursive: true }); writeFileSync(join(ctx.runDir, "wall/loki_wall_x.test.ts"), SEALED);
    const prev = Object.fromEntries(Object.keys(o.env ?? {}).map((k) => [k, process.env[k]])); Object.assign(process.env, o.env ?? {});
    try {
      await commitStage.run(ctx, new AbortController().signal);
      const productHead = git(repo, "rev-parse", "HEAD").trim(), s = await sealStage.run(ctx, new AbortController().signal);
      return { repo, base, ctx, s, r: receiptOf(s), productHead, head: git(repo, "rev-parse", "HEAD").trim() };
    } finally { for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const names = (repo: string, a: string, b: string) => git(repo, "diff", "--name-only", a, b).trim().split("\n").filter(Boolean);

  test("VERIFIED: the sealed Wall file is committed in a child commit, the receipt still binds the product head and diff", async () => {
    const x = await run("fcv-ok");
    expect(x.s.data.verdict).toBe("VERIFIED");
    expect(x.head).not.toBe(x.productHead);
    expect(git(x.repo, "rev-parse", "HEAD^").trim()).toBe(x.productHead);
    expect(names(x.repo, x.productHead, x.head)).toEqual([REL]);
    expect(git(x.repo, "show", `HEAD:${REL}`)).toBe(SEALED); // the sealed bytes, never the agent's copy
    expect(readFileSync(join(x.repo, REL), "utf8")).toBe(SEALED);
    expect(x.r.head_sha).toBe(x.productHead);
    expect(names(x.repo, x.base, x.r.head_sha)).toEqual(["a.txt"]); // the sealed product diff holds no Wall file
    expect(x.s.data.wall_published).toEqual({ files: [REL], cmds: [`bun test ${REL}`] });
    expect(git(x.repo, "log", "-1", "--format=%B")).toContain("Loki-Wall-Publish: r1");
    expect(x.r.diff_sha256).toBe(sha(git(x.repo, "diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", "-O/dev/null", x.base, x.productHead, "--", ".", ":(exclude).loki")));
  }, 30000);
  test("the receipt is identical in tree and diff to the opt-out run (Wall is never product)", async () => {
    const on = await run("fcv-on"), off = await run("fcv-off", { env: { LOKI_COMMIT_WALL: "0" } });
    expect(on.r.diff_sha256).toBe(off.r.diff_sha256); expect(on.r.tree).toBe(off.r.tree);
    expect(off.head).toBe(off.productHead); expect(off.s.data.wall_published).toBeUndefined(); // LOKI_COMMIT_WALL=0 restores the old behavior
    expect(git(off.repo, "ls-files", REL).trim()).toBe("");
  }, 60000);
  test("a sealed copy that does not hash to the sealed sha256 is not published and is NOT PROVEN", async () => {
    const x = await run("fcv-mismatch", { sealedSha: "ab".repeat(32) });
    expect(x.head).toBe(x.productHead); expect(x.s.data.wall_published).toBeUndefined();
    expect(x.r.not_proven.some((n) => n.includes("Wall test not published") && n.includes(REL))).toBe(true);
  }, 30000);
  test("a Wall file that failed, or is not in verify's passing target checks, stays dropped", async () => {
    const f = await run("fcv-failed", { result: "fail" }), n = await run("fcv-notarget", { target: [] });
    for (const x of [f, n]) { expect(x.head).toBe(x.productHead); expect(x.s.data.wall_published).toBeUndefined(); expect(git(x.repo, "ls-files", REL).trim()).toBe(""); }
  }, 60000);
  test("PARTIAL keeps today's behavior: nothing published", async () => {
    const x = await run("fcv-partial", { verifyNotProven: ["some gap"] });
    expect(x.s.data.verdict).toBe("PARTIAL"); expect(x.head).toBe(x.productHead); expect(x.s.data.wall_published).toBeUndefined();
  }, 30000);
  test("a Wall-only change (no product diff) is FAILED and publishes nothing", async () => {
    const x = await run("fcv-wallonly", { productEdit: false });
    expect(x.s.data.verdict).toBe("FAILED"); expect(x.head).toBe(x.base); expect(x.s.data.wall_published).toBeUndefined();
  }, 30000);
  test("re-sealing after the publish commit keeps the receipt on the product head (idempotent)", async () => {
    const x = await run("fcv-reseal"), again = await sealStage.run(x.ctx, new AbortController().signal);
    expect(receiptOf(again).head_sha).toBe(x.productHead); expect(receiptOf(again).diff_sha256).toBe(x.r.diff_sha256);
    expect(git(x.repo, "rev-list", "--count", `${x.base}..HEAD`).trim()).toBe("2"); // product + one Wall commit, not two
  }, 30000);
  test("backstopCommit (killed or crashed worker) still drops Wall files", () => {
    const { repo, base } = makeRepo("fcv-backstop"); mkdirSync(join(repo, "tests"), { recursive: true }); writeFileSync(join(repo, REL), SEALED);
    backstopCommit(repo, process.env, "r1", base, undefined);
    expect(names(repo, base, "HEAD")).toEqual(["a.txt"]); expect(git(repo, "ls-files", REL).trim()).toBe("");
  }, 30000);
});

describe("FC-VERIFIED-PR-WITHOUT-ITS-TEST review block: hooks, sealed bytes, forged trailer, drift", () => {
  const REL = "tests/loki_wall_x.test.ts", NAME = `bun:${REL}`, SEALED = 'import { test, expect } from "bun:test"; test("ok", () => expect(1).toBe(1));\n';
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const git = (repo: string, ...a: string[]): string => sh(["git", ...a], repo);
  const hook = (repo: string, body: string): void => { const h = join(repo, ".git/hooks/pre-commit"); mkdirSync(dirname(h), { recursive: true }); writeFileSync(h, `#!/bin/sh\n${body}\n`); chmodSync(h, 0o755); };
  async function run(name: string, pre?: (repo: string) => void) {
    noKey();
    const { repo, base } = makeRepo(name);
    mkdirSync(join(repo, "tests"), { recursive: true }); writeFileSync(join(repo, REL), "// agent\n");
    const { ctx } = ctxFor(repo, base, "claude", {
      wall: { files: [{ path: join(repo, REL), sha256: sha(SEALED) }], base_run: { pass: 0, fail: 1, not_run: 0 } },
      verify: { checks: [{ name: NAME, cmd: `bun test ${REL}`, result: "pass", n: 2, duration_s: 1 }], target_checks: [NAME], flaky: [], wall_passed: true, duration_s: 1 },
    });
    mkdirSync(join(ctx.runDir, "wall"), { recursive: true }); writeFileSync(join(ctx.runDir, "wall/loki_wall_x.test.ts"), SEALED);
    await commitStage.run(ctx, new AbortController().signal);
    pre?.(repo);
    const s = await sealStage.run(ctx, new AbortController().signal);
    return { repo, ctx, s, r: receiptOf(s) };
  }
  const tree = (repo: string): string[] => git(repo, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");

  test("a pre-commit hook that adds evil.js and rewrites the Wall file never runs: the child holds exactly the sealed bytes", async () => {
    const { repo } = await run("fc-hook-evil", (r) => hook(r, `echo evil > evil.js; git add evil.js; echo '// extra' >> ${REL}; git add ${REL}`));
    expect(tree(repo)).not.toContain("evil.js");
    expect(git(repo, "show", `HEAD:${REL}`)).toBe(SEALED);
    expect(git(repo, "diff", "--name-only", "HEAD^", "HEAD").trim()).toBe(REL);
  });

  test("a formatter-style hook that only reformats the Wall file leaves the sealed bytes committed", async () => {
    const { repo } = await run("fc-hook-fmt", (r) => hook(r, `printf '// reformatted\\n' > ${REL}; git add ${REL}`));
    expect(git(repo, "show", `HEAD:${REL}`)).toBe(SEALED);
  });

  test("a forged Loki-Wall-Publish trailer on a commit that adds another file is not a re-seal child: the receipt binds that HEAD", async () => {
    const { repo, ctx, r } = await run("fc-forged");
    expect(r["head_sha"]).toBe(git(repo, "rev-parse", "HEAD^").trim());
    writeFileSync(join(repo, "evil.js"), "x"); git(repo, "add", "evil.js");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "forged", "-m", `Loki-Wall-Publish: ${ctx.runId}`);
    const forged = git(repo, "rev-parse", "HEAD").trim(), s2 = await sealStage.run(ctx, new AbortController().signal);
    expect(receiptOf(s2)["head_sha"]).toBe(forged);
  });

  test("seal_drift: the genuine Wall child is benign; a trailer-bearing commit with a non-Wall file is drift", async () => {
    const { repo, ctx, s, r } = await run("fc-drift");
    const rp = String(s.data["receipt_path"]);
    expect(sealDrift(rp, r as unknown as Record<string, unknown>)).toBeNull();
    writeFileSync(join(repo, "evil.js"), "x"); git(repo, "add", "evil.js");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "child", "-m", `Loki-Wall-Publish: ${ctx.runId}`);
    expect(sealDrift(rp, r as unknown as Record<string, unknown>)?.verdict).toBe("UNCHECKED");
  });
});

describe("#238 wall proven at committed path", () => {
  const REL = "tests/loki_wall_loc.test.ts", NAME = `bun:${REL}`;
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  // resolves its fixture from its own dir: passes only where loc_fixture.txt sits beside it
  const SEALED = 'import { test, expect } from "bun:test"; import { readFileSync } from "node:fs"; test("loc", () => expect(readFileSync(`${import.meta.dir}/loc_fixture.txt`, "utf8")).toBe("ok\\n"));\n';
  async function run(name: string, fixtureAtCommitted: boolean) {
    noKey();
    const { repo, base } = makeRepo(name);
    mkdirSync(join(repo, "tests"), { recursive: true }); writeFileSync(join(repo, REL), "// agent\n");
    writeFileSync(join(repo, "loc_fixture.txt"), "ok\n"); // proven where the fixture is: the repo root
    if (fixtureAtCommitted) writeFileSync(join(repo, "tests/loc_fixture.txt"), "ok\n");
    const { ctx } = ctxFor(repo, base, "claude", {
      wall: { files: [{ path: join(repo, REL), sha256: sha(SEALED) }], base_run: { pass: 0, fail: 1, not_run: 0 } },
      verify: { checks: [{ name: NAME, cmd: `bun test ${REL}`, result: "pass", n: 1, duration_s: 1 }], target_checks: [NAME], flaky: [], wall_passed: true, duration_s: 1 },
    });
    mkdirSync(join(ctx.runDir, "wall"), { recursive: true }); writeFileSync(join(ctx.runDir, "wall/loki_wall_loc.test.ts"), SEALED);
    await commitStage.run(ctx, new AbortController().signal);
    const productHead = sh(["git", "rev-parse", "HEAD"], repo).trim(), s = await sealStage.run(ctx, new AbortController().signal);
    return { repo, s, r: receiptOf(s), productHead, head: sh(["git", "rev-parse", "HEAD"], repo).trim() };
  }
  test("a Wall test that only passes away from its committed path is PARTIAL, named, and not published", async () => {
    const x = await run("loc-bad", false);
    expect(x.s.data.verdict).toBe("PARTIAL");
    expect(x.r.not_proven).toContain(`Wall test fails at its committed path: ${REL}`);
    expect(x.head).toBe(x.productHead); expect(x.s.data.wall_published).toBeUndefined();
  }, 60000);
  test("the same test with its fixture at the committed path still seals VERIFIED and publishes", async () => {
    const x = await run("loc-ok", true);
    expect(x.s.data.verdict).toBe("VERIFIED"); expect(x.s.data.wall_published).toBeDefined();
  }, 60000);
});

describe.skipIf(!Bun.which("go"))("a published in-package Go Wall is re-proven at its committed path with the real go toolchain", () => {
  const REL = "loki_wall_ini_test.go", NAME = `go:${REL}`;
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const IMPL = "package ini\n\nfunc Two() int { return 2 }\n";
  const WALLS: Record<string, string> = {
    pass: 'package ini\n\nimport "testing"\n\nfunc TestTwo(t *testing.T) {\n\tif Two() != 2 {\n\t\tt.Fatal("two")\n\t}\n}\n',
    skipped: 'package ini\n\nimport "testing"\n\nfunc TestTwo(t *testing.T) {\n\tt.Skip("later")\n}\n',
    noFuncs: 'package ini\n\nimport "testing"\n\nfunc helper(t *testing.T) {}\n',
  };
  async function run(name: string, wall: string) {
    noKey();
    const { repo, base } = makeRepo(name);
    writeFileSync(join(repo, "go.mod"), "module example.com/ini\n\ngo 1.20\n"); writeFileSync(join(repo, "ini.go"), IMPL); writeFileSync(join(repo, REL), "// agent\n");
    const { ctx } = ctxFor(repo, base, "claude", {
      wall: { files: [{ path: join(repo, REL), sha256: sha(wall) }], base_run: { pass: 0, fail: 1, not_run: 0 } },
      verify: { checks: [{ name: NAME, cmd: "go test ./...", result: "pass", n: 1, duration_s: 1 }], target_checks: [NAME], flaky: [], wall_passed: true, duration_s: 1 },
    });
    mkdirSync(join(ctx.runDir, "wall"), { recursive: true }); writeFileSync(join(ctx.runDir, "wall", REL), wall);
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    return { s, r: receiptOf(s) };
  }
  test("a passing in-package Wall seals VERIFIED and publishes (the seal re-run corroborates a Go exit 0)", async () => {
    const x = await run("go-pass", WALLS.pass!);
    expect(x.r.not_proven ?? []).not.toContain(`Wall test fails at its committed path: ${REL}`);
    expect(x.s.data.verdict).toBe("VERIFIED"); expect(x.s.data.wall_published).toBeDefined();
  }, 120000);
  test("a Wall whose only test is t.Skip never reproves as a pass", async () => {
    const x = await run("go-skip", WALLS.skipped!);
    expect(x.s.data.verdict).toBe("PARTIAL"); expect(x.r.not_proven).toContain(`Wall test fails at its committed path: ${REL}`);
  }, 120000);
  test("a Wall with no Test functions never reproves as a pass", async () => {
    const x = await run("go-nofuncs", WALLS.noFuncs!);
    expect(x.s.data.verdict).toBe("PARTIAL"); expect(x.r.not_proven).toContain(`Wall test fails at its committed path: ${REL}`);
  }, 120000);
});

describe("Seal accuracy line (GAME10-03)", () => {
  const MODEL = "claude-opus-5-5", DAY = 86_400_000;
  const mk = (name: string, over: { row?: Record<string, unknown> | null; ver?: string | null; run?: Record<string, unknown>; ageDays?: number | null; corpusSha?: string } = {}) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "results"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), '{"defects":[]}');
    const sha = createHash("sha256").update('{"defects":[]}').digest("hex");
    const row = over.row === null ? [] : [{ language: "python", runner: "pytest", tier: "top", n: 60, wrong_pass: 0, wilson_upper_95: 0.0602, ...over.row }];
    const file = join(dir, "results", "wrong-pass.json");
    writeFileSync(file, JSON.stringify({ schema: "loki.seeded-defects.results/v3", manifest_sha256: sha, runs: [{ setup: "top", model: MODEL, loki_version: over.ver === undefined ? getVersion() : over.ver, corpus_sha256: over.corpusSha ?? sha, strata: row, ...(over.ageDays === null ? {} : { measured_at: new Date(Date.now() - (over.ageDays ?? 0) * DAY).toISOString() }), ...over.run }] }));
    return { LOKI_SEEDED_DEFECTS_DIR: dir } as NodeJS.ProcessEnv;
  };
  const line = (env: NodeJS.ProcessEnv, files = ["src/app.py", "tests/test_app.py"], model = MODEL) => sealAccuracyLine(files, [{ cmd: "pytest -q", result: "pass" }], model, env);
  test("a measured stratum states its counts, upper bound and version from the file", () => {
    expect(line(mk("sa-ok"))).toBe(`Seal accuracy for python/pytest at this tier: 0 wrong passes in 60 seeded defects, 95% upper bound 6.0%, measured on ${getVersion()}`);
    expect(line(mk("sa-one", { row: { wrong_pass: 1, n: 40, wilson_upper_95: 0.1286 } }))).toContain("1 wrong pass in 40 seeded defects, 95% upper bound 12.9%");
  });
  test("not measured on a version mismatch", () => {
    expect(line(mk("sa-ver", { ver: "0.0.1" }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line(mk("sa-nover", { ver: null }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
  });
  test("not measured when the stratum is missing", () => {
    expect(line(mk("sa-nostratum", { row: null }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line(mk("sa-otherlang"), ["src/app.go"])).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line(mk("sa-othermodel"), undefined, "claude-haiku-5-5")).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(sealAccuracyLine(["src/app.py"], [{ cmd: "pytest", result: "fail" }], MODEL, mk("sa-nopass"))).toBe(SEAL_ACCURACY_NOT_MEASURED);
  });
  test("measured_at rules: missing or unparseable is not measured, 8 days is not measured, 1 day is measured, a checkout-fresh mtime does not help", () => {
    expect(line(mk("sa-noat", { ageDays: null }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line(mk("sa-badat", { run: { measured_at: "yesterday" } }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line(mk("sa-8d", { ageDays: 8 }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line(mk("sa-1d", { ageDays: 1 }))).toStartWith("Seal accuracy for python/pytest");
    expect(line(mk("sa-future", { ageDays: -2 }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
  });
  test("not measured when the result is older than 7 days, measured at 6 days", () => {
    expect(line(mk("sa-old", { ageDays: 8 }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line(mk("sa-6d", { ageDays: 6 }))).toStartWith("Seal accuracy for python/pytest");
  });
  test("not measured for a corpus other than the current manifest and for a malformed row", () => {
    expect(line(mk("sa-corpus", { corpusSha: "f".repeat(64) }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line(mk("sa-badrow", { row: { wrong_pass: 61 } }))).toBe(SEAL_ACCURACY_NOT_MEASURED);
    expect(line({ LOKI_SEEDED_DEFECTS_DIR: join(root, "sa-absent") })).toBe(SEAL_ACCURACY_NOT_MEASURED);
  });
  test("the sealed receipt carries the line and editing it fails verification", async () => {
    const { repo, base } = makeRepo("sa-seal");
    const { ctx } = ctxFor(repo, base);
    ctx.model = MODEL;
    const prev = process.env["LOKI_SEEDED_DEFECTS_DIR"];
    process.env["LOKI_SEEDED_DEFECTS_DIR"] = mk("sa-seal-corpus", { row: { language: "unknown" } })["LOKI_SEEDED_DEFECTS_DIR"]!;
    try {
      const s = await sealStage.run(ctx, new AbortController().signal), path = s.data.receipt_path as string;
      expect(receiptOf(s).seal_accuracy).toContain("Seal accuracy for unknown/pytest at this tier: 0 wrong passes in 60");
      expect(s.data.signed).toBe(true);
      expect((await verifyReceipt(path)).reasons.some((r) => r.startsWith("receipt_sha256 mismatch"))).toBe(false); // the fixture event log is not the sealed one; integrity is under test
      const t = JSON.parse(readFileSync(path, "utf8"));
      t.seal_accuracy = t.seal_accuracy.replace("95% upper bound 6.0%", "95% upper bound 0.1%");
      writeFileSync(path, JSON.stringify(t, null, 2) + "\n");
      const bad = await verifyReceipt(path);
      expect(bad.verdict).toBe("TAMPERED");
      expect(bad.reasons[0]).toStartWith("receipt_sha256 mismatch");
    } finally { if (prev === undefined) delete process.env["LOKI_SEEDED_DEFECTS_DIR"]; else process.env["LOKI_SEEDED_DEFECTS_DIR"] = prev; }
  });
  test("a receipt with no usable stratum signs not measured", async () => {
    const { repo, base } = makeRepo("sa-seal-none");
    const { ctx } = ctxFor(repo, base);
    expect(receiptOf(await sealStage.run(ctx, new AbortController().signal)).seal_accuracy).toBe(SEAL_ACCURACY_NOT_MEASURED);
  });
});
