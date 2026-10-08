// select: walk-all-src
// T5-ATTEMPTS-PR: every credentialed push in loki-ts/src goes through engine10-push.sh push-pr (_loki_trusted_push).
// No TS source may run `git push`, `gh pr create`, or opt a git call into credentials for anything but fetch.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../../src");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
});
// safe_git.ts defines the allowToken mechanism itself; voter/quality-gate files only list push in a DENY list for agents.
const DEFINES = new Set(["util/safe_git.ts"]);
const DENYLISTS = new Set(["council/voter_agents.ts", "runner/quality_gates.ts"]);

describe("credentialed push guard", () => {
  const files = walk(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, "utf8") }));

  it("no source spawns git push or gh pr create directly", () => {
    const bad = files.filter((f) => !DENYLISTS.has(f.rel) && (/["']push["']/.test(f.text) || /["']pr["'],\s*["']create["']/.test(f.text))).map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it("allowToken is only ever enabled for fetch", () => {
    const bad = files.filter((f) => !DEFINES.has(f.rel)).flatMap((f) => [...f.text.matchAll(/allowToken\s*(?::|=)\s*([^,}\n]+)/g)].map((m) => ({ f: f.rel, v: m[1]!.trim() })))
      .filter((x) => x.v !== 'args[0] === "fetch"' && x.v !== "false");
    expect(bad).toEqual([]);
  });
});
