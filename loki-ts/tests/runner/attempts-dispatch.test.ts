// FC-37: `bin/loki start "<task>" --attempts N` must reach the attempts runner on the positional
// (engine10) route too. A stub entry answers `engine10`; start delegates to the real runStart.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const REPO = resolve(import.meta.dir, "../../..");
const SEAL_TS = join(REPO, "loki-ts/src/engine10/stages/seal.ts");
const START_TS = join(REPO, "loki-ts/src/commands/start.ts");

function sh(cwd: string, cmd: string, args: string[]) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8" });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loki-attempts-dispatch-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  sh(repo, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "sum.js"), "exports.sum = (a) => a.slice(1).reduce((x, y) => x + y, 0);\n");
  writeFileSync(join(repo, ".gitignore"), ".loki/\n");
  sh(repo, "git", ["add", "sum.js", ".gitignore"]);
  sh(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
  const log = join(root, "engine.log");
  const keyFile = join(root, "key.pem");
  writeFileSync(keyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  const entry = join(root, "entry.ts");
  writeFileSync(
    entry,
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const a = process.argv.slice(2);
if (a[0] === "engine10") {
  const wts = spawnSync("git", ["worktree", "list"], { encoding: "utf8" }).stdout.trim().split("\\n").length;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), wts, argv: a.slice(1) }) + "\\n");
  writeFileSync("sum.js", "exports.sum = (a) => a.reduce((x, y) => x + y, 0);\\n");
  mkdirSync(".loki/runs/stub", { recursive: true });
  const { receiptSha256, signReceipt } = await import(${JSON.stringify(SEAL_TS)});
  const body: Record<string, unknown> = { run_id: "stub", verdict: "VERIFIED", checks: [{ name: "t", cmd: "t", result: "pass", duration_s: 1, n: 3 }], verification: {} };
  body["receipt_sha256"] = receiptSha256(body);
  const { jwt, kid } = signReceipt("stub", body["receipt_sha256"]);
  body["verification"] = { jwt, kid };
  writeFileSync(".loki/runs/stub/receipt.json", JSON.stringify(body));
  process.exit(0);
}
const { runStart } = await import(${JSON.stringify(START_TS)});
process.exit(await runStart(a.slice(1)));
`,
  );
  return { root, repo, log, entry, keyFile };
}

function run(f: ReturnType<typeof fixture>, args: string[], extra: { pathPrefix?: string } = {}) {
  return spawnSync(join(REPO, "bin/loki"), args, {
    cwd: f.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, PATH: `${extra.pathPrefix ? `${extra.pathPrefix}:` : ""}${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LOKI_TS_ENTRY: f.entry, LOKI_NO_BROWSER: "1", LOKI_RECEIPT_SIGNING_KEY_FILE: f.keyFile, LOKI_DIR: join(f.repo, ".loki") },
  });
}

/** A bare origin plus a stub gh that records its argv, so the default (PR) path can be exercised for real. */
function withOriginAndGh(f: ReturnType<typeof fixture>) {
  const origin = join(f.root, "origin.git");
  sh(f.root, "git", ["init", "-q", "--bare", origin]);
  // A GitHub-shaped origin (the pin must parse as one) that insteadOf redirects to the local bare repo.
  sh(f.repo, "git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  sh(f.repo, "git", ["config", `url.${origin}.insteadOf`, "https://github.com/acme/widgets.git"]);
  const bin = join(f.root, "ghbin");
  mkdirSync(bin);
  const ghLog = join(f.root, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ghLog)}\necho https://example.invalid/pr/1\n`, { mode: 0o755 });
  return { bin, ghLog };
}

