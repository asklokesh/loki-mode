// loki-ts/tests/engine10/already_done.test.ts -- E-66 unit + mutation-proof tests for the
// deterministic evidence search and its confirmation gate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildAlreadyDoneCommentArgv,
  buildConfirmBrief,
  checkAlreadyDone,
  findEvidence,
  renderAlreadyDoneComment,
} from "../../src/engine10/already_done.ts";
import { runIntake, intakeStage } from "../../src/engine10/stages/intake.ts";
import { runMachine } from "../../src/engine10/machine.ts";
import { hitsUnchangedFromBase } from "../../src/features/speed/already_done_async.ts";
import { buildRepoMap, listRepoFiles } from "../../src/engine10/repomap.ts";
import { buildTestMap, isTestFile } from "../../src/engine10/testmap.ts";
import type { CostReader, RunContext, SessionRunner, Stage, StageName, TestMap } from "../../src/engine10/types.ts";
import { REPO_ROOT } from "../../src/util/paths.ts";

const FIX = join(import.meta.dir, "fixtures", "intake", "already-done-repo");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-already-done-"));
  execFileSync("cp", ["-R", `${FIX}/.`, dir]);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

const TASK = "Add global search (Cmd+K)";

describe("findEvidence (deterministic search)", () => {
  test("code + test + CHANGELOG together clear the MIN_CATEGORIES gate", () => {
    const dir = freshRepo();
    const repoMap = buildRepoMap(dir);
    const testMap = buildTestMap(dir);
    const hits = findEvidence(TASK, repoMap, testMap, dir);
    expect(new Set(hits.map((h) => h.source))).toEqual(new Set(["code", "test", "changelog"]));
    rmSync(dir, { recursive: true, force: true });
  });

  // Mutation proof: dropping MIN_CATEGORIES to 1 would make this pass on a single incidental
  // match (the task merely names a symbol that already exists), which is exactly the
  // false-positive the two-category gate exists to prevent.
  test("one category alone (a task naming an existing symbol) is never a candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-onecat-")); // no CHANGELOG/README here
    const repoMap = { files: ["src/search-command.ts"], entries: [{ path: "src/search-command.ts", symbols: ["search"] }], truncated: false };
    const hits = findEvidence("refactor search internals", repoMap, { runners: [], tests: [] }, dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no keyword overlap at all: no evidence, no crash on a repo with no CHANGELOG/README", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-empty-"));
    const hits = findEvidence("completely unrelated task text", { files: [], entries: [], truncated: false }, { runners: [], tests: [] }, dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  // Two unrelated keywords each hitting a different source is not the same signal as one keyword
  // naming the feature in two places (the fixture test above): "gizmo" is a real symbol name but
  // has no test or changelog mention, "sprocket" is a test-name-only coincidence with no code or
  // changelog mention. Neither says the task's actual feature already exists.
  test("two different keywords each covering a different source alone are not enough", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-crosscat-"));
    const repoMap = { files: ["src/gizmo.ts"], entries: [{ path: "src/gizmo.ts", symbols: ["gizmo"] }], truncated: false };
    const testMap = { runners: ["bun" as const], tests: [{ runner: "bun" as const, path: "tests/sprocket.test.ts" }] };
    const hits = findEvidence("wire the gizmo into the sprocket pipeline", repoMap, testMap, dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 2, reproduced on THIS repo (not a fixture): before the stop-word list and
  // whole-token matching, these two tasks matched hundreds of unrelated lines (generic words like
  // "add", "mode", "the", "files" hitting test names and old CHANGELOG headings) and would have
  // spent a confirmation session on almost every real-world run. A genuinely already-built feature
  // (the fixture case just above, and again below) must still clear the gate.
  test("generic-word tasks give zero candidate evidence on a real, large repo", () => {
    // Uncapped: this repo has ~4700+ tracked files, well past listRepoFiles' default 2000-file
    // cap. Capped, this test stayed green even with STOP_WORDS emptied out (the words that would
    // have produced a false candidate live past file #2000), which made the test worthless as a
    // guard. Number.MAX_SAFE_INTEGER as maxFiles turns the cap off for both repoMap and testMap.
    const repoMap = buildRepoMap(REPO_ROOT, Number.MAX_SAFE_INTEGER);
    // Tracked test files only (git ls-files), never buildTestMap's raw fs walk: this checkout's
    // .claude/worktrees/ holds a full repo copy per concurrent agent (excluded via
    // .git/info/exclude, so `git ls-files` never sees it, but a plain readdirSync walk would),
    // which made the earlier version of this test slow enough to risk the CI timeout.
    const testMap: TestMap = { runners: ["bun"], tests: listRepoFiles(REPO_ROOT, Number.MAX_SAFE_INTEGER).files.filter(isTestFile).map((path) => ({ runner: "bun", path })) };
    for (const task of ["Add a dark mode toggle to the settings page", "Support exporting invoices as PDF files"]) {
      expect(findEvidence(task, repoMap, testMap, REPO_ROOT)).toEqual([]);
    }
  });

  // A flat `slice(0, N)` after concatenating [...code, ...test, ...changelog] could let 30 code
  // hits alone fill the cap and crowd the test category out entirely, even though both sources
  // are what made this a candidate in the first place. The cap must be per source.
  test("hit list is capped per source, so a noisy category never crowds another one out", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-cap-"));
    const entries = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, symbols: ["widget"] }));
    const tests = [{ runner: "bun" as const, path: "tests/widget-x.test.ts" }];
    const hits = findEvidence("ship the widget dashboard", { files: [], entries, truncated: false }, { runners: ["bun"], tests }, dir);
    expect(hits.length).toBeLessThanOrEqual(10);
    expect(new Set(hits.map((h) => h.source))).toEqual(new Set(["code", "test"]));
    expect(hits.some((h) => h.source === "test")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("findEvidence compound matching (D50-F5)", () => {
  function repo(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-compound-"));
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    }
    return dir;
  }
  const src = { path: "src/search-command.tsx", symbols: ["SearchCommand"] };
  const mapOf = (entries: { path: string; symbols: string[] }[]) => ({ files: entries.map((e) => e.path), entries, truncated: false });
  const testsOf = (...paths: string[]) => ({ runners: ["bun" as const], tests: paths.map((path) => ({ runner: "bun" as const, path })) });
  const AIQ = "[Feature]: add searchbar\n\nthere is no searchbar to find things";

  test("aiq-52 shape: searchbar vs search-command.tsx + a test importing it is a candidate", () => {
    const dir = repo({ "src/search-command.tsx": "export function SearchCommand() {}", "src/search-command.test.tsx": 'import { SearchCommand } from "./search-command";' });
    const hits = findEvidence(AIQ, mapOf([src]), testsOf("src/search-command.test.tsx"), dir);
    expect(new Set(hits.map((h) => h.source))).toEqual(new Set(["code", "test"]));
    rmSync(dir, { recursive: true, force: true });
  });

  test("no related file: no candidate", () => {
    const dir = repo({ "src/billing.tsx": "", "src/billing.test.tsx": 'import "./billing";' });
    const hits = findEvidence(AIQ, mapOf([{ path: "src/billing.tsx", symbols: ["Billing"] }]), testsOf("src/billing.test.tsx"), dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("source file without a referencing test: not two categories", () => {
    const dir = repo({ "src/search-command.tsx": "", "src/search-command.test.tsx": "test('x', () => {});" });
    expect(findEvidence(AIQ, mapOf([src]), testsOf("src/search-command.test.tsx"), dir)).toEqual([]);
    expect(findEvidence(AIQ, mapOf([src]), testsOf(), dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  // Review: an exact single-part equality is no compounding at all and must never be a candidate.
  const noCandidate = (task: string, file: string, sym: string, importLine: string, testFile = file.replace(/(\.\w+)$/, ".test$1")) => {
    const dir = repo({ [file]: "", [testFile]: importLine });
    expect(findEvidence(task, mapOf([{ path: file, symbols: [sym] }]), testsOf(testFile), dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  };
  test("exact part equality is not a candidate (user, api, notification)", () => {
    noCandidate("rate limiting to the user endpoint", "src/user-service.ts", "getUser", 'import { getUser } from "./user-service";');
    noCandidate("retries to api", "src/api-client.ts", "ApiClient", 'import { ApiClient } from "./api-client";');
    noCandidate("email notification setting", "src/notification_settings.py", "NotificationSettings", "from notification_settings import NotificationSettings");
  });
  test("a -less suffix is an inflection (passwordless vs password-reset)", () => {
    noCandidate("add passwordless login", "src/password-reset.ts", "resetPassword", 'import { resetPassword } from "./password-reset";');
  });
  test("derivational suffixes are not compounds (authorization, productivity, information)", () => {
    noCandidate("add authorization checks", "src/author.ts", "Author", 'import { Author } from "./author";');
    noCandidate("productivity report", "src/product.ts", "Product", 'import { Product } from "./product";');
    noCandidate("show information panel", "src/inform.ts", "inform", 'import { inform } from "./inform";');
  });
  test("more suffixes are not compounds (ful, hood, ship, dom, ance, ency, ator, ence)", () => {
    for (const [kw, stem] of <[string, string][]>[["successful", "success"], ["neighborhood", "neighbor"], ["ownership", "owner"], ["chiefdom", "chief"], ["performance", "perform"], ["dependency", "depend"], ["validator", "valid"], ["existence", "exist"], ["parentwards", "parent"], ["colorish", "color"]]) {
      noCandidate(`improve ${kw} flow`, `src/${stem}.ts`, stem, `import { x } from "./${stem}";`);
    }
  });
  test("multi-line template literals and Python backslash continuations are not imports", () => {
    const cases: [string, string, string][] = [
      ["src/search-command.tsx", "src/search-command.test.tsx", "const fx = `\nimport { SearchCommand } from './search-command';\n`;"],
      ["src/search_command.py", "src/search_command.test.py", 'x = "a\\\nimport search_command"'],
    ];
    for (const [sf, tf, body] of cases) {
      const dir = repo({ [sf]: "", [tf]: body });
      expect(findEvidence(AIQ, mapOf([{ path: sf, symbols: ["SearchCommand"] }]), testsOf(tf), dir)).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("string literals, block comments and Python docstrings never count as imports", () => {
    const cases: [string, string][] = [
      ["src/search-command.test.tsx", `const s = "x from 'search-command'";`],
      ["src/search-command.test.tsx", `/*\nimport { SearchCommand } from "./search-command";\n*/`],
      ["tests/search_command.test.py", `"""\nimport search_command\nfrom search_command import SearchCommand\n"""`],
    ];
    for (const [tf, body] of cases) {
      const sf = tf.replace(".test", "").replace("tests/", "src/");
      const dir = repo({ [sf]: "", [tf]: body });
      expect(findEvidence(AIQ, mapOf([{ path: sf, symbols: ["SearchCommand"] }]), testsOf(tf), dir)).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a real Python from-import still links", () => {
    const dir = repo({ "src/search_command.py": "", "tests/search_command.test.py": "from search_command import SearchCommand" });
    const hits = findEvidence(AIQ, mapOf([{ path: "src/search_command.py", symbols: ["SearchCommand"] }]), testsOf("tests/search_command.test.py"), dir);
    expect(hits.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
  test("a stem that appears only in a comment or string is not an import", () => {
    const dir = repo({ "src/search-command.tsx": "", "src/search-command.test.tsx": '// covers ./search-command\nconst s = "import ./search-command";\nconst a = 1; // import search-command' });
    expect(findEvidence(AIQ, mapOf([src]), testsOf("src/search-command.test.tsx"), dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
  test("vendored and generated directories are skipped", () => {
    for (const d of ["vendor", "third_party", "build", ".venv", "coverage", "__generated__"]) {
      noCandidate(AIQ, `${d}/search-command.tsx`, "SearchCommand", 'import { SearchCommand } from "./search-command";');
    }
  });

  test("an inflected keyword (exporting vs export) is not a compound match", () => {
    const dir = repo({ "tools/receipt-export.py": "", "tests/test_receipt_export.py": "import receipt_export" });
    const hits = findEvidence("support exporting invoices", mapOf([{ path: "tools/receipt-export.py", symbols: ["export"] }]), testsOf("tests/test_receipt_export.py"), dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stem token under 5 chars is not a prefix match", () => {
    const dir = repo({ "src/tab-bar.tsx": "", "src/tab-bar.test.tsx": 'import "./tab-bar";' });
    const hits = findEvidence("add tabular layout", mapOf([{ path: "src/tab-bar.tsx", symbols: ["TabBar"] }]), testsOf("src/tab-bar.test.tsx"), dir);
    expect(hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildConfirmBrief", () => {
  test("cites every deterministic hit and demands a citing marker line", () => {
    const brief = buildConfirmBrief(TASK, [{ source: "code", path: "src/search-command.ts", line: "search" }]);
    expect(brief).toContain("src/search-command.ts: search");
    expect(brief).toContain("LOKI_ALREADY_DONE:");
    expect(brief).toContain("Do not edit any file");
  });
});

const fakeCost: CostReader = { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) };
function ctxWith(sessions: SessionRunner, repoDir: string): RunContext {
  return {
    runId: "e10-already-done-run", repoDir, runDir: repoDir, baseSha: "", branch: "loki/e10-already-done-run",
    provider: "claude", model: "test-model", deep: false, capS: 900, emit: () => {}, sessions,
    tests: { detect: async (d) => buildTestMap(d), impacted: () => [] }, cost: fakeCost,
    clock: { now: () => Date.now() }, outputs: () => ({}),
  };
}

describe("checkAlreadyDone", () => {
  test("no candidate evidence: never calls the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-already-done-nocand-"));
    const sessions: SessionRunner = { run: () => { throw new Error("must not be called"); } };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, "unrelated task", { files: [], entries: [], truncated: false }, { runners: [], tests: [] });
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("candidate evidence, confirmed: returns the model's citation plus the deterministic hits", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "search-command.ts:1 already implemented", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result?.satisfied).toBe(true);
    expect(result?.evidence[0]).toBe("search-command.ts:1 already implemented");
    expect(result?.evidence.some((e) => e.includes("search-command.ts: search"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("candidate evidence, not confirmed: null, never a false already-done", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: true, alreadyDone: null, specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 3: a marker with no real citation must never satisfy already-done, even
  // though the marker string itself is non-empty (the old gate was `if (!alreadyDone) return
  // null`, which "LOKI_ALREADY_DONE: yes" alone would pass).
  test("confirmed marker names no file at all: rejected, not already-done", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "yes, fully implemented", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // A citation must name one of THIS search's own hits, not merely an existing file: naming a real
  // but unrelated path (package.json exists, but was never offered as evidence) must not count.
  test("confirmed marker names a real file that is not in the hit list: rejected", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "bunfig.toml proves it", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 5: a changelog heading says a feature was documented, not that working
  // code for it exists today. A citation naming only the changelog entry (never the code or the
  // test) must not be enough, even though CHANGELOG.md is a real hit in the hit list.
  test("confirmed marker cites only the CHANGELOG.md hit: rejected, changelog alone is not code", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "CHANGELOG.md documents this feature", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // E-66 review finding 5: substring citation must respect a word boundary, so a coincidental
  // superstring of a hit's basename ("presearch-command.ts" contains the literal text
  // "search-command.ts") is never mistaken for citing "search-command.ts".
  test("a coincidental substring of a basename is not a citation of it", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "see presearch-command.ts for background", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  // The citation gate requires the cited path to still exist on disk, not just to appear in the
  // hit list findEvidence built a moment earlier (the repo can change between the search and the
  // confirmation session). Same hit, both branches of that existsSync check.
  test("confirmed marker cites a hit whose file no longer exists on disk: rejected", async () => {
    const dir = freshRepo();
    const repoMap = buildRepoMap(dir);
    const testMap = buildTestMap(dir);
    rmSync(join(dir, "src", "search-command.ts"));
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "search-command.ts:1 already implemented", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, repoMap, testMap);
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("confirmed marker cites a hit whose file still exists on disk: accepted", async () => {
    const dir = freshRepo();
    const repoMap = buildRepoMap(dir);
    const testMap = buildTestMap(dir);
    const sessions: SessionRunner = { run: async () => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: false, alreadyDone: "search-command.ts:1 already implemented", specConflict: null } }) };
    const result = await checkAlreadyDone(ctxWith(sessions, dir), new AbortController().signal, TASK, repoMap, testMap);
    expect(result?.satisfied).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an already-aborted signal never calls the session", async () => {
    const dir = freshRepo();
    const sessions: SessionRunner = { run: () => { throw new Error("must not be called"); } };
    const controller = new AbortController();
    controller.abort();
    const result = await checkAlreadyDone(ctxWith(sessions, dir), controller.signal, TASK, buildRepoMap(dir), buildTestMap(dir));
    expect(result).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("comment building (no PR)", () => {
  test("renderAlreadyDoneComment lists every evidence line", () => {
    const body = renderAlreadyDoneComment(["a.ts: foo", "CHANGELOG.md: Foo"]);
    expect(body).toContain("no change needed");
    expect(body).toContain("- a.ts: foo");
    expect(body).toContain("- CHANGELOG.md: Foo");
  });

  test("buildAlreadyDoneCommentArgv is deterministic argv, not a shell string", () => {
    const argv = buildAlreadyDoneCommentArgv("e10-run-1", "acme/widgets#303", "/tmp/body.md");
    expect(argv).toEqual(["comment", "e10-run-1", "acme/widgets#303", "/tmp/body.md"]);
  });
});

// D61-04: LOKI_SPEED=1 moves the confirmation off the critical path (src/features/speed/already_done_async.ts).
describe("deferred already-done check (LOKI_SPEED=1)", () => {
  const CITE = "search-command.ts:1 already implemented";
  type Opts = Parameters<SessionRunner["run"]>[0];
  const ok = (alreadyDone: string | null) => ({ exit: 0, durationS: 0.1, killed: false, markers: { done: alreadyDone === null, alreadyDone, specConflict: null } });
  const killed = { exit: null, durationS: 0, killed: true, markers: { done: false, alreadyDone: null, specConflict: null } };
  /** Fake sessions: the intake confirmation resolves via release(); implement resolves via finishImpl() or when aborted. */
  function rig(confirm: string | null) {
    const calls: { stage: string; aborted: boolean }[] = [];
    let release: () => void = () => {};
    let finishImpl: () => void = () => {};
    let implSignal: AbortSignal | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const sessions: SessionRunner = {
      run: async (o: Opts) => {
        calls.push({ stage: o.stage, aborted: o.signal.aborted });
        if (o.stage === "intake") { await gate; return ok(confirm); }
        implSignal = o.signal;
        if (o.signal.aborted) return killed;
        await new Promise<void>((res) => { finishImpl = res; o.signal.addEventListener("abort", () => res(), { once: true }); });
        return o.signal.aborted ? killed : ok(null);
      },
    };
    return { sessions, calls, release: () => release(), finishImpl: () => finishImpl(), implAborted: () => implSignal?.aborted === true };
  }
  const tick = () => new Promise<void>((r) => setTimeout(r, 20));
  async function intakeWith(r: ReturnType<typeof rig>, task: string, dir: string) {
    const ctx = ctxWith(r.sessions, dir);
    ctx.runDir = mkdtempSync(join(tmpdir(), "e10-already-done-run-"));
    ctx.baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const res = await runIntake(ctx, new AbortController().signal, { taskText: task });
    return { ctx, res };
  }
  const runImpl = (ctx: RunContext) =>
    ctx.sessions.run({ stage: "implement", brief: "b", tier: "development", iterationId: "i-impl", limitS: 60, signal: new AbortController().signal });

  test("LOKI_SPEED unset: confirmation stays inline on the critical path, sessions untouched", async () => {
    const dir = freshRepo();
    const r = rig(CITE);
    r.release();
    const { ctx, res } = await intakeWith(r, TASK, dir);
    expect(res.data.already_satisfied).toBe(true);
    expect(ctx.sessions).toBe(r.sessions);
    rmSync(dir, { recursive: true, force: true });
  });

  describe("with LOKI_SPEED=1", () => {
    const prev = process.env["LOKI_SPEED"];
    beforeEach(() => { process.env["LOKI_SPEED"] = "1"; });
    afterEach(() => { if (prev === undefined) delete process.env["LOKI_SPEED"]; else process.env["LOKI_SPEED"] = prev; });

    test("no deterministic hit: zero cheap-model calls, sessions not wrapped", async () => {
      const dir = freshRepo();
      const r = rig(CITE);
      const { ctx, res } = await intakeWith(r, "unrelated zebra migration", dir);
      expect(res.data.already_satisfied).toBe(false);
      expect(r.calls).toEqual([]);
      expect(ctx.sessions).toBe(r.sessions);
      rmSync(dir, { recursive: true, force: true });
    });

    test("hit: intake returns without waiting for the model; confirmation lands during implement and stops it", async () => {
      const dir = freshRepo();
      const r = rig(CITE);
      const { ctx, res } = await intakeWith(r, TASK, dir); // gate still closed: intake did not await the check
      expect(res.data.already_satisfied).toBe(false);
      expect(res.data.repomap_ref).toBeDefined();
      const impl = runImpl(ctx);
      await tick();
      expect(r.calls.map((c) => c.stage)).toEqual(["intake", "implement"]); // concurrent
      r.release();
      const out = await impl;
      expect(r.implAborted()).toBe(true);
      expect(out.markers.alreadyDone).toBe(CITE);
      expect(out.killed).toBe(false);
      expect(res.data.already_satisfied).toBe(true);
      expect((res.data.evidence as string[])[0]).toBe(CITE);
      expect(typeof res.data.comment).toBe("string");
      expect(res.data.iteration_ids).toEqual(["e10-already-done-run-already-done"]);
      rmSync(dir, { recursive: true, force: true });
    });

    test("confirmed before implement starts: implement is never spawned live and still reports already done", async () => {
      const dir = freshRepo();
      const r = rig(CITE);
      const { ctx, res } = await intakeWith(r, TASK, dir);
      r.release();
      await tick();
      expect(res.data.already_satisfied).toBe(false); // nothing changes until implement is in flight
      const out = await runImpl(ctx);
      expect(r.calls[1]).toEqual({ stage: "implement", aborted: true });
      expect(out.markers.alreadyDone).toBe(CITE);
      expect(res.data.already_satisfied).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    test("not confirmed: implement runs to completion, verdict untouched", async () => {
      const dir = freshRepo();
      const r = rig(null);
      const { ctx, res } = await intakeWith(r, TASK, dir);
      const impl = runImpl(ctx);
      r.release();
      await tick();
      r.finishImpl();
      const out = await impl;
      expect(out.exit).toBe(0);
      expect(out.markers.alreadyDone).toBeNull();
      expect(r.implAborted()).toBe(false);
      expect(res.data.already_satisfied).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    });

    test("cancelled check (implement finished first) never changes the verdict", async () => {
      const dir = freshRepo();
      const r = rig(CITE);
      const { ctx, res } = await intakeWith(r, TASK, dir);
      const impl = runImpl(ctx);
      await tick();
      r.finishImpl();
      const out = await impl;
      expect(out.markers.alreadyDone).toBeNull();
      r.release(); // the check answers after implement is done: late, discarded
      await tick();
      expect(res.data.already_satisfied).toBe(false);
      expect(res.data.evidence).toBeUndefined();
      rmSync(dir, { recursive: true, force: true });
    });

    // D61-04 round 2 (Opus B1): the check reads the live tree implement is editing; an honest "feature present"
    // that rests on a file implement already changed must never become ALREADY_SATISFIED.
    describe("race with implement's own edits", () => {
      const SENTINEL = "// FEATURE_IMPLEMENTED_BY_THIS_RUN";
      const cited = "src/search-command.ts";
      const impl = (ctx: RunContext) => ctx.sessions.run({ stage: "implement", brief: "b", tier: "development", iterationId: "i-impl", limitS: 60, signal: new AbortController().signal, cwd: ctx.repoDir });
      function raceRig(dir: string, edit: () => void) {
        const target = join(dir, cited);
        let wrote: () => void = () => {};
        const w = new Promise<void>((r) => { wrote = r; });
        const sessions: SessionRunner = {
          run: async (o: Opts) => {
            if (o.stage === "intake") {
              await w;
              const done = readFileSync(target, "utf8").includes(SENTINEL);
              return ok(done ? `${cited}:1 feature present` : null);
            }
            edit(); wrote();
            await new Promise<void>((res) => { o.signal.addEventListener("abort", () => res(), { once: true }); setTimeout(res, 300); });
            return o.signal.aborted ? killed : ok(null);
          },
        };
        return sessions;
      }
      test("cited file edited by implement: hit discarded, implement not aborted, verdict untouched", async () => {
        const dir = freshRepo();
        const target = join(dir, cited);
        const { ctx, res } = await intakeWith(rig(null), TASK, dir);
        ctx.sessions = raceRig(dir, () => appendFileSync(target, `\n${SENTINEL}\n`));
        // re-arm the deferral on the race sessions
        const events: string[] = [];
        ctx.emit = (t) => { events.push(t); };
        const res2 = await runIntake(ctx, new AbortController().signal, { taskText: TASK });
        const out = await impl(ctx);
        expect(res2.data.already_satisfied).toBe(false);
        expect(out.killed).toBe(false);
        expect(out.markers.alreadyDone).toBeNull();
        expect(events).not.toContain("already.satisfied");
        expect(res.data.already_satisfied).toBe(false);
        rmSync(dir, { recursive: true, force: true });
      });
      /** Race rig where the model cites `cite(dir)` after implement ran `edit`. */
      async function uncited(edit: (dir: string) => void, cite: (dir: string) => string | null) {
        const dir = freshRepo();
        let wrote: () => void = () => {};
        const w = new Promise<void>((r) => { wrote = r; });
        const sessions: SessionRunner = {
          run: async (o: Opts) => {
            if (o.stage === "intake") { await w; return ok(cite(dir)); }
            edit(dir); wrote();
            await new Promise<void>((res) => { o.signal.addEventListener("abort", () => res(), { once: true }); setTimeout(res, 300); });
            return o.signal.aborted ? killed : ok(null);
          },
        };
        const { ctx } = await intakeWith(rig(null), TASK, dir);
        ctx.sessions = sessions;
        const events: string[] = [];
        ctx.emit = (t) => { events.push(t); };
        const res2 = await runIntake(ctx, new AbortController().signal, { taskText: TASK });
        const out = await impl(ctx);
        rmSync(dir, { recursive: true, force: true });
        return { res2, out, events };
      }
      test("implement edits a hit file, model cites only an unchanged sibling hit: not already satisfied", async () => {
        const r = await uncited(
          (d) => appendFileSync(join(d, cited), `\n${SENTINEL}\n`),
          (d) => readFileSync(join(d, cited), "utf8").includes(SENTINEL) ? "tests/search.test.ts:1 covers global search; implementation present" : null,
        );
        expect(r.res2.data.already_satisfied).toBe(false);
        expect(r.out.killed).toBe(false);
        expect(r.events).not.toContain("already.satisfied");
      });
      test("implement deletes a cited hit file: not already satisfied", async () => {
        const r = await uncited(
          (d) => unlinkSync(join(d, "tests/search.test.ts")),
          () => `${cited}:1 and tests/search.test.ts:1 prove it`,
        );
        expect(r.res2.data.already_satisfied).toBe(false);
        expect(r.events).not.toContain("already.satisfied");
      });
      test("hitsUnchangedFromBase fails closed on an empty baseSha and on no paths", () => {
        const dir = freshRepo();
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
        expect(hitsUnchangedFromBase(dir, sha, [cited])).toBe(true);
        expect(hitsUnchangedFromBase(dir, "", [cited])).toBe(false);
        expect(hitsUnchangedFromBase(dir, sha, [])).toBe(false);
        rmSync(dir, { recursive: true, force: true });
      });
      test("machine: a deferred hit makes implement jump to the tail, verify never runs", async () => {
        const dir = freshRepo();
        const prevTask = process.env["LOKI_E10_TASK_TEXT"];
        process.env["LOKI_E10_TASK_TEXT"] = TASK;
        const r = rig(CITE);
        const ctx = ctxWith(r.sessions, dir);
        ctx.runDir = mkdtempSync(join(tmpdir(), "e10-already-done-run-"));
        ctx.baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
        const ran: string[] = [];
        const st = (name: StageName, run: Stage["run"]): Stage => ({ name, targetS: 1, limitS: 30, run });
        const stages: Partial<Record<StageName, Stage>> = {
          intake: intakeStage,
          implement: st("implement", async (c) => {
            setTimeout(() => r.release(), 20);
            await c.sessions.run({ stage: "implement", brief: "b", tier: "development", iterationId: "i-impl", limitS: 60, signal: new AbortController().signal });
            return { status: "completed", data: {} };
          }),
          verify: st("verify", async () => { ran.push("verify"); return { status: "completed", data: {} }; }),
          commit: st("commit", async () => { ran.push("commit"); return { status: "completed", data: {} }; }),
        };
        try {
          const out = await runMachine(ctx, { flow: ["intake", "implement", "verify", "commit"], load: async (n) => stages[n] ?? null });
          expect(out.outputs.intake?.already_satisfied).toBe(true);
          expect(ran).toEqual(["commit"]);
        } finally {
          if (prevTask === undefined) delete process.env["LOKI_E10_TASK_TEXT"]; else process.env["LOKI_E10_TASK_TEXT"] = prevTask;
          rmSync(dir, { recursive: true, force: true });
        }
      });
      test("cited file untouched at base: confirmed hit fires and emits already.satisfied", async () => {
        const dir = freshRepo();
        const target = join(dir, cited);
        appendFileSync(target, `\n${SENTINEL}\n`);
        git(dir, ["commit", "-q", "-am", "feature at base"]);
        const { ctx } = await intakeWith(rig(null), TASK, dir);
        ctx.sessions = raceRig(dir, () => {});
        const events: string[] = [];
        ctx.emit = (t) => { events.push(t); };
        const res2 = await runIntake(ctx, new AbortController().signal, { taskText: TASK });
        const out = await impl(ctx);
        expect(out.markers.alreadyDone).toBe(`${cited}:1 feature present`);
        expect(res2.data.already_satisfied).toBe(true);
        expect(events).toContain("already.satisfied");
        rmSync(dir, { recursive: true, force: true });
      });
    });
  });
});
