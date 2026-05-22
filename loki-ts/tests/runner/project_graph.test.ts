// Tests for src/project_graph.ts
//
// Covers the Phase F cross-project discovery contract:
//   - discoverProjectGraph returns null when no .loki/app.json is found
//   - discoverProjectGraph reads a parent manifest and resolves members
//   - sibling whose own .loki/app.json declares a different app_id is skipped
//   - applyProjectGraphEnv sets the three documented env vars
//   - manifest with schema_version != 1 returns null (and warns)
//
// Each test runs in an isolated tmpdir and snapshots/restores process.env
// for the three LOKI_PROJECT_GRAPH_* keys so suite ordering is stable.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyProjectGraphEnv,
  discoverProjectGraph,
  type AppGraphResult,
} from "../../src/project_graph.ts";

let scratch = "";
const ENV_KEYS = [
  "LOKI_PROJECT_GRAPH_ROOT",
  "LOKI_PROJECT_GRAPH_APP_ID",
  "LOKI_PROJECT_GRAPH_MEMBERS",
  "LOKI_PROJECT_GRAPH_SHARED_MEMORY_DIR",
] as const;
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-project-graph-test-"));
  for (const k of ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = envSnapshot[k];
    }
  }
});

function writeAppJson(dir: string, manifest: object): void {
  const lokiDir = join(dir, ".loki");
  mkdirSync(lokiDir, { recursive: true });
  writeFileSync(join(lokiDir, "app.json"), JSON.stringify(manifest), "utf8");
}

describe("discoverProjectGraph", () => {
  it("returns null when no .loki/app.json is present", () => {
    const target = join(scratch, "no-manifest");
    mkdirSync(target, { recursive: true });
    const result = discoverProjectGraph(target);
    expect(result).toBeNull();
  });

  it("returns AppGraphResult with members from a parent manifest", () => {
    // Layout: scratch/.loki/app.json declares two members; scratch/api +
    // scratch/web exist; discovery from scratch/api walks up one level.
    const api = join(scratch, "api");
    const web = join(scratch, "web");
    mkdirSync(api, { recursive: true });
    mkdirSync(web, { recursive: true });
    writeAppJson(scratch, {
      schema_version: 1,
      app_id: "demo-app",
      members: ["api", "web"],
    });

    const result = discoverProjectGraph(api);
    expect(result).not.toBeNull();
    const r = result as AppGraphResult;
    expect(r.appId).toBe("demo-app");
    expect(r.root).toBe(scratch);
    expect(r.members.length).toBe(2);
    expect(r.members.some((p) => p.endsWith("/api"))).toBe(true);
    expect(r.members.some((p) => p.endsWith("/web"))).toBe(true);
  });

  it("skips a sibling whose own .loki/app.json declares a different app_id", () => {
    // scratch/.loki/app.json declares both members under "demo-app".
    // scratch/web has its own .loki/app.json claiming a different app_id;
    // it must NOT appear in the resolved members list.
    const api = join(scratch, "api");
    const web = join(scratch, "web");
    mkdirSync(api, { recursive: true });
    mkdirSync(web, { recursive: true });
    writeAppJson(scratch, {
      schema_version: 1,
      app_id: "demo-app",
      members: ["api", "web"],
    });
    writeAppJson(web, {
      schema_version: 1,
      app_id: "other-app",
      members: [],
    });

    const result = discoverProjectGraph(api);
    expect(result).not.toBeNull();
    const r = result as AppGraphResult;
    expect(r.appId).toBe("demo-app");
    expect(r.members.some((p) => p.endsWith("/web"))).toBe(false);
    expect(r.members.some((p) => p.endsWith("/api"))).toBe(true);
  });

  it("returns null when app_id fails the slug regex", () => {
    const target = join(scratch, "bad-id");
    mkdirSync(target, { recursive: true });
    writeAppJson(scratch, {
      schema_version: 1,
      app_id: "BAD_ID!",
      members: ["bad-id"],
    });
    const orig = console.warn;
    console.warn = () => {};
    try {
      const result = discoverProjectGraph(target);
      expect(result).toBeNull();
    } finally {
      console.warn = orig;
    }
  });

  it("writes a cache file at .loki/state/project-graph.json with a sha256 key", () => {
    const api = join(scratch, "api");
    mkdirSync(api, { recursive: true });
    writeAppJson(scratch, {
      schema_version: 1,
      app_id: "demo-app",
      members: ["api"],
    });
    discoverProjectGraph(api);
    const cachePath = join(api, ".loki", "state", "project-graph.json");
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(
      require("node:fs").readFileSync(cachePath, "utf8"),
    ) as { key: string; result: { appId: string } };
    expect(cached.result.appId).toBe("demo-app");
    expect(/^[0-9a-f]{64}$/.test(cached.key)).toBe(true);
  });

  it("returns null and warns when schema_version is not 1", () => {
    const target = join(scratch, "future-schema");
    mkdirSync(target, { recursive: true });
    writeAppJson(scratch, {
      schema_version: 2,
      app_id: "demo-app",
      members: ["future-schema"],
    });
    // Spy on console.warn (Bun's Console doesn't expose .calls, so capture
    // by monkey-patching).
    const orig = console.warn;
    const calls: string[] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args.join(" "));
    };
    try {
      const result = discoverProjectGraph(target);
      expect(result).toBeNull();
      expect(calls.some((c) => c.includes("unsupported schema_version"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });
});

describe("applyProjectGraphEnv", () => {
  it("sets the three documented env vars from the result", () => {
    const result: AppGraphResult = {
      appId: "demo-app",
      root: "/tmp/demo",
      members: ["/tmp/demo/api", "/tmp/demo/web"],
    };
    applyProjectGraphEnv(result);
    expect(process.env["LOKI_PROJECT_GRAPH_ROOT"]).toBe("/tmp/demo");
    expect(process.env["LOKI_PROJECT_GRAPH_APP_ID"]).toBe("demo-app");
    expect(process.env["LOKI_PROJECT_GRAPH_MEMBERS"]).toBe(
      "/tmp/demo/api:/tmp/demo/web",
    );
  });
});
