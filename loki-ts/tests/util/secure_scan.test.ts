import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecurityScan } from "../../src/runner/quality_gates.ts";
import type { RunnerContext } from "../../src/runner/types.ts";
import { ADDED_LINE_RULE, parseAddedLines, parseDiffHeaderPath, runSecureScan } from "../../src/util/secure_scan.ts";

const dir = mkdtempSync(join(tmpdir(), "secure-scan-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const FINDING = { rule: "debug-in-prod", file: "a.env", line: 3, severity: "MEDIUM", message: "m", fix: "f" };

describe("runSecureScan", () => {
  it("pass: exit 0 gives ok with no findings", async () => {
    const s = fake("pass.py", 'import json\nprint(json.dumps({"findings":[]}))\n');
    const r = await runSecureScan(dir, { scriptPath: s });
    expect(r).toEqual({ ok: true, findings: [] });
  });

  it("findings: exit 1 gives ok with typed findings", async () => {
    const s = fake("find.py", `import json,sys\nprint(json.dumps({"findings":[${JSON.stringify(FINDING)}]}))\nsys.exit(1)\n`);
    const r = await runSecureScan(dir, { scriptPath: s });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([FINDING]);
  });

  it("crash: traceback with non-JSON output is an error, not a pass", async () => {
    const s = fake("crash.py", 'raise RuntimeError("boom")\n');
    const r = await runSecureScan(dir, { scriptPath: s });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.error).toContain("boom");
  });

  it("bad input: exit 2 surfaces the script error message", async () => {
    const s = fake("bad.py", 'import json,sys\nprint(json.dumps({"error":"nope"}))\nsys.exit(2)\n');
    const r = await runSecureScan(dir, { scriptPath: s });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
  });

  it("timeout: slow script is killed and reported", async () => {
    const s = fake("slow.py", "import time\ntime.sleep(30)\n");
    const r = await runSecureScan(dir, { scriptPath: s, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
  });

  it("missing script is an error", async () => {
    const r = await runSecureScan(dir, { scriptPath: join(dir, "absent.py") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("real script on a clean dir passes", async () => {
    const r = await runSecureScan(dir);
    expect(r.ok).toBe(true);
  });
});

describe("runSecureScan token rules (real scanner)", () => {
  const tokens: Record<string, string> = {
    "ghp.txt": "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "gho.txt": "gho_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "ghs.txt": "ghs_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    "fine.txt": "github_pat_" + "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789",
    "aws.txt": "AKIA" + "ABCDEFGHIJKLMNOP",
    "ant.txt": "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123",
    "sk.txt": "sk-" + "abcdefghijklmnopqrstuvwx1234",
    "slack.txt": "xoxp-" + "1234567890-abcdefghij",
  };
  for (const [name, tok] of Object.entries(tokens)) {
    it(`secretsEverywhere flags ${name}`, async () => {
      const d = mkdtempSync(join(tmpdir(), "secure-scan-tok-"));
      try {
        writeFileSync(join(d, name), `{"note":"${tok}"}\n`);
        const on = await runSecureScan(d, { secretsEverywhere: true });
        expect(on.ok).toBe(true);
        expect(on.findings.length).toBeGreaterThan(0);
        expect(on.findings[0]!.severity).toBe("HIGH");
        const off = await runSecureScan(d);
        expect(off.findings).toEqual([]);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });
  }
  it("secretsEverywhere flags a PEM private key in events.jsonl", async () => {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-pem-"));
    try {
      writeFileSync(join(d, "events.jsonl"), '{"k":"-----BEGIN ' + 'PRIVATE KEY-----"}\n');
      const r = await runSecureScan(d, { secretsEverywhere: true });
      expect(r.findings.map((f) => f.rule)).toContain("private-key-committed");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// TEN-SECURITY-01: the pre-PR scan blocks a provider key on an ADDED line in any
// file (server code included), naming file:line and never echoing the value.
// Keys are built at runtime so the fixture itself never trips gitleaks.
describe("runSecureScan added-line provider keys (TEN-SECURITY-01)", () => {
  const body = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const KEYS = {
    ant: ["sk", "ant", "api03", body].join("-"),
    google: "AI" + "za" + body.slice(0, 35),
    slack: ["xo" + "xb", "1234567890", "abcdefghij"].join("-"),
    github: "gh" + "p_" + body,
  };

  function git(repo: string, ...args: string[]): void {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  function repoWithBase(): string {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-diff-"));
    git(d, "init", "-q");
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "config.ts"), "export const a = 1;\nexport const b = 2;\n");
    git(d, "add", "src/config.ts");
    git(d, "commit", "-q", "-m", "base");
    return d;
  }

  it("user diff prefix config (noprefix, mnemonicPrefix) does not hide an added key", async () => {
    for (const cfg of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"]] as const) {
      const d = repoWithBase();
      try {
        git(d, "config", cfg[0], cfg[1]);
        writeFileSync(join(d, "src", "config.ts"), `export const a = 1;\nexport const key = "${KEYS.ant}";\nexport const b = 2;\n`);
        const r = await runSecureScan(d);
        expect(r.ok).toBe(true);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0]).toMatchObject({ rule: ADDED_LINE_RULE, file: "src/config.ts", line: 2 });
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("red-then-green: a runtime-built sk-ant key added to server code is blocked at file:line", async () => {
    const d = repoWithBase();
    try {
      writeFileSync(join(d, "src", "config.ts"), `export const a = 1;\nexport const key = "${KEYS.ant}";\nexport const b = 2;\n`);
      const r = await runSecureScan(d);
      expect(r.ok).toBe(true);
      expect(r.findings).toHaveLength(1);
      const f = r.findings[0]!;
      expect(f).toMatchObject({ rule: ADDED_LINE_RULE, file: "src/config.ts", line: 2, severity: "HIGH" });
      expect(f.message).toContain("src/config.ts:2");
      expect(f.message).toContain("anthropic-key");
      expect(JSON.stringify(r)).not.toContain(KEYS.ant);
      // The off switch is the old behavior: server code was never scanned.
      const off = await runSecureScan(d, { diffBase: false });
      expect(off.findings).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("flags AIza, xoxb and ghp_ keys in committed and untracked added lines", async () => {
    const d = repoWithBase();
    try {
      const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).stdout.trim();
      writeFileSync(join(d, "src", "svc.py"), `x = 1\nGOOGLE = "${KEYS.google}"\n`);
      git(d, "add", "src/svc.py");
      git(d, "commit", "-q", "-m", "add svc");
      writeFileSync(join(d, "notes.yaml"), `slack: ${KEYS.slack}\n\ngithub: ${KEYS.github}\n`);
      const r = await runSecureScan(d, { diffBase: base });
      expect(r.ok).toBe(true);
      const got = r.findings.map((f) => `${f.rule} ${f.file}:${f.line}`).sort();
      expect(got).toEqual([`${ADDED_LINE_RULE} notes.yaml:1`, `${ADDED_LINE_RULE} notes.yaml:3`, `${ADDED_LINE_RULE} src/svc.py:2`]);
      const text = JSON.stringify(r);
      for (const k of Object.values(KEYS)) expect(text).not.toContain(k);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("a clean diff passes and a key already in the base is not re-flagged", async () => {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-diff-"));
    try {
      git(d, "init", "-q");
      writeFileSync(join(d, "old.ts"), `const k = "${KEYS.ant}";\n`);
      git(d, "add", "old.ts");
      git(d, "commit", "-q", "-m", "base");
      writeFileSync(join(d, "old.ts"), `const k = "${KEYS.ant}";\nconst clean = process.env.ANTHROPIC_API_KEY;\n`);
      writeFileSync(join(d, "new.ts"), "export const n = 3;\n");
      const r = await runSecureScan(d);
      expect(r).toMatchObject({ ok: true, findings: [] });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("oversized untracked file: key past 1 MB is flagged at its line, file over the cap is listed as skipped", async () => {
    const d = repoWithBase();
    try {
      const pad = "x".repeat(99) + "\n";
      const big = pad.repeat(30_000) + `const k = "${KEYS.ant}";\n` + pad.repeat(5_000);
      writeFileSync(join(d, "big.txt"), big);
      writeFileSync(join(d, "huge.bin.txt"), "");
      truncateSync(join(d, "huge.bin.txt"), 65 * 1024 * 1024);
      const r = await runSecureScan(d);
      expect(r.ok).toBe(true);
      const got = r.findings.map((f) => `${f.rule} ${f.file}:${f.line}`).sort();
      expect(got).toEqual([`${ADDED_LINE_RULE} big.txt:30001`, "untracked-file-not-scanned huge.bin.txt:0"]);
      expect(JSON.stringify(r)).not.toContain(KEYS.ant);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("oversized untracked file: one 3 MB line and multibyte chunks still yield the key at its line", async () => {
    const d = repoWithBase();
    try {
      writeFileSync(join(d, "f.js"), `var a=${"1,".repeat(1_500_000)}k="${KEYS.ant}";\n`);
      const cjk = "\u4e2d".repeat(999) + "\n";
      writeFileSync(join(d, "cjk.txt"), `const k = "${KEYS.ant}";\n` + cjk.repeat(1000) + `const j = "${KEYS.ant}";\n`);
      writeFileSync(join(d, "ok.txt"), `x\nconst k = "${KEYS.ant}";\n`);
      const r = await runSecureScan(d);
      expect(r.ok).toBe(true);
      const got = r.findings.map((f) => `${f.rule} ${f.file}:${f.line}`).sort();
      expect(got).toEqual([
        `${ADDED_LINE_RULE} cjk.txt:1`,
        `${ADDED_LINE_RULE} cjk.txt:1002`,
        `${ADDED_LINE_RULE} f.js:1`,
        `${ADDED_LINE_RULE} ok.txt:2`,
      ]);
      expect(JSON.stringify(r)).not.toContain(KEYS.ant);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("a real untracked file named like a chunk path does not collide", async () => {
    const d = repoWithBase();
    try {
      const pad = "x".repeat(99) + "\n";
      writeFileSync(join(d, "big.txt"), pad.repeat(30_000) + `const k = "${KEYS.ant}";\n`);
      mkdirSync(join(d, "big.txt.loki-chunk-0"));
      writeFileSync(join(d, "big.txt.loki-chunk-0", "big.txt"), "clean\n");
      const r = await runSecureScan(d);
      expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["big.txt:30001"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("the security_scan gate blocks and its receipt names file:line without the value", async () => {
    const d = repoWithBase();
    try {
      writeFileSync(join(d, "src", "config.ts"), `export const a = 1;\nexport const b = 2;\nconst k = "${KEYS.ant}";\n`);
      const ctx = { cwd: d, lokiDir: join(d, ".loki"), log: () => {} } as unknown as RunnerContext;
      const g = await runSecurityScan(ctx);
      expect(g.passed).toBe(false);
      const receipt = readFileSync(join(d, ".loki", "quality", "security-findings.json"), "utf8");
      expect(receipt).not.toContain(KEYS.ant);
      const doc = JSON.parse(receipt) as { high_active: number; findings: Array<{ rule: string; file: string; line: number }> };
      expect(doc.high_active).toBe(1);
      expect(doc.findings[0]).toMatchObject({ rule: ADDED_LINE_RULE, file: "src/config.ts", line: 3 });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("an added line starting with \"++ \" does not hide a later key or shift its line", async () => {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-diff-"));
    try {
      git(d, "init", "-q");
      writeFileSync(join(d, "a.md"), "x\n");
      git(d, "add", "a.md");
      git(d, "commit", "-q", "-m", "base");
      writeFileSync(join(d, "a.md"), `x\n++ note\nk=${KEYS.ant}\n`);
      const r = await runSecureScan(d);
      expect(r.ok).toBe(true);
      expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["a.md:3"]);
      writeFileSync(join(d, "a.md"), `x\n++ b/a.md\nk=${KEYS.ant}\n`);
      const r2 = await runSecureScan(d);
      expect(r2.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["a.md:3"]);
      expect(JSON.stringify([r, r2])).not.toContain(KEYS.ant);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("paths with a space or a tab are named exactly as on disk", async () => {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-diff-"));
    try {
      git(d, "init", "-q");
      writeFileSync(join(d, "my file.ts"), "x\n");
      writeFileSync(join(d, "tab\there.ts"), "x\n");
      git(d, "add", "my file.ts", "tab\there.ts");
      git(d, "commit", "-q", "-m", "base");
      writeFileSync(join(d, "my file.ts"), `x\nk=${KEYS.ant}\n`);
      writeFileSync(join(d, "tab\there.ts"), `x\nk=${KEYS.github}\n`);
      const r = await runSecureScan(d);
      expect(r.ok).toBe(true);
      expect(r.findings.map((f) => `${f.file}:${f.line}`).sort()).toEqual(["my file.ts:2", "tab\there.ts:2"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("parseDiffHeaderPath strips git's trailing tab and unquotes C-quoted paths", () => {
    expect(parseDiffHeaderPath("b/my file.ts\t")).toBe("my file.ts");
    expect(parseDiffHeaderPath('"b/tab\\there.ts"')).toBe("tab\there.ts");
    expect(parseDiffHeaderPath('"b/back\\\\slash \\"q\\".ts"')).toBe('back\\slash "q".ts');
    expect(parseDiffHeaderPath('"b/caf\\303\\251.ts"')).toBe("caf\u00e9.ts");
    expect(parseDiffHeaderPath("/dev/null")).toBeNull();
    expect(parseDiffHeaderPath('"b/unterminated')).toBeNull();
  });

  it("parseAddedLines keeps new-file line numbers across hunks", () => {
    const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,0 +2,2 @@", "+two", "+three", "@@ -9 +11 @@", "-old", "+eleven", "--- a/gone", "+++ /dev/null"].join("\n");
    const m = parseAddedLines(diff);
    expect([...m.keys()]).toEqual(["x"]);
    expect([...m.get("x")!.entries()]).toEqual([[2, "two"], [3, "three"], [11, "eleven"]]);
  });
});

describe("runSecureScan files_scanned (TEN-GATES-20)", () => {
  it("real script reports summary.files_scanned", () => {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-fs-"));
    try {
      writeFileSync(join(d, "a.txt"), "hello\n");
      writeFileSync(join(d, "b.txt"), "world\n");
      const r = spawnSync("python3", [join(import.meta.dir, "../../../autonomy/lib/secure-scan.py"), d, "--json"], { encoding: "utf8" });
      expect(JSON.parse(r.stdout).summary.files_scanned).toBe(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("empty directory is not_run, not a clean pass", async () => {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-empty-"));
    try {
      const r = await runSecureScan(d, { diffBase: false });
      expect(r.ok).toBe(false);
      expect(r.notRun).toBe(true);
      expect(r.filesScanned).toBe(0);
      expect(r.error).toContain("not_run");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("dir holding only skipped files (binary ext) is not_run", async () => {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-bin-"));
    try {
      writeFileSync(join(d, "x.png"), "not really a png");
      const r = await runSecureScan(d, { diffBase: false });
      expect(r.ok).toBe(false);
      expect(r.notRun).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("one scanned file passes and carries filesScanned", async () => {
    const d = mkdtempSync(join(tmpdir(), "secure-scan-one-"));
    try {
      writeFileSync(join(d, "a.txt"), "hello\n");
      const r = await runSecureScan(d, { diffBase: false });
      expect(r.ok).toBe(true);
      expect(r.filesScanned).toBe(1);
      expect(r.notRun).toBeUndefined();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("scanner that omits files_scanned (legacy) is not flagged not_run", async () => {
    const s = fake("legacy.py", 'import json\nprint(json.dumps({"findings":[],"summary":{"total":0}}))\n');
    const r = await runSecureScan(dir, { scriptPath: s, diffBase: false });
    expect(r).toEqual({ ok: true, findings: [] });
  });
});
