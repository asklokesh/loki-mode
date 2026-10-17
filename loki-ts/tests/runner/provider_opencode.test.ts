// Tests for src/runner/provider_opencode.ts -- argv shape and invoke path.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpencodeArgv, opencodeProvider } from "../../src/runner/provider_opencode.ts";
import { PROVIDER_COMMIT_HYGIENE } from "../../src/runner/providers.ts";

describe("buildOpencodeArgv", () => {
  it("defaults to the opencode cli with run --auto and hygiene-prefixed prompt", () => {
    const argv = buildOpencodeArgv("do work", {});
    expect(argv.slice(0, 3)).toEqual(["opencode", "run", "--auto"]);
    expect(argv).toHaveLength(4);
    expect(argv[3]).toBe(`${PROVIDER_COMMIT_HYGIENE}\n\ndo work`);
  });

  it("honors LOKI_OPENCODE_CLI and ignores an empty override", () => {
    expect(buildOpencodeArgv("p", { LOKI_OPENCODE_CLI: "/x/fake-oc" })[0]).toBe("/x/fake-oc");
    expect(buildOpencodeArgv("p", { LOKI_OPENCODE_CLI: "" })[0]).toBe("opencode");
  });

  it("adds -m only for a non-blank LOKI_OPENCODE_MODEL, trimmed", () => {
    const argv = buildOpencodeArgv("p", { LOKI_OPENCODE_MODEL: "  anthropic/sonnet  " });
    expect(argv.slice(3, 5)).toEqual(["-m", "anthropic/sonnet"]);
    expect(buildOpencodeArgv("p", { LOKI_OPENCODE_MODEL: "   " })).not.toContain("-m");
  });

  it("splits LOKI_OPENCODE_FLAGS on whitespace before the prompt", () => {
    const argv = buildOpencodeArgv("p", { LOKI_OPENCODE_FLAGS: "  --a   --b=1\t--c " });
    expect(argv.slice(3, 6)).toEqual(["--a", "--b=1", "--c"]);
    expect(argv).toHaveLength(7);
    expect(argv[6]?.endsWith("\n\np")).toBe(true);
  });

  it("orders model flag before extra flags", () => {
    const argv = buildOpencodeArgv("p", { LOKI_OPENCODE_MODEL: "a/b", LOKI_OPENCODE_FLAGS: "--z" });
    expect(argv.slice(3, 6)).toEqual(["-m", "a/b", "--z"]);
  });
});

describe("opencodeProvider.invoke", () => {
  let scratch: string;
  const saved: Record<string, string | undefined> = {};
  const keys = ["LOKI_OPENCODE_CLI", "LOKI_OPENCODE_MODEL", "LOKI_OPENCODE_FLAGS"];

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "loki-oc-test-"));
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it("runs the fake cli with built argv and captures output and exit code", async () => {
    const fake = join(scratch, "fake-oc");
    writeFileSync(fake, '#!/bin/sh\nprintf "ARGS:%s|%s|%s\\n" "$1" "$2" "$3"\necho err >&2\nexit 3\n');
    chmodSync(fake, 0o755);
    process.env["LOKI_OPENCODE_CLI"] = fake;
    const out = join(scratch, "nested", "iter.txt");
    const res = await opencodeProvider().invoke({ prompt: "hi", cwd: scratch, iterationOutputPath: out } as never);
    expect(res.exitCode).toBe(3);
    expect(res.capturedOutputPath).toBe(out);
    const body = readFileSync(out, "utf8");
    expect(body.startsWith("err\n")).toBe(true);
    expect(body).toContain("ARGS:run|--auto|");
  });
});
