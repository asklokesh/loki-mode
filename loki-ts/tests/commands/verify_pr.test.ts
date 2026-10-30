import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainLines, defaultCheckout, defaultIssue, defaultPrMeta, defaultPackageSuites, defaultSandbox, parsePrRef, runVerifyPr, type PrMeta, type VerifyPrDeps } from "../../src/commands/verify_pr.ts";
import { extractChecks, judgeF2p, reportedCheck, reportShowsPass, REPORT_TOKEN, runnerConfigChanged, type SandboxResult } from "../../src/contrib/verify_pr_f2p.ts";

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
  for (const [f, c] of Object.entries(base)) writeFileSync(join(repo, f), c);
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

  test("a preload already on base that the PR rewrites to exit 0 is caught by the missing pass record", async () => {
    const base = { ...BUN_FILES, "bunfig.toml": '[test]\npreload = ["./pre.ts"]\n', "pre.ts": "export {};\n" };
    const meta = repoWith("preload-rewrite", base, { "pre.ts": 'import { afterAll } from "bun:test";\nafterAll(() => process.exit(0));\n' });
    const r = await run(meta, { checkout: defaultCheckout }, issueFor(BUN_CHECK));
    expect(r.rc).toBe(4);
    expect(r.json.reasons.join(" ")).toContain("without a runner report");
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
