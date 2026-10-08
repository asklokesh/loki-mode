import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCheckout, defaultSandbox, parsePrRef, runVerifyPr, type PrMeta, type VerifyPrDeps } from "../../src/commands/verify_pr.ts";
import { extractChecks } from "../../src/engine10/verify_pr_f2p.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vpr2-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

const ISSUE = "Fix add()\n\n## Acceptance criteria\n- add(1,2) is 3\n\nCheck: `sh t.sh`\n";

/** A local repo: main has a buggy add and t.sh; branch pr either fixes it, deletes t.sh, or changes nothing. */
function fixture(kind: "fix" | "delete-test" | "noop" | "already-passing"): { url: string; meta: PrMeta } {
  const repo = join(dir, `src-${kind}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "add.sh"), kind === "already-passing" ? "echo 3\n" : "echo 4\n");
  writeFileSync(join(repo, "t.sh"), '[ "$(sh add.sh)" = 3 ]\n');
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-qb", "pr");
  if (kind === "fix") writeFileSync(join(repo, "add.sh"), "echo 3\n");
  if (kind === "delete-test") { rmSync(join(repo, "t.sh")); writeFileSync(join(repo, "add.sh"), "echo 3\n"); }
  if (kind === "noop") writeFileSync(join(repo, "README"), "x\n");
  if (kind === "already-passing") writeFileSync(join(repo, "README"), "x\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "pr");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/pull/7/head", head);
  return { url: repo, meta: { baseSha: base, headSha: head, cloneUrl: repo, issueRefs: ["o/r#1"] } };
}

/** Trusted-fixture stand-in for the sandbox: runs the check on the host in the given dir. The real adapter is tested separately. */
const hostSandbox = (d: string, cmd: string) => {
  const r = spawnSync("sh", ["-c", cmd], { cwd: d, stdio: "ignore" });
  return { status: "COMPLETED" as const, exit_code: r.status };
};

function run(meta: PrMeta, over: Partial<VerifyPrDeps> = {}, issueBody = ISSUE) {
  const out: string[] = [], err: string[] = [];
  const outDir = join(dir, "out");
  const p = runVerifyPr(["o/r#7", "--out", outDir], {
    env: { LOKI_VERIFY_PR: "1" }, out: (s) => void out.push(s), err: (s) => void err.push(s),
    prMeta: () => meta, issue: () => ({ body: issueBody }), sandbox: hostSandbox, packageSuites: () => [], ...over,
  });
  return p.then((rc) => ({ rc, out: out.join(""), err: err.join(""), json: JSON.parse(readFileSync(join(outDir, "verify-pr-result.json"), "utf8")) }));
}

describe("loki verify-pr", () => {
  test("parsePrRef accepts url and owner/repo#N, refuses the rest", () => {
    expect(parsePrRef("https://github.com/o/r/pull/7")).toEqual({ repo: "o/r", number: 7 });
    expect(parsePrRef("o/r#7")).toEqual({ repo: "o/r", number: 7 });
    expect(parsePrRef("http://evil/o/r/pull/7")).toBeNull();
    expect(parsePrRef("o/r#7; rm")).toBeNull();
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
    expect(r.rc).toBe(4);
    expect(r.json.reasons[0]).toContain("no linked issue");
  });

  test("an issue with no runnable check is NOT PROVEN", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout }, "Fix add()\n- add works\n");
    expect(r.json.verdict).toBe("NOT PROVEN");
  });

  test("a forged 'tests pass' in the PR body is ignored: only the issue is read", async () => {
    const f = fixture("noop");
    let asked: string[] = [];
    const r = await run({ ...f.meta, issueRefs: ["o/r#1"] }, { checkout: defaultCheckout, issue: (ref) => { asked.push(ref); return { body: ISSUE }; } });
    expect(asked).toEqual(["o/r#1"]);
    expect(r.json.verdict).toBe("NOT PROVEN");
  });

  test("a failing package suite blocks VERIFIED", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout, packageSuites: () => ["exit 1"] });
    expect(r.json.verdict).toBe("NOT PROVEN");
    expect(r.json.reasons.join(" ")).toContain("package suite");
  });

  test("sandbox BLOCKED is NOT PROVEN with exit 2, not a failing verdict", async () => {
    const f = fixture("fix");
    const r = await run(f.meta, { checkout: defaultCheckout, sandbox: () => ({ status: "BLOCKED", exit_code: null, detail: "daemon down" }) });
    expect(r.rc).toBe(2);
    expect(r.json.blocked).toBe(true);
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

  test("the default sandbox is BLOCKED without an image", () => {
    expect(defaultSandbox(dir, "true", {}).status).toBe("BLOCKED");
  });
});
