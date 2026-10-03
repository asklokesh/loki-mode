// Malformed percent-encoding in the URL path is a client error (400), never a 500.
import { expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";

const { app } = createApp({ dbPath: ":memory:" });

for (const path of ["/v1/runs/%E0%A4%A", "/%", "/some/page/%zz", "/assets/%E0%A4%A.js"]) {
  test(`malformed encoding ${path} returns 400 JSON`, async () => {
    const r = await app.request(path);
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type") ?? "").toContain("application/json");
    expect(((await r.json()) as any).error).toBeTruthy();
  });
}

test("well-formed encoding still falls through to 404", async () => {
  const r = await app.request("/v1/nothing%20here");
  expect(r.status).toBe(404);
});
