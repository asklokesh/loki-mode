// M-23 wall: remote unit dispatch never trusts the remote verdict (docs/v10/MODERNIZE.md, D30).
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundariesFromCase,
  buildUnitJob,
  defaultUnitFile,
  makeUnitRunners,
  dispatchRemoteUnit,
  dispatchRemoteUnits,
  httpTransport,
  REMOTE_UNIT_FIELDS,
  type LocalReverify,
  type RemoteTransport,
} from "../../../src/util/modernize_unit.ts";

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

describe("nested unit ids and text boundaries (M-26b)", () => {
  it("buildUnitJob accepts a nested unit path and rejects traversal forms", () => {
    expect(buildUnitJob({ ...spec, unit: "legacy/calc.py" }).unit).toBe("legacy/calc.py");
    for (const unit of ["../x", "/abs", "a//b", "a/", "a\\b", "a/../b"]) expect(() => buildUnitJob({ ...spec, unit })).toThrow();
  });

  it("defaultUnitFile reaches a nested file and refuses traversal and a symlink that escapes the tree", () => {
    const root = mkdtempSync(join(tmpdir(), "e10-m26b-"));
    try {
      const tree = join(root, "tree"), outside = join(root, "outside");
      mkdirSync(join(tree, "legacy"), { recursive: true }); mkdirSync(outside);
      writeFileSync(join(tree, "legacy", "calc.py"), "x = 1\n"); writeFileSync(join(outside, "evil.py"), "x = 2\n");
      symlinkSync(join(outside, "evil.py"), join(tree, "link.py"));
      symlinkSync(outside, join(tree, "dirlink"));
      expect(defaultUnitFile("legacy/calc.py", tree)).toBe(join(require("node:fs").realpathSync(tree), "legacy", "calc.py"));
      expect(defaultUnitFile("link.py", tree)).toBeNull();
      expect(defaultUnitFile("dirlink/evil.py", tree)).toBeNull();
      expect(defaultUnitFile("../outside/evil.py", tree)).toBeNull();
      expect(defaultUnitFile("missing.py", tree)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  const rec = (over: Record<string, unknown>) => ({ format: 1, case: "c", entry: "label", args: [], kwargs: {}, return: null, exc: null, stdout: { t: "text", v: "" }, files: [], not_proven: [], ...over }) as never;

  it("boundariesFromCase declares the text kind the oracle recorded, nested too; mixed and non-text stay undeclared", () => {
    const b = boundariesFromCase(rec({
      args: [{ t: "text", v: "a" }, { t: "int", v: "1" }, { t: "list", v: [{ t: "bytes", v: "x" }] }, { t: "list", v: [{ t: "text", v: "a" }, { t: "bytes", v: "b" }] }],
      kwargs: { k: { t: "dict", v: [[{ t: "text", v: "a" }, { t: "int", v: "1" }]] } },
      return: { t: "text", v: "A" },
    }));
    expect(b).toEqual({ args: ["text", null, "bytes", null], kwargs: { k: "text" }, return: "text" });
  });

  const py = spawnSync("python3", ["-c", "pass"]).status === 0;
  it.skipIf(!py)("replays a text-argument case without throwing; a genuinely undeclared boundary is a named not_proven", () => {
    const tree = mkdtempSync(join(tmpdir(), "e10-m26b-"));
    try {
      writeFileSync(join(tree, "m.py"), "def label(raw):\n    return raw.upper() if isinstance(raw, str) else str(raw)\n\ndef leak():\n    return 'now text'\n");
      const { runNew } = makeUnitRunners({ target: "python3" });
      const ok = runNew("m.py", tree, rec({ args: [{ t: "text", v: "abc" }], return: { t: "text", v: "ABC" } }));
      expect(ok.not_proven ?? []).toEqual([]);
      expect(ok.return).toEqual({ t: "text", v: "ABC" });
      const bad = runNew("m.py", tree, rec({ entry: "leak", return: { t: "none" } }));
      expect(bad.not_proven).toEqual(["boundary:return undeclared"]);
      const mixed = runNew("m.py", tree, rec({ args: [{ t: "list", v: [{ t: "text", v: "a" }, { t: "bytes", v: "YWJj" }] }], return: { t: "text", v: "x" } }));
      expect(mixed.not_proven!.join(";")).toContain("boundary:raw mixes text and bytes");
    } finally { rmSync(tree, { recursive: true, force: true }); }
  }, 30_000);
});
