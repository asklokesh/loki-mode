// FC-29 sweep: the Bun verifier route must resolve the verified tree the same
// way as loki_verify_root in autonomy/loki, never default to the ambient cwd.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as proof from "../../src/commands/proof.ts";

const resolveRoot = (proof as Record<string, unknown>)["resolveVerifyRoot"] as
  | ((env: Record<string, string | undefined>, cwd: string) => string | null)
  | undefined;

let scratch = "";
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "loki-vroot-ts-")));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("resolveVerifyRoot (FC-29)", () => {
  it("refuses a non-project cwd", () => {
    const bare = join(scratch, "bare");
    mkdirSync(bare);
    expect(resolveRoot!({ HOME: join(scratch, "nohome") }, bare)).toBeNull();
  });
  it("refuses HOME even when it holds .loki", () => {
    mkdirSync(join(scratch, "home", ".loki"), { recursive: true });
    const h = join(scratch, "home");
    expect(resolveRoot!({ HOME: h }, h)).toBeNull();
  });
  it("refuses TARGET_DIR equal to HOME with a trailing slash", () => {
    const h = join(scratch, "home");
    mkdirSync(h);
    expect(resolveRoot!({ HOME: h, TARGET_DIR: h + "/" }, scratch)).toBeNull();
  });
  it("explicit TARGET_DIR wins", () => {
    expect(resolveRoot!({ HOME: "/nope", TARGET_DIR: scratch }, "/")).toBe(scratch);
  });
  it("uses the parent of an absolute LOKI_DIR", () => {
    const l = join(scratch, "proj", ".loki");
    mkdirSync(l, { recursive: true });
    expect(resolveRoot!({ HOME: "/nope", LOKI_DIR: l }, scratch)).toBe(join(scratch, "proj"));
  });
  it("uses the cwd when it holds .loki", () => {
    mkdirSync(join(scratch, "proj", ".loki"), { recursive: true });
    expect(resolveRoot!({ HOME: "/nope" }, join(scratch, "proj"))).toBe(join(scratch, "proj"));
  });
  it("uses the repo top-level when it holds .loki", () => {
    const p = join(scratch, "proj");
    mkdirSync(join(p, ".loki"), { recursive: true });
    mkdirSync(join(p, "sub", "deep"), { recursive: true });
    Bun.spawnSync(["git", "-C", p, "init", "-q"]);
    expect(resolveRoot!({ HOME: "/nope" }, join(p, "sub", "deep"))).toBe(p);
  });
});
