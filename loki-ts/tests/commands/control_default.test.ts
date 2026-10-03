import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverControlUrl, instancePath, isLoopbackHttp } from "../../../packages/control-plane/src/shipper/discover.ts";
import { runControl } from "../../src/commands/control.ts";
import { startShip } from "../../src/e10ext/ship_hook.ts";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cpdef-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const env = (x: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: home, ...x });
const writeInst = (o: object): void => { mkdirSync(join(home, ".loki", "control"), { recursive: true }); writeFileSync(instancePath(env()), JSON.stringify(o)); };
const health = (service: string, calls: string[] = []): typeof fetch => (async (u: string) => { calls.push(String(u)); return new Response(JSON.stringify({ service })); }) as unknown as typeof fetch;

describe("discoverControlUrl", () => {
  test("no instance.json: zero fetch calls", async () => {
    const calls: string[] = [];
    expect(await discoverControlUrl(env(), { fetchImpl: health("loki-control", calls) })).toBeNull();
    expect(calls.length).toBe(0);
  });
  test("stale pid is ignored", async () => {
    writeInst({ pid: 999999, port: 1, url: "http://127.0.0.1:1" });
    const calls: string[] = [];
    expect(await discoverControlUrl(env(), { fetchImpl: health("loki-control", calls), alive: () => false })).toBeNull();
    expect(calls.length).toBe(0);
  });
  test("live pid with the wrong service is ignored", async () => {
    writeInst({ pid: process.pid, port: 1, url: "http://127.0.0.1:1" });
    expect(await discoverControlUrl(env(), { fetchImpl: health("other") })).toBeNull();
  });
  test("valid instance gives its url after one health call", async () => {
    writeInst({ pid: process.pid, port: 1, url: "http://127.0.0.1:1/" });
    const calls: string[] = [];
    expect(await discoverControlUrl(env(), { fetchImpl: health("loki-control", calls) })).toBe("http://127.0.0.1:1");
    expect(calls).toEqual(["http://127.0.0.1:1/health"]);
  });
  test("LOKI_CONTROL=0 disables discovery", async () => {
    writeInst({ pid: process.pid, port: 1, url: "http://127.0.0.1:1" });
    const calls: string[] = [];
    expect(await discoverControlUrl(env({ LOKI_CONTROL: "0" }), { fetchImpl: health("loki-control", calls) })).toBeNull();
    expect(calls.length).toBe(0);
  });
  test("explicit LOKI_CONTROL_URL wins without a probe", async () => {
    expect(await discoverControlUrl(env({ LOKI_CONTROL_URL: "http://x:9" }))).toBe("http://x:9");
  });
});

describe("loopback only", () => {
  test("a non-loopback instance url is ignored with no fetch", async () => {
    writeInst({ pid: process.pid, port: 80, url: "http://10.255.255.1:80" });
    const calls: string[] = [];
    expect(await discoverControlUrl(env(), { fetchImpl: health("loki-control", calls) })).toBeNull();
    expect(calls.length).toBe(0);
  });
  test("isLoopbackHttp accepts only http on 127.0.0.1, localhost, [::1]", () => {
    for (const u of ["http://127.0.0.1:5", "http://localhost:5", "http://[::1]:5"]) expect(isLoopbackHttp(u)).toBe(true);
    for (const u of ["https://127.0.0.1:5", "http://10.0.0.1:5", "http://127.0.0.1.evil.example:5", "nonsense"]) expect(isLoopbackHttp(u)).toBe(false);
  });
});

describe("startShip discovery", () => {
  test("a valid instance gives one ship (ingest reaches the stub)", async () => {
    let posts = 0;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return Response.json({ service: "loki-control" });
      if (u.pathname === "/v1/ingest") { posts++; return Response.json({}); }
      return new Response("nf", { status: 404 });
    } });
    try {
      writeInst({ pid: process.pid, port: srv.port, url: `http://127.0.0.1:${srv.port}` });
      const runDir = join(home, "repo", ".loki", "runs", "r1"); mkdirSync(runDir, { recursive: true });
      const log = new SupervisorLog(join(runDir, "events.jsonl"), "r1"); log.append("run.started", null, {});
      await startShip(join(home, "repo"), log.path, env());
      for (let i = 0; i < 40 && !existsSync(join(runDir, "ship.json")); i++) await Bun.sleep(100);
      expect(existsSync(join(runDir, "ship.json"))).toBe(true);
      expect(posts).toBeGreaterThan(0);
    } finally { srv.stop(true); }
  }, 15000);
});

describe("test sandbox", () => {
  test("preload gives every bun test child LOKI_CONTROL=0 when the ambient env has none", async () => {
    const e: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home };
    const p = Bun.spawn(["bun", "test", "tests/commands/control_env_probe.test.ts"], { cwd: join(import.meta.dir, "../.."), env: e, stdout: "ignore", stderr: "ignore" });
    expect(await p.exited).toBe(0);
  }, 30000);
  test("a live instance in HOME receives no ingest from the engine10 ship_hook suite", async () => {
    let posts = 0;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/health") return Response.json({ service: "loki-control" });
      if (u.pathname === "/v1/ingest") posts++;
      return Response.json({});
    } });
    try {
      writeInst({ pid: process.pid, port: srv.port, url: `http://127.0.0.1:${srv.port}` });
      const e: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home };
      const p = Bun.spawn(["bun", "test", "tests/engine10/ship_hook.test.ts"], { cwd: join(import.meta.dir, "../.."), env: e, stdout: "ignore", stderr: "ignore" });
      await p.exited;
      expect(posts).toBe(0);
    } finally { srv.stop(true); }
  }, 60000);
});

describe("loki control default", () => {
  test("LOKI_CONTROL=0 prints one off line and exits 0", async () => {
    let out = ""; const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    try { expect(await runControl(["status"], env({ LOKI_CONTROL: "0" }))).toBe(0); } finally { process.stdout.write = w; }
    expect(out.trim().split("\n")).toEqual(["loki control is off (LOKI_CONTROL=0). Unset it to turn the Control Plane back on."]);
  });
  test("serve needs no flag; instance.json is 0600 and removed after exit", async () => {
    const db = join(home, "c.db");
    const p = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli.ts"), "control", "serve", "--port", "0", "--db", db], { env: { PATH: process.env.PATH ?? "", HOME: home, LOKI_NO_BROWSER: "1", LOKI_TELEMETRY_DISABLED: "1" }, stdout: "ignore", stderr: "pipe" });
    const errText = new Response(p.stderr as ReadableStream).text();
    const f = instancePath(env());
    for (let i = 0; i < 100 && !existsSync(f); i++) await Bun.sleep(100);
    try {
      if (!existsSync(f)) { p.kill("SIGTERM"); await p.exited; throw new Error(`instance.json never appeared; child exit=${p.exitCode} stderr:\n${await errText}`); }
      expect(existsSync(f)).toBe(true);
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, ".loki", "control")).mode & 0o777).toBe(0o700);
      const inst = JSON.parse(await Bun.file(f).text());
      expect(Object.keys(inst).sort()).toEqual(["db", "install_path", "pid", "port", "url", "version"]);
      expect(await discoverControlUrl(env())).toBe(inst.url);
    } finally { p.kill("SIGTERM"); await p.exited; }
    for (let i = 0; i < 30 && existsSync(f); i++) await Bun.sleep(100);
    expect(existsSync(f)).toBe(false);
  }, 20000);
});
