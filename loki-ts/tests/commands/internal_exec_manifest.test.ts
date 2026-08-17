import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInternalExecManifest } from "../../src/commands/internal_exec_manifest.ts";

let scratch = "";
afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe("internal exec-manifest bridge", () => {
  it("is wired before mutation at the autonomous merge seam", () => {
    const runSh = readFileSync(join(import.meta.dir, "../../../autonomy/run.sh"), "utf8");
    const start = runSh.indexOf("merge_feature() {");
    const end = runSh.indexOf("\n}\n\n# Initialize parallel workflow streams", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const mergeFeature = runSh.slice(start, end);
    const validate = mergeFeature.indexOf('validate_exec_manifest_result "$feature" "$branch"');
    const checkout = mergeFeature.indexOf('git -C "$TARGET_DIR" checkout main');
    const merge = mergeFeature.indexOf('git -C "$TARGET_DIR" merge "$branch"');
    expect(validate).toBeGreaterThan(0);
    expect(checkout).toBeGreaterThan(validate);
    expect(merge).toBeGreaterThan(validate);
  });

  it("plans and accepts an in-scope result", () => {
    scratch = mkdtempSync(join(tmpdir(), "loki-exec-manifest-"));
    const plan = join(scratch, "plan.json");
    writeFileSync(plan, JSON.stringify({
      baseSha: "abc",
      integrationOwner: "parallel-orchestrator",
      streams: [{ name: "tests", paths: ["tests"], acceptance: "tests pass" }],
      env: { LOKI_EXEC_MANIFEST: "1" },
    }));
    expect(runInternalExecManifest(["plan", plan, scratch])).toBe(0);
    expect(existsSync(join(scratch, "manifest", "exec-manifest.json"))).toBe(true);

    const result = join(scratch, "result.json");
    writeFileSync(result, JSON.stringify({
      name: "tests", baseSha: "abc", changedPaths: ["tests/a.test.ts"], acceptanceMet: true,
    }));
    expect(runInternalExecManifest(["validate", result, scratch])).toBe(0);
  });

  it("rejects a stale result", () => {
    scratch = mkdtempSync(join(tmpdir(), "loki-exec-manifest-"));
    const manifestDir = join(scratch, "manifest");
    const plan = join(scratch, "plan.json");
    writeFileSync(plan, JSON.stringify({
      baseSha: "abc",
      integrationOwner: "parallel-orchestrator",
      streams: [{ name: "docs", paths: ["docs"], acceptance: "docs check passes" }],
      env: { LOKI_EXEC_MANIFEST: "1" },
    }));
    expect(runInternalExecManifest(["plan", plan, scratch])).toBe(0);
    expect(JSON.parse(readFileSync(join(manifestDir, "exec-manifest.json"), "utf8")).base_sha).toBe("abc");
    const result = join(scratch, "result.json");
    writeFileSync(result, JSON.stringify({
      name: "docs", baseSha: "old", changedPaths: [], acceptanceMet: true,
    }));
    expect(runInternalExecManifest(["validate", result, scratch])).toBe(2);
  });
});
