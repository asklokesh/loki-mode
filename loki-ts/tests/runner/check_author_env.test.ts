// The check author's accept child runs with a minimal env: no provider key, no GitHub token.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptCall, checkAuthorChildEnv } from "../../src/runner/check_author.ts";

test("checkAuthorChildEnv keeps only PATH, HOME, LANG and TMPDIR", () => {
  const env = checkAuthorChildEnv({ PATH: "/usr/bin", HOME: "/h", LANG: "C", TMPDIR: "/t", ANTHROPIC_API_KEY: "k", GH_TOKEN: "g", OPENAI_API_KEY: "o" });
  expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"]);
});

test("the accept child gets no ANTHROPIC_API_KEY or GH_TOKEN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "check-author-env-"));
  const prev = { a: process.env["ANTHROPIC_API_KEY"], g: process.env["GH_TOKEN"], t: process.env["GITHUB_TOKEN"] };
  try {
    const script = join(dir, "dump.py");
    const out = join(dir, "env.json");
    writeFileSync(script, "import json, os, sys\nopen(sys.argv[-1], 'w').write(json.dumps(dict(os.environ)))\n");
    process.env["ANTHROPIC_API_KEY"] = "sk-test-secret";
    process.env["GH_TOKEN"] = "ghp_test_secret";
    process.env["GITHUB_TOKEN"] = "ghp_test_secret2";
    const py = ["/usr/bin/python3", "/bin/python3"].find((p) => existsSync(p));
    if (py === undefined) return;
    expect(await acceptCall(py, script, "", [out])).toBe(true);
    const seen = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
    expect(seen["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(seen["GH_TOKEN"]).toBeUndefined();
    expect(seen["GITHUB_TOKEN"]).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("secret");
  } finally {
    for (const [k, v] of [["ANTHROPIC_API_KEY", prev.a], ["GH_TOKEN", prev.g], ["GITHUB_TOKEN", prev.t]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
