import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeReceiptHash, verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { evidenceSection, hashScreens, isPageFile, routeFor, sealEvidence } from "../../src/features/visual_evidence.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vis-ev-"));
  mkdirSync(join(root, "runs", "r1"), { recursive: true });
  mkdirSync(join(root, "evidence", "screens"), { recursive: true });
  writeFileSync(join(root, "evidence", "screens", "index.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeReceipt(screens: { path: string; sha256: string }[] | null): string {
  const body: Record<string, unknown> = { schema: "loki.v10.receipt/1", run_id: "r1", verdict: "VERIFIED", ...(screens ? { evidence_screens: screens } : {}) };
  const receipt = { ...body, receipt_sha256: computeReceiptHash(body), verification: { jwt: null, kid: null } };
  const p = join(root, "runs", "r1", "receipt.json");
  writeFileSync(p, JSON.stringify(receipt));
  return p;
}

test("page file and route detection", () => {
  expect(isPageFile("src/pages/about.tsx")).toBe(true);
  expect(isPageFile("lib/util.ts")).toBe(false);
  expect(routeFor("app/dashboard/page.tsx")).toBe("/dashboard");
  expect(routeFor("public/index.html")).toBe("/");
});

test("hashScreens records sha256 and drops missing files", () => {
  const s = hashScreens(root, ["evidence/screens/index.png", "evidence/screens/nope.png"]);
  expect(s.length).toBe(1);
  expect(s[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("verify passes intact screens and is unchanged when the field is absent", async () => {
  const s = hashScreens(root, ["evidence/screens/index.png"]);
  expect((await verifyReceipt(writeReceipt(s))).verdict).toBe("UNSIGNED");
  expect((await verifyReceipt(writeReceipt(null))).verdict).toBe("UNSIGNED");
});

test("verify detects an altered screenshot", async () => {
  const s = hashScreens(root, ["evidence/screens/index.png"]);
  const p = writeReceipt(s);
  writeFileSync(join(root, "evidence", "screens", "index.png"), Buffer.from([9, 9, 9]));
  const r = await verifyReceipt(p);
  expect(r.verdict).toBe("TAMPERED");
  expect(r.reasons[0]).toContain("altered");
});

test("verify detects a missing screenshot", async () => {
  const s = hashScreens(root, ["evidence/screens/index.png"]);
  const p = writeReceipt(s);
  rmSync(join(root, "evidence", "screens", "index.png"));
  const r = await verifyReceipt(p);
  expect(r.verdict).toBe("TAMPERED");
  expect(r.reasons[0]).toContain("missing");
});

test("evidence section lists screens from the receipt, empty otherwise", () => {
  const s = hashScreens(root, ["evidence/screens/index.png"]);
  expect(evidenceSection(writeReceipt(s))).toContain(`sha256:${s[0]!.sha256}`);
  expect(evidenceSection(writeReceipt(null))).toBe("");
  expect(evidenceSection(undefined)).toBe("");
});

test("sealEvidence is a no-op when the flag is off", async () => {
  delete process.env["LOKI_VISUAL_EVIDENCE"];
  expect(await sealEvidence(root, join(root, "runs", "r1"), {}, new Set())).toEqual({});
});
