// A-113b: end to end through bin/loki, the real worker and the CLI invoker with a stub claude.
// (1) The provider child's own stderr reaches the fatal classifier; the same text on stdout never does.
// (2) A crashed verify is not a repeat of the previous failure signature (a preload replaces only verify's run).
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOKI_TS = resolve(import.meta.dir, "../..");
const BIN_LOKI = resolve(LOKI_TS, "../bin/loki");
const FIX = join(import.meta.dir, "fixtures", "e2e");
const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

const STUB = `#!/bin/sh
case "$*" in *--help*) echo "--settings"; exit 0;; esac
[ -n "$STUB_ERR" ] && echo "$STUB_ERR" >&2
[ -n "$STUB_PLANT" ] && echo "$STUB_PLANT" > ".loki/iteration-$LOKI_ITERATION.log.stderr"
[ -n "$STUB_REWRITE" ] && ( perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sh -c 'i=0; while [ $i -lt 100000 ]; do echo "Your credit balance is too low" > ".loki/iteration-$LOKI_ITERATION.log.stderr"; i=$((i+1)); done'>/dev/null 2>&1 & )
[ -n "$STUB_REWRITE" ] && sleep 0.1
[ -n "$STUB_OUT" ] && echo "$STUB_OUT"
exit \${STUB_EXIT:-0}
`;
// Replaces only verify's run: each call takes the next token of VERIFY_SEQ (X fails with signature X, crash throws, anything else passes).
const PLUGIN = `import { plugin } from "bun";
plugin({ name: "verify-seq", setup(b) {
  b.onLoad({ filter: /engine10\\/stages\\/verify\\.ts$/ }, async (a) => ({ loader: "ts", contents: (await Bun.file(a.path).text()) + \`
let __i = 0;
(verifyStage as any).run = async () => {
  const seq = (process.env.VERIFY_SEQ ?? "").split(",");
  const t = seq[Math.min(__i++, seq.length - 1)];
  if (t === "crash") throw new Error("verify crashed");
  const g = t === "X" ? [{ signature: "X", count: 1, sample: "X" }] : [];
  return { status: "completed", data: { checks: [], flaky: [], failures_grouped: g, changed_files: [], not_proven: [], pre_red: [], pre_red_checks: [] } };
};\` }));
} });
`;

function run(env: Record<string, string>) {
  const tmp = mkdtempSync(join(tmpdir(), "loki-a113b-")); temps.push(tmp);
  const repo = join(tmp, "repo");
  cpSync(join(FIX, "repo"), repo, { recursive: true });
  const git = (...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd: repo }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  git("init", "-q", "-b", "main"); git("config", "user.name", "t"); git("config", "user.email", "t@example.invalid");
  git("add", "calc.ts", "calc.test.ts", "bunfig.toml"); git("commit", "-q", "-m", "base");
  const bin = join(tmp, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "claude"), STUB, { mode: 0o755 });
  const plugin = join(tmp, "plugin.ts"); writeFileSync(plugin, PLUGIN);
  const e: Record<string, string | undefined> = {
    ...process.env, LOKI_TS_ENTRY: join(LOKI_TS, "src", "cli.ts"), LOKI_E10_INVOKER: "cli",
    LOKI_CLAUDE_CLI: join(bin, "claude"), PATH: `${bin}:${process.env.PATH ?? ""}`, LOKI_NO_BROWSER: "1",
    HOME: tmp, LOKI_RECEIPT_SIGNING_KEY_FILE: join(tmp, "k.pem"), BUN_OPTIONS: `--preload ${plugin}`, ...env,
  };
  delete e.LOKI_LEGACY_BASH; delete e.LOKI_MODEL_OVERRIDE; delete e.LOKI_RECEIPT_SIGNING_KEY;
  const r = Bun.spawnSync(["bash", BIN_LOKI, "add a multiply(a, b) function to calc.ts", "--no-pr", "--json"], { cwd: repo, env: e, timeout: 90_000 });
  const out = r.stdout.toString();
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) throw new Error(`no --json line: ${out}${r.stderr.toString()}`);
  return { json: JSON.parse(line) as { outcome: string; stop: string | null }, code: r.exitCode };
}

describe("A-113b fatal classification through the CLI invoker", () => {
  for (const [text, stop] of [["Your credit balance is too low to access the API", "fatal:quota_exhausted"], ["Invalid API key. API key is invalid", "fatal:auth"]] as const) {
    test(`stderr '${text}' stops ${stop}`, () => {
      expect(run({ STUB_ERR: text, STUB_EXIT: "1" }).json.stop).toBe(stop);
    }, 120_000);
    test(`the same text on stdout is NOT fatal (transcript forgery guard)`, () => {
      expect(run({ STUB_OUT: text, STUB_EXIT: "1" }).json.stop ?? "").not.toMatch(/^fatal/);
    }, 120_000);
  }
  test("a .stderr file the agent plants is overwritten, never classified (forgery guard)", () => {
    expect(run({ STUB_PLANT: "Your credit balance is too low", STUB_EXIT: "1" }).json.stop ?? "").not.toMatch(/^fatal/);
  }, 120_000);
  test("a detached rewriter of the sidecar path is never classified (race guard, repeated)", () => {
    for (let i = 0; i < 3; i++) expect(run({ STUB_REWRITE: "1", STUB_EXIT: "1" }).json.stop ?? "").not.toMatch(/^fatal/);
  }, 300_000);
});

describe("A-113b crashed verify is not a stall repeat", () => {
  test("control: X, X, X is STALLED", () => { expect(run({ VERIFY_SEQ: "X" }).json.outcome).toBe("STALLED"); }, 120_000);
  test("X, crash, X is not STALLED", () => {
    expect(run({ VERIFY_SEQ: "X,crash,X,ok" }).json.outcome).not.toBe("STALLED");
  }, 120_000);
});
