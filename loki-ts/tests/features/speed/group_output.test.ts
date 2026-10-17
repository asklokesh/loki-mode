// SPEED-TIMER-UNREF: the repaint interval must not keep the process alive when stop() is never called.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runGroup } from "../../../src/features/speed/run_group.ts";
import type { Dag } from "../../../src/features/decompose.ts";

test("start() without stop() does not keep the process alive", async () => {
  const mod = join(import.meta.dir, "../../../src/features/speed/group_output.ts");
  const code = `import { createGroupRenderer } from ${JSON.stringify(mod)};
const r = createGroupRenderer({ write: () => {}, isTTY: true, intervalMs: 50 });
r.start();`;
  const t0 = Date.now();
  const p = Bun.spawn(["bun", "-e", code], { stdout: "ignore", stderr: "ignore", env: { ...process.env, LOKI_NO_BROWSER: "1" } });
  const timer = setTimeout(() => p.kill(), 5000);
  const exit = await p.exited;
  clearTimeout(timer);
  expect(Date.now() - t0).toBeLessThan(2500);
  expect(exit).toBe(0);
});

// Q18-08: runGroup reports a non-decomposable DAG (checkDecomposable, D61-09) after writing dag.json and still runs.
async function decomposeRun(dag: Dag, lines: (gid: string) => string = () => ""): Promise<{ err: string; launched: number }> {
  const repo = mkdtempSync(join(tmpdir(), "q18-08-"));
  try {
    const sh = (a: string[]): void => {
      const p = Bun.spawnSync({ cmd: ["git", ...a], cwd: repo, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    };
    for (const a of [["init", "-q", "-b", "main"], ["config", "user.name", "t"], ["config", "user.email", "t@t.invalid"], ["config", "commit.gpgsign", "false"]]) sh(a);
    writeFileSync(join(repo, "README.md"), "x\n");
    sh(["add", "README.md"]); sh(["commit", "-q", "-m", "init"]);
    sh(["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    let err = "", launched = 0;
    const seal = { receiptSha256: (() => "") as never, verifyReceipt: (async () => ({ verdict: "NOT_PROVEN", reasons: [] })) as never };
    await runGroup(async (argv, _e, _c, onOut) => { launched++; onOut?.(lines(argv[argv.indexOf("--group") + 1]!)); return { code: 1, stdout: "" }; }, dag,
      { task: "t", repoDir: repo, env: { LOKI_PROVIDER: "claude" } as NodeJS.ProcessEnv, provider: "claude", spec: "- a\n- b\n", specPath: null, seal, say: (s: string) => { err += s; } });
    return { err, launched };
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
const unit = (id: string, files: string[]) => ({ id, items: [`work ${id}`], writeSet: files, modules: [], serialized: [] as string[] });

test("coupled DAG is reported not decomposable and the run still launches", async () => {
  const r = await decomposeRun({ units: [unit("u1", ["src/a.ts"]), unit("u2", ["src/a.ts"])], sharedFiles: [], edges: [] });
  expect(r.err).toContain("not decomposable");
  expect(r.err).toContain("write-set overlap");
  expect(r.launched).toBe(1);
});

test("independent DAG prints no decomposability warning", async () => {
  const r = await decomposeRun({ units: [unit("u1", ["src/a.ts"]), unit("u2", ["src/b.ts"])], sharedFiles: [], edges: [] });
  expect(r.err).not.toContain("not decomposable");
  expect(r.launched).toBe(1);
});

// Q18-11: backlog launcher output drives group.started/group.unit and the unit lines.
test("runGroup renders a unit line per backlog status from the launcher output callback", async () => {
  const r = await decomposeRun({ units: [unit("u1", ["src/a.ts"]), unit("u2", ["src/b.ts"])], sharedFiles: [], edges: [] },
    (g) => `backlog: unit-${g}-1 VERIFIED\nbacklog: unit-${g}-2 FAILED: boom\n`);
  expect(r.err).toContain("unit u1 done verified");
  expect(r.err).toContain("unit u2 failed failed");
});
