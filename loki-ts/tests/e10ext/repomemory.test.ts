import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoCacheDir, repoKey } from "../../src/engine10/cache.ts";
import { readRepoMemory, writeRepoMemory } from "../../src/e10ext/repomemory.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repomem-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const A = repoKey("https://example.com/a.git", "/x");
const B = repoKey("https://example.com/b.git", "/x");
const EMPTY = { verifiedCommand: null, flaky: [], failures: [] };

describe("repomemory", () => {
  it("cold read returns empty", () => {
    expect(readRepoMemory(A, root)).toEqual(EMPTY);
  });

  it("write then read round-trips (warm)", () => {
    const f = { signature: "ENOENT", count: 2, sample: "no such file" };
    writeRepoMemory(A, { verifiedCommand: "bun test", flaky: ["t/b.test.ts", "t/a.test.ts"], failures: [f] }, root);
    expect(readRepoMemory(A, root)).toEqual({ verifiedCommand: "bun test", flaky: ["t/a.test.ts", "t/b.test.ts"], failures: [f] });
  });

  it("a different repo does not see another repo's memory", () => {
    writeRepoMemory(A, { verifiedCommand: "bun test", flaky: ["x"] }, root);
    expect(readRepoMemory(B, root)).toEqual(EMPTY);
  });

  it("a corrupt file is ignored", () => {
    writeRepoMemory(A, { verifiedCommand: "bun test" }, root);
    const dir = repoCacheDir(A, root);
    writeFileSync(join(dir, "verified_command.json"), "{not json");
    writeFileSync(join(dir, "flaky.json"), "null");
    writeFileSync(join(dir, "failures.jsonl"), "garbage\n42\n");
    expect(readRepoMemory(A, root)).toEqual(EMPTY);
  });

  it("concurrent recordFailures keeps every line", async () => {
    const dir = repoCacheDir(A, root);
    const mod = join(import.meta.dir, "../../src/util/failure_memory.ts");
    const procs = 6;
    const per = 40;
    const code = `import { recordFailures } from ${JSON.stringify(mod)};
const id = process.argv[2];
for (let i = 0; i < ${per}; i++) recordFailures(${JSON.stringify(dir)}, [{ signature: id + "-" + i, count: 1, sample: "s" }]);`;
    const script = join(root, "child.ts");
    writeFileSync(script, code);
    const kids = Array.from({ length: procs }, (_, k) => Bun.spawn(["bun", script, String(k)], { stdout: "ignore", stderr: "inherit" }));
    for (const k of kids) expect(await k.exited).toBe(0);
    const lines = readFileSync(join(dir, "failures.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(procs * per);
  });
});
