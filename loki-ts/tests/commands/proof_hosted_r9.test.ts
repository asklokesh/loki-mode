// R9 open-core seam tests: hosted proof-publish + tier/license gate.
//
// Covers the new seams added for R9 ("Hosted/paid open-core hooks"):
//   - tierGate(): no-op ALLOW for OSS (default); honest non-allow / notes for
//     non-OSS tiers with no verification backend. Never a fabricated grant.
//   - loki proof share --hosted: POSTs the ALREADY-REDACTED proof page to a
//     mock LOKI_HOSTED_ENDPOINT; without the env var, prints an honest
//     "backend not available" message and exits non-zero (no silent gist
//     fallback, no fabricated URL).
//   - redaction metadata travels with the published payload; an unredacted
//     proof (redaction.applied=false) is refused.
//   - OSS path unchanged: no existing free command is gated by LOKI_TIER.
//
// All network is MOCKED with a localhost Bun.serve; no paid/real calls. Both
// the bash route (autonomy/loki) and the Bun route (loki-ts) are exercised so
// the dual-route parity gate stays honest.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { run } from "../../src/util/shell.ts";
import { tierGate, currentTier } from "../../src/util/tier.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const BUN_CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

let scratch = "";

// A mock hosted endpoint. Records the last request so tests can assert the
// redacted payload + headers actually arrived. Returns a JSON {url} on 2xx.
interface CapturedReq {
  method: string;
  proofId: string | null;
  auth: string | null;
  body: string;
}
let lastReq: CapturedReq | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let endpoint = "";
// When set, the server replies with this status (and no url) to test failures.
let forceStatus = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      lastReq = {
        method: req.method,
        proofId: req.headers.get("x-loki-proof-id"),
        auth: req.headers.get("authorization"),
        body,
      };
      if (forceStatus && forceStatus >= 400) {
        return new Response("mock failure", { status: forceStatus });
      }
      return new Response(
        JSON.stringify({ url: "https://hosted.example/proofs/published-123" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  endpoint = `http://127.0.0.1:${server.port}/publish`;
});

afterAll(() => {
  server?.stop(true);
});

function seedProofWithHtml(
  id: string,
  proof: Record<string, unknown>,
  htmlBody: string,
): void {
  const dir = join(scratch, "proofs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proof.json"), JSON.stringify(proof, null, 2));
  writeFileSync(join(dir, "index.html"), htmlBody);
}

const REDACTED_PROOF = {
  run_id: "run-r9-abc",
  generated_at: "2026-06-03T12:00:00Z",
  council: { final_verdict: "APPROVE" },
  cost: { usd: "0.42" },
  files_changed: { count: 3 },
  redaction: { applied: true, rules_version: "1", redactions_count: 2 },
};

// Marker string that the redactor would have already stripped; we use it to
// assert the published bytes are exactly the (already-redacted) index.html.
const REDACTED_HTML = "<html><body>proof-page redacted-marker-OK</body></html>";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-r9-"));
  lastReq = null;
  forceStatus = 0;
});

afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

function bunRoute(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(["bun", BUN_CLI, ...argv], {
    env: { LOKI_DIR: scratch, NO_COLOR: "1", ...env },
    timeoutMs: 30000,
  });
}

function bashRoute(
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run([BASH_CLI, ...argv], {
    env: { LOKI_DIR: scratch, NO_COLOR: "1", ...env },
    timeoutMs: 30000,
  });
}

