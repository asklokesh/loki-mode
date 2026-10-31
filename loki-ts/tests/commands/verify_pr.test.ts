import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainLines, defaultCheckout, defaultIssue, defaultPrMeta, defaultPackageSuites, defaultSandbox, parsePrRef, runnerConfigChanged, runVerifyPr, type PrMeta, type VerifyPrDeps } from "../../src/commands/verify_pr.ts";
import { extractChecks, judgeF2p, reportedCheck, reportShowsPass, REPORT_TOKEN, type SandboxResult } from "../../src/contrib/verify_pr_f2p.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vpr2-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

const ISSUE = "Fix add()\n\n## Acceptance criteria\n- add(1,2) is 3\n\nCheck: `bun test t.test.ts`\n";

/** A local repo: main has a buggy add and t.test.ts; branch pr either fixes it, deletes t.test.ts, or changes nothing. */
function fixture(kind: "fix" | "delete-test" | "noop" | "already-passing"): { url: string; meta: PrMeta } {
  const repo = join(dir, `src-${kind}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  const addTs = (n: number): string => `export const add = (_a: number, _b: number) => ${n};\n`;
  writeFileSync(join(repo, "add.ts"), addTs(kind === "already-passing" ? 3 : 4));
  writeFileSync(join(repo, "t.test.ts"), 'import { test, expect } from "bun:test";\nimport { add } from "./add.ts";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n');
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-qb", "pr");
  if (kind === "fix") writeFileSync(join(repo, "add.ts"), addTs(3));
  if (kind === "delete-test") { rmSync(join(repo, "t.test.ts")); writeFileSync(join(repo, "add.ts"), addTs(3)); }
  if (kind === "noop") writeFileSync(join(repo, "README"), "x\n");
  if (kind === "already-passing") writeFileSync(join(repo, "README"), "x\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "pr");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/pull/7/head", head);
  return { url: repo, meta: { baseSha: base, headSha: head, cloneUrl: repo, issueRefs: ["o/r#1"] } };
}

/** Trusted-fixture stand-in for the sandbox: runs the check on the host in the given dir. The real adapter is tested separately. */
let reportSeq = 0;
const hostSandbox = (d: string, cmd: string) => {
  const rep = join(dir, `report-${reportSeq++}`);
  const r = spawnSync("sh", ["-c", `{ ${cmd.split(REPORT_TOKEN).join(rep)}\n} 2>&1`], { cwd: d, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  return { status: "COMPLETED" as const, exit_code: r.status, output: r.stdout, report: existsSync(rep) ? readFileSync(rep, "utf8") : undefined };
};

const TRUSTED = { author: "maint", authorAssociation: "MEMBER", updatedAt: "2026-10-01T00:00:00Z", repo: "o/r" };
const noSuites = () => ({ suites: [] as string[], removed: [] as string[] });

function run(meta: PrMeta, over: Partial<VerifyPrDeps> = {}, issueBody = ISSUE, extra: string[] = []) {
  const out: string[] = [], err: string[] = [];
  const outDir = join(dir, "out");
  const p = runVerifyPr(["o/r#7", "--out", outDir, ...extra], {
    env: { LOKI_VERIFY_PR: "1" }, out: (s) => void out.push(s), err: (s) => void err.push(s),
    prMeta: () => meta, issue: () => ({ body: issueBody, ...TRUSTED }), sandbox: hostSandbox, packageSuites: noSuites, ...over,
  });
  return p.then((rc) => ({ rc, out: out.join(""), err: err.join(""), json: JSON.parse(readFileSync(join(outDir, "verify-pr-result.json"), "utf8")) }));
}

describe("loki verify-pr", () => {
  test("parsePrRef accepts url and owner/repo#N, refuses the rest", () => {
    expect(parsePrRef("https://github.com/o/r/pull/7")).toEqual({ repo: "o/r", number: 7 });
    expect(parsePrRef("o/r#7")).toEqual({ repo: "o/r", number: 7 });
    expect(parsePrRef("http://evil/o/r/pull/7")).toBeNull();
    expect(parsePrRef("o/r#7; rm")).toBeNull();
    expect(parsePrRef("../..#1")).toBeNull();
    expect(parsePrRef("-x/y#1")).toBeNull();
    expect(parsePrRef("o/-r#1")).toBeNull();
    expect(parsePrRef("o/a..b#1")).toBeNull();
    expect(parsePrRef("a..b/r#1")).toBeNull();
    expect(parsePrRef("https://github.com/../r/pull/1")).toBeNull();
  });

  test("extractChecks reads the issue only: Check lines and loki-check fences", () => {
    expect(extractChecks("Check: `a b`\n```loki-check\nc\n```\n```sh\nnot me\n```\n")).toEqual(["a b", "c"]);
  });

  test("a real fix is VERIFIED (red on base, green on head)", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout });
    expect(r.rc).toBe(0);
    expect(r.json.verdict).toBe("VERIFIED");
  });

  test("mutation guard: base and head swapped would not verify", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: (a, m, w) => { const c = defaultCheckout(a, m, w); return { ...c, baseDir: c.headDir, headDir: c.baseDir }; } });
    expect(r.rc).toBe(4);
    expect(r.json.verdict).toBe("NOT PROVEN");
  });

  test("a PR that deletes the failing test is NOT PROVEN (test removed)", async () => {
    const f = fixture("delete-test");
    const r = await run(f.meta, { checkout: defaultCheckout });
    expect(r.rc).toBe(4);
    expect(r.json.reasons.join(" ")).toContain("test removed");
  });

  test("a check that already passes on base is NOT PROVEN (does not discriminate)", async () => {
    const f = fixture("already-passing");
    const r = await run(f.meta, { checkout: defaultCheckout });
    expect(r.rc).toBe(4);
    expect(r.json.reasons.join(" ")).toContain("does not discriminate");
  });

  test("a PR that does not fix the bug is NOT PROVEN", async () => {
    const f = fixture("noop");
    const r = await run(f.meta, { checkout: defaultCheckout });
    expect(r.json.verdict).toBe("NOT PROVEN");
    expect(r.json.reasons.join(" ")).toContain("still fails on head");
  });

  test("no linked issue is NOT PROVEN, never VERIFIED", async () => {
    const f = fixture("fix");
    const r = await run({ ...f.meta, issueRefs: [] }, { checkout: defaultCheckout });
    expect(r.rc).toBe(3);
    expect(r.json.reasons[0]).toContain("no linked issue");
  });

  test("no receipt exit code: missing proof is 3, failed proof stays 4, both say which", async () => {
    const f = fixture("fix");
    const none = await run({ ...f.meta, issueRefs: [] }, { checkout: defaultCheckout });
    expect(none.rc).toBe(3);
    expect(none.out).toContain("no proof:");
    expect(none.json.noProof).toBe(true);
    const nocheck = await run(f.meta, { checkout: defaultCheckout }, "Fix add()\n- add works\n");
    expect(nocheck.rc).toBe(3);
    const untrusted = await run(f.meta, { checkout: defaultCheckout, issue: () => ({ body: ISSUE, ...TRUSTED, authorAssociation: "NONE" }) });
    expect(untrusted.rc).toBe(3);
    const noop = fixture("noop");
    const failed = await run(noop.meta, { checkout: defaultCheckout });
    expect(failed.rc).toBe(4);
    expect(failed.out).not.toContain("no proof:");
    expect(failed.json.noProof).toBeUndefined();
  });

  test("an issue with no runnable check is NOT PROVEN", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout }, "Fix add()\n- add works\n");
    expect(r.json.verdict).toBe("NOT PROVEN");
  });

  test("a forged 'tests pass' in the PR body is ignored: only the issue is read", async () => {
    const f = fixture("noop");
    let asked: string[] = [];
    const r = await run({ ...f.meta, issueRefs: ["o/r#1"] }, { checkout: defaultCheckout, issue: (ref) => { asked.push(ref); return { body: ISSUE, ...TRUSTED }; } });
    expect(asked).toEqual(["o/r#1"]);
    expect(r.json.verdict).toBe("NOT PROVEN");
  });

  test("a check from an untrusted issue is NOT PROVEN, and the issue is recorded", async () => {
    const f = fixture("fix");
    for (const bad of [{ authorAssociation: "NONE" }, { authorAssociation: "CONTRIBUTOR" }, { authorAssociation: undefined }, { repo: "evil/r" }]) {
      const r = await run(f.meta, { checkout: defaultCheckout, issue: () => ({ body: ISSUE, ...TRUSTED, ...bad }) });
      expect(r.json.verdict).toBe("NOT PROVEN");
      expect(r.json.reasons.join(" ")).toContain("check from an untrusted issue");
    }
    const ok = await run(f.meta, { checkout: defaultCheckout });
    expect(ok.json.verdict).toBe("VERIFIED");
    expect(ok.json.issues).toEqual([{ ref: "o/r#1", author: "maint", association: "MEMBER", updatedAt: "2026-10-01T00:00:00Z", trusted: true }]);
  });

  test("a failed trust lookup says so, distinct from an untrusted association", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout, issue: () => ({ body: ISSUE, repo: "o/r", lookupFailed: true }) });
    expect(r.json.verdict).toBe("NOT PROVEN");
    expect(r.json.reasons.join(" ")).toContain("trust lookup failed");
    expect(r.json.reasons.join(" ")).not.toContain("untrusted issue");
  });

  test("defaultIssue reads the association through a gh that rejects unknown --json fields", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh
if [ "$1" = issue ] && [ "$2" = view ]; then
  for a in "$@"; do case "$a" in *authorAssociation*) echo 'Unknown JSON field: "authorAssociation"' >&2; exit 1;; esac; done
  echo '{}'; exit 0
fi
if [ "$1" = api ] && [ "$2" = repos/o/r/issues/1 ] && [ "$3" = --jq ]; then
  [ -n "$FAKE_GH_FAIL" ] && { echo 'HTTP 404' >&2; exit 1; }
  echo '{"a":"MEMBER","u":"maint","t":"2026-10-01T00:00:00Z"}'; exit 0
fi
echo "unexpected: $*" >&2; exit 2
`);
    chmodSync(join(bin, "gh"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"]}` };
    const fetch = () => ({ body: ISSUE });
    expect(defaultIssue("o/r#1", env, fetch)).toEqual({ body: ISSUE, repo: "o/r", author: "maint", authorAssociation: "MEMBER", updatedAt: "2026-10-01T00:00:00Z" });
    const bad = defaultIssue("o/r#1", { ...env, FAKE_GH_FAIL: "1" }, fetch);
    expect(bad.lookupFailed).toBe(true);
    expect(bad.authorAssociation).toBeUndefined();
  });

  test("gh timeout: a stalled gh throws within the bound instead of hanging", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "gh"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, LOKI_VPR_GH_TIMEOUT_MS: "300" };
    const t0 = Date.now();
    expect(() => defaultPrMeta({ repo: "o/r", number: 1 }, env)).toThrow();
    expect(Date.now() - t0).toBeLessThan(10_000);
    const i = defaultIssue("o/r#1", env, () => ({ body: ISSUE }));
    expect(i.lookupFailed).toBe(true);
  });

  test("OWNER, MEMBER and COLLABORATOR are trusted; repo match ignores case", async () => {
    const f = fixture("fix");
    for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      const r = await run(f.meta, { checkout: defaultCheckout, issue: () => ({ body: ISSUE, ...TRUSTED, authorAssociation: a, repo: "O/R" }) });
      expect(r.json.verdict).toBe("VERIFIED");
    }
  });

  test("a package test script removed by the PR is NOT PROVEN", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout, packageSuites: () => ({ suites: [], removed: ["pkg"] }) });
    expect(r.json.verdict).toBe("NOT PROVEN");
    expect(r.json.reasons.join(" ")).toContain("package test script removed");
  });

  test("no package suites is recorded as a note, not silent", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout });
    expect(r.json.notes).toContain("no package suites found");
  });

  test("defaultPackageSuites compares base and head and escapes the cd path", () => {
    const mk = (root: string, files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), c); } };
    const b = join(dir, "b"), h = join(dir, "h");
    mk(b, { "pkg/package.json": '{"scripts":{"test":"exit 1"}}', "pkg/a.txt": "x", "ok/package.json": '{"scripts":{"test":"true"}}', "ok/a.txt": "x", "p$(id)/package.json": '{"scripts":{"test":"true"}}', "p$(id)/a.txt": "x" });
    mk(h, { "pkg/package.json": '{"scripts":{}}', "pkg/a.txt": "y", "ok/package.json": '{"scripts":{"test":"true"}}', "ok/a.txt": "y", "p$(id)/package.json": '{"scripts":{"test":"true"}}', "p$(id)/a.txt": "y" });
    const r = defaultPackageSuites(b, h, ["pkg/a.txt", "ok/a.txt", "p$(id)/a.txt"]);
    expect(r.removed).toEqual(["pkg"]);
    expect(r.suites).toContain("cd 'ok' && npm test --silent");
    expect(r.suites).toContain("cd 'p$(id)' && npm test --silent");
    expect(r.suites.some((s) => s.includes('"'))).toBe(false);
    expect(defaultPackageSuites(b, h, ["zzz.txt"])).toEqual({ suites: [], removed: [] });
  });

  test("a failing package suite blocks VERIFIED", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout, packageSuites: () => ({ suites: ["exit 1"], removed: [] }) });
    expect(r.json.verdict).toBe("NOT PROVEN");
    expect(r.json.reasons.join(" ")).toContain("package suite");
  });

  test("sandbox BLOCKED is NOT PROVEN with exit 2, not a failing verdict", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout, sandbox: () => ({ status: "BLOCKED", exit_code: null, detail: "daemon down" }) });
    expect(r.rc).toBe(2);
    expect(r.json.blocked).toBe(true);
  });

  test("json stdout: --json prints the verdict object, exit codes unchanged", async () => {
    const fx = fixture("fix").meta;
    const ok = await run(fx, { checkout: defaultCheckout }, ISSUE, ["--json"]);
    expect(ok.rc).toBe(0);
    expect(JSON.parse(ok.out)).toEqual(ok.json);
    expect(ok.out).not.toContain("verdict: ");
    const np = await run(fixture("noop").meta, { checkout: defaultCheckout }, ISSUE, ["--json"]);
    expect(np.rc).toBe(4);
    expect(JSON.parse(np.out).verdict).toBe("NOT PROVEN");
    const bl = await run(fx, { checkout: defaultCheckout, sandbox: () => ({ status: "BLOCKED", exit_code: null }) }, ISSUE, ["--json"]);
    expect(bl.rc).toBe(2);
    expect(JSON.parse(bl.out).blocked).toBe(true);
    const plain = await run(fx, { checkout: defaultCheckout });
    expect(plain.out).toContain("verdict: VERIFIED");
  });

  test("json stdout: through bin/loki the flag is not a usage error", () => {
    const r = spawnSync(join(__dirname, "../../../bin/loki"), ["verify-pr", "--json", "nope"], { encoding: "utf8", env: { ...process.env, LOKI_VERIFY_PR: "1" } });
    expect(r.stderr).toContain("not a PR url");
    expect(r.status).toBe(2);
  });

  test("out needs a value: a dash-led or missing --out is a usage error and creates nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "loki-vpr-out-"));
    try {
      for (const argv of [["o/r#7", "--out", "--json"], ["o/r#7", "--out", "-x"], ["o/r#7", "--out"]]) {
        const errs: string[] = [];
        expect(await runVerifyPr(argv, { env: { LOKI_VERIFY_PR: "1" }, err: (s) => void errs.push(s) })).toBe(2);
        expect(errs.join("")).toContain("Usage: loki verify-pr");
      }
      const r = spawnSync(join(__dirname, "../../../bin/loki"), ["verify-pr", "o/r#7", "--out", "--json"], { encoding: "utf8", cwd, env: { ...process.env, LOKI_VERIFY_PR: "1" } });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Usage: loki verify-pr");
      expect(existsSync(join(cwd, "--json"))).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("off by default and bad refs exit 2", async () => {
    expect(await runVerifyPr(["o/r#1"], { env: {}, err: () => {} })).toBe(2);
    expect(await runVerifyPr(["nope"], { env: { LOKI_VERIFY_PR: "1" }, err: () => {} })).toBe(2);
  });

  test("the default sandbox goes through verify-pr-sandbox.sh: network none, token-free", () => {
    const fake = join(dir, "fake-docker");
    const log = join(dir, "argv.log");
    writeFileSync(fake, `#!/usr/bin/env bash\ncase "$1" in info|image) exit 0;; run) printf '%s\\n' "$@" >"${log}"; env >"${log}.env"; read -r N; printf 'LOKI_VPR_END %s 0\\n' "$N";; esac\n`);
    chmodSync(fake, 0o755);
    const repo = join(dir, "repo"); mkdirSync(repo); writeFileSync(join(repo, "a"), "x");
    const res = defaultSandbox(repo, "true", { LOKI_VPR_IMAGE: "img", LOKI_VPR_DOCKER: fake, GH_TOKEN: "secret", PATH: process.env["PATH"] });
    expect(res).toMatchObject({ status: "COMPLETED", exit_code: 0 });
    const argv = readFileSync(log, "utf8").split("\n");
    expect(argv).toContain("--network");
    expect(argv).toContain("none");
    expect(readFileSync(`${log}.env`, "utf8")).not.toContain("secret");
  });

  test("the default sandbox passes a fresh in-sandbox report path and returns the report file", () => {
    const fake = join(dir, "fake-docker-report");
    const log = join(dir, "argv-report.log");
    writeFileSync(fake, `#!/usr/bin/env bash\ncase "$1" in info|image) exit 0;; run) printf '%s\\n' "$@" >"${log}"; read -r N; printf 'LOKI_VPR_REPORT %s\\n<testsuites>r</testsuites>\\nLOKI_VPR_REPORT_END %s\\nLOKI_VPR_END %s 0\\n' "$N" "$N" "$N";; esac\n`);
    chmodSync(fake, 0o755);
    const repo = join(dir, "repo-r"); mkdirSync(repo); writeFileSync(join(repo, "a"), "x");
    const env = { LOKI_VPR_IMAGE: "img", LOKI_VPR_DOCKER: fake, PATH: process.env["PATH"] };
    const res = defaultSandbox(repo, `bun test --reporter-outfile=${REPORT_TOKEN}`, env);
    expect(res.report?.trim()).toBe("<testsuites>r</testsuites>");
    const argv = readFileSync(log, "utf8");
    const paths = [...argv.matchAll(/\/work\/\.loki-vpr-[0-9a-f]{32}/g)].map((m) => m[0]);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(new Set(paths).size).toBe(1);
    expect(argv).not.toContain(REPORT_TOKEN);
  });

  test("the default sandbox is BLOCKED without an image", () => {
    expect(defaultSandbox(dir, "true", {}).status).toBe("BLOCKED");
  });

  // R100-005: /loki explain and /loki reseal PR comment handlers.
  test("explain prints the clause matrix for a VERIFIED PR in at most 60 lines", async () => {
    const f = fixture("fix");
    const e = await runExplain(f.meta);
    expect(e.rc).toBe(0);
    expect(e.out).toContain("verdict: VERIFIED");
    expect(e.out).toContain("bun test t.test.ts");
    expect(e.out.trimEnd().split("\n").length).toBeLessThanOrEqual(60);
  });

  test("explain caps a huge result at 60 lines and says what was cut", () => {
    const res = { verdict: "NOT PROVEN" as const, reasons: Array.from({ length: 200 }, (_, i) => `reason ${i}`), pr: { repo: "o/r", number: 7 }, base: "a", head: "b",
      checks: Array.from({ length: 200 }, (_, i) => `check ${i}`), criteria: 200, blocked: false, issues: [], notes: [] };
    const lines = explainLines(res);
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines[lines.length - 1]).toMatch(/more line\(s\) cut/);
  });

  test("reseal writes the loki/receipt status: success for VERIFIED, failure for NOT PROVEN, error for blocked", async () => {
    const st = (outDir: string) => JSON.parse(readFileSync(join(outDir, "loki-receipt-status.json"), "utf8"));
    const fx = fixture("fix").meta;
    const ok = await runReseal(fx, {});
    expect(ok.rc).toBe(0);
    expect(st(ok.outDir)).toMatchObject({ context: "loki/receipt", state: "success", sha: fx.headSha });
    const np = await runReseal(fixture("noop").meta, {});
    expect(np.rc).toBe(4);
    expect(st(np.outDir).state).toBe("failure");
    const bl = await runReseal(fx, { sandbox: () => ({ status: "BLOCKED", exit_code: null }) });
    expect(bl.rc).toBe(2);
    expect(st(bl.outDir).state).toBe("error");
    expect(st(bl.outDir).description.length).toBeLessThanOrEqual(140);
  });

  test("explain and reseal are off without LOKI_VERIFY_PR and refuse bad refs", async () => {
    for (const verb of ["explain", "reseal"]) {
      const err: string[] = [];
      expect(await runVerifyPr([verb, "o/r#7"], { env: {}, err: (s) => void err.push(s) })).toBe(2);
      expect(err.join("")).toContain("LOKI_VERIFY_PR=1");
      expect(await runVerifyPr([verb, "nonsense"], { env: { LOKI_VERIFY_PR: "1" }, err: () => {} })).toBe(2);
    }
  });
});

