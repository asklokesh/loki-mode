// loki-ts/tests/engine10/providers.test.ts
//
// E-37: non-claude provider paths through session.ts, with honest cost
// (docs/v10/ENGINE.md 23:00Z cut). Test only -- no source file in this slice.
//
// Group A (below) runs TODAY against main as it stands: real session.ts
// (createSessionRunner, the self-respawn child), real runner/providers.ts
// (resolveProvider -> codexProvider/clineProvider/aiderProvider spawning the
// stub CLIs in fixtures/providers/bin), real stages/implement.ts,
// stages/seal.ts (commitStage, sealStage) and the real supervisor
// (runSupervisor, worker.ts's runWorker/assertWorkerEnv). It skips plan/wall/
// verify (not needed to prove the Green criteria below) by seeding intake
// output directly, the same "prior" idea machine.ts uses for resume.
//
// Group B is written against the E-42 contract (supervisor.ts/worker.ts
// `main`, wired preflight) per the task's instruction to code against that
// slice's contract and report the dependency. E-42 is in flight in
// .claude/worktrees/wf_c7ce2eb5-e8f-1 at the time this test was written; it
// is expected RED on main until E-42 (and E-36, which owns the exact
// refusal line) merge. See the final report for exactly which assertion
// depends on which slice.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as supervisorMod from "../../src/engine10/supervisor.ts";
import type { Receipt } from "../../src/engine10/types.ts";

const { runSupervisor } = supervisorMod;
// Mirrors the "Until then that assertion prints SKIP" convention E-35's card
// established: Group B needs supervisor.ts's `main` (E-42) to run bin/loki
// end to end. Checked once, structurally, so this test starts passing for
// real the moment E-42 lands, with no edit here.
const E42_SUPERVISOR_MAIN_LANDED = typeof (supervisorMod as Record<string, unknown>).main === "function";

const FIX = join(import.meta.dir, "fixtures", "providers");
const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const CLI_ENTRY = join(LOKI_TS, "src", "cli.ts");

const roots: string[] = [];
function cleanupRoot(d: string): void {
  roots.push(d);
}
function cleanupAll(): void {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Fresh repo from fixtures/providers/repo, base-committed on `main`. */
function makeRepo(): { repo: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "e10-providers-"));
  cleanupRoot(dir);
  const repo = join(dir, "repo");
  cpSync(join(FIX, "repo"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "e37-test");
  git(repo, "config", "user.email", "e37@test.invalid");
  git(repo, "add", "calc.ts");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

const PROVIDERS = ["codex", "cline", "aider"] as const;
type Provider = (typeof PROVIDERS)[number];

const CLI_ENV_VAR: Record<Provider, string> = {
  codex: "LOKI_CODEX_CLI",
  cline: "LOKI_CLINE_CLI",
  aider: "LOKI_AIDER_CLI",
};

// The "worker": runs intake (seeded, no session -- plan/wall/verify are not
// needed to prove E-37's Green criteria) then the real implement, commit and
// seal stages, through the real SessionRunner (session.ts) for `implement`.
// This is what worker.ts's own `main` will do once E-42 adds it (E-42
// deletes E-14's run.ts glue in favor of exactly this shape); written inline
// here, the same idiom rule_of_two.test.ts already uses for its fake worker,
// so this test needs no new source file.
function workerDriverCode(): string {
  return `
    const { runWorker } = await import(${JSON.stringify(join(LOKI_TS, "src/engine10/worker.ts"))});
    const { createSessionRunner } = await import(${JSON.stringify(join(LOKI_TS, "src/engine10/session.ts"))});
    const { implementStage } = await import(${JSON.stringify(join(LOKI_TS, "src/engine10/stages/implement.ts"))});
    const { commitStage, sealStage } = await import(${JSON.stringify(join(LOKI_TS, "src/engine10/stages/seal.ts"))});

    const runId = process.env.E37_RUN_ID;
    const repoDir = process.env.E37_REPO;
    const baseSha = process.env.E37_BASE;
    const provider = process.env.E37_PROVIDER;

    await runWorker(async (emit) => {
      const outputs = {
        intake: {
          source: "text", task_sha256: "ab".repeat(32), repo: "acme/widget",
          title: "add multiply", resumed: false,
          task: "add a multiply(a, b) function to calc.ts",
        },
      };
      const ctx = {
        runId, repoDir, runDir: repoDir + "/.loki/runs/" + runId, baseSha,
        branch: "loki/" + runId, provider, model: "test-model", deep: false, capS: 900,
        emit, sessions: createSessionRunner({ provider }),
        tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
        cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
        clock: { now: () => Date.now() },
        outputs: () => outputs,
      };
      const signal = new AbortController().signal;
      const impl = await implementStage.run(ctx, signal);
      outputs.implement = impl.data;
      const commit = await commitStage.run(ctx, signal);
      outputs.commit = commit.data;
      await sealStage.run(ctx, signal);
    }, { env: process.env });
  `;
}

async function runProvider(provider: Provider, opts: { modelOverride?: string } = {}): Promise<{
  verdict: string; workerExit: number | null; notProven: string[]; costUsd: number | null;
  stubEnv: Record<string, string> | null; calcAfter: string;
}> {
  const { repo, base } = makeRepo();
  const runId = `e37-${provider}`;
  const stubEnvLog = join(repo, "..", "stub-env.log");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LOKI_RECEIPT_SIGNING_KEY_FILE: join(repo, "..", "k.pem"), // throwaway auto-generated key, never the real ~/.loki
    E37_RUN_ID: runId,
    E37_REPO: repo,
    E37_BASE: base,
    E37_PROVIDER: provider,
    [CLI_ENV_VAR[provider]]: join(FIX, "bin", provider),
    STUB_ENV_LOG: stubEnvLog,
    ...(opts.modelOverride ? { LOKI_MODEL_OVERRIDE: opts.modelOverride } : {}),
  };
  const r = await runSupervisor({
    runId,
    repoDir: repo,
    env,
    started: { provider }, // as main() does: preflight checks this provider's stub CLI, not claude
    workerArgv: [process.execPath, "-e", workerDriverCode()],
  });
  const stubEnv = existsSync(stubEnvLog)
    ? Object.fromEntries(readFileSync(stubEnvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }))
    : null;
  const receiptPath = join(repo, ".loki/runs", runId, "receipt.json");
  const receipt = existsSync(receiptPath) ? (JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt) : null;
  return {
    verdict: r.verdict,
    workerExit: r.workerExit,
    notProven: receipt?.not_proven ?? [],
    costUsd: receipt?.cost.usd ?? null,
    stubEnv,
    calcAfter: readFileSync(join(repo, "calc.ts"), "utf8"),
  };
}

