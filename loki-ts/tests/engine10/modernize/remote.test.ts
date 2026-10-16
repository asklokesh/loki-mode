// M-23 wall: remote unit dispatch never trusts the remote verdict (docs/v10/MODERNIZE.md, D30).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildUnitJob,
  dispatchRemoteUnit,
  dispatchRemoteUnits,
  httpTransport,
  REMOTE_UNIT_FIELDS,
  type LocalReverify,
  type RemoteTransport,
} from "../../../src/engine10/modernize/remote.ts";

const spec = { repo: "acme/app", ref: "loki/mod-x", unit: "billing.core" };
const transport = (status: "passed" | "failed" | "unknown", sent: unknown[] = []): RemoteTransport => ({
  submit: async (job) => { sent.push(job); return { id: "j1" }; },
  wait: async () => ({ status }),
});
const reverify = (verdict: "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN", calls: string[] = []): LocalReverify => async (job) => {
  calls.push(job.unit);
  return { verdict };
};

describe("remote units", () => {
  it("builds a closed job with only schema fields", () => {
    const job = buildUnitJob({ ...spec, target: "python3" });
    expect(job.kind).toBe("unit");
    for (const k of Object.keys(job)) expect((REMOTE_UNIT_FIELDS as readonly string[]).includes(k)).toBe(true);
    expect(JSON.stringify(job)).not.toMatch(/token|secret|password|authorization/i);
  });

  it("rejects unbounded or flag-shaped fields", () => {
    expect(() => buildUnitJob({ ...spec, repo: "--x/y" })).toThrow();
    expect(() => buildUnitJob({ ...spec, ref: "a..b" })).toThrow();
    expect(() => buildUnitJob({ ...spec, ref: "a".repeat(201) })).toThrow();
    expect(() => buildUnitJob({ ...spec, unit: "-u" })).toThrow();
    expect(() => buildUnitJob({ ...spec, unit: "u".repeat(129) })).toThrow();
    expect(() => buildUnitJob({ ...spec, target: "cobol" as never })).toThrow();
    expect(() => buildUnitJob({ ...spec, token: "t" } as never)).toThrow();
  });

  it("merges only when remote passed AND local re-verify is PROVEN", async () => {
    const calls: string[] = [];
    const out = await dispatchRemoteUnit(spec, transport("passed"), reverify("PROVEN", calls));
    expect(out.mergeable).toBe(true);
    expect(out.status).toBe("PROVEN");
    expect(calls).toEqual(["billing.core"]);
  });

  it("a remote pass with a failing local re-verify must not merge", async () => {
    for (const v of ["NOT_EQUAL", "NOT_PROVEN"] as const) {
      const out = await dispatchRemoteUnit(spec, transport("passed"), reverify(v));
      expect(out.mergeable).toBe(false);
      expect(out.status).toBe(v);
      expect(out.remoteStatus).toBe("passed");
    }
  });

  it("a throwing local re-verify is NOT_PROVEN, never merged", async () => {
    const boom: LocalReverify = async () => { throw new Error("boom"); };
    const out = await dispatchRemoteUnit(spec, transport("passed"), boom);
    expect(out.mergeable).toBe(false);
    expect(out.status).toBe("NOT_PROVEN");
  });

  it("a remote failed or unknown status is never merged", async () => {
    for (const s of ["failed", "unknown"] as const) {
      const out = await dispatchRemoteUnit(spec, transport(s), reverify("PROVEN"));
      expect(out.mergeable).toBe(false);
    }
  });

  it("refuses to run without a local re-verifier", async () => {
    await expect(dispatchRemoteUnit(spec, transport("passed"), undefined as never)).rejects.toThrow(/re-verif/);
  });

  it("a transport error is NOT_PROVEN, not a crash", async () => {
    const bad: RemoteTransport = { submit: async () => { throw new Error("down"); }, wait: async () => ({ status: "passed" }) };
    const out = await dispatchRemoteUnit(spec, bad, reverify("PROVEN"));
    expect(out.mergeable).toBe(false);
    expect(out.status).toBe("NOT_PROVEN");
  });

  it("fans out units with bounded concurrency", async () => {
    let live = 0;
    let peak = 0;
    const t: RemoteTransport = {
      submit: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); return { id: "j" }; },
      wait: async () => { live--; return { status: "passed" }; },
    };
    const outs = await dispatchRemoteUnits(
      ["a", "b", "c", "d", "e"].map((unit) => ({ ...spec, unit })), t, reverify("PROVEN"), 2);
    expect(outs.length).toBe(5);
    expect(peak).toBeLessThanOrEqual(2);
    expect(outs.every((o) => o.mergeable)).toBe(true);
  });

  it("http transport sends the token in a header, never in the body", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      seen.push({ url, headers: init.headers, body: init.body ?? "" });
      return new Response(JSON.stringify({ id: "j9", status: "queued" }), { status: 202 });
    }) as unknown as typeof fetch;
    const t = httpTransport("http://host:1/", "tok-123", fakeFetch);
    await t.submit(buildUnitJob(spec));
    expect(seen[0]!.headers["Authorization"]).toBe("Bearer tok-123");
    expect(seen[0]!.body).not.toContain("tok-123");
    expect(seen[0]!.url).toBe("http://host:1/jobs");
  });

  it("http transport gives every request an abort signal so a hung server cannot stall the poll loop", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fakeFetch = (async (url: string, init: { method: string; signal?: AbortSignal }) => {
      signals.push(init.signal);
      return init.method === "POST"
        ? new Response(JSON.stringify({ id: "j9" }), { status: 202 })
        : new Response(JSON.stringify({ status: "passed" }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = httpTransport("http://host:1/", "tok", fakeFetch, 1, 5000);
    await t.submit(buildUnitJob(spec));
    await t.wait("j9");
    expect(signals.length).toBe(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("shares a fixture with the Python validator: same verdict for every case (tests/test-trigger-server-unit-jobs.py)", () => {
    const cases = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "unit_job_parity.json"), "utf8")) as { name: string; valid: boolean; payload: never }[];
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) {
      let ok = true;
      try { buildUnitJob(c.payload); } catch { ok = false; }
      expect(`${c.name}: ${ok}`).toBe(`${c.name}: ${c.valid}`);
    }
  });
});
