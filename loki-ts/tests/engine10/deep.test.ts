// loki-ts/tests/engine10/deep.test.ts
//
// E-23 wall check (docs/v10/ENGINE.md sections 4, 6, 7, 9, 16). supervisor.ts
// (E-03), machine.ts (E-02) and seal.ts's outputs are fakes here; the push
// child is a stub script (fixtures/deep/push-stub.sh), never the real,
// credentialed autonomy/lib/engine10-push.sh. secret-scan.sh is the REAL
// checked-in script: it is pure (sources shell functions, reads files),
// takes no credentials and makes no network call, so exercising it for real
// is the honest test of "a secret in a changed file sets the status to
// failure".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SECRET_SCAN_SH,
  deepStage,
  runDeep,
  type CouncilOutcome,
  type DeepContext,
  type DeepOptions,
} from "../../src/engine10/stages/deep.ts";
import type { EventType, StageName, TestMap, TestRef } from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "fixtures", "deep");
const PUSH_STUB = join(FIX, "push-stub.sh");
const NO_PATH = "/nonexistent-test-path";
const REAL_TOKEN = "ghp_" + "x".repeat(36); // not the withheld sentinel prefix

// git may not preserve the executable bit across checkout on every platform.
chmodSync(PUSH_STUB, 0o755);

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** A committed base, then a second commit (simulating implement+commit having
 *  already run -- deep verify sits after commit/seal/pr in the pipeline). */
function mkRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "e10-deep-"));
  cleanupDirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  return { dir, base };
}

function commitChange(dir: string, path: string, content: string): void {
  writeFileSync(join(dir, path), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `change ${path}`]);
}

const cleanupDirs: string[] = [];
beforeEach(() => {
  process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
  const keyDir = mkdtempSync(join(tmpdir(), "e10-deep-key-")); cleanupDirs.push(keyDir);
  process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(keyDir, "k.pem"); // throwaway auto-generated key, never the real ~/.loki
});
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Emitted { type: EventType | string; stage: StageName | string | null; data: Record<string, unknown> }

function fakeCtx(opts: {
  repoDir: string;
  baseSha: string;
  pinnedOrigin?: string | null;
  outputs?: Partial<Record<StageName, Record<string, unknown>>>;
  tests?: TestMap;
}): { ctx: DeepContext; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const map: TestMap = opts.tests ?? { runners: [], tests: [] };
  const ctx: DeepContext = {
    runId: "e10-deep-test",
    repoDir: opts.repoDir,
    runDir: join(opts.repoDir, ".loki", "runs", "e10-deep-test"),
    baseSha: opts.baseSha,
    branch: "loki/e10-deep-test",
    provider: "claude",
    model: "test-model",
    deep: true,
    capS: 2700,
    emit: (type, stage, data) => { emitted.push({ type, stage, data }); },
    sessions: { run: async () => { throw new Error("deep verify must never start a provider session directly"); } },
    tests: { detect: async () => map, impacted: (_m: TestMap, _c: string[]): TestRef[] => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs: () => opts.outputs ?? {},
    ...(opts.pinnedOrigin === null ? {} : { pinnedOrigin: opts.pinnedOrigin ?? "https://github.com/octocat/hello.git" }),
  };
  return { ctx, emitted };
}

const sig = () => new AbortController().signal;

function baseOpts(over: Partial<DeepOptions> = {}): DeepOptions {
  return {
    pushScriptPath: PUSH_STUB,
    secretScanShPath: DEFAULT_SECRET_SCAN_SH,
    appProbe: async () => ({ checks: [{ name: "app boot", cmd: "fake", result: "not_run", duration_s: 0, reason: "fake probe" }], pid: null, url: null }),
    env: { PATH: process.env["PATH"] ?? "" }, // clean env by default: no real token
    ...over,
  };
}

describe("engine10 deep: Rule of Two (worker env holds no token)", () => {
  test("refuses to run when a real GitHub token is present", async () => {
    const { dir, base } = mkRepo();
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base });
    const result = await runDeep(ctx, sig(), baseOpts({ env: { ...process.env, GH_TOKEN: REAL_TOKEN } }));
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/GH_TOKEN/);
  });

  test("runs normally with a withheld sentinel token", async () => {
    const { dir, base } = mkRepo();
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts({ env: { ...process.env, GH_TOKEN: "ghp_LOKIWITHHELDsentinel-abc" } }));
    expect(result.status).toBe("completed");
  });
});