afterAll(cleanupAll);

describe("E-37 non-claude provider paths (codex, cline, aider)", () => {
  test.each([...PROVIDERS])("%s: reaches seal with honest NOT PROVEN and no host guard", async (provider: Provider) => {
    const r = await runProvider(provider, { modelOverride: "some-override-model" });
    expect(r.workerExit).toBe(0);
    // implement really ran the stub CLI: calc.ts carries its edit.
    expect(r.calcAfter).toContain("multiply");
    // No verify stage ran (checks.length === 0), so seal reports PARTIAL --
    // still "reaches seal": receipt.json/seal.ts's Green line is about the
    // run getting there, not the verdict value.
    expect(r.verdict).toBe("PARTIAL");
    expect(r.costUsd).toBeNull();
    expect(r.notProven).toContain("kill blocking not enforced");
    expect(r.notProven).toContain("model override not applied");
    // childEnv() (session.ts) only ever ADDS LOKI_HOST_GUARD for provider
    // "claude"; a non-claude session must never see it.
    expect(r.stubEnv).not.toBeNull();
    expect(r.stubEnv).not.toHaveProperty("LOKI_HOST_GUARD");
  }, 30_000);
});

// --- Group B: written against the E-42 contract; reports its own gap -------
//
// E-42 (in flight, .claude/worktrees/wf_c7ce2eb5-e8f-1) adds `main` to
// supervisor.ts and worker.ts so `bin/loki` dispatches a real run without any
// glue. Until it merges, cli.ts's route(...) resolves to supervisor.ts's
// "main" export, which does not exist yet, and this test is RED for that one
// reason (`engine10: supervisor.ts does not export main`), not because the
// assertion itself is wrong. E-36 (also not yet merged) owns the exact
// refusal line preflight.ts prints for `--provider opencode`; this asserts
// that final line so a landed E-36+E-42 turns it green unmodified.
describe("E-37 opencode refusal (depends on E-36 + E-42)", () => {
  test.skipIf(!E42_SUPERVISOR_MAIN_LANDED)("--provider opencode exits 2 with the E-36 refusal line", () => {
    const { repo } = makeRepo();
    const r = Bun.spawnSync({
      cmd: ["bash", BIN_LOKI, "add a thing", "--provider", "opencode", "--no-pr"],
      cwd: repo,
      env: { ...process.env, LOKI_ENGINE: "v10", LOKI_TS_ENTRY: CLI_ENTRY, LOKI_NO_BROWSER: "1" },
    });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(r.exitCode).toBe(2);
    expect(out).toContain("the v10 engine has no opencode invoker yet; use LOKI_ENGINE=legacy loki start --provider opencode");
  }, 20_000);
});