const handlerDeps = (meta: PrMeta, over: Partial<VerifyPrDeps>, out: string[]): Partial<VerifyPrDeps> => ({
  env: { LOKI_VERIFY_PR: "1" }, out: (s) => void out.push(s), err: () => {}, prMeta: () => meta, issue: () => ({ body: ISSUE, ...TRUSTED }),
  checkout: defaultCheckout, sandbox: hostSandbox, packageSuites: noSuites, ...over,
});
async function runExplain(meta: PrMeta) {
  const out: string[] = [];
  const rc = await runVerifyPr(["explain", "o/r#7", "--out", join(dir, "ex")], handlerDeps(meta, {}, out));
  return { rc, out: out.join("") };
}
async function runReseal(meta: PrMeta, over: Partial<VerifyPrDeps>) {
  const out: string[] = [];
  const outDir = mkdtempSync(join(dir, "rs-"));
  const rc = await runVerifyPr(["reseal", "o/r#7", "--out", outDir], handlerDeps(meta, over, out));
  return { rc, out: out.join(""), outDir };
}

/** A local repo with `base` files on main and `pr` files layered on the branch; checks use the real bun and pytest on the host. */
function repoWith(name: string, base: Record<string, string>, pr: Record<string, string>): PrMeta {
  const repo = join(dir, `src-${name}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(base)) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); }
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-qb", "pr");
  for (const [f, c] of Object.entries(pr)) writeFileSync(join(repo, f), c);
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "pr");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/pull/7/head", head);
  return { baseSha, headSha: head, cloneUrl: repo, issueRefs: ["o/r#1"] };
}

const issueFor = (cmd: string): string => `Fix add()\n\n## Acceptance criteria\n- add(1,2) is 3\n\nCheck: \`${cmd}\`\n`;
const BUN_FILES = {
  "add.ts": "export const add = (a: number, b: number) => a + b + 1;\n",
  "add.test.ts": 'import { test, expect } from "bun:test";\nimport { add } from "./add.ts";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n',
};
const BUN_FIXED = "export const add = (a: number, b: number) => a + b;\n";
const PY_FILES = { "add.py": "def add(a, b):\n    return a + b + 1\n", "test_add.py": "from add import add\n\ndef test_add():\n    assert add(1, 2) == 3\n" };
const PY_FIXED = "def add(a, b):\n    return a + b\n";
const BUN_CHECK = "bun test add.test.ts";
const PY_CHECK = "python3 -m pytest -q -p no:cacheprovider test_add.py";

describe("verify-pr: an exit code alone is not proof", () => {
  test("a correct bun fix and a correct pytest fix are still VERIFIED", async () => {
    const b = await run(repoWith("bun-ok", BUN_FILES, { "add.ts": BUN_FIXED }), { checkout: defaultCheckout }, issueFor(BUN_CHECK));
    expect([b.rc, b.json.verdict]).toEqual([0, "VERIFIED"]);
    const p = await run(repoWith("py-ok", PY_FILES, { "add.py": PY_FIXED }), { checkout: defaultCheckout }, issueFor(PY_CHECK));
    expect([p.rc, p.json.verdict]).toEqual([0, "VERIFIED"]);
  }, 60_000);

  test("a bunfig preload that exits 0 after the run is NOT PROVEN (exit 4) naming bunfig.toml", async () => {
    const meta = repoWith("bunfig", BUN_FILES, {
      "bunfig.toml": '[test]\npreload = ["./pre.ts"]\n',
      "pre.ts": 'import { afterAll } from "bun:test";\nafterAll(() => process.exit(0));\n',
    });
    const r = await run(meta, { checkout: defaultCheckout }, issueFor(BUN_CHECK));
    expect(r.rc).toBe(4);
    expect(r.json.verdict).toBe("NOT PROVEN");
    expect(r.json.reasons.join(" ")).toContain("bunfig.toml");
  }, 60_000);

  test("a conftest.py that calls os._exit(0) is NOT PROVEN (exit 4) naming conftest.py", async () => {
    const meta = repoWith("conftest", PY_FILES, { "conftest.py": "import os\n\ndef pytest_sessionfinish(session, exitstatus):\n    os._exit(0)\n" });
    const r = await run(meta, { checkout: defaultCheckout }, issueFor(PY_CHECK));
    expect(r.rc).toBe(4);
    expect(r.json.verdict).toBe("NOT PROVEN");
    expect(r.json.reasons.join(" ")).toContain("conftest.py");
  }, 60_000);

  test("a preload already on base that the PR rewrites to exit 0 is runner config, though bunfig.toml stays", async () => {
    const base = { ...BUN_FILES, "bunfig.toml": '[test]\npreload = ["./pre.ts"]\n', "pre.ts": "export {};\n" };
    const meta = repoWith("preload-rewrite", base, { "pre.ts": 'import { afterAll } from "bun:test";\nafterAll(() => process.exit(0));\n' });
    const r = await run(meta, { checkout: defaultCheckout }, issueFor(BUN_CHECK));
    expect(r.rc).toBe(4);
    expect(r.json.reasons.join(" ")).toMatch(/runner config.*pre\.ts/);
  }, 60_000);

  test("printed totals are never read: a test that prints fake totals and exits 0 is NOT PROVEN", async () => {
    const forged = 'console.log("(pass) add\\n 1 pass\\n 0 fail");\nprocess.exit(0);\n';
    const r = await run(repoWith("fake-totals", BUN_FILES, { "add.test.ts": forged }), { checkout: defaultCheckout }, issueFor(BUN_CHECK));
    expect(r.rc).toBe(4);
    expect(r.json.reasons.join(" ")).toContain("without a runner report");
  }, 60_000);

  test("a Check with no recognised runner is NOT PROVEN and the reason names the recognised runners", async () => {
    const r = await run(fixture("fix").meta, { checkout: defaultCheckout }, issueFor("sh t.sh"));
    expect(r.rc).toBe(4);
    const why = r.json.reasons.join(" ");
    for (const w of ["bun", "pytest", "jest", "vitest", "report file"]) expect(why).toContain(w);
  });

  test("reportedCheck rewrites recognised runners and refuses go, cargo and unknown commands with a reason", () => {
    expect(reportedCheck("cd a && bun test x.test.ts")).toEqual({ cmd: `cd a && bun test --reporter=junit --reporter-outfile=${REPORT_TOKEN} x.test.ts` });
    expect(reportedCheck("python3 -m pytest -q t.py")).toEqual({ cmd: `python3 -m pytest --junitxml=${REPORT_TOKEN} -q t.py` });
    expect(reportedCheck("npx jest a")).toEqual({ cmd: `npx jest --json --outputFile=${REPORT_TOKEN} a` });
    expect(reportedCheck("npx vitest run")).toEqual({ cmd: `npx vitest --reporter=junit --outputFile=${REPORT_TOKEN} run` });
    for (const c of ["go test ./...", "cargo test", "sh t.sh", "node t.js"]) expect(reportedCheck(c)).toHaveProperty("reason");
    expect((reportedCheck("cargo test") as { reason: string }).reason).toContain("no stable report file");
  });

  test("reportShowsPass reads only a runner report: passes need a test case and no failure, error or missing report", () => {
    const ok = '<testsuites tests="1" failures="0"><testsuite tests="1" errors="0" failures="0"><testcase name="a"/></testsuite></testsuites>';
    expect(reportShowsPass(ok)).toBe(true);
    expect(reportShowsPass(undefined)).toBe(false);
    expect(reportShowsPass("")).toBe(false);
    expect(reportShowsPass("1 pass\n0 fail")).toBe(false);
    expect(reportShowsPass('<testsuites tests="0"></testsuites>')).toBe(false);
    expect(reportShowsPass('<testsuites><testsuite><testcase name="a"><failure/></testcase></testsuite></testsuites>')).toBe(false);
    expect(reportShowsPass('<testsuites><testsuite errors="1"><testcase name="a"/></testsuite></testsuites>')).toBe(false);
    expect(reportShowsPass('<testsuites><testsuite><testcase name="a"><skipped/></testcase></testsuite></testsuites>')).toBe(false);
    expect(reportShowsPass('{"success":true,"numFailedTests":0,"numPassedTests":2}')).toBe(true);
    expect(reportShowsPass('{"success":true,"numFailedTests":0,"numPassedTests":0}')).toBe(false);
    expect(reportShowsPass('{"success":false,"numFailedTests":1,"numPassedTests":1}')).toBe(false);
    expect(reportShowsPass("{not json")).toBe(false);
  });

  test("judgeF2p: exit 0 with no report showing a pass is not a pass", () => {
    const base = { status: "COMPLETED" as const, exit_code: 1 };
    const head = (report: string | undefined, output = "(pass) a\n 1 pass\n 0 fail\n") => ({ status: "COMPLETED" as const, exit_code: 0, output, report });
    expect(judgeF2p("c", base, head(undefined)).ok).toBe(false);
    expect(judgeF2p("c", base, head('<testsuites><testsuite><testcase name="a"/></testsuite></testsuites>')).ok).toBe(true);
  });

  test("runnerConfigChanged flags runner files and test-runner sections, not unrelated config", () => {
    writeFileSync(join(dir, "setup.cfg"), "[tool:x_test]\naddopts = -q\n");
    writeFileSync(join(dir, "runner.ini"), "[runner_test]\nk = 1\n");
    writeFileSync(join(dir, "plain.toml"), "[project]\nname = 'x'\n");
    writeFileSync(join(dir, "bunfig.toml"), "x = 1\n");
    expect(runnerConfigChanged(["setup.cfg", "runner.ini", "plain.toml", "bunfig.toml", "gone/conftest.py", "src/a.ts"], dir)).toEqual(["setup.cfg", "runner.ini", "bunfig.toml", "gone/conftest.py"]);
  });

  test.each([["deleted pytest.ini", { "pytest.ini": null }], ["renamed pytest.ini", { "pytest.ini": null, "pytest.ini.bak": "[pytest]\nfilterwarnings =\n    error\n" }], ["deleted jest.config.js", { "jest.config.js": null }]] as const)("a PR with a %s is NOT PROVEN (exit 4)", async (_n, edits) => {
    const files = { "pytest.ini": "[pytest]\nfilterwarnings =\n    error\n", "jest.config.js": "module.exports = {};\n", "test_w.py": "import warnings\n\ndef test_w():\n    warnings.warn('x', DeprecationWarning)\n" };
    const meta = repoWith(`del-${_n.replace(/\W/g, "")}`, files, { "note.txt": "x\n" });
    const repo = meta.cloneUrl;
    for (const [f, c] of Object.entries(edits)) { if (c === null) git(repo, "rm", "-q", f); else writeFileSync(join(repo, f), c); }
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "edit");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/pull/7/head", head);
    let n = 0;
    const r = await run({ ...meta, headSha: head }, { checkout: defaultCheckout, sandbox: () => (n++ === 0 ? { status: "COMPLETED", exit_code: 1 } : { status: "COMPLETED", exit_code: 0, report: '<testsuites><testsuite><testcase name="a"/></testsuite></testsuites>' }) }, issueFor("python3 -m pytest -q test_w.py"));
    expect(r.rc).toBe(4);
    expect(r.json.reasons.join(" ")).toMatch(/pytest\.ini|jest\.config\.js/);
  }, 30_000);

  const PYC = "[tool:pytest]\naddopts = -q -p plug\n\n[flake8]\nmax-line-length = 100\n";
  const PASS = '<testsuites><testsuite><testcase name="a"/></testsuite></testsuites>';
  const SECTION_FILES = { "setup.cfg": PYC, "package.json": '{"name":"x","main":"add.py","jest":{"testEnvironment":"node","setupFiles":["<rootDir>/jest.setup.js"]}}\n', "pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-q'\n", "add.py": PY_FILES["add.py"], "test_add.py": PY_FILES["test_add.py"], "jest.setup.js": "// setup\n", "vitest.config.ts": 'export default { test: { setupFiles: ["./vsetup.ts"] } };\n', "vsetup.ts": "// setup\n", "plug.py": "# plugin\n", "tsconfig.json": '{"compilerOptions":{"strict":true}}\n' };
  test.each([
    ["setup.cfg [tool:pytest] section removed", { "setup.cfg": "[flake8]\nmax-line-length = 100\n" }, 4, /setup\.cfg/],
    ["package.json jest key removed", { "package.json": '{"name":"x"}\n' }, 4, /package\.json/],
    ["jest.config.json added with a moduleNameMapper stub", { "jest.config.json": '{"moduleNameMapper":{"^./add$":"<rootDir>/fake.js"}}\n' }, 4, /jest\.config\.json/],
    ["pyproject.toml pytest section removed", { "pyproject.toml": "[project]\nname = 'x'\n" }, 4, /pyproject\.toml/],
    ["F1 a jest setupFiles target edited while package.json stays", { "jest.setup.js": "Math.random = () => 0;\n" }, 4, /jest\.setup\.js/],
    ["F1 a vitest setupFiles target edited while the config stays", { "vsetup.ts": "globalThis.x = 1;\n" }, 4, /vsetup\.ts/],
    ["F1 a pytest -p plugin module edited while setup.cfg stays", { "plug.py": "import sys\nsys.exit(0)\n" }, 4, /plug\.py/],
    ["F2 a root __mocks__ module added", { "__mocks__/fs.js": "module.exports = {};\n" }, 4, /__mocks__\/fs\.js/],
    ["F3 babel.config.js added", { "babel.config.js": "module.exports = { plugins: ['./stub'] };\n" }, 4, /babel\.config\.js/],
    ["F3 .babelrc added", { ".babelrc": '{"plugins":["./stub"]}\n' }, 4, /\.babelrc/],
    ["F4 tsconfig.json path mapping added", { "tsconfig.json": '{"compilerOptions":{"paths":{"./add":["./fake"]}}}\n' }, 4, /tsconfig\.json/],
    ["F5 sitecustomize.py added", { "sitecustomize.py": "import builtins\n" }, 4, /sitecustomize\.py/],
    ["F5 a .pth file added", { "stub.pth": "import os\n" }, 4, /stub\.pth/],
    ["F6 .mocharc.yml added", { ".mocharc.yml": "require: ./stub.js\n" }, 4, /\.mocharc\.yml/],
    ["a tsconfig.json edit with no path mapping", { "tsconfig.json": '{"compilerOptions":{"strict":false}}\n' }, 0, /^$/],
    ["only an unrelated setup.cfg section edited", { "setup.cfg": "[flake8]\nmax-line-length = 120\n" }, 0, /^$/],
    ["config kept untouched while the bug is fixed", { "add.py": PY_FIXED }, 0, /^$/],
  ] as const)("a PR with %s", async (_n, edits, rc, reason) => {
    const base = _n.startsWith("only an unrelated") ? { ...SECTION_FILES, "setup.cfg": "[flake8]\nmax-line-length = 100\n" } : SECTION_FILES;
    const meta = repoWith(`sec-${_n.replace(/\W/g, "")}`, base, { "note.txt": "x\n" });
    const repo = meta.cloneUrl;
    for (const [f, c] of Object.entries({ "add.py": PY_FIXED, ...edits })) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); }
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "edit");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/pull/7/head", head);
    let n = 0;
    const r = await run({ ...meta, headSha: head }, { checkout: defaultCheckout, packageSuites: () => ({ suites: [], removed: [] }), sandbox: () => (n++ === 0 ? { status: "COMPLETED", exit_code: 1 } : { status: "COMPLETED", exit_code: 0, report: PASS }) }, issueFor(PY_CHECK));
    expect(r.rc).toBe(rc);
    expect(r.json.reasons.join(" ")).toMatch(reason);
  }, 30_000);

  const HOOK = "import sys\nsys.exit(0)\n";
  const PLUG_REF = { "setup.cfg": "[flake8]\nmax-line-length = 100\n" };
  test.each([
    ["E1 pyproject addopts -p plugin module rewritten", { ...PLUG_REF, "pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"-p plug\"\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["E4 pyproject addopts list plugin module rewritten", { ...PLUG_REF, "pyproject.toml": "[tool.pytest.ini_options]\naddopts = [\"-p\", \"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["E3 conftest pytest_plugins list module rewritten", { ...PLUG_REF, "conftest.py": "pytest_plugins = [\"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["E3 conftest pytest_plugins string module rewritten", { ...PLUG_REF, "conftest.py": "pytest_plugins = \"plug\"\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["F1 pytest_plugins list over 4096 chars, plug last", { ...PLUG_REF, "conftest.py": `pytest_plugins = [${Array.from({ length: 450 }, (_, i) => `"mod${i}"`).join(", ")}, "plug"]\n` }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["F2 pytest_plugins list over 4096 chars, plug first", { ...PLUG_REF, "conftest.py": `pytest_plugins = ["plug", ${Array.from({ length: 450 }, (_, i) => `"mod${i}"`).join(", ")}]\n` }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["F3 pytest_plugins tuple over 4096 chars", { ...PLUG_REF, "conftest.py": `pytest_plugins = (${Array.from({ length: 450 }, (_, i) => `"mod${i}"`).join(", ")}, "plug")\n` }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["F4 pytest_plugins opener followed by a 5000 char comment", { ...PLUG_REF, "conftest.py": `pytest_plugins = [  # ${"c".repeat(5000)}\n  "plug",\n]\n` }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["F5 pytest_plugins annotation over 200 chars", { ...PLUG_REF, "conftest.py": `pytest_plugins: List${" ".repeat(260)} = ["plug"]\n` }, { "plug.py": HOOK }, 4, /conftest\.py/],
    ["F6 pytest_plugins assigned a non-literal", { ...PLUG_REF, "conftest.py": "PLUGINS = ['plug']\npytest_plugins = PLUGINS\n" }, { "plug.py": HOOK }, 4, /conftest\.py \(pytest_plugins is not a closed literal\)/],
    ["F7 pytest_plugins list plus an extra", { ...PLUG_REF, "conftest.py": "pytest_plugins = [] + extra\n" }, { "plug.py": HOOK }, 4, /not a closed literal/],
    ["B1 closer bracket inside a comment in the list", { ...PLUG_REF, "conftest.py": "pytest_plugins = [\"a\",  # ]\n  \"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["B2 closer paren inside a comment in the tuple", { ...PLUG_REF, "conftest.py": "pytest_plugins = (\"a\",  # )\n  \"plug\")\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["B3 pytest_plugins += a list", { ...PLUG_REF, "conftest.py": "pytest_plugins = []\npytest_plugins += [\"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["B4 pytest_plugins.append", { ...PLUG_REF, "conftest.py": "pytest_plugins = []\npytest_plugins.append(\"plug\")\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["B5 pytest_plugins.extend", { ...PLUG_REF, "conftest.py": "pytest_plugins = []\npytest_plugins.extend([\"plug\"])\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["B6 globals() assignment of pytest_plugins", { ...PLUG_REF, "conftest.py": "globals()[\"pytest_plugins\"] = [\"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["B7 pytest_plugins imported from another module", { ...PLUG_REF, "conftest.py": "from x import pytest_plugins\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N1 setattr on the module with a concatenated name", { ...PLUG_REF, "conftest.py": "import sys\nsetattr(sys.modules[__name__], \"pytest_\" + \"plugins\", [\"plug\"])\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N2 exec of a concatenated assignment", { ...PLUG_REF, "conftest.py": "exec(\"pytest_\" \"plugins = ['plug']\")\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N3 globals() with an implicitly concatenated key", { ...PLUG_REF, "conftest.py": "globals()[\"pytest_\" \"plugins\"] = [\"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N4 implicitly concatenated plugin name", { ...PLUG_REF, "conftest.py": "pytest_plugins = [\"pl\" \"ug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N5 escaped plugin name", { ...PLUG_REF, "conftest.py": "pytest_plugins = [\"plu\\x67\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N9 vars() with an implicitly concatenated key", { ...PLUG_REF, "conftest.py": "vars()[\"pytest_\" \"plugins\"] = [\"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N10 __dict__.update with a concatenated key", { ...PLUG_REF, "conftest.py": "import sys\nsys.modules[__name__].__dict__.update({\"pytest_\" \"plugins\": [\"plug\"]})\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N11 fullwidth low line in the name", { ...PLUG_REF, "conftest.py": "pytest＿plugins = [\"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N17 pluginmanager.import_plugin in pytest_configure", { ...PLUG_REF, "conftest.py": "def pytest_configure(config):\n    config.pluginmanager.import_plugin(\"plug\")\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["N18 pluginmanager.register in pytest_configure", { ...PLUG_REF, "conftest.py": "import plug\ndef pytest_configure(config):\n    config.pluginmanager.register(plug)\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R01 locals() key built by implicit concatenation", { ...PLUG_REF, "conftest.py": "locals()[\"pytest_\" \"plugins\"] = [\"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R02 module __setattr__ with a concatenated name", { ...PLUG_REF, "conftest.py": "import sys\nsys.modules[__name__].__setattr__(\"pytest_\" \"plugins\", [\"plug\"])\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R03 getattr(builtins, setattr) on the module", { ...PLUG_REF, "conftest.py": "import sys, builtins\ngetattr(builtins, \"set\" \"attr\")(sys.modules[__name__], \"pytest_\" \"plugins\", [\"plug\"])\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R04 __builtins__ exec with a concatenated name", { ...PLUG_REF, "conftest.py": "__builtins__[\"ex\" \"ec\"](\"pytest_\" \"plugins = ['plug']\")\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R05 getattr(config, pluginmanager).import_plugin", { ...PLUG_REF, "conftest.py": "def pytest_configure(config):\n    getattr(config, \"plugin\" \"manager\").import_plugin(\"plug\")\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R06a star import of the edited module", { ...PLUG_REF, "conftest.py": "from plug import *\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R06b plain import of the edited module", { ...PLUG_REF, "conftest.py": "import plug\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R06c from-import of a name in the edited module", { ...PLUG_REF, "conftest.py": "from plug import x\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R06d relative from-import of the edited module", { ...PLUG_REF, "conftest.py": "from . import plug\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R06e import of a submodule of the edited package", { ...PLUG_REF, "conftest.py": "import plug.sub\n" }, { "plug/sub.py": HOOK }, 4, /plug\/sub\.py/],
    ["R07 fullwidth plugin name, fullwidth module edited", { ...PLUG_REF, "conftest.py": "pytest_plugins = [\"\uff50lug\"]\n" }, { "ｐlug.py": HOOK }, 4, /ｐlug\.py/],
    ["R14 type(sys).__setattr__ on the module", { ...PLUG_REF, "conftest.py": "import sys\ntype(sys).__setattr__(sys.modules[__name__], \"pytest_\" \"plugins\", [\"plug\"])\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R15 the plugin list read through a frame", { ...PLUG_REF, "conftest.py": "import sys\nsys._getframe().f_globals[\"pytest_\" + \"plugins\"] = [\"plug\"]\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["R16 a syntax error in the conftest", { ...PLUG_REF, "conftest.py": "pytest_plugins = [\"plug\"\n" }, { "plug.py": HOOK }, 4, /conftest\.py/],
    ["R17 fullwidth -p module in an ini file", { ...PLUG_REF, "pytest.ini": "[pytest]\naddopts = -p \uff50lug\n" }, { "\uff50lug.py": HOOK }, 4, /pytest\.ini|\uff50lug\.py/],
    ["R18 -p module spliced from adjacent quotes in an ini file", { ...PLUG_REF, "pytest.ini": "[pytest]\naddopts = -p \"pl\"ug\n" }, { "plug.py": HOOK }, 4, /plug\.py/],
    ["L1 conftest with stdlib imports, a regex and a fixture", { ...PLUG_REF, "conftest.py": "import os\nimport re\nimport pytest\n\nPAT = re.compile(\"x\")\n\n@pytest.fixture\ndef f():\n    return os.getcwd()\n" }, {  }, 0, /^$/],
    ["A13 package plugin __init__.py rewritten", { ...PLUG_REF, "pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"-p plug\"\n", "plug.py": null, "plug/__init__.py": "# plugin\n" }, { "plug/__init__.py": HOOK }, 4, /plug\/__init__\.py/],
    ["a referenced plugin left unchanged while the bug is fixed", { ...PLUG_REF, "pyproject.toml": "[tool.pytest.ini_options]\naddopts = [\"-p\", \"plug\"]\n", "conftest.py": "pytest_plugins = [\"plug\"]\n" }, {}, 0, /^$/],
  ] as const)("a PR where %s", async (_n, baseEdits, edits, rc, reason) => {
    const files: Record<string, string> = { ...SECTION_FILES };
    for (const [f, c] of Object.entries(baseEdits)) { if (c === null) delete files[f]; else files[f] = c; }
    const meta = repoWith(`plg-${_n.replace(/\W/g, "").slice(0, 28)}`, files, { "note.txt": "x\n" });
    const repo = meta.cloneUrl;
    for (const [f, c] of Object.entries({ "add.py": PY_FIXED, ...edits })) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); }
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "edit");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/pull/7/head", head);
    let n = 0;
    const r = await run({ ...meta, headSha: head }, { checkout: defaultCheckout, packageSuites: () => ({ suites: [], removed: [] }), sandbox: () => (n++ === 0 ? { status: "COMPLETED", exit_code: 1 } : { status: "COMPLETED", exit_code: 0, report: PASS }) }, issueFor(PY_CHECK));
    expect(r.rc).toBe(rc);
    expect(r.json.reasons.join(" ")).toMatch(reason);
  }, 30_000);

  const WARN_TEST = "import warnings\n\ndef test_w():\n    warnings.warn('x', DeprecationWarning)\n";
  const SELECT_TEST = "def test_bad():\n    assert False\n\ndef check_ok():\n    assert True\n";
  const WARN_CHECK = "python3 -m pytest -q -p no:cacheprovider test_w.py";
  test.each([
    ["G1 setup.cfg [tool:pytest] masked by an added empty pytest.ini", { "setup.cfg": "[tool:pytest]\nfilterwarnings = error\n", "test_w.py": WARN_TEST }, { "pytest.ini": "" }, WARN_CHECK, 4],
    ["G2 dotted-key pytest config removed from pyproject.toml", { "pyproject.toml": "[tool]\npytest.ini_options.filterwarnings = ['error']\n", "test_w.py": WARN_TEST }, { "pyproject.toml": "[tool]\nblack.line-length = 88\n" }, WARN_CHECK, 4],
    ["G3 top-level dotted pytest key added to pyproject.toml", { "pyproject.toml": "[project]\nname = 'x'\n", "test_b.py": SELECT_TEST }, { "pyproject.toml": "tool.pytest.ini_options.python_functions = 'check_*'\n[project]\nname = 'x'\n" }, "python3 -m pytest -q -p no:cacheprovider test_b.py", 4],
    ["G4 inline-table pytest config added under [tool] in pyproject.toml", { "pyproject.toml": "[project]\nname = 'x'\n", "test_b.py": SELECT_TEST }, { "pyproject.toml": "[tool]\npytest = { ini_options = { python_functions = \"check_*\" } }\n[project]\nname = 'x'\n" }, "python3 -m pytest -q -p no:cacheprovider test_b.py", 4],
    ["G5 quoted-key pytest config added to pyproject.toml", { "pyproject.toml": "[project]\nname = 'x'\n", "test_b.py": SELECT_TEST }, { "pyproject.toml": "tool.\"pytest\".ini_options.python_functions = \"check_*\"\n[project]\nname = 'x'\n" }, "python3 -m pytest -q -p no:cacheprovider test_b.py", 4],
    ["a pyproject == pin bump that names pytest", { "pyproject.toml": "[project]\nname = 'x'\ndependencies = [\n  \"pytest==8.0\",\n]\n", "test_w.py": "def test_w():\n    assert False\n" }, { "pyproject.toml": "[project]\nname = 'x'\ndependencies = [\n  \"pytest==8.1\",\n]\n", "test_w.py": "def test_w():\n    assert True\n" }, WARN_CHECK, 0],
    ["a Poetry caret bump of pytest", { "pyproject.toml": "[tool.poetry.group.dev.dependencies]\npytest = \"^7.0\"\n", "test_w.py": "def test_w():\n    assert False\n" }, { "pyproject.toml": "[tool.poetry.group.dev.dependencies]\npytest = \"^8.0\"\n", "test_w.py": "def test_w():\n    assert True\n" }, WARN_CHECK, 0],
    ["a pyproject dependency bump that names pytest", { "pyproject.toml": "[project]\nname = 'x'\ndependencies = [\"pytest>=7\"]\n", "test_w.py": "def test_w():\n    assert False\n" }, { "pyproject.toml": "[project]\nname = 'x'\ndependencies = [\"pytest>=8\"]\n", "test_w.py": "def test_w():\n    assert True\n" }, WARN_CHECK, 0],
  ] as const)("config bypass form: %s", async (_n, base, pr, check, rc) => {
    const meta = repoWith(`byp-${_n.replace(/\W/g, "").slice(0, 24)}`, base, pr);
    const r = await run(meta, { checkout: defaultCheckout }, issueFor(check));
    expect(r.rc).toBe(rc);
    if (rc === 4) expect(r.json.reasons.join(" ")).toMatch(/pytest\.ini|pyproject\.toml/);
  }, 60_000);

  test.each([
    ["pyproject.toml", "-p" + " ".repeat(1 << 20) + ":"],
    ["conftest.py", "pytest_plugins=[".repeat(1 << 16)],
  ])("a 1MB %s built to stall a parser is read in under a second", (name, body) => {
    const d = join(dir, `redos-${name}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), name === "pyproject.toml" ? `[tool.pytest.ini_options]\naddopts = "${body}"\n` : body);
    writeFileSync(join(d, "a.py"), "x = 1\n");
    const t0 = performance.now();
    runnerConfigChanged(["a.py"], d);
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 60_000);

  test("60000 pytest_plugins openers before one closer are NOT PROVEN and scanned in linear time", () => {
    const d = join(dir, "redos-many-openers");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "conftest.py"), "pytest_plugins=[".repeat(60000) + "]\n");
    writeFileSync(join(d, "a.py"), "x = 1\n");
    const t0 = performance.now();
    const r = runnerConfigChanged(["a.py"], d);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.join(" ")).toContain("a.py");
  });

  test("a conftest is NOT PROVEN when python3 cannot be run, never read by a fallback", () => {
    const d = join(dir, "no-python");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "conftest.py"), "pytest_plugins = [\"plug\"]\n");
    writeFileSync(join(d, "other.py"), "x = 1\n");
    const path = process.env.PATH;
    process.env.PATH = join(d, "empty-bin");
    try { expect(runnerConfigChanged(["other.py"], d).join(" ")).toContain("other.py"); } finally { process.env.PATH = path; }
    expect(runnerConfigChanged(["other.py"], d)).toEqual([]);
  });

  test("a 1MB unclosed pytest_plugins list is NOT PROVEN, not clean, and is read in under a second", () => {
    const d = join(dir, "redos-unclosed");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "conftest.py"), "pytest_plugins = [" + "x".repeat(1 << 20));
    writeFileSync(join(d, "a.py"), "x = 1\n");
    const t0 = performance.now();
    const r = runnerConfigChanged(["a.py"], d);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.join(" ")).toContain("a.py");
    expect(r.join(" ")).toContain("conftest.py");
  });

  test("a config path that cannot be read is treated as config, not skipped", () => {
    mkdirSync(join(dir, "unreadable.toml"));
    writeFileSync(join(dir, "unreadable.toml", "x"), "x\n");
    expect(runnerConfigChanged(["unreadable.toml"], dir)).toEqual(["unreadable.toml"]);
  });

  test("a PR that only bumps a git submodule is not flagged as runner config", async () => {
    const files = { "pytest.ini": "[pytest]\nfilterwarnings =\n    error\n", "test_w.py": "def test_w():\n    assert True\n" };
    const meta = repoWith("submodule-bump", files, { "note.txt": "x\n" });
    const repo = meta.cloneUrl;
    const gitlink = (sha: string) => git(repo, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor/lib`);
    gitlink("1".repeat(40)); git(repo, "commit", "-qm", "add submodule");
    gitlink("2".repeat(40)); git(repo, "commit", "-qm", "bump submodule");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/pull/7/head", head);
    const r = await run({ ...meta, headSha: head }, { checkout: defaultCheckout, sandbox: (): SandboxResult => ({ status: "COMPLETED", exit_code: 0 }) }, issueFor("python3 -m pytest -q test_w.py"));
    expect(r.json.reasons.join(" ")).not.toMatch(/vendor\/lib/);
  }, 30_000);

  test("runnerConfigChanged treats a dedicated jest.config.json as config at either side, while package.json is judged by its jest key", () => {
    mkdirSync(join(dir, "head"), { recursive: true }); mkdirSync(join(dir, "base/sub"), { recursive: true });
    writeFileSync(join(dir, "head/jest.config.json"), '{"moduleNameMapper":{"^./add$":"<rootDir>/fake.js"}}');
    writeFileSync(join(dir, "base/sub/jest.config.json"), '{"testMatch":["**/*.test.js"]}');
    writeFileSync(join(dir, "head/package.json"), '{"name":"x","version":"2"}');
    writeFileSync(join(dir, "base/package.json"), '{"name":"x","version":"1"}');
    expect(runnerConfigChanged(["jest.config.json", "sub/jest.config.json", "package.json"], join(dir, "head"), join(dir, "base"))).toEqual(["jest.config.json", "sub/jest.config.json"]);
  });

  test("runnerConfigChanged flags jest, vitest and vite configs and a package.json with a jest key only", () => {
    const names = ["jest.config.js", "sub/vitest.config.ts", "vite.config.mts", "vitest.workspace.ts"];
    for (const n of names) { mkdirSync(join(dir, "sub"), { recursive: true }); writeFileSync(join(dir, n), "export default {};\n"); }
    writeFileSync(join(dir, "package.json"), '{"jest":{"setupFiles":["./x.js"]}}');
    mkdirSync(join(dir, "plain"), { recursive: true });
    writeFileSync(join(dir, "plain/package.json"), '{"name":"x"}');
    expect(runnerConfigChanged([...names, "package.json", "plain/package.json"], dir)).toEqual([...names, "package.json"]);
    mkdirSync(join(dir, "cm"), { recursive: true });
    writeFileSync(join(dir, "cm/package.json"), '{"name":"r","jest":{"testEnvironment":"node","rootDir":"setup","testMatch":["**/decoy.test.js"]} /* c */ }');
    expect(runnerConfigChanged(["cm/package.json"], dir)).toEqual(["cm/package.json"]);
  });

  test.each([["jest.config.js", "npx jest add.test.js", '{"success":true,"numFailedTests":0,"numPassedTests":1}'], ["vitest.config.ts", "npx vitest run add.test.js", '<testsuites><testsuite><testcase name="a"/></testsuite></testsuites>']])("a %s change makes a passing check NOT PROVEN (exit 4) naming the file", async (cfgFile, check, report) => {
    const base = { "add.test.js": "// test\n" };
    const meta = repoWith(`cfg-${cfgFile}`, base, { [cfgFile]: "module.exports = {};\n" });
    let n = 0;
    const r = await run(meta, { checkout: defaultCheckout, sandbox: () => (n++ === 0 ? { status: "COMPLETED", exit_code: 1 } : { status: "COMPLETED", exit_code: 0, report }) }, issueFor(check));
    expect(r.rc).toBe(4);
    expect(r.json.verdict).toBe("NOT PROVEN");
    expect(r.json.reasons.join(" ")).toContain(cfgFile);
  }, 30_000);
});
