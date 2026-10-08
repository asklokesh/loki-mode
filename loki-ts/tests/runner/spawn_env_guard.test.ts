// select: walk-all-src
// BACKLOG 149 round 4 guard: every subprocess spawn under loki-ts/src must pass
// an explicit `env`. In Bun (measured on 1.3.13) a spawn with no `env` option
// inherits the environment from process START, so it silently undoes
// withholdGithubTokens() (real GH_TOKEN, real SSH_AUTH_SOCK, un-reset
// credential helpers). See spawn_env_fsmonitor.test.ts for the live repro.
// `env: process.env` and `env: { ...process.env, ... }` are both correct: Bun
// reads the object at call time.
//
// A source scan, not an AST: it walks the balanced parentheses of each call
// (skipping string literals) and requires an `env` key inside them.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../../src");
const CALL = /(execFileSync|execSync|spawnSync|execFile|Bun\.spawnSync|Bun\.spawn|(?<![\w.$])spawn|(?<![\w.$])exec)\(/g;

function bareSpawns(src: string): number[] {
  const hits: number[] = [];
  for (const m of src.matchAll(CALL)) {
    const start = m.index!;
    const lineStart = src.lastIndexOf("\n", start - 1) + 1;
    const lead = src.slice(lineStart, start).trimStart();
    if (lead.startsWith("//") || lead.startsWith("*")) continue;
    // Skip definitions and non-call uses such as `function exec(` or `.exec(`.
    if (/(function|def)\s+$/.test(src.slice(lineStart, start))) continue;
    let i = start + m[0].length;
    let depth = 1;
    let quote = "";
    let code = ""; // the call's text with string-literal contents removed
    while (i < src.length && depth > 0) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else {
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        code += c;
      }
      i++;
    }
    if (!/\benv\s*[:,}]/.test(code)) {
      hits.push(src.slice(0, start).split("\n").length);
    }
  }
  return hits;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("spawn env guard", () => {
  it("the scanner flags a bare call and accepts an env-carrying one (positive control)", () => {
    expect(bareSpawns(`execFileSync("git", ["diff"], { cwd });`)).toEqual([1]);
    expect(bareSpawns(`x;\nconst p = Bun.spawn({\n  cmd: ["git"],\n  cwd,\n});`)).toEqual([2]);
    expect(bareSpawns(`spawnSync("git", ["status"], { cwd, env: { ...process.env } });`)).toEqual([]);
    expect(bareSpawns(`Bun.spawn({ cmd: ["x"], env: process.env });`)).toEqual([]);
    // An "env" inside a string literal does not count.
    expect(bareSpawns(`spawnSync("sh", ["-c", "env: x"], { cwd });`)).toEqual([1]);
    expect(bareSpawns(`// execFileSync("git", [])`)).toEqual([]);
  });

  it("no spawn under loki-ts/src omits env", () => {
    const files = tsFiles(SRC);
    expect(files.length).toBeGreaterThan(20); // not an empty scan
    const offenders: string[] = [];
    let calls = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      calls += [...src.matchAll(CALL)].length;
      for (const ln of bareSpawns(src)) offenders.push(`${relative(SRC, f)}:${ln}`);
    }
    expect(calls).toBeGreaterThan(10); // the pattern still matches real calls
    expect(offenders).toEqual([]);
  });
});
