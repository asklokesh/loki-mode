import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPrompt } from "../src/runner/build_prompt.ts";

// Reviewer findings must reach the model even when no gate wrote
// gate-failures.txt.
//
// The findings block used to be nested inside `if (failures !== null)`, so a
// council BLOCK with no gate-failures.txt produced a prompt containing the
// order "fix these issues" without saying WHICH. The model re-derived the
// problem from scratch every iteration: the slowest and least accurate way to
// converge, and the exact blind-retry loop that makes runs long and expensive.
//
// Two sibling blocks (semantic findings, invariant findings) were already
// hoisted out of that guard for the identical reason, with source comments
// saying nesting them "would silently drop exactly that case". Reviewer
// findings never got the same treatment.
//
// Verified by execution before and after: with this fixture the baseline
// prompt contained neither "auth.ts" nor "constant-time"; after the hoist it
// contains both.

function fixture(): string {
  const root = join(tmpdir(), `loki-findings-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const reviewDir = join(root, ".loki", "quality", "reviews", "review-1");
  mkdirSync(reviewDir, { recursive: true });
  // The parser expects bracketed severities.
  writeFileSync(
    join(reviewDir, "reviewer-security.txt"),
    "[Critical] src/auth.ts:42 - token comparison is not constant-time\n" +
      "[High] src/api.ts:88 - unvalidated user input reaches the query builder\n",
    "utf-8",
  );
  // Deliberately NO .loki/quality/gate-failures.txt -- that is the case under test.
  return root;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function promptFor(root: string, env: Record<string, string> = {}): Promise<string> {
  const ctx = { env: { ...process.env, ...env, TARGET_DIR: root }, cwd: root } as never;
  return String(await buildPrompt({ retry: 0, prd: "spec", iteration: 2, ctx } as never));
}

describe("reviewer findings reach the prompt", () => {
  test("findings appear with no gate-failures.txt present", async () => {
    const root = fixture();
    roots.push(root);
    const prompt = await promptFor(root);

    // The specific file and the specific defect, not just a generic order.
    expect(prompt).toContain("auth.ts");
    expect(prompt).toContain("constant-time");
    expect(prompt).toContain("PREVIOUS REVIEWER FINDINGS");
  });

  test("severity is preserved so the model can triage", async () => {
    const root = fixture();
    roots.push(root);
    const prompt = await promptFor(root);
    expect(prompt.toLowerCase()).toContain("critical");
  });

  test("the opt-out still works", async () => {
    // Operators can disable injection; that path must stay honoured.
    const root = fixture();
    roots.push(root);
    const prompt = await promptFor(root, { LOKI_INJECT_FINDINGS: "0" });
    expect(prompt).not.toContain("PREVIOUS REVIEWER FINDINGS");
  });

  test("no findings means no block and no dangling instruction", async () => {
    // An empty review dir must not emit a "fix these issues" order with
    // nothing attached -- that would be the same blind retry in reverse.
    const root = join(tmpdir(), `loki-nofindings-${Date.now()}`);
    mkdirSync(join(root, ".loki", "quality"), { recursive: true });
    roots.push(root);
    const prompt = await promptFor(root);
    expect(prompt).not.toContain("PREVIOUS REVIEWER FINDINGS");
  });
});