describe("R9 tier/license gate (OSS-first, no-op)", () => {
  let savedTier: string | undefined;
  let savedKey: string | undefined;
  beforeEach(() => {
    savedTier = process.env["LOKI_TIER"];
    savedKey = process.env["LOKI_LICENSE_KEY"];
    delete process.env["LOKI_TIER"];
    delete process.env["LOKI_LICENSE_KEY"];
  });
  afterEach(() => {
    if (savedTier === undefined) delete process.env["LOKI_TIER"];
    else process.env["LOKI_TIER"] = savedTier;
    if (savedKey === undefined) delete process.env["LOKI_LICENSE_KEY"];
    else process.env["LOKI_LICENSE_KEY"] = savedKey;
  });

  it("defaults to oss tier", () => {
    expect(currentTier()).toBe("oss");
  });

  it("allows every capability for oss with zero notes", () => {
    for (const cap of ["hosted_publish", "anything", "enterprise_sso", ""]) {
      const r = tierGate(cap);
      expect(r.allowed).toBe(true);
      expect(r.notes).toEqual([]);
    }
  });

  it("oss allows even with LOKI_TIER explicitly set to oss", () => {
    process.env["LOKI_TIER"] = "oss";
    expect(tierGate("hosted_publish").allowed).toBe(true);
  });

  it("non-oss tier without a license key is NOT allowed (honest, no fabricated grant)", () => {
    process.env["LOKI_TIER"] = "enterprise";
    const r = tierGate("hosted_publish");
    expect(r.allowed).toBe(false);
    expect(r.notes.join("\n")).toContain("LOKI_LICENSE_KEY");
  });

  it("non-oss tier with a license key allows but flags the seam is unverified", () => {
    process.env["LOKI_TIER"] = "enterprise";
    process.env["LOKI_LICENSE_KEY"] = "k-123";
    const r = tierGate("hosted_publish");
    expect(r.allowed).toBe(true);
    expect(r.notes.join("\n")).toContain("verification backend is not available");
  });
});

