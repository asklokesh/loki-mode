// R10 extension seam: an agent a user installs via `loki agent install`
// (.loki/agents/installed.json) must actually reach the code-review reviewer
// pool on the Bun route.
//
// Before this seam was wired, `selectReviewers` scored ONLY the 5 hardcoded
// SPECIALISTS and never read installed.json, so a user-installed reviewer was
// silently dropped and its perspective never ran. These tests prove it runs.
//
// The security model is data-only (agents/hub_install.py never executes
// anything from a manifest), so "the extension executes" means: the installed
// agent is dispatched as a reviewer and its manifest text reaches the reviewer
// prompt. That is asserted directly against the prompt the reviewer receives.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCodeReview, selectReviewers } from "../../src/runner/quality_gates";
import type { RunnerContext } from "../../src/runner/types.ts";

const MANDATORY = ["architecture-strategist", "maintainer-mergeability"];

// Diff whose tokens match the installed agent's focus keywords.
const A11Y_DIFF = 'diff --git a/x.html b/x.html\n+<div aria-label="x">contrast wcag screenreader aria</div>\n';
const A11Y_FILES = "x.html\n";

// Backend-only diff: none of the a11y keywords appear.
const BACKEND_DIFF = 'diff --git a/db.py b/db.py\n+def q(): return sql_query("SELECT 1")\n';
const BACKEND_FILES = "db.py\n";

const AGENT = {
  type: "my-a11y-auditor",
  name: "Accessibility Auditor",
  swarm: "community",
  persona: "You are PROBE_PERSONA_MARKER, a WCAG accessibility auditor.",
  focus: ["wcag", "aria", "contrast", "screenreader"],
  capabilities: "WCAG 2.2 AA, ARIA roles, color contrast, keyboard nav",
  source: "hub-installed",
};

const dirs: string[] = [];

function projectWithInstalled(contents: string | object): string {
  const dir = mkdtempSync(join(tmpdir(), "loki-ext-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".loki", "agents"), { recursive: true });
  writeFileSync(
    join(dir, ".loki", "agents", "installed.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
  );
  return dir;
}

function emptyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "loki-ext-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

describe("user-installed agent reaches the reviewer pool", () => {
  it("dispatches the installed agent as a reviewer on a matching diff", () => {
    const cwd = projectWithInstalled([AGENT]);
    const names = selectReviewers(A11Y_DIFF, A11Y_FILES, { cwd }).reviewers.map((r) => r.name);
    expect(names).toContain("my-a11y-auditor");
  });

  it("carries the manifest's own text into the reviewer spec", () => {
    const cwd = projectWithInstalled([AGENT]);
    const rv = selectReviewers(A11Y_DIFF, A11Y_FILES, { cwd }).reviewers.find(
      (r) => r.name === "my-a11y-auditor",
    );
    expect(rv).toBeDefined();
    // Derived from `capabilities` and `focus` in the user's manifest, not from
    // any hardcoded table in this repo.
    expect(rv!.focus).toBe("WCAG 2.2 AA, ARIA roles, color contrast, keyboard nav");
    expect(rv!.checks).toContain("wcag");
    expect(rv!.checks).toContain("screenreader");
  });

  // The load-bearing safety property: installing an agent may only ADD
  // scrutiny. If a user agent can displace a built-in reviewer, installing one
  // silently weakens the code-review gate.
  it("is strictly additive -- never displaces a built-in reviewer", () => {
    for (const complexity of ["simple", "standard", "complex"]) {
      const baseline = selectReviewers(A11Y_DIFF, A11Y_FILES, {
        cwd: emptyProject(),
        complexity,
      }).reviewers.map((r) => r.name);
      const withAgent = selectReviewers(A11Y_DIFF, A11Y_FILES, {
        cwd: projectWithInstalled([AGENT]),
        complexity,
      }).reviewers.map((r) => r.name);

      // Every baseline reviewer survives, in order, and the user agent is appended.
      expect(withAgent.slice(0, baseline.length)).toEqual(baseline);
      expect(withAgent.length).toBe(baseline.length + 1);
      for (const m of MANDATORY) expect(withAgent).toContain(m);
    }
  });

  it("stays silent when its keywords do not match the diff", () => {
    const cwd = projectWithInstalled([AGENT]);
    const names = selectReviewers(BACKEND_DIFF, BACKEND_FILES, { cwd }).reviewers.map((r) => r.name);
    expect(names).not.toContain("my-a11y-auditor");
  });

  it("caps the number of appended installed reviewers", () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ ...AGENT, type: `a11y-${n}`, name: `Auditor ${n}` }));
    const cwd = projectWithInstalled(many);
    const extra = selectReviewers(A11Y_DIFF, A11Y_FILES, { cwd }).reviewers.filter((r) =>
      r.name.startsWith("a11y-"),
    );
    expect(extra.length).toBe(2);
  });

  it("never lets an installed agent shadow a built-in reviewer name", () => {
    const cwd = projectWithInstalled([
      { ...AGENT, type: "security-sentinel", capabilities: "IMPOSTOR" },
    ]);
    const rv = selectReviewers(A11Y_DIFF, A11Y_FILES, { cwd }).reviewers.find(
      (r) => r.name === "security-sentinel",
    );
    // Present or absent by the normal built-in scoring, but never the impostor.
    if (rv !== undefined) expect(rv.focus).not.toBe("IMPOSTOR");
  });
});