describe("engine10 deep: secret scan", () => {
  test("a secret in a changed file sets the status to failure", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "config.js", `const KEY = "AKIAABCDEFGHIJKLMNOP";\n`);
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    expect(result.status).toBe("completed");
    expect(result.data.status_state).toBe("failure");
    const checks = result.data.checks as { name: string; result: string; reason?: string }[];
    const scan = checks.find((c) => c.name === "security scan");
    expect(scan?.result).toBe("fail");
    expect(scan?.reason).toMatch(/config\.js/);
  });

  test("no secret keeps status success", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "config.js", "const greeting = 'hello';\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    expect(result.status).toBe("completed");
    expect(result.data.status_state).toBe("success");
    const checks = result.data.checks as { name: string; result: string }[];
    expect(checks.find((c) => c.name === "security scan")?.result).toBe("pass");
  });
});

const PEM = "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA " + "PRIVATE KEY-----\n";
const OPEN_RULES = '{\n  "rules": {\n    ".read": true,\n    ".write": true\n  }\n}\n';
/** A fake secure-scan.py: prints `stdout` and exits `code`, whatever it is asked to scan. */
function stubScanner(stdout: string, code: number): string {
  const d = mkdtempSync(join(tmpdir(), "e10-deep-scan-")); cleanupDirs.push(d);
  const p = join(d, "secure-scan.py");
  writeFileSync(p, `import sys\nsys.stdout.write(${JSON.stringify(stdout)})\nsys.exit(${code})\n`);
  return p;
}
type Chk = { name: string; cmd?: string; result: string; reason?: string };

describe("engine10 deep: secure scan rules (TEN-GATES-06)", () => {
  test("a changed file with a committed PEM private key fails with the secure-scan rule id", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "server.txt", PEM);
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    const scan = (result.data.checks as Chk[]).find((c) => c.name === "security scan");
    expect(scan?.result).toBe("fail");
    expect(scan?.reason).toMatch(/private-key-committed: server\.txt:1/);
    expect(result.data.status_state).toBe("failure");
  });

  test("a HIGH rule only secure-scan knows (world-open datastore) fails the check", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "database.rules.json", OPEN_RULES);
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    const scan = (result.data.checks as Chk[]).find((c) => c.name === "security scan");
    expect(scan?.result).toBe("fail");
    expect(scan?.reason).toMatch(/world-open-datastore: database\.rules\.json:3/);
    expect(scan?.reason).not.toMatch(/secret match/);
  });

  test("a finding in an unchanged base file is out of scope (only changed files are scanned)", async () => {
    const { dir } = mkRepo();
    commitChange(dir, "database.rules.json", OPEN_RULES);
    const base = git(dir, ["rev-parse", "HEAD"]);
    commitChange(dir, "app.js", "const greeting = 'hello';\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    expect((result.data.checks as Chk[]).find((c) => c.name === "security scan")?.result).toBe("pass");
  });

  test("a changed symlink is never followed out of the repo into the secure-scan copy", async () => {
    const { dir, base } = mkRepo();
    const outside = mkdtempSync(join(tmpdir(), "e10-deep-outside-")); cleanupDirs.push(outside);
    writeFileSync(join(outside, "rules.json"), OPEN_RULES);
    symlinkSync(join(outside, "rules.json"), join(dir, "database.rules.json"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "symlink"]);
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    expect((result.data.checks as Chk[]).find((c) => c.name === "security scan")?.reason ?? "").not.toMatch(/world-open-datastore/);
  });

  test("secure-scan missing is not_run and NOT PROVEN, never pass", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "app.js", "const greeting = 'hello';\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts({ secureScanPath: join(dir, "no-such-secure-scan.py") }));
    expect((result.data.checks as Chk[]).find((c) => c.name === "security scan")?.result).toBe("not_run");
    expect((result.data.not_proven as string[]).some((n) => n.startsWith("not run: security scan (secure-scan script not found"))).toBe(true);
    expect(result.data.status_state).toBe("success");
  });

  test("a broken secure-scan exit is not_run, never a silent pass", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "app.js", "const greeting = 'hello';\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts({ secureScanPath: stubScanner("", 7) }));
    expect((result.data.checks as Chk[]).find((c) => c.name === "security scan")?.result).toBe("not_run");
    expect((result.data.not_proven as string[]).some((n) => n.startsWith("not run: security scan (secure-scan failed (exit 7)"))).toBe(true);
  });

  test("a MEDIUM-only finding does not fail; a lowercase high does", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "app.js", "const greeting = 'hello';\n");
    const f = (severity: string) => JSON.stringify({ findings: [{ rule: "debug-in-prod", file: "app.js", line: 1, severity, message: "m", fix: "f" }] });
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const med = await runDeep(ctx, sig(), baseOpts({ secureScanPath: stubScanner(f("MEDIUM"), 1) }));
    expect((med.data.checks as Chk[]).find((c) => c.name === "security scan")?.result).toBe("pass");
    const high = await runDeep(ctx, sig(), baseOpts({ secureScanPath: stubScanner(f("high"), 1) }));
    expect((high.data.checks as Chk[]).find((c) => c.name === "security scan")?.result).toBe("fail");
  });
});

