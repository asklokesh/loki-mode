// SPEED-TIMER-UNREF: the repaint interval must not keep the process alive when stop() is never called.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("start() without stop() does not keep the process alive", async () => {
  const mod = join(import.meta.dir, "../../../src/features/speed/group_output.ts");
  const code = `import { createGroupRenderer } from ${JSON.stringify(mod)};
const r = createGroupRenderer({ write: () => {}, isTTY: true, intervalMs: 50 });
r.start();`;
  const t0 = Date.now();
  const p = Bun.spawn(["bun", "-e", code], { stdout: "ignore", stderr: "ignore", env: { ...process.env, LOKI_NO_BROWSER: "1" } });
  const timer = setTimeout(() => p.kill(), 5000);
  const exit = await p.exited;
  clearTimeout(timer);
  expect(Date.now() - t0).toBeLessThan(2500);
  expect(exit).toBe(0);
});
