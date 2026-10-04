// A5: GET /v1/doctor maps the real `loki doctor --json` output; a failing check is reported as fail.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const dir = mkdtempSync(join(tmpdir(), "cp-doctor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DOC = {
  loki_mode_version: "1.0.0",
  checks: [
    { name: "git", command: "git", found: true, version: "2.45.0", required: "required", min_version: null, status: "pass", path: "/usr/bin/git" },
    { name: "jq", command: "jq", found: false, version: null, required: "required", min_version: null, status: "fail", path: null },
    { name: "Bun", command: "bun", found: true, version: "1.0.0", required: "recommended", min_version: "1.3", status: "warn", path: "/x/bun" },
  ],
  disk: { available_gb: 120.5, status: "pass" },
  ai_provider: { found: false, status: "fail", required: "required", detail: "no provider CLI found" },
  summary: { passed: 2, failed: 2, warnings: 1, ok: false },
};
const fake = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
const get = (app: { fetch: (r: Request, e?: unknown) => Response | Promise<Response> }) =>
  app.fetch(new Request("http://127.0.0.1:1234/v1/doctor", { headers: { host: "127.0.0.1:1234" } }), { requestIP: () => ({ address: "127.0.0.1" }) });
const mk = (startBin: string) => createApp({ dbPath: ":memory:", answerDir: mkdtempSync(join(tmpdir(), "cp-doctor-a-")), startBin }).app;

test("a failing doctor check is returned as fail with its detail (exit 1 still parsed)", async () => {
  const bin = fake("loki-fail", `[ "$1 $2" = "doctor --json" ] || exit 2\ncat <<'J'\n${JSON.stringify(DOC)}\nJ\nexit 1`);
  const res = await get(mk(bin));
  expect(res.status).toBe(200);
  const j = (await res.json()) as { checks: { name: string; status: string; detail: string }[] };
  const by = (n: string) => j.checks.find((c) => c.name === n)!;
  expect(by("git").status).toBe("pass");
  expect(by("jq").status).toBe("fail");
  expect(by("jq").detail).toMatch(/not found/i);
  expect(by("Bun").status).toBe("warn");
  expect(by("AI provider").status).toBe("fail");
  expect(by("Disk space").status).toBe("pass");
});

test("unusable doctor output is a 502 error, not an invented pass", async () => {
  const res = await get(mk(fake("loki-junk", "echo not json")));
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toBeTruthy();
});

test("result is cached for 60s (one spawn for two requests)", async () => {
  const marker = join(dir, "count");
  const bin = fake("loki-count", `echo x >> ${marker}\necho '${JSON.stringify(DOC)}'`);
  const app = mk(bin);
  await get(app); await get(app);
  expect((await Bun.file(marker).text()).trim().split("\n").length).toBe(1);
});