describe("engine10 deep: app boot via util/app_probe.ts (TEN-GATES-06)", () => {
  test("an injected appProbe pass becomes a passing app boot and http probe, absent from NOT PROVEN", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    let seen: string[] = [];
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts({
      appProbe: async (repoDir, lokiDir) => {
        seen = [repoDir, lokiDir];
        return { checks: [
          { name: "app boot", cmd: "autonomy/app-runner.sh", result: "pass", duration_s: 1, reason: "app process started" },
          { name: "http probe", cmd: "autonomy/app-runner.sh", result: "pass", duration_s: 1, reason: "health.json ok" },
        ], pid: 123, url: "http://127.0.0.1:1" };
      },
    }));
    expect(seen).toEqual([dir, join(dir, ".loki")]);
    const checks = result.data.checks as Chk[];
    expect(checks.find((c) => c.name === "app boot")?.result).toBe("pass");
    expect(checks.find((c) => c.name === "http probe")?.result).toBe("pass");
    expect((result.data.not_proven as string[]).some((n) => n.includes("app boot"))).toBe(false);
  });

  test("a failing boot fails the run; a not_run boot is NOT PROVEN with its reason", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const failed = await runDeep(ctx, sig(), baseOpts({ appProbe: async () => ({ checks: [
      { name: "app boot", cmd: "x", result: "fail", duration_s: 0, reason: "app start command failed or exited" },
      { name: "http probe", cmd: "x", result: "not_run", duration_s: 0, reason: "app not booted" },
    ], pid: null, url: null }) }));
    expect(failed.data.status_state).toBe("failure");
    expect(failed.data.not_proven as string[]).toContain("not run: http probe (app not booted)");
    const skipped = await runDeep(ctx, sig(), baseOpts());
    expect(skipped.data.not_proven as string[]).toContain("not run: app boot (fake probe)");
    expect(skipped.data.status_state).toBe("success");
  });

  test("FC-SEAL-NA-AS-UNPROVEN: an n/a boot (no app to run) is not a check and not NOT PROVEN; it is listed as not_applicable", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const r = await runDeep(ctx, sig(), baseOpts({ appProbe: async () => ({ checks: [
      { name: "app boot", cmd: "x", result: "n/a", duration_s: 0, reason: "app-runner detected no app" },
      { name: "http probe", cmd: "x", result: "n/a", duration_s: 0, reason: "app not booted" },
    ], pid: null, url: null }) }));
    expect((r.data.checks as Chk[]).some((c) => c.name === "app boot")).toBe(false);
    expect((r.data.not_proven as string[]).some((n) => n.includes("app boot"))).toBe(false);
    expect(r.data.not_applicable as string[]).toContain("app boot (app-runner detected no app)");
  });

  test("FC-DEEP-REQUIRED-CHECK-UNRECORDED: a high-tier run whose required check was skipped is recorded not ran and is never success", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const risk = { tier: "high", checks_selected: ["targeted tests", "lint of changed files", "full test command", "full suite", "council", "security scan"], checks_deferred: ["full suite", "council", "security scan"] };
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null, outputs: { verify: { risk, checks: [] } } });
    const r = await runDeep(ctx, sig(), baseOpts());
    const req = r.data.required_checks as { check: string; ran: boolean; reason?: string }[];
    expect(req.find((q) => q.check === "council")).toMatchObject({ ran: false, reason: "not wired: see the contract-gap note in stages/deep.ts" });
    expect(req.find((q) => q.check === "security scan")?.ran).toBe(true);
    expect(r.data.status_state).toBe("pending");
    expect(r.data.not_proven as string[]).toContain("council (not wired: see the contract-gap note in stages/deep.ts)");
    const add = JSON.parse(readFileSync(join(dir, ".loki", "runs", "e10-deep-test", "receipt-addendum-1.json"), "utf8"));
    expect(add.required_checks).toEqual(req); expect(add.status_state).toBe("pending");
  });

  test("FC-DEEP-REQUIRED-CHECK-UNRECORDED: every required check ran gives success; a low-tier record requires nothing", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const sel = ["targeted tests", "lint of changed files", "full test command", "full suite", "council", "security scan"];
    const done = { name: "full suite: bun", cmd: "x", result: "pass", duration_s: 0 };
    const hi = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null, outputs: { verify: { risk: { tier: "high", checks_selected: sel, checks_deferred: ["council"] }, checks: [done] } } });
    const okCouncil = await runDeep(hi.ctx, sig(), baseOpts({ council: { run: async () => ({ findings: [] }) } }));
    expect(okCouncil.data.status_state).toBe("success");
    expect((okCouncil.data.required_checks as { ran: boolean }[]).every((q) => q.ran)).toBe(true);
    const lo = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null, outputs: { verify: { risk: { tier: "low", checks_selected: sel.slice(0, 2), checks_deferred: [] }, checks: [] } } });
    const low = await runDeep(lo.ctx, sig(), baseOpts());
    expect(low.data.required_checks).toEqual([]); expect(low.data.status_state).toBe("success");
  });

  test("a throwing or empty probe is NOT PROVEN, never a pass", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const threw = await runDeep(ctx, sig(), baseOpts({ appProbe: async () => { throw new Error("boom"); } }));
    expect((threw.data.checks as Chk[]).find((c) => c.name === "app boot")?.result).toBe("not_run");
    expect(threw.data.not_proven as string[]).toContain("not run: app boot (app probe threw: boom)");
    const empty = await runDeep(ctx, sig(), baseOpts({ appProbe: async () => ({ checks: [], pid: null, url: null }) }));
    expect(empty.data.not_proven as string[]).toContain("not run: app boot (app probe reported no result)");
  });
});

