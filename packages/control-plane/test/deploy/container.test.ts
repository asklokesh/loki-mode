import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("Dockerfile.control-plane is non-root, exposes the port and has a healthcheck", () => {
  const d = read("Dockerfile.control-plane");
  expect(d).toContain("USER loki");
  expect(d).toContain("EXPOSE 47821");
  expect(d).toContain("HEALTHCHECK");
  expect(d).not.toMatch(/ANTHROPIC_API_KEY\s*=/);
});

test("ECS task definition is valid JSON with secrets as ARNs only", () => {
  const t = JSON.parse(read("deploy/ecs/control-plane-task.json"));
  const c = t.containerDefinitions[0];
  for (const s of c.secrets) expect(s.valueFrom).toMatch(/^arn:aws:secretsmanager:/);
  expect(c.portMappings[0].containerPort).toBe(47821);
});

test("server bind host is overridable and defaults to loopback", () => {
  expect(read("packages/control-plane/src/server/serve.ts")).toContain('process.env.LOKI_CONTROL_HOST || "127.0.0.1"');
});
