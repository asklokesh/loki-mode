// LM-001: the bash evaluator (autonomy/lib/requirements.sh, used by the minimal
// `loki doctor --json` fallback) agrees with the table and the TS evaluator on
// the paths that do not depend on the host: a restricted PATH with no provider CLI.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/util/paths.ts";
import { loadRequirements } from "../../src/util/requirements.ts";

function bashReport(env: Record<string, string>): { paths: { id: string; ready: boolean; items: { id: string; status: string }[] }[]; first_task_ready: boolean } {
  const lib = join(REPO_ROOT, "autonomy/lib/requirements.sh");
  const r = spawnSync("bash", ["-c", `source "$1"; loki_requirements_json "$2"`, "bash", lib, REPO_ROOT], {
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

describe("bash requirements evaluator", () => {
  test("emits every path and item from the shared table", () => {
    const rep = bashReport({ LOKI_SDK_NODE_MODULES: join(REPO_ROOT, "no-such-dir") });
    const t = loadRequirements();
    expect(rep.paths.map((p) => p.id)).toEqual(t.paths.map((p) => p.id));
    const ids = rep.paths.flatMap((p) => p.items.map((i) => i.id)).sort();
    expect(ids).toEqual(t.requirements.map((r) => r.id).sort());
  });

  test("api-key path is not ready without the SDK loop flag and SDK binary", () => {
    const rep = bashReport({ ANTHROPIC_API_KEY: "k", LOKI_SDK_NODE_MODULES: join(REPO_ROOT, "no-such-dir") });
    const sdk = rep.paths.find((p) => p.id === "api-key-sdk")!;
    expect(sdk.ready).toBe(false);
    expect(sdk.items.find((i) => i.id === "sdk-credentials")!.status).toBe("present");
    expect(sdk.items.find((i) => i.id === "sdk-binary")!.status).toBe("missing");
    expect(sdk.items.find((i) => i.id === "sdk-mode")!.status).toBe("missing");
  });

  test("SDK loop flag is honored", () => {
    const rep = bashReport({ LOKI_SDK_LOOP: "1", LOKI_SDK_NODE_MODULES: join(REPO_ROOT, "no-such-dir") });
    const sdk = rep.paths.find((p) => p.id === "api-key-sdk")!;
    expect(sdk.items.find((i) => i.id === "sdk-mode")!.status).toBe("present");
  });
});