describe("R9 hosted proof-publish seam (mocked endpoint)", () => {
  for (const route of [
    { name: "bun", fn: bunRoute },
    { name: "bash", fn: bashRoute },
  ] as const) {
    describe(`route: ${route.name}`, () => {
      it("without LOKI_HOSTED_ENDPOINT: honest message, non-zero exit, no fake URL", async () => {
        seedProofWithHtml("p1", REDACTED_PROOF, REDACTED_HTML);
        const r = await route.fn(["proof", "share", "--hosted", "p1"]);
        expect(r.exitCode).not.toBe(0);
        const out = r.stdout + r.stderr;
        expect(out).toContain("Hosted publishing backend not available");
        expect(out).toContain("LOKI_HOSTED_ENDPOINT");
        // Never fabricate a hosted URL.
        expect(out).not.toContain("http://");
        expect(out).not.toContain("https://hosted");
        // Honest fallback pointer to the free gist path.
        expect(out).toContain("loki proof share p1");
      });

      it("with LOKI_HOSTED_ENDPOINT: POSTs the redacted page and prints the endpoint URL", async () => {
        seedProofWithHtml("p2", REDACTED_PROOF, REDACTED_HTML);
        const r = await route.fn(["proof", "share", "--hosted", "p2"], {
          LOKI_HOSTED_ENDPOINT: endpoint,
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("Published: https://hosted.example/proofs/published-123");
        // The mock actually received the request.
        expect(lastReq).not.toBeNull();
        expect(lastReq?.method).toBe("POST");
        expect(lastReq?.proofId).toBe("p2");
        // Redaction travels: the published bytes are the already-redacted html.
        expect(lastReq?.body).toBe(REDACTED_HTML);
        // OSS user (no license key) sends no auth header.
        expect(lastReq?.auth).toBeNull();
      });

      it("non-2xx from endpoint: honest error, non-zero exit, no fake URL", async () => {
        seedProofWithHtml("p3", REDACTED_PROOF, REDACTED_HTML);
        forceStatus = 500;
        const r = await route.fn(["proof", "share", "--hosted", "p3"], {
          LOKI_HOSTED_ENDPOINT: endpoint,
        });
        expect(r.exitCode).not.toBe(0);
        const out = r.stdout + r.stderr;
        expect(out).toContain("500");
        expect(out).not.toContain("Published:");
      });

      it("refuses to publish an unredacted proof (redaction.applied=false)", async () => {
        const unredacted = { ...REDACTED_PROOF, redaction: { applied: false } };
        seedProofWithHtml("p4", unredacted, REDACTED_HTML);
        const r = await route.fn(["proof", "share", "--hosted", "p4"], {
          LOKI_HOSTED_ENDPOINT: endpoint,
        });
        expect(r.exitCode).not.toBe(0);
        const out = r.stdout + r.stderr;
        expect(out.toLowerCase()).toContain("redaction was not");
        // Nothing posted.
        expect(lastReq).toBeNull();
      });

      it("refuses to publish when redaction metadata is ABSENT (fail-closed)", async () => {
        // An old/degraded proof with no redaction key must NOT publish: checking
        // only `applied === false` would let undefined through and leak. The
        // guard must require applied === true (matches the bash route).
        const noMeta: Record<string, unknown> = { ...REDACTED_PROOF };
        delete noMeta["redaction"];
        seedProofWithHtml("p4b", noMeta, REDACTED_HTML);
        const r = await route.fn(["proof", "share", "--hosted", "p4b"], {
          LOKI_HOSTED_ENDPOINT: endpoint,
        });
        expect(r.exitCode).not.toBe(0);
        const out = r.stdout + r.stderr;
        expect(out.toLowerCase()).toContain("redaction was not");
        // Nothing posted -- absent metadata is treated as not-redacted.
        expect(lastReq).toBeNull();
      });

      it("sends an Authorization header when LOKI_LICENSE_KEY is set", async () => {
        seedProofWithHtml("p5", REDACTED_PROOF, REDACTED_HTML);
        const r = await route.fn(["proof", "share", "--hosted", "p5"], {
          LOKI_HOSTED_ENDPOINT: endpoint,
          LOKI_LICENSE_KEY: "k-secret",
        });
        expect(r.exitCode).toBe(0);
        expect(lastReq?.auth).toBe("Bearer k-secret");
      });
    });
  }
});

describe("R9 OSS-not-gated guarantee", () => {
  // The default (non-hosted) command paths must be byte-unchanged: --hosted is
  // the only new branch. We assert existing free paths produce IDENTICAL output
  // and exit code with LOKI_TIER unset vs LOKI_TIER=enterprise -- proving the
  // tier env never gates any existing free feature. We pick deterministic,
  // gh-independent paths (help text and a missing-id error) so the assertion is
  // stable on any machine.
  for (const route of [
    { name: "bun", fn: bunRoute },
    { name: "bash", fn: bashRoute },
  ] as const) {
    it(`${route.name}: 'proof list' identical with LOKI_TIER unset vs enterprise`, async () => {
      seedProofWithHtml("g1", REDACTED_PROOF, REDACTED_HTML);
      const unset = await route.fn(["proof", "list"]);
      const setTier = await route.fn(["proof", "list"], { LOKI_TIER: "enterprise" });
      expect(setTier.exitCode).toBe(unset.exitCode);
      expect(setTier.stdout).toBe(unset.stdout);
      const s = (setTier.stdout + setTier.stderr).toLowerCase();
      expect(s).not.toContain("license");
      expect(s).not.toContain("not allowed");
    });

    it(`${route.name}: plain 'proof share' (no --hosted) missing-id error unaffected by LOKI_TIER`, async () => {
      const unset = await route.fn(["proof", "share"]);
      const setTier = await route.fn(["proof", "share"], { LOKI_TIER: "enterprise" });
      // Existing behavior: missing id -> exit 2, same message, regardless of tier.
      expect(unset.exitCode).toBe(2);
      expect(setTier.exitCode).toBe(2);
      expect(setTier.stdout).toBe(unset.stdout);
      expect(setTier.stderr).toBe(unset.stderr);
      const s = (setTier.stdout + setTier.stderr).toLowerCase();
      expect(s).not.toContain("license");
      expect(s).not.toContain("tier");
    });
  }
});
