// CPE-24: the legacy shim is mounted before the SPA fallback in createApp.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const uiDir = mkdtempSync(join(tmpdir(), "cp-legacy-mount-"));
writeFileSync(join(uiDir, "index.html"), "<html>SPA-INDEX</html>");
const cp = createApp({ dbPath: ":memory:", uiDir, answerDir: join(uiDir, "answers"), repoDir: uiDir });
afterAll(() => { cp.close(); rmSync(uiDir, { recursive: true, force: true }); });
const loop = { requestIP: () => ({ address: "127.0.0.1" }) };

test("a legacy path is answered by the shim, not index.html", async () => {
  const r = await cp.app.request("/api/v2/tenants", { redirect: "manual" }, loop);
  expect(r.status).toBe(501);
  expect(await r.text()).not.toContain("SPA-INDEX");
});

test("an unknown non-legacy path still gets the SPA", async () => {
  const r = await cp.app.request("/some/ui/route", { redirect: "manual" }, loop);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("SPA-INDEX");
});
