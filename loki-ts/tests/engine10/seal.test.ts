// loki-ts/tests/engine10/seal.test.ts
//
// E-10 wall check (docs/v10/ENGINE.md sections 9 and 16). Signing goes through
// findIsolatedPython3 with -I (never -S) and autonomy/receipt_jwt.py. The JWT is
// verified in Python against the PUBLIC key only, and receipt_sha256 is
// recomputed in Python from receipt.json, so a TS canonicalizer bug cannot
// pass by agreeing with itself.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitStage, DEEP_NOT_PROVEN, SIGNING_UNAVAILABLE, sealStage } from "../../src/engine10/stages/seal.ts";
import type { EventType, Receipt, RunContext, StageName } from "../../src/engine10/types.ts";
import { _setIsolatedPythonFixedForTests } from "../../src/util/python.ts";
import { REPO_ROOT } from "../../src/util/paths.ts";

const AUTONOMY = resolve(REPO_ROOT, "autonomy");
let root = "";
let cryptoPy = "";

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
  writeFileSync(join(repo, ".loki/runs/r1/events.jsonl"), '{"v":1}\n');
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

const noKey = () => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = ""; };
const receiptOf = (s: { data: Record<string, unknown> }) => JSON.parse(readFileSync(s.data.receipt_path as string, "utf8")) as Receipt;
const PY_HASH = `
import sys, json, hashlib
r = json.load(open(sys.argv[1]))
body = {k: v for k, v in r.items() if k not in ("verification", "receipt_sha256")}
print(hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
`;

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
    const p = Bun.spawnSync({ cmd: [c, "-I", "-c", "import cryptography"], stdout: "ignore", stderr: "ignore" });
    if (p.exitCode === 0) { cryptoPy = c; break; }
  }
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
afterEach(() => {
  _setIsolatedPythonFixedForTests(null);
  delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];
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

  test("no key: signed false, summary UNSIGNED, deep checks in NOT PROVEN", async () => {
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = "";
    const { repo, base } = makeRepo("unsigned");
    const { ctx, events } = ctxFor(repo, base, "codex");
    await commitStage.run(ctx, new AbortController().signal);
    const s = await sealStage.run(ctx, new AbortController().signal);
    expect(s.data.signed).toBe(false);
    expect(String(s.data.summary)).toContain("UNSIGNED");
    const r = JSON.parse(readFileSync(s.data.receipt_path as string, "utf8")) as Receipt;
    expect(r.verification).toEqual({ jwt: null, kid: null });
    for (const d of DEEP_NOT_PROVEN) expect(r.not_proven).toContain(d);
    expect(r.not_proven).toContain("kill blocking not enforced");
    expect(r.cost.usd).toBeNull();
    const md = readFileSync(join(ctx.runDir, "receipt.md"), "utf8");
    expect(md).toContain("UNSIGNED");
    expect(events.find((e) => e.type === "receipt.sealed")?.data.signed).toBe(false);
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

  test("only section 4 keys are trusted; off-table keys go on NOT PROVEN when absent", async () => {
    noKey();
    const { repo, base } = makeRepo("keys");
    const { ctx } = ctxFor(repo, base, "claude", {
      intake: { source: "issue", task_sha256: "ab".repeat(32) },
      implement: { exit: "done", tests_reverted: [] },
      verify: {
        checks: [{ name: "pytest", cmd: "pytest -q", result: "pass", duration_s: 1 }, { name: "ruff", cmd: "ruff check", result: "not_run", duration_s: 0 }],
        flaky: [], not_proven: ["stray off-table entry"],
      },
    });
    await commitStage.run(ctx, new AbortController().signal);
    const r = receiptOf(await sealStage.run(ctx, new AbortController().signal));
    expect(r.task.source).toBe("issue");
    expect(r.not_proven).toContain("not run: ruff");
    expect(r.not_proven).not.toContain("stray off-table entry");
    for (const n of ["repo not recorded by intake", "resume state not recorded by intake", "wall result not recorded by verify",
      "cost not measured (no iteration ids recorded)"]) expect(r.not_proven).toContain(n);
    expect(r.verdict).toBe("PARTIAL");
    const noSrc = ctxFor(repo, base, "claude", { intake: { task_sha256: "ab".repeat(32) } });
    expect(receiptOf(await sealStage.run(noSrc.ctx, new AbortController().signal)).not_proven).toContain("task source not recorded by intake");
  }, 30000);

  test("key configured but no token: signed false, SIGNING_UNAVAILABLE on NOT PROVEN", async () => {
    // A python3 that passes the isolation probe but cannot sign (like /usr/bin/python3 without cryptography).
    const stub = join(root, "py-nocrypto");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
    _setIsolatedPythonFixedForTests([stub]);
    const keyFile = join(root, "k2.pem");
    writeFileSync(keyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
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
    const py = cryptoPy || "python3";
    expect(sh([py, "-I", "-c", PY_HASH, s.data.receipt_path as string], root).trim()).toBe(r.receipt_sha256);
  }, 30000);
});