describe("FC-38 start never reaches the legacy loop", () => {
  it("a PRD-path start runs engine10 (one sealed run), not runAutonomous", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, "prd.md"), "Fix sum so it includes the first element.\n");
      const r = run(f, ["start", "prd.md", "--no-pr"]);
      expect(r.status).toBe(0);
      const lines = readFileSync(f.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[] });
      expect(lines.length).toBe(1);
      expect(lines[0]!.argv[0]).toContain("Fix sum so it includes the first element.");
      expect(lines[0]!.argv).toContain("--no-pr");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("a one-word task and a bare start run engine10 or refuse, never the legacy loop", () => {
    const f = fixture();
    try {
      const r = run(f, ["start", "refactor", "--no-pr"]);
      expect(r.status).toBe(0);
      expect(readFileSync(f.log, "utf8").trim().split("\n").length).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("a flag only the legacy loop honored is refused loudly (rc 2), engine never runs", () => {
    const f = fixture();
    try {
      for (const flag of ["--parallel", "--github", "--sandbox", "--detach"]) {
        const r = run(f, ["start", "prd.md", flag]);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("only the Loki 10 engine");
      }
      expect(existsSync(f.log)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("a provider engine10 cannot invoke is refused, not sent to the legacy engine", () => {
    const f = fixture();
    try {
      const r = spawnSync(join(REPO, "bin/loki"), ["start", "prd.md"], { cwd: f.repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LOKI_TS_ENTRY: f.entry, LOKI_PROVIDER: "opencode", LOKI_NO_BROWSER: "1" } });
      expect(r.status).toBe(2);
      expect(existsSync(f.log)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("FC-37 --attempts on the positional start route", () => {
  it("runs 2 attempt worktrees for `start \"<multi word task>\" --no-pr --attempts 2`", () => {
    const f = fixture();
    try {
      const r = run(f, ["start", "sum skips the first element; fix it", "--no-pr", "--attempts", "2"]);
      expect(r.status).toBe(0);
      const lines = readFileSync(f.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; wts: number; argv: string[] });
      expect(lines.length).toBe(2);
      expect(new Set(lines.map((l) => l.cwd)).size).toBe(2);
      expect(lines.every((l) => l.cwd !== f.repo)).toBe(true);
      expect(Math.max(...lines.map((l) => l.wts))).toBeGreaterThanOrEqual(3);
      expect(readFileSync(join(f.repo, "sum.js"), "utf8")).toContain("a.reduce");
      const att = join(f.repo, ".loki", "attempts");
      expect(existsSync(att)).toBe(true);
      const rc = JSON.parse(readFileSync(join(att, readdirSync(att)[0]!, "attempts-receipt.json"), "utf8")) as { ran: number; requested: number };
      expect(rc.ran).toBe(2);
      expect(rc.requested).toBe(2);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses an out-of-range or valueless --attempts loudly", () => {
    const f = fixture();
    try {
      expect(run(f, ["start", "fix the thing please", "--attempts", "9"]).status).not.toBe(0);
      expect(run(f, ["start", "fix the thing please", "--attempts"]).status).not.toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("maps --budget to the engine10 per-run cap instead of gluing it onto the task", () => {
    const f = fixture();
    try {
      const r = run(f, ["start", "fix the thing please", "--attempts", "2", "--budget", "3", "--no-pr"]);
      expect(r.status).toBe(0);
      const lines = readFileSync(f.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[] });
      for (const l of lines) {
        expect(l.argv).toContain("--max-cost");
        expect(l.argv[0]).toBe("fix the thing please");
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("--no-pr both ways through the real wiring", () => {
  it("with --attempts and no --no-pr: children never open PRs, the winner's PR is opened once", () => {
    const f = fixture();
    try {
      const g = withOriginAndGh(f);
      const r = run(f, ["start", "sum skips the first element; fix it", "--attempts", "2"], { pathPrefix: g.bin });
      expect(r.status).toBe(0);
      const lines = readFileSync(f.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[] });
      expect(lines.length).toBe(2);
      for (const l of lines) expect(l.argv).toContain("--no-pr");
      const calls = readFileSync(g.ghLog, "utf8").trim().split("\n");
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("pr create");
      const att = join(f.repo, ".loki", "attempts");
      const rc = JSON.parse(readFileSync(join(att, readdirSync(att)[0]!, "attempts-receipt.json"), "utf8")) as { winner: { attempt_id: number }; pr: { mode: string; url?: string } };
      expect(rc.pr.mode).toBe("opened");
      expect(calls[0]).toContain("--head loki-attempt/");
      expect(calls[0]).toContain(`attempt-${rc.winner.attempt_id}`);
      expect(r.stdout).toContain("PR:         https://example.invalid/pr/1");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("with --attempts and --no-pr: gh is never called and the receipt says skipped_no_pr", () => {
    const f = fixture();
    try {
      const g = withOriginAndGh(f);
      const r = run(f, ["start", "sum skips the first element; fix it", "--attempts", "2", "--no-pr"], { pathPrefix: g.bin });
      expect(r.status).toBe(0);
      expect(existsSync(g.ghLog)).toBe(false);
      const att = join(f.repo, ".loki", "attempts");
      const rc = JSON.parse(readFileSync(join(att, readdirSync(att)[0]!, "attempts-receipt.json"), "utf8")) as { pr: { mode: string } };
      expect(rc.pr.mode).toBe("skipped_no_pr");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("a plain single start without --no-pr leaves --no-pr out of the engine10 argv; with it, passes it", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, "prd.md"), "Fix sum so it includes the first element.\n");
      expect(run(f, ["start", "prd.md"]).status).toBe(0);
      const first = JSON.parse(readFileSync(f.log, "utf8").trim().split("\n")[0]!) as { argv: string[] };
      expect(first.argv).not.toContain("--no-pr");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("preserves each attempt's sealed run dir past worktree removal and cites its sha256", () => {
    const f = fixture();
    try {
      const r = run(f, ["start", "sum skips the first element; fix it", "--attempts", "2", "--no-pr"]);
      expect(r.status).toBe(0);
      const att = join(f.repo, ".loki", "attempts");
      const dir = join(att, readdirSync(att)[0]!);
      const rc = JSON.parse(readFileSync(join(dir, "attempts-receipt.json"), "utf8")) as { attempts: { attempt_id: number; engine10: { receipt_sha256: string; preserved_path: string } }[] };
      expect(rc.attempts.length).toBe(2);
      for (const a of rc.attempts) {
        const kept = JSON.parse(readFileSync(join(a.engine10.preserved_path, "receipt.json"), "utf8")) as { receipt_sha256: string };
        expect(kept.receipt_sha256).toBe(a.engine10.receipt_sha256);
      }
      expect(r.stdout).toContain("kept at ");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("FC-38 bin/loki start fallbacks refuse instead of reaching autonomy/loki", () => {
  const refused = (r: ReturnType<typeof spawnSync>) => {
    expect(r.status).toBe(1);
    expect(String(r.stderr)).toContain("Loki 10 engine");
    expect(String(r.stdout)).not.toContain("Loki Mode");
  };
  it("a missing LOKI_TS_ENTRY", () => {
    const f = fixture();
    try {
      const r = spawnSync(join(REPO, "bin/loki"), ["start", "fix the thing please"], { cwd: f.repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LOKI_TS_ENTRY: join(f.root, "missing.ts"), LOKI_NO_BROWSER: "1" } });
      refused(r);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("LOKI_LEGACY_BASH=1", () => {
    const f = fixture();
    try {
      const r = spawnSync(join(REPO, "bin/loki"), ["start", "fix the thing please"], { cwd: f.repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LOKI_TS_ENTRY: f.entry, LOKI_LEGACY_BASH: "1", LOKI_NO_BROWSER: "1" } });
      refused(r);
      expect(existsSync(f.log)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("no bun on PATH with a PRD path (the bare no-bun start refusal, past the engine10 arm)", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, "prd.md"), "Fix sum.\n");
      const r = spawnSync(join(REPO, "bin/loki"), ["start", "prd.md"], { cwd: f.repo, encoding: "utf8", timeout: 60_000, env: { PATH: "/usr/bin:/bin", HOME: f.root, LOKI_TS_ENTRY: f.entry, LOKI_NO_BROWSER: "1" } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not reachable from start");
      expect(existsSync(f.log)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("no bun on PATH", () => {
    const f = fixture();
    try {
      const r = spawnSync(join(REPO, "bin/loki"), ["start", "fix the thing please"], { cwd: f.repo, encoding: "utf8", timeout: 60_000, env: { PATH: "/usr/bin:/bin", HOME: f.root, LOKI_TS_ENTRY: f.entry, LOKI_NO_BROWSER: "1" } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("needs bun");
      expect(existsSync(f.log)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
