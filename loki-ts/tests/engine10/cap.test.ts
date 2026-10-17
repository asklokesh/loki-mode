// loki-ts/tests/engine10/cap.test.ts
//
// E-19 wall check (docs/v10/ENGINE.md section 4 "Hard cap"; section 16 slice
// E-19). With LOKI_E10_CAP_S=30 -- the same "for tests only" knob
// supervisor.ts (E-03, on main) already reads via Number(env.LOKI_E10_CAP_S)
// -- and a sleeping stub session, the global cap fires mid-implement,
// session.ts (E-07, on main) kills the whole process group (grandchild
// included: same fixture and assertion style as session.test.ts), the real
// commit + seal stages (stages/seal.ts, E-10, already covered by
// seal.test.ts) record verdict PARTIAL, and pr_body.ts (this slice) renders
// a DRAFT body listing the missing checks seal actually produced.
//
// intake/plan/wall/pr are stubbed passthroughs: their own stage-table wiring
// and cap-jump behavior is already proven by machine.test.ts. Commit and
// seal are the REAL modules (not stubs) so "verdict is PARTIAL" is a fact
// this test computes, not one it asserts into existence.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachine } from "../../src/engine10/machine.ts";
import { draftReason, isDraft } from "../../src/engine10/pr_body.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { commitStage, sealStage } from "../../src/engine10/stages/seal.ts";
import { runPr, type PrContext } from "../../src/engine10/stages/pr.ts";
import { envCapS } from "../../src/engine10/types.ts";
import { resolveRunCapS, yamlRunCapS } from "../../src/util/run_cap.ts";
import type { RunContext, Stage, StageName } from "../../src/engine10/types.ts";
const PRE_KEY_FILE = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];

// Reused from session.ts's own fixture (E-07): sleeps 30s, forks a grandchild
// whose pid it records, so group-kill (not just direct-child kill) is provable.
const STUB = join(import.meta.dir, "fixtures", "session", "stub.sh");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function passthrough(name: StageName): Stage {
  return { name, targetS: 5, limitS: 30, run: async () => ({ status: "completed", data: {} }) };
}

/** A fake engine10-push.sh (same shape pr.test.ts's own writeStub uses): logs
 *  every call's mode + args, prints a fake PR URL for push-pr, exits 0 for
 *  status. Never the real, credentialed autonomy/lib/engine10-push.sh. */
