import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("Dockerfile documents the required token and never bakes one or opens the insecure bind", () => {
  const d = read("Dockerfile.control-plane");
  expect(d).not.toMatch(/no authentication/i);
  expect(d).toContain("LOKI_CONTROL_TOKEN");
  expect(d).not.toContain("ALLOW_INSECURE_BIND");
  expect(d).not.toMatch(/LOKI_CONTROL_TOKEN\s*=/);
  expect(d).toContain("/ready");
});

test("ECS task carries LOKI_CONTROL_TOKEN via valueFrom and never opens the insecure bind", () => {
  const raw = read("deploy/ecs/control-plane-task.json");
  const c = JSON.parse(raw).containerDefinitions[0];
  const tok = c.secrets.find((s: { name: string }) => s.name === "LOKI_CONTROL_TOKEN");
  expect(tok?.valueFrom).toMatch(/^arn:aws:secretsmanager:/);
  expect(c.environment.find((e: { name: string }) => e.name === "LOKI_CONTROL_TOKEN")).toBeUndefined();
  expect(raw).not.toContain("ALLOW_INSECURE_BIND");
});

test("Helm deployment wires the token secretKeyRef behind a required guard", () => {
  const t = read("deploy/helm/control-plane/templates/deployment.yaml");
  expect(t).toContain("LOKI_CONTROL_TOKEN");
  expect(t).toContain("secretKeyRef");
  expect(t).toMatch(/required\s+"[^"]*controlToken\.existingSecret/);
  expect(t).toContain("LOKI_CONTROL_ALLOW_INSECURE_BIND");
  const v = read("deploy/helm/control-plane/values.yaml");
  expect(v).toMatch(/controlToken:/);
  expect(v).toMatch(/allowInsecureBind:\s*false/);
});

const chart = join(root, "deploy/helm/control-plane");
const helmOk = spawnSync("helm", ["version", "--short"]).status === 0;
const render = (...args: string[]) => spawnSync("helm", ["template", "t", chart, ...args], { encoding: "utf8" });

if (!helmOk) console.log("SKIP (helm absent): helm template checks not run");

test.skipIf(!helmOk)("helm template fails without a token secret and succeeds with it", () => {
  const bad = render();
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain("controlToken.existingSecret");
  const ok = render("--set", "controlToken.existingSecret=my-token");
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain("name: LOKI_CONTROL_TOKEN");
  expect(ok.stdout).toContain("name: my-token");
  expect(ok.stdout).not.toContain("ALLOW_INSECURE_BIND");
});

test.skipIf(!helmOk)("helm allowInsecureBind opts out of the token and sets the override", () => {
  const r = render("--set", "allowInsecureBind=true");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("LOKI_CONTROL_ALLOW_INSECURE_BIND");
  expect(r.stdout).not.toContain("name: LOKI_CONTROL_TOKEN");
});
