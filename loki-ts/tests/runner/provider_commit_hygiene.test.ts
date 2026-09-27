// S-209 (BACKLOG 99, Bun half): codex, cline and aider take no system prompt,
// so the bash providers lead every prompt with PROVIDER_COMMIT_HYGIENE plus a
// blank line. The Bun invokers must send the same bytes. The literal is read
// from providers/codex.sh at test time (never copied) so bash/Bun drift goes red.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexProvider,
  clineProvider,
  aiderProvider,
  claudeProvider,
} from "../../src/runner/providers.ts";
import type { ProviderInvocation } from "../../src/runner/types.ts";

const CODEX_SH = resolve(import.meta.dir, "../../../providers/codex.sh");
const match = /^PROVIDER_COMMIT_HYGIENE='(.*)'$/m.exec(readFileSync(CODEX_SH, "utf8"));
const HYGIENE = match?.[1] ?? "";
const RAW = "build the thing";

let tmp: string;
let stub: string;
let argvLog: string;

// NUL-framed argv record so a multi-line prompt stays one argument.
function writeStub(): void {
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvLog}'\nexit 0\n`);
  chmodSync(stub, 0o755);
}

function readArgv(): string[] {
  const parts = readFileSync(argvLog, "utf8").split("\0");
  parts.pop(); // trailing NUL
  return parts;
}

function call(provider: ProviderInvocation["provider"]): ProviderInvocation {
  return {
    provider,
    prompt: RAW,
    tier: "development",
    cwd: tmp,
    iterationOutputPath: join(tmp, "iter", "captured.log"),
  };
}

const ENV_KEYS = [
  "LOKI_CODEX_CLI", "LOKI_CLINE_CLI", "LOKI_AIDER_CLI", "LOKI_CLAUDE_CLI",
  "LOKI_CODEX_OUTPUT_LAST", "LOKI_CODEX_WEB_SEARCH", "LOKI_CLINE_MODEL",
  "LOKI_AIDER_MODEL", "LOKI_AIDER_FLAGS",
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-hygiene-test-"));
  stub = join(tmp, "cli-stub");
  argvLog = join(tmp, "argv.log");
  for (const k of ENV_KEYS) delete process.env[k];
  writeStub();
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  rmSync(tmp, { recursive: true, force: true });
});

describe("commit-hygiene prefix (S-209)", () => {
  it("reads a non-empty literal from providers/codex.sh", () => {
    expect(HYGIENE.length).toBeGreaterThan(50);
    expect(HYGIENE).toContain("git add -A");
  });

  it("NUL framing keeps a multi-line argument whole", async () => {
    process.env["LOKI_CLINE_CLI"] = stub;
    await clineProvider().invoke({ ...call("cline"), prompt: "a\n\nb" });
    expect(readArgv().length).toBe(2); // -y, prompt
  });

  it("codex: the last argv is the hygiene line, a blank line, then the prompt", async () => {
    process.env["LOKI_CODEX_CLI"] = stub;
    await codexProvider().invoke(call("codex"));
    const argv = readArgv();
    expect(argv[argv.length - 1]).toBe(`${HYGIENE}\n\n${RAW}`);
  });

  it("cline: the positional prompt carries the hygiene prefix", async () => {
    process.env["LOKI_CLINE_CLI"] = stub;
    await clineProvider().invoke(call("cline"));
    expect(readArgv()).toEqual(["-y", `${HYGIENE}\n\n${RAW}`]);
  });

  it("aider: the --message value carries the hygiene prefix", async () => {
    process.env["LOKI_AIDER_CLI"] = stub;
    await aiderProvider().invoke(call("aider"));
    const argv = readArgv();
    expect(argv[argv.indexOf("--message") + 1]).toBe(`${HYGIENE}\n\n${RAW}`);
  });

  it("claude: -p gets the raw prompt, the literal is not double-sent", async () => {
    process.env["LOKI_CLAUDE_CLI"] = stub;
    await claudeProvider().invoke(call("claude"));
    const argv = readArgv();
    expect(argv[argv.indexOf("-p") + 1]).toBe(RAW);
    expect(argv.join("\0").split(HYGIENE).length - 1).toBeLessThanOrEqual(1);
  });
});