function writePushStub(dir: string, logPath: string): string {
  const scriptPath = join(dir, "push-stub.sh");
  const content = `#!/bin/sh
mode="$1"; shift
printf 'CALL mode=%s args=%s\\n' "$mode" "$*" >> "${logPath}"
case "$mode" in
  push-pr) echo "https://github.com/o/r/pull/1" ;;
  status) exit 0 ;;
esac
exit 0
`;
  writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

describe("engine10 hard cap -> DRAFT PR body (E-19)", () => {
  test("kills the session's process group, seals PARTIAL for real, and renders a draft body listing the missing checks", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e10-cap-repo-"));
    const workDir = mkdtempSync(join(tmpdir(), "loki-e10-cap-work-")); // outside repoDir: never touched by `git add -A`
    const gcPidFile = join(workDir, "grandchild.pid");
    process.env["LOKI_E10_CAP_S"] = "30";
    process.env["SESSION_TEST_GRANDCHILD_PID_FILE"] = gcPidFile;
    // seal.ts auto-generates a key when none is set; point it at the throwaway work dir, never the real ~/.loki.
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(workDir, "k.pem");

    try {
      git(["init", "-q"], repoDir);
      git(["config", "user.name", "cap-test"], repoDir);
      git(["config", "user.email", "cap@test.invalid"], repoDir);
      writeFileSync(join(repoDir, "base.txt"), "base\n");
      git(["add", "base.txt"], repoDir);
      git(["commit", "-q", "-m", "base"], repoDir);
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

      const runId = "e10-cap-test";
      const runDir = join(repoDir, ".loki", "runs", runId); // under .loki: excluded from commit's `git add -A`
      const sessions = createSessionRunner({ provider: "claude", childCommand: ["bash", [STUB]] });
      const capS = Number(process.env["LOKI_E10_CAP_S"]); // same convention as supervisor.ts
      const events: { type: string; stage: StageName | null; data: Record<string, unknown> }[] = [];
      const pushLog = join(workDir, "push-calls.log");
      const pushScriptPath = writePushStub(workDir, pushLog);

      const ctx: PrContext = {
        runId, repoDir, runDir, baseSha, branch: "loki/e10-cap-test",
        provider: "claude", model: "fake", deep: false, capS,
        pinnedOrigin: "https://github.com/o/r.git", // never the real, credentialed remote
        emit: (type, stage, data) => { events.push({ type, stage, data }); },
        sessions,
        tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
        cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
        clock: { now: () => Date.now() },
        outputs: () => ({}),
      };

      // Writes a real change before the session runs, so the cap-killed run
      // still has a non-empty diff for commit + seal to act on (ENGINE.md
      // section 4: "commits whatever diff exists"). Report-only finding: had
      // this write been skipped, seal's verdictOf (stages/seal.ts) returns
      // FAILED for an empty diff and never reads capHit, so a cap that fires
      // before any progress currently seals FAILED, not the PARTIAL section
      // 4 promises -- a contract gap in E-10's file, not this slice's,
      // reported rather than fixed here.
      const implement: Stage = {
        name: "implement",
        targetS: 5,
        limitS: 30,
        run: async (c, signal) => {
          writeFileSync(join(repoDir, "change.txt"), "changed\n");
          const r = await c.sessions.run({ stage: "implement", brief: "x", tier: "development", iterationId: "e10-cap-test-1", limitS: 30, signal });
          return { status: "completed", data: { exit: r.killed ? "killed" : "done" } };
        },
      };

      // The real pr stage (E-11, on main), not a stub: "a draft is requested"
      // is a fact this test drives through pr.ts's own draft decision
      // (verdict != VERIFIED || capHit), not one asserted only against
      // pr_body.ts's own isDraft in isolation.
      const prWrapped: Stage = {
        name: "pr",
        targetS: 15,
        limitS: 60,
        run: (c, s) => runPr(c as PrContext, s, { pushScriptPath }),
      };
      const load = async (name: StageName): Promise<Stage | null> => {
        if (name === "implement") return implement;
        if (name === "commit") return commitStage;
        if (name === "seal") return sealStage;
        if (name === "pr") return prWrapped;
        return passthrough(name);
      };

      // capS=30 is above the ~24.83s threshold below which softCapS(capS)'s
      // commit+seal-tail budget goes negative (E-67 round 5), so softCapS(30)
      // is the plain-point/budget value unaffected by that clamp: 5.0s exactly
      // (backstopS(30)=29s minus the 24s commit+seal+grace+margin tail).
      // Backdating the start by 3.33s leaves about 1.67s of real wall time
      // before it fires, so implement's session is genuinely mid-run (not
      // already past the cap) when the kill happens, with margin for the
      // near-instant intake/plan/wall stubs ahead of it -- without the test
      // waiting out the full 3.33s.
      const startedAtMs = Date.now() - 3_330;
      const result = await runMachine(ctx, { load, startedAtMs });

      expect(result.capHit).toBe(true);
      expect(events.some((e) => e.type === "cap.hit" && e.stage === "implement")).toBe(true);

      const gcPid = Number(readFileSync(gcPidFile, "utf8").trim());
      // session.ts's SIGKILL escalation grace (KILL_GRACE_MS) is 2s; give it room to land.
      await new Promise((res) => setTimeout(res, 2500));
      expect(isAlive(gcPid)).toBe(false);

      const sealData = result.outputs.seal as { verdict: string; not_proven: string[]; receipt_path: string };
      expect(sealData.verdict).toBe("PARTIAL");
      expect(sealData.not_proven.length).toBeGreaterThan(0);

      // "A draft is requested": driven through pr.ts's OWN draft decision
      // (verdict != VERIFIED || capHit, stages/pr.ts), running for real
      // against a stub push script, not asserted only against this slice's
      // isDraft in isolation.
      const prData = result.outputs.pr as { pr_url: string; draft: boolean } | undefined;
      expect(prData?.draft).toBe(true);
      const pushLines = readFileSync(pushLog, "utf8").trim().split("\n");
      expect(pushLines[0]).toMatch(/^CALL mode=push-pr /);
      expect(pushLines[0]?.endsWith("--draft")).toBe(true);
      // pr.ts's own (unedited) body-writer already lists every missing check.
      const writtenBody = readFileSync(join(runDir, "pr-body.md"), "utf8");
      for (const check of sealData.not_proven) expect(writtenBody).toContain(check);
      expect(writtenBody.startsWith("## What the issue asked")).toBe(true); // INTEL-3: the real PR body leads with the contract
      expect(writtenBody).toContain("loki verify ");

      expect(isDraft(sealData.verdict as "PARTIAL", result.capHit)).toBe(true);
      expect(draftReason(sealData.verdict as "PARTIAL", result.capHit)).toBe("global cap fired");
    } finally {
      delete process.env["LOKI_E10_CAP_S"];
      delete process.env["SESSION_TEST_GRANDCHILD_PID_FILE"];
      delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
      if (PRE_KEY_FILE === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = PRE_KEY_FILE; // restore the preload default (E-154b)
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("isDraft/draftReason: the cap alone forces a draft even on a VERIFIED verdict", () => {
    expect(isDraft("VERIFIED", true)).toBe(true);
    expect(draftReason("VERIFIED", true)).toBe("global cap fired");
  });

  test("isDraft/draftReason: a VERIFIED, uncapped run is not a draft", () => {
    expect(isDraft("VERIFIED", false)).toBe(false);
    expect(draftReason("VERIFIED", false)).toBeNull();
  });

  test("draftReason: a non-VERIFIED verdict without a cap names the verdict", () => {
    expect(draftReason("SPEC_CONFLICT", false)).toBe("verdict SPEC_CONFLICT");
  });
});

describe("invalid cap warns", () => {
  const capture = (fn: () => void): string => {
    const orig = process.stderr.write.bind(process.stderr);
    let out = "";
    (process.stderr as { write: unknown }).write = (c: unknown) => { out += String(c); return true; };
    try { fn(); } finally { (process.stderr as { write: unknown }).write = orig; }
    return out;
  };
  test("invalid cap warns once per value, names value and default, never loosens", () => {
    const out = capture(() => {
      for (const v of ["abc-e10", "0", "-5"]) { expect(envCapS(v)).toBeNull(); expect(envCapS(v)).toBeNull(); }
      expect(yamlRunCapS("budgets:\n  run_cap_s: zzz\n")).toBeNull();
      expect(yamlRunCapS("budgets:\n  run_cap_s: 1.5\n")).toBeNull();
    });
    expect(out).toContain('LOKI_E10_CAP_S="abc-e10"');
    expect(out).toContain('budgets.run_cap_s="zzz"');
    expect(out).toContain("900s");
    expect(out.split("\n").filter((l) => l.includes('LOKI_E10_CAP_S="abc-e10"')).length).toBe(1);
    expect(out.split("\n").filter((l) => l.startsWith("loki: ignoring")).length).toBe(5);
  });
  test("valid, blank and unset print nothing", () => {
    const out = capture(() => {
      expect(envCapS("30")).toBe(30); expect(envCapS(undefined)).toBeNull(); expect(envCapS("")).toBeNull();
      expect(yamlRunCapS("budgets:\n  run_cap_s: 600\n")).toBe(600); expect(yamlRunCapS("x: 1\n")).toBeNull();
    });
    expect(out).toBe("");
  });
  test("real entry: resolveRunCapS with a bad env warns and keeps 900", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e10-capw-"));
    try {
      let r: ReturnType<typeof resolveRunCapS> | undefined;
      const out = capture(() => { r = resolveRunCapS(dir, true, { LOKI_E10_CAP_S: "bad-entry" } as NodeJS.ProcessEnv); });
      expect(r?.capS).toBe(900);
      expect(out).toContain('LOKI_E10_CAP_S="bad-entry"');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