// End-to-end: the extension EXECUTES. Not just "selected" -- the code-review
// gate actually dispatches the installed agent and feeds it a prompt built from
// the user's own manifest text.
describe("runCodeReview dispatches the installed agent", () => {
  it("invokes a reviewer whose prompt carries the manifest's focus text", async () => {
    const cwd = projectWithInstalled([AGENT]);
    const seen: Array<{ name: string; prompt: string }> = [];

    const ctx: RunnerContext = {
      cwd,
      lokiDir: join(cwd, ".loki"),
      prdPath: undefined,
      provider: "claude",
      maxRetries: 5,
      maxIterations: 10,
      baseWaitSeconds: 1,
      maxWaitSeconds: 60,
      autonomyMode: "single-pass",
      sessionModel: "development",
      budgetLimit: undefined,
      completionPromise: undefined,
      iterationCount: 1,
      retryCount: 0,
      currentTier: "development",
      log: () => {},
    };

    const r = await runCodeReview(ctx, {
      diffOverride: { diff: A11Y_DIFF, files: A11Y_FILES },
      reviewer: async ({ reviewer, prompt }) => {
        seen.push({ name: reviewer.name, prompt });
        return "VERDICT: PASS\nFINDINGS:\n- None";
      },
    });

    expect(r.passed).toBe(true);
    const mine = seen.find((s) => s.name === "my-a11y-auditor");
    // The user's extension ran: it was dispatched as a reviewer.
    expect(mine).toBeDefined();
    // And it ran with ITS OWN manifest text, not a hardcoded built-in profile.
    expect(mine!.prompt).toContain("WCAG 2.2 AA, ARIA roles, color contrast, keyboard nav");
    expect(mine!.prompt).toContain("screenreader");
    // Built-in reviewers still ran alongside it.
    for (const m of MANDATORY) expect(seen.map((s) => s.name)).toContain(m);
  });
});

describe("fail-safe", () => {
  const baseline = () =>
    selectReviewers(A11Y_DIFF, A11Y_FILES, { cwd: emptyProject() }).reviewers.map((r) => r.name);

  it("a corrupt installed.json leaves the normal battery intact", () => {
    const cwd = projectWithInstalled("{ this is not json");
    expect(selectReviewers(A11Y_DIFF, A11Y_FILES, { cwd }).reviewers.map((r) => r.name)).toEqual(
      baseline(),
    );
  });

  it("an agent with no focus keywords is skipped rather than always-on", () => {
    const cwd = projectWithInstalled([{ ...AGENT, focus: [] }]);
    expect(selectReviewers(A11Y_DIFF, A11Y_FILES, { cwd }).reviewers.map((r) => r.name)).toEqual(
      baseline(),
    );
  });

  it("omitting cwd is byte-identical to today (built-ins only)", () => {
    expect(selectReviewers(A11Y_DIFF, A11Y_FILES, {}).reviewers.map((r) => r.name)).toEqual(
      baseline(),
    );
  });
});
