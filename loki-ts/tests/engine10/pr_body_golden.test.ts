// select: walk-all-src
// L7 "Outputs are contracts": golden test from the real FireLater#17 recording (sanitised subset in tests/fixtures/pr-body-firelater17).
// The recorded PR body printed "not recorded" for the issue, why, files in scope and tests although every one was in the run dir.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tierBodyLine, applyPrTemplate, readPrTemplate, receiptProof } from "../../src/engine10/pr_body.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReviewerBody } from "../../src/e10ext/reviewer_body.ts";
import { loadRunOutputs, type StageOutputs } from "../../src/util/run_outputs.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "pr-body-firelater17");
const events = readFileSync(join(FIX, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as EventEnvelope);
const seal = (events.find((e) => e.stage === "seal")?.data ?? {}) as { receipt_sha256?: string; signed?: boolean; verdict?: string; not_proven?: string[] };
const render = (outputs: StageOutputs, sha: string | null = seal.receipt_sha256 ?? null): string =>
  renderReviewerBody({ verdict: seal.verdict ?? "FAILED", draftReason: "verdict FAILED", notProven: seal.not_proven ?? [], receiptPath: "/repo/.loki/runs/e10-fixture/receipt.json", receiptSha256: sha, signed: seal.signed ?? null, runId: "e10-fixture", outputs });
const notRecorded = (body: string): string[] => body.split("\n").filter((l) => l.includes("not recorded"));

describe("PR body golden: FireLater#17 recording", () => {
  const outputs = loadRunOutputs(FIX, events);
  const body = render(outputs);
  it("prints no 'not recorded' for any field whose source data exists", () => {
    expect(notRecorded(body)).toEqual([]);
    expect(body).not.toMatch(/not recorded|not available|unavailable|no data|unknown|missing/i); // widened missing-field phrases
  });
  it("names the receipt-check action with a copyable uses: line pinned to the current version", () => {
    const v = readFileSync(join(import.meta.dir, "../../../VERSION"), "utf8").trim();
    expect(body).toContain(`- \`uses: asklokesh/loki-mode/.github/actions/receipt-check@v${v}\``);
    expect(body).not.toContain("adds the receipt-check action");
    const unpinned = renderReviewerBody({ verdict: "VERIFIED", draftReason: null, notProven: [], receiptPath: null, receiptSha256: null, signed: null, runId: "r", outputs }, {}, "unknown");
    expect(unpinned).not.toContain("uses:");
    expect(renderReviewerBody({ verdict: "VERIFIED", draftReason: null, notProven: [], receiptPath: null, receiptSha256: null, signed: null, runId: "r", outputs }, {}, "11.17.9")).toContain("receipt-check@v11.17.9`");
  });
  it("fills what the issue asked from the issue's acceptance criteria", () => {
    expect(body).toContain("- Create centralized Zod schema registry");
    expect(body).toContain("- Implement validation middleware for all routes");
  });
  it("fills why from the issue title and files from the diff", () => {
    expect(body).toContain("- Why: Create Unified Request Validation and Sanitization Middleware");
    expect(body).toContain("- backend/src/middleware/sanitization.ts");
  });
  it("fills tests from the verify evidence with real results", () => {
    expect(body).toMatch(/- Checks: \d+ passed, \d+ failed/);
    expect(body).toContain("`npx vitest run backend/tests/unit/middleware/sanitization-escape.test.ts` -> pass");
  });
  it("falls back to issue.json and plan-output.txt when the events lack intake and plan", () => {
    const bare = loadRunOutputs(FIX, events.filter((e) => e.stage !== "intake" && e.stage !== "plan"));
    expect(String(bare.intake?.["task"])).toContain("Create Unified Request Validation");
    expect(String(bare.plan?.["plan"])).toContain("backend/src/schemas/");
    expect(render(bare)).toContain("- Why: Create Unified Request Validation and Sanitization Middleware");
  });
  it("labels plan files as planned, never as changed, when no diff was recorded", () => {
    const noDiff = structuredClone(outputs) as StageOutputs;
    noDiff["verify"] = { ...noDiff["verify"], changed_files: [] };
    const b = render(noDiff);
    expect(b).toContain("- Files in scope (planned, no diff recorded): ");
    expect(b).not.toMatch(/^- backend\/src\/types\/index\.ts$/m);
    expect(body).not.toContain("planned, no diff recorded");
  });
  it("does not list files the commit stage reverted as changed", () => {
    for (const r of ["backend/src/routes/applications.ts", "backend/src/routes/assets.ts", "backend/src/routes/attachments.ts"]) {
      expect(outputs.verify?.["changed_files"]).not.toContain(r);
      expect(body).not.toContain(`- ${r}\n`);
    }
    expect(outputs.verify?.["changed_files"]).toContain("backend/src/middleware/sanitization.ts");
  });
  it("still prints 'not recorded' when the source is genuinely absent (the honest case)", () => {
    const empty = mkdtempSync(join(tmpdir(), "l7-empty-"));
    try {
      const none = render(loadRunOutputs(empty, []), null);
      for (const f of ["- not recorded", "- Why: not recorded", "- Files in scope: not recorded", "- Tests: not recorded", "- Digest: not recorded"]) expect(none).toContain(f);
      const noVerify = render(loadRunOutputs(FIX, events.filter((e) => e.stage !== "verify" && e.stage !== "plan")));
      expect(noVerify).toContain("- Tests: not recorded");
      expect(noVerify).toContain("- Files in scope: not recorded");
      expect(noVerify).not.toContain("## What the issue asked\n- not recorded");
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
  it("is sanitised: no home paths or secrets in the fixture", () => {
    for (const f of readdirSync(FIX)) { const t = readFileSync(join(FIX, f), "utf8"); expect(t).not.toMatch(/\/Users\/|\/home\/[a-z]+\/|ghp_|eyJ[A-Za-z0-9]/); }
  });
});

describe("L7 guard: no producer prints 'not recorded' for a present source key", () => {
  const full = loadRunOutputs(FIX, events);
  // field line prefix -> the source keys that feed it; removing ALL of them is the only way it may read "not recorded"
  const FIELDS: { line: string; keys: [string, string][] }[] = [
    { line: "- not recorded", keys: [["intake", "task"]] },
    { line: "- Why: not recorded", keys: [["intake", "task"], ["intake", "title"], ["plan", "plan"]] },
    { line: "- Files in scope: not recorded", keys: [["verify", "changed_files"], ["plan", "relevant_files"]] },
    { line: "- Tests: not recorded", keys: [["verify", "checks"]] },
  ];
  for (const f of FIELDS) {
    it(`"${f.line}" appears only when every source (${f.keys.map((k) => k.join(".")).join(", ")}) is gone`, () => {
      expect(render(full)).not.toContain(f.line);
      for (const [stage, key] of f.keys) {
        const without = structuredClone(full) as StageOutputs;
        delete without[stage]?.[key];
        const survivors = f.keys.some(([s, k]) => without[s]?.[k] !== undefined);
        if (survivors) expect(render(without)).not.toContain(f.line);
      }
      const gone = structuredClone(full) as StageOutputs;
      for (const [s, k] of f.keys) delete gone[s]?.[k];
      if (f.line === "- Tests: not recorded") delete gone["verify"];
      expect(render(gone)).toContain(f.line);
    });
  }
  it("the supervisor feeds the PR body from the recorded run, not seal alone", () => {
    const sup = readFileSync(join(import.meta.dir, "..", "..", "src", "engine10", "supervisor.ts"), "utf8");
    expect(sup).toContain("loadRunOutputs(runDir, events)");
  });
  it("every source file that can print 'not recorded' is a registered producer", () => {
    const REGISTERED = new Set(["e10ext/reviewer_body.ts", "engine10/stages/seal.ts", "engine10/session.ts", "runner/sdk_stream_parser.ts", "util/run_outputs.ts", "runner/router/route_block.ts", "util/run_summary.ts", "metrics/trust.ts", "engine10/verify_cmd.ts", "util/check_result.ts"]);
    const root = join(import.meta.dir, "..", "..", "src");
    const hits: string[] = [];
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("not recorded")) hits.push(p.slice(root.length + 1)); } };
    walk(root);
    expect(hits.filter((h) => !REGISTERED.has(h))).toEqual([]);
  });
});

it("FC-VERIFIED-PR-WITHOUT-ITS-TEST: the body lists the published acceptance tests and the command that ran them", () => {
  const input = { verdict: "VERIFIED", draftReason: null, notProven: [], receiptPath: null, receiptSha256: null, signed: null, runId: "r1" };
  const body = renderReviewerBody({ ...input, outputs: { seal: { wall_published: { files: ["tests/loki_wall_x.test.ts"], cmds: ["bun test tests/loki_wall_x.test.ts"] } } } });
  expect(body).toContain("## Acceptance tests");
  expect(body).toContain("- tests/loki_wall_x.test.ts");
  expect(body).toContain("`bun test tests/loki_wall_x.test.ts`");
  expect(renderReviewerBody({ ...input, outputs: {} })).not.toContain("## Acceptance tests");
});

describe("pr template", () => {
  const TPL = "<!-- describe -->\n## Summary\nWhat does this do?\n\n## Changes\n- list\n\n## Testing\n- [ ] Tests pass\n- [ ] Tests added\n- [ ] Docs updated\n\n## Reviewer notes\nanything else\n";
  const full = loadRunOutputs(FIX, events);
  const base = render(full);
  const proof = receiptProof("VERIFIED", full, "abc");
  it("fills each of 4 headings, keeps unmapped template text, ticks only proven boxes", () => {
    const out = applyPrTemplate(base, TPL, proof);
    for (const h of ["## Summary", "## Changes", "## Testing", "## Reviewer notes"]) expect(out).toContain(h);
    expect(out).toContain("- Why: Create Unified Request Validation and Sanitization Middleware");
    expect(out).toContain("- backend/src/middleware/sanitization.ts");
    expect(out).toContain("Checks:");
    expect(out).toContain("anything else");
    expect(out).toContain("- [x] Tests pass");
    expect(out).toContain("- [ ] Docs updated");
    expect(out).toContain("## NOT PROVEN");
    expect(out).toContain("## Receipt");
  });
  it("ticks nothing when the receipt proves nothing", () => {
    expect(applyPrTemplate(base, TPL, receiptProof("FAILED", {}, null))).not.toContain("[x]");
  });
  it("resets pre-ticked boxes and ticks only what the receipt proves", () => {
    const T = "## Testing\n- [x] All tests pass\n- [X] Verified by loki\n- [x] Receipt attached\n- [x] Docs updated\n";
    const failed = applyPrTemplate(base, T, receiptProof("FAILED", {}, null));
    expect(failed).not.toMatch(/\[[xX]\]/);
    const ok = applyPrTemplate(base, T, proof);
    expect(ok).toContain("- [x] All tests pass");
    expect(ok).toContain("- [x] Verified by loki");
    expect(ok).toContain("- [x] Receipt attached");
    expect(ok).toContain("- [ ] Docs updated");
    const U = "## Notes\n- [x] Receipt attached\n";
    expect(applyPrTemplate(base, U, receiptProof("FAILED", {}, null))).not.toMatch(/\[[xX]\]/);
  });
  it("heading matchers use whole words and skip HTML comments", () => {
    const out = applyPrTemplate(base, "## Checklist\nkeep me\n\n## Latest\nkeep too\n\n<!--\n## Testing\nhidden\n-->\n", proof);
    expect(out).toContain("keep me");
    expect(out).toContain("keep too");
    expect(out).toContain("hidden");
  });
  it("rejects a template reached through a symlinked directory or file", () => {
    const d = mkdtempSync(join(tmpdir(), "prt-")), o = mkdtempSync(join(tmpdir(), "prt-out-"));
    try {
      writeFileSync(join(o, "pull_request_template.md"), "## Evil\n");
      symlinkSync(o, join(d, ".github"));
      expect(readPrTemplate(d)).toBeNull();
      rmSync(join(d, ".github"));
      mkdirSync(join(d, ".github"));
      symlinkSync(join(o, "pull_request_template.md"), join(d, ".github", "pull_request_template.md"));
      expect(readPrTemplate(d)).toBeNull();
      rmSync(join(d, ".github", "pull_request_template.md"));
      writeFileSync(join(d, ".github", "pull_request_template.md"), "## Ok\n");
      expect(readPrTemplate(d)).toBe("## Ok\n");
    } finally { rmSync(d, { recursive: true, force: true }); rmSync(o, { recursive: true, force: true }); }
  });
  it("reads only documented paths, caps size, and returns null with no template", () => {
    const d = mkdtempSync(join(tmpdir(), "prt-"));
    try {
      expect(readPrTemplate(d)).toBeNull();
      mkdirSync(join(d, ".github"));
      writeFileSync(join(d, ".github", "PULL_REQUEST_TEMPLATE.md"), "## A\nx\n".repeat(20000));
      expect((readPrTemplate(d) ?? "").length).toBeLessThanOrEqual(32768);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("PR body tier line (GAME10-09b)", () => {
  it("prints the sealed tier and parity record, and not measured when the record is missing", () => {
    const c = (verified: number, total: number) => ({ verified, partial: 0, failed: total - verified, other: 0, unsealed: 0, total });
    expect(tierBodyLine({ tier: "sonnet", topTierCostAvoidedUsd: 0.42, record: { sonnet: c(10, 10), opus: c(9, 10) } })).toBe("- Model tier: sonnet tier sealed; top-tier cost avoided $0.42; parity here: sonnet sealed 10 of 10, opus sealed 9 of 10");
    expect(tierBodyLine({ tier: "sonnet" })).toContain("parity here: sonnet not measured, opus not measured");
  });
});
