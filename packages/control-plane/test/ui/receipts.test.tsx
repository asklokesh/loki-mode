// CPE-16: receipts page. Verify happens in place; a TAMPERED result is shown as such; the key and the trend are real data or "not measured".
import "./dom";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { Receipts } = await import("../../ui/src/pages/receipts/Receipts");
const { page } = await import("../../ui/src/pages/receipts/index");
const { verifiedTrend } = await import("../../ui/src/pages/receipts/api");

const run = (id: string, verdict: string | null, day: string) => ({ source_id: "s1", run_id: id, verdict, started_at: `${day}T10:00:00Z` });
const KEY = { kty: "OKP", crv: "Ed25519", x: "abc", kid: "kid-1", alg: "EdDSA", use: "sig" };

function serve(verifyVerdict: string, key: unknown = KEY) {
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/verify")) return new Response(JSON.stringify({ run: "r1", verdict: verifyVerdict, reasons: verifyVerdict === "TAMPERED" ? ["receipt_sha256 mismatch"] : [], receipt_sha256: null, verified_at: "x" }));
    if (u.startsWith("/v1/keys")) return key ? new Response(JSON.stringify(key)) : new Response("{}", { status: 404 });
    if (u.startsWith("/v1/runs")) return new Response(JSON.stringify({ runs: [run("r1", "VERIFIED", "2026-10-01"), run("r2", "FAILED", "2026-10-01"), run("r3", null, "2026-10-02")], total: 3, next_cursor: null }));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeAll(() => { (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE = ""; });
afterEach(cleanup);
afterAll(() => { globalThis.fetch = realFetch; });

test("page export shape", () => { expect(page.id).toBe("receipts"); expect(page.path).toBe("/receipts"); });

test("lists finished runs only, shows the key and an honest rate", async () => {
  serve("VERIFIED");
  render(<Receipts />);
  expect((await screen.findAllByTestId("verify-btn")).length).toBe(2);
  expect((await screen.findByTestId("key-kid")).textContent).toContain("kid-1");
  expect(screen.getByText("50%")).toBeTruthy();
});

test("Verify shows a TAMPERED result in place with the reason", async () => {
  serve("TAMPERED");
  render(<Receipts />);
  fireEvent.click((await screen.findAllByTestId("verify-btn"))[0]!);
  const out = await screen.findByTestId("verify-result");
  expect(out.getAttribute("data-verdict")).toBe("TAMPERED");
  expect(out.textContent).toContain("receipt_sha256 mismatch");
});

test("no key reads not measured", async () => {
  serve("VERIFIED", null);
  render(<Receipts />);
  await screen.findByText(/not measured: no signing key/);
});

test("trend skips days with no finished run", () => {
  const t = verifiedTrend([run("a", "VERIFIED", "2026-10-01"), run("b", "FAILED", "2026-10-01"), run("c", null, "2026-10-02")]);
  expect(t).toEqual([{ day: "2026-10-01", rate: 0.5, total: 2 }]);
});