describe("engine10 deep: council", () => {
  test("an oversized council context is NOT PROVEN, and the runner is never called", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "big.txt", "x".repeat(500));
    let called = false;
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts({
      maxCouncilDiffBytes: 10,
      council: { run: async (): Promise<CouncilOutcome> => { called = true; return { findings: [] }; } },
    }));
    expect(called).toBe(false);
    expect(result.data.not_proven as string[]).toContain("council (context oversized, refused)");
    const checks = result.data.checks as { name: string }[];
    expect(checks.find((c) => c.name === "council")).toBeUndefined();
  });

  test("a small diff runs the injected council and excludes .md files", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "code.txt", "small change\n");
    commitChange(dir, "NOTES.md", "generated notes, not code\n");
    let seenFiles: string[] = [];
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts({
      council: {
        run: async (input): Promise<CouncilOutcome> => {
          seenFiles = input.files;
          return { findings: [] };
        },
      },
    }));
    expect(seenFiles).toEqual(["code.txt"]);
    const checks = result.data.checks as { name: string; result: string }[];
    expect(checks.find((c) => c.name === "council")?.result).toBe("pass");
  });

  test("with no council runner injected, council is NOT PROVEN, never fabricated as passing", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "code.txt", "small change\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    const checks = result.data.checks as { name: string }[];
    expect(checks.find((c) => c.name === "council")).toBeUndefined();
    expect((result.data.not_proven as string[]).some((n) => n.startsWith("council (not wired"))).toBe(true);
  });
});

describe("engine10 deep: full suite", () => {
  test("a missing runner tool is NOT PROVEN, never a failure", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.py", "x = 1\n");
    const { ctx } = fakeCtx({
      repoDir: dir, baseSha: base, pinnedOrigin: null,
      tests: { runners: ["pytest"], tests: [{ runner: "pytest", path: "a.py" }] },
    });
    const result = await runDeep(ctx, sig(), baseOpts({ path: NO_PATH }));
    const checks = result.data.checks as { name: string; result: string }[];
    expect(checks.find((c) => c.name === "full suite: pytest")?.result).toBe("not_run");
    expect((result.data.not_proven as string[]).some((n) => n.includes("full suite: pytest"))).toBe(true);
  });

  test("no detected runner is N/A (FC-SEAL-NA-AS-UNPROVEN), listed not hidden", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    expect((result.data.not_proven as string[])).not.toContain("full suite (no test runner detected)"); // FC-SEAL-NA-AS-UNPROVEN: no runner at all is N/A, listed
    expect((result.data.not_applicable as string[])).toContain("full suite (no test runner detected)");
  });
});

