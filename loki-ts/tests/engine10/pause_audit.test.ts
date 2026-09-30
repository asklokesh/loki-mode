// loki-ts/tests/engine10/pause_audit.test.ts
//
// E-67 wall check (v10 never waits on a human): a provider session that
// asks a question and tries to read stdin, then never finishes on its own,
// must never turn a run into a pause state. The run ends within the cap
// (LOKI_E10_CAP_S, the same "for tests only" knob supervisor.ts and
// cap.test.ts already read), the engine never reads that stdin question's
// answer (session.ts spawns the session with stdio stdin "ignore" --
// verified here, not assumed, by reading what the stub itself observed),
// and the outcome is a draft-PR push argv naming the exact reason.
//
// commit/seal are stubbed (their real-module behavior under a cap is
// already proven by cap.test.ts); this slice's own thing to prove is the
// implement-stage stdin/never-finishes behavior and that no new pause state
// swallows it.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachine } from "../../src/engine10/machine.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { runPr, type PrContext } from "../../src/engine10/stages/pr.ts";
import type { Stage, StageName } from "../../src/engine10/types.ts";
const PRE_KEY_FILE = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"];

const ASK_STUB = join(import.meta.dir, "fixtures", "session", "ask_stub.sh");

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function passthrough(name: StageName, data: Record<string, unknown> = {}): Stage {
  return { name, targetS: 5, limitS: 30, run: async () => ({ status: "completed", data }) };
}

/** Same shape cap.test.ts's writePushStub uses: never the real, credentialed engine10-push.sh. */
function writePushStub(dir: string, logPath: string): string {
  const scriptPath = join(dir, "push-stub.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
mode="$1"; shift
printf 'CALL mode=%s args=%s\\n' "$mode" "$*" >> "${logPath}"
case "$mode" in
  push-pr) echo "https://github.com/o/r/pull/1" ;;
  status) exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

describe("engine10 never waits on a human (E-67)", () => {
  test("implement's provider asks a question on stdin and never finishes -> cap kills it, stdin is never read, outcome is a draft PR argv", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e10-pause-repo-"));
    const workDir = mkdtempSync(join(tmpdir(), "loki-e10-pause-work-"));
    const stdinResultFile = join(workDir, "stdin-result.txt");
    process.env["LOKI_E10_CAP_S"] = "30"; // same test-only knob as cap.test.ts
    process.env["ASK_STUB_STDIN_RESULT"] = stdinResultFile;
    process.env["LOKI_RECEIPT_SIGNING_KEY"] = "";
    process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(workDir, "k.pem"); // throwaway auto-generated key, never the real ~/.loki

    try {
      git(["init", "-q"], repoDir);
      git(["config", "user.name", "pause-test"], repoDir);
      git(["config", "user.email", "pause@test.invalid"], repoDir);
      writeFileSync(join(repoDir, "base.txt"), "base\n");
      git(["add", "base.txt"], repoDir);
      git(["commit", "-q", "-m", "base"], repoDir);
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

      const runId = "e10-pause-test";
      const runDir = join(repoDir, ".loki", "runs", runId);
      const sessions = createSessionRunner({ provider: "claude", childCommand: ["bash", [ASK_STUB]] });
      const capS = Number(process.env["LOKI_E10_CAP_S"]);
      const events: { type: string; stage: StageName | null }[] = [];
      const pushLog = join(workDir, "push-calls.log");
      const pushScriptPath = writePushStub(workDir, pushLog);

      const ctx: PrContext = {
        runId, repoDir, runDir, baseSha, branch: "loki/e10-pause-test",
        provider: "claude", model: "fake", deep: false, capS,
        pinnedOrigin: "https://github.com/o/r.git", // never the real, credentialed remote
        emit: (type, stage) => { events.push({ type, stage }); },
        sessions,
        tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
        cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
        clock: { now: () => Date.now() },
        outputs: () => ({}),
      };

      // Never finishes on its own: only the machine's cap/limit kill ends it.
      const implement: Stage = {
        name: "implement",
        targetS: 5,
        limitS: 30,
        run: async (c, signal) => {
          const r = await c.sessions.run({ stage: "implement", brief: "x", tier: "development", iterationId: "e10-pause-test-1", limitS: 30, signal });
          return { status: "completed", data: { exit: r.killed ? "killed" : "done" } };
        },
      };
      // seal is stubbed with a fixed non-VERIFIED verdict: cap.test.ts already
      // proves the real seal module derives PARTIAL for a capped run; this
      // slice's own claim is about implement + the machine, not seal's math.
      const seal = passthrough("seal", { verdict: "PARTIAL", not_proven: ["global cap fired"], receipt_path: null });
      const prWrapped: Stage = {
        name: "pr",
        targetS: 15,
        limitS: 60,
        run: (c, s) => runPr(c as PrContext, s, { pushScriptPath }),
      };
      const load = async (name: StageName): Promise<Stage | null> => {
        if (name === "implement") return implement;
        if (name === "seal") return seal;
        if (name === "pr") return prWrapped;
        return passthrough(name);
      };

      // Same softCapS(30)=5.0s backdating trick as cap.test.ts: the cap fires
      // about 1.67s of real wall time in, so implement's session is
      // genuinely mid-run (already past its own question, sleeping) when
      // killed, without the test waiting out the full window.
      const startedAtMs = Date.now() - 3_330;
      const t0 = Date.now();
      const result = await runMachine(ctx, { load, startedAtMs });
      const wallMs = Date.now() - t0;

      // Ends within the cap: the machine returned in a couple seconds, not
      // 3600s (the stub's sleep) and nowhere near the 15-minute run cap.
      expect(wallMs).toBeLessThan(15 * 60 * 1000);
      expect(result.capHit).toBe(true);
      expect(events.some((e) => e.type === "cap.hit" && e.stage === "implement")).toBe(true);

      // Stdin was never read: session.ts spawns the child with stdin
      // "ignore" (session.ts), so the stub's `read` on stdin sees EOF
      // immediately -- proven here by the stub's own observation, not
      // assumed. Give the child a moment to have written it.
      await new Promise((res) => setTimeout(res, 300));
      expect(readFileSync(stdinResultFile, "utf8").trim()).toBe("EOF");

      // Outcome is a draft PR argv naming the reason: the real pr.ts stage's
      // own draft decision (verdict != VERIFIED || capHit), driven for real
      // against a stub push script.
      const prData = result.outputs.pr as { pr_url: string; draft: boolean } | undefined;
      expect(prData?.draft).toBe(true);
      const pushLines = readFileSync(pushLog, "utf8").trim().split("\n");
      expect(pushLines[0]).toMatch(/^CALL mode=push-pr /);
      expect(pushLines[0]?.endsWith("--draft")).toBe(true);
      const writtenBody = readFileSync(join(runDir, "pr-body.md"), "utf8");
      expect(writtenBody).toContain("global cap fired");
    } finally {
      delete process.env["LOKI_E10_CAP_S"];
      delete process.env["ASK_STUB_STDIN_RESULT"];
      delete process.env["LOKI_RECEIPT_SIGNING_KEY"];
      if (PRE_KEY_FILE === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = PRE_KEY_FILE; // restore the preload default (E-154b)
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 15_000);
});
