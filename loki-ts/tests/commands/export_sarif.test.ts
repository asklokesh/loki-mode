// SARIF-2: `loki export --sarif`. Fixture run dir yields a file; unknown run exits 66; secrets never leak; help lists the flag.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, scanDiff } from "../../src/commands/export_sarif.ts";

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const SHA = (c: string) => c.repeat(40);

function fixture(): { root: string; runs: string } {
  const root = mkdtempSync(join(tmpdir(), "sarif2-"));
  const runs = join(root, "runs");
  mkdirSync(join(runs, "e10-1-aaaa"), { recursive: true });
  writeFileSync(join(runs, "e10-1-aaaa", "receipt.json"), JSON.stringify({
    base_sha: SHA("a"), head_sha: SHA("b"), not_proven: ["perf claim has no benchmark"],
    checks: [{ name: "unit", result: "fail" }, { name: "lint", result: "pass" }],
  }));
  return { root, runs };
}
const diff = `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +5,2 @@\n+const ok = 1;\n+const t = "${TOKEN}";\n`;

async function run(args: string[], deps: Parameters<typeof main>[1]) {
  let out = "", err = "";
  const o = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try { return { rc: await main(args, deps), out, err }; } finally { process.stdout.write = o; process.stderr.write = e; }
}

describe("export --sarif", () => {
  test("fixture run writes findings.sarif with secret, not-proven and failed check, no secret value", async () => {
    const { root, runs } = fixture();
    try {
      const r = await run(["--sarif", "e10-1-aaaa"], { runsRoot: runs, diff: async () => diff });
      expect(r.rc).toBe(0);
      const path = join(runs, "e10-1-aaaa", "findings.sarif");
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain(TOKEN);
      const results = JSON.parse(text).runs[0].results as { ruleId: string; locations?: { physicalLocation: { region: { startLine: number } } }[] }[];
      expect(results.map((x) => x.ruleId).sort()).toEqual(["loki/not-proven", "loki/secret-scan", "loki/verify-failure"]);
      expect(results.find((x) => x.ruleId === "loki/secret-scan")!.locations![0]!.physicalLocation.region.startLine).toBe(6);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("defaults to the latest run; findings never change the exit code", async () => {
    const { root, runs } = fixture();
    try { expect((await run(["--sarif"], { runsRoot: runs, diff: async () => diff })).rc).toBe(0); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("unknown run exits 66, no runs exits 66, bad flag exits 2", async () => {
    const { root, runs } = fixture();
    try {
      expect((await run(["--sarif", "e10-nope"], { runsRoot: runs })).rc).toBe(66);
      expect((await run(["--sarif", "../x"], { runsRoot: runs })).rc).toBe(66);
      expect((await run(["--sarif"], { runsRoot: join(root, "empty") })).rc).toBe(66);
      expect((await run(["--sarif", "--bogus"], { runsRoot: runs })).rc).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("uncomputable diff is reported as not-proven, template paths are skipped", async () => {
    const { root, runs } = fixture();
    try {
      await run(["--sarif", "e10-1-aaaa"], { runsRoot: runs, diff: async () => null });
      expect(readFileSync(join(runs, "e10-1-aaaa", "findings.sarif"), "utf8")).toContain("secret scan skipped");
      expect(scanDiff(diff.replace(/a\/src\/a.ts|b\/src\/a.ts/g, "b/.env.example"))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("help lists the flag", async () => {
    const r = await run(["--help"], {});
    expect(r.rc).toBe(0);
    expect(r.out).toContain("loki export --sarif");
  });
});

describe("export --sarif uris", () => {
  test("absolute paths under the repo become repo-relative; outside paths are dropped", async () => {
    const { root, runs } = fixture();
    try {
      const d = `+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+x = "${TOKEN}"\n`;
      await run(["--sarif", "e10-1-aaaa"], { runsRoot: runs, repoDir: root, diff: async () => d });
      const log = JSON.parse(readFileSync(join(runs, "e10-1-aaaa", "findings.sarif"), "utf8"));
      const uris = log.runs[0].results.flatMap((r: any) => (r.locations ?? []).map((l: any) => l.physicalLocation.artifactLocation.uri));
      expect(uris).toEqual(["src/a.ts"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("export --sarif vendor keys", () => {
  const J = (...p: string[]) => p.join("");
  const cases: [string, string][] = [
    ["anthropic-api-key", J("sk-", "ant-", "api03-", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv_-wX")],
    ["openai-project-key", J("sk-", "proj-", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0")],
    ["npm-token", J("npm", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")],
    ["stripe-key", J("sk", "_live_", "a1B2c3D4e5F6g7H8i9J0k1L2m3")],
    ["jwt", J("eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".dBjftJeZ4CVPmB92K27uhbUJU1p1r")],
  ];
  const mk = (line: string) => `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+const t = "${line}";\n`;
  test.each(cases)("vendor keys: %s is reported through main without the value", async (label, key) => {
    const { root, runs } = fixture();
    try {
      expect(scanDiff(mk(key)).map((f) => f.key)).toEqual([label]);
      const r = await run(["--sarif", "e10-1-aaaa"], { runsRoot: runs, diff: async () => mk(key) });
      expect(r.rc).toBe(0);
      const sarif = readFileSync(join(runs, "e10-1-aaaa", "findings.sarif"), "utf8");
      expect(sarif.match(/"ruleId": "loki\/secret-scan"/g)?.length).toBe(1);
      expect(sarif).not.toContain(key);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("vendor keys: clean lookalikes report 0", () => {
    for (const clean of ["risk-assessment-framework-documentation", "task-management-workflow-orchestrator", "const npm_config = 1;", "sk_live_ placeholder", "eyJ.short.tok", "sk-ant-api03-short"]) {
      expect(scanDiff(mk(clean))).toEqual([]);
    }
  });
});

describe("export --sarif extra token formats", () => {
  const J = (...p: string[]) => p.join("");
  const cases: [string, string][] = [
    ["huggingface-token", J("hf", "_", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5")],
    ["sendgrid-key", J("SG", ".", "aB3dE5gH7jK9mN1pQ3sT5v", ".", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9u")],
    ["twilio-key", J("SK", "0123456789abcdef0123456789abcdef")],
    ["azure-storage-key", J("Account", "Key=", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ0123456789+/abcd==")],
  ];
  const mk = (line: string) => `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+const t = "${line}";\n`;
  test.each(cases)("extra token formats: %s is reported through main label-only", async (label, key) => {
    const { root, runs } = fixture();
    try {
      expect(scanDiff(mk(key)).map((f) => f.key)).toEqual([label]);
      const r = await run(["--sarif", "e10-1-aaaa"], { runsRoot: runs, diff: async () => mk(key) });
      expect(r.rc).toBe(0);
      const sarif = readFileSync(join(runs, "e10-1-aaaa", "findings.sarif"), "utf8");
      expect(sarif.match(/"ruleId": "loki\/secret-scan"/g)?.length).toBe(1);
      expect(sarif).not.toContain(key);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("extra token formats: clean lookalikes report 0", () => {
    for (const clean of ["const hf_model = 'bert';", "hf_short", "SG.short.tok", "SK0123", "AccountKey=short", "MASK0123456789abcdef0123456789abcdef"]) {
      expect(scanDiff(mk(clean))).toEqual([]);
    }
  });
});

describe("export --sarif more token shapes", () => {
  const J = (...p: string[]) => p.join("");
  const B = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ01";
  const cases: [string, string][] = [
    ["pypi-token", J("pypi", "-AgEI", B)],
    ["docker-pat", J("dckr", "_pat_", "aB3dE5gH7jK9mN1pQ3sT5v")],
    ["digitalocean-token", J("dop", "_v1_", "0123456789abcdef".repeat(4))],
    ["google-oauth-token", J("ya29", ".", "aB3dE5gH7jK9mN1pQ3sT5vW7")],
    ["shopify-token", J("shp", "at_", "0123456789abcdef0123456789abcdef")],
    ["postman-key", J("PM", "AK-", "aB3dE5gH7jK9mN1pQ3sT5vW7", "-", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3j")],
  ];
  const mk = (line: string) => `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+const t = "${line}";\n`;
  test.each(cases)("more token shapes: %s is reported through main label-only", async (label, key) => {
    const { root, runs } = fixture();
    try {
      expect(scanDiff(mk(key)).map((f) => f.key)).toEqual([label]);
      const r = await run(["--sarif", "e10-1-aaaa"], { runsRoot: runs, diff: async () => mk(key) });
      expect(r.rc).toBe(0);
      const sarif = readFileSync(join(runs, "e10-1-aaaa", "findings.sarif"), "utf8");
      expect(sarif.match(/"ruleId": "loki\/secret-scan"/g)?.length).toBe(1);
      expect(sarif).not.toContain(key);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("more token shapes: clean lookalikes report 0", () => {
    for (const clean of ["pypi-AgEIshort", "pypi-install", "dckr_pat_x", "dop_v1_abc", "ya29.short", "shpat_abc", "PMAK-short-tok", "xya29.aB3dE5gH7jK9mN1pQ3sT5vW7"]) {
      expect(scanDiff(mk(clean))).toEqual([]);
    }
  });
});