describe("engine10 deep: push (Rule of Two and the comment argv contract-gap fix)", () => {
  test("with no pinned origin, nothing is pushed", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await runDeep(ctx, sig(), baseOpts());
    expect((result.data.not_proven as string[])).toContain("push refused: no pinned origin (Rule of Two)");
  });

  test("posts comment(pr-number, body-file) -- NOT pushArgv's comment shape -- and status(sha, state, description)", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const logPath = join(dir, "push-calls.log");
    const { ctx } = fakeCtx({
      repoDir: dir, baseSha: base,
      outputs: { pr: { pr_url: "https://github.com/octocat/hello/pull/42" } },
    });
    const result = await runDeep(ctx, sig(), baseOpts({ pushExtraEnv: { LOG_PATH: logPath } }));
    expect(result.status).toBe("completed");
    const log = readFileSync(logPath, "utf8");
    const calls = log.split("\n").filter((l) => l.startsWith("CALL "));
    // comment: exactly 2 args after the mode, the second (pr-number) is digits,
    // not the 3-arg {runId, prUrl, file} shape types.ts's pushArgv would build.
    const commentCall = calls.find((l) => l.startsWith("CALL mode=comment"));
    expect(commentCall).toBeDefined();
    const commentArgs = commentCall!.replace("CALL mode=comment args=", "").trim().split(" ");
    expect(commentArgs.length).toBe(2);
    expect(commentArgs[0]).toBe("42");
    // status: sha state description (pushArgv's real shape, unchanged)
    const statusCall = calls.find((l) => l.startsWith("CALL mode=status"));
    expect(statusCall).toBeDefined();
    expect(statusCall).toMatch(/args=[0-9a-f]{40} success/);
    expect(log).toMatch(/ENV pinned=1 origin=https:\/\/github\.com\/octocat\/hello\.git/);
  });

  test("no PR number leaves the comment NOT PROVEN but still sets status", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const logPath = join(dir, "push-calls.log");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base });
    const result = await runDeep(ctx, sig(), baseOpts({ pushExtraEnv: { LOG_PATH: logPath } }));
    expect((result.data.not_proven as string[])).toContain("deep comment not posted (no PR number)");
    const log = readFileSync(logPath, "utf8");
    expect(log).toMatch(/CALL mode=status/);
  });
});

describe("engine10 deep: receipt addendum", () => {
  test("writes a natively signed addendum referencing the base receipt hash", async () => {
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null, outputs: { seal: { receipt_sha256: "ab".repeat(32) } } });
    const result = await runDeep(ctx, sig(), baseOpts());
    const addendum = JSON.parse(readFileSync(join(ctx.runDir, "receipt-addendum-1.json"), "utf8"));
    expect(addendum.base_receipt_sha256).toBe("ab".repeat(32));
    expect(addendum.addendum_sha256).toBe(result.data.addendum_sha256);
    expect(typeof addendum.verification.jwt).toBe("string");
    expect(addendum.verification.kid).toBeTruthy();
  });
});

describe("engine10 deep: stage export", () => {
  test("deepStage.run delegates to runDeep with the right name and budgets", async () => {
    expect(deepStage.name).toBe("deep");
    expect(deepStage.limitS).toBe(2700);
    const { dir, base } = mkRepo();
    commitChange(dir, "a.txt", "hi\n");
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await deepStage.run(ctx, sig());
    expect(result.status).toBe("completed");
  });

  test("TEN-GATES-06: the registry-loaded stage runs the real app probe and secure scan defaults", async () => {
    const { REGISTRY } = await import("../../src/engine10/registry.ts");
    const mod = await REGISTRY["./stages/deep.ts"]!();
    const { dir, base } = mkRepo();
    commitChange(dir, "database.rules.json", OPEN_RULES);
    const { ctx } = fakeCtx({ repoDir: dir, baseSha: base, pinnedOrigin: null });
    const result = await (mod["stage"] as typeof deepStage).run(ctx, sig());
    const checks = result.data.checks as Chk[];
    expect(checks.some((c) => c.name === "app boot")).toBe(false); // FC-SEAL-NA-AS-UNPROVEN: a rules file is no runnable app: N/A, from the real util/app_probe.ts (not the old discoverProjectGraph stub)
    expect((result.data.not_applicable as string[]).some((n) => n.startsWith("app boot ("))).toBe(true);
    expect((result.data.not_proven as string[]).some((n) => n.includes("app boot"))).toBe(false);
    expect(checks.find((c) => c.name === "security scan")?.reason).toMatch(/world-open-datastore: database\.rules\.json:3/);
  });
});
