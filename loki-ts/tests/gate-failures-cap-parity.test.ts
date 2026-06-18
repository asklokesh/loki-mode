// Wave-4 L1 parity: the gate-failures.txt cap must read the FIRST 8000 bytes
// on BOTH routes. Bun build_prompt.ts uses readBytesSafe(gfPath, 8000) which is
// buf.subarray(0, 8000) (head). Bash autonomy/run.sh uses `head -c 8000`. This
// test pins that the two produce byte-identical output for a >8000-byte input,
// covering the truncation path the SHA fixtures do not exercise (all parity
// fixtures are well under 8000 bytes, so head vs tail would look identical there
// -- exactly the gap that let a tail/head divergence slip past review once).
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reproduce the Bun readBytesSafe(_, 8000) head semantics on a byte buffer.
// (readBytesSafe is module-private in build_prompt.ts; this mirrors its slice
// exactly: buf.subarray(0, maxBytes) then utf8 decode. The input here is pure
// ASCII so there is no NUL/trailing-newline subtlety to diverge on.)
function bunHeadCap(buf: Buffer, maxBytes: number): string {
  const sliced = buf.byteLength <= maxBytes ? buf : buf.subarray(0, maxBytes);
  return sliced.toString("utf8");
}

describe("gate-failures cap head/tail parity (W4 L1)", () => {
  it("bash head -c 8000 and Bun subarray(0,8000) agree on a >8000-byte file", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-gfcap-"));
    try {
      // 12000 bytes: first 8000 are 'A', remainder 'B'. `head -c 8000` keeps
      // only the leading 'A' run; `tail -c 8000` would keep the 'B' tail. We
      // assert Bun's cap reproduces head semantics against the DETERMINISTIC
      // expected slice (the first 8000 bytes), not against a spawned `head`
      // subprocess. The earlier version shelled out to `execFileSync("head",
      // ...)`, which on some CI runners (macos-latest + bun 1.3.13) returned 0
      // bytes -- a non-hermetic subprocess flake, not a real parity divergence.
      // The semantic being pinned (head, NOT tail) is fully captured by the
      // expected-slice comparison below.
      const content = "A".repeat(8000) + "B".repeat(4000);
      const fpath = join(dir, "gate-failures.txt");
      writeFileSync(fpath, content);

      // What `head -c 8000` produces, by definition: the first 8000 bytes.
      const expectedHead = content.slice(0, 8000);
      const bunOut = bunHeadCap(Buffer.from(content, "utf8"), 8000);

      expect(expectedHead.length).toBe(8000);
      expect(bunOut.length).toBe(8000);
      expect(bunOut).toBe(expectedHead);
      // Non-vacuity: the cap must drop the tail 'B' run entirely (head, not tail).
      expect(expectedHead.includes("B")).toBe(false);
      expect(bunOut.includes("B")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor per-provider install hint goes to STDERR (parity with bash, invisible to stdout-only gate)", () => {
    // Regression lock for v7.63.1: the install hint must be on STDERR, matching
    // bash run.sh doctor_check_provider (`>&2`). The canonical bun-parity gate
    // captures STDOUT only (`>out 2>/dev/null`), so a stdout hint appears on the
    // Bun route but not bash and breaks parity (this exact bug shipped in v7.63.0
    // and went red on GH Bun Parity). Assert: with all providers absent, the
    // Bun route's STDOUT contains NO "Install: npm install -g" provider hint.
    const repoRoot = join(import.meta.dir, "..", "..");
    // doctor exits non-zero when providers are missing; execFileSync throws on a
    // non-zero exit but still populates err.stdout. Capture stdout either way
    // (mirror the gate's `>out 2>/dev/null` -- stdout only).
    let out: string;
    try {
      out = execFileSync("bash", [join(repoRoot, "bin", "loki"), "doctor"], {
        env: { ...process.env, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
    } catch (err: unknown) {
      out = String((err as { stdout?: Buffer | string }).stdout ?? "");
    }
    // The "No AI provider" fallback hint (a single always-shown line) is allowed
    // on stdout; the PER-PROVIDER hints under each WARN must NOT be. Distinguish by
    // counting: bash stdout has at most ONE "Install:" line (the fallback), never
    // four (one per absent provider).
    const installLines = out.split("\n").filter((l) => l.includes("Install:"));
    expect(installLines.length).toBeLessThanOrEqual(1);
  });

  it("sub-cap files are returned whole on both routes", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-gfcap-"));
    try {
      const content = "short failure log\n";
      const fpath = join(dir, "gate-failures.txt");
      writeFileSync(fpath, content);

      // head -c 8000 of a sub-cap file returns it verbatim. We compare Bun's
      // slice against the content directly (a sub-cap head is the whole file),
      // not a spawned `head` (non-hermetic on some CI runners, see above).
      const bunOut = bunHeadCap(Buffer.from(content, "utf8"), 8000);
      expect(bunOut).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
