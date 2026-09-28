// loki-ts/tests/engine10/seal.test.ts
//
// E-10 wall check (docs/v10/ENGINE.md sections 9 and 16). Signing goes through
// findIsolatedPython3 with -I (never -S) and autonomy/receipt_jwt.py. The JWT is
// verified in Python against the PUBLIC key only, and receipt_sha256 is
// recomputed in Python from receipt.json, so a TS canonicalizer bug cannot
// pass by agreeing with itself.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitStage, DEEP_NOT_PROVEN, renderReceiptMd, SIGNING_UNAVAILABLE, sealStage } from "../../src/engine10/stages/seal.ts";
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
    // Bun.spawnSync throws ENOENT on Linux for a missing path (macOS returns non-zero), so skip absent candidates.
    if (!existsSync(c)) continue;
    const p = Bun.spawnSync({ cmd: [c, "-I", "-c", "import cryptography"], stdout: "ignore", stderr: "ignore", env: process.env });
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
