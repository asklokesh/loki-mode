// CP-UI-SHELL: POST /v1/start validates strictly, exists only on a loopback bind, requires a loopback peer, allows one start per repo and strips server secrets from the child env.
import { expect, test } from "bun:test";
import { childEnv, planStart } from "../../src/server/actions.ts";
import { createApp } from "../../src/server/app.ts";

const calls: string[][] = [];
type Spawn = NonNullable<Parameters<typeof createApp>[0]["spawnImpl"]>;
const mk = (spawnImpl?: Spawn, loopbackOnly = true) => createApp({ dbPath: ":memory:", loopbackOnly, spawnImpl: spawnImpl ?? (async (argv) => { calls.push(argv); return { pid: 4242 }; }) });
const peer = (address: string) => ({ requestIP: () => ({ address }) });
const post = (app: ReturnType<typeof mk>["app"], body: unknown, o: { host?: string; ct?: string; ip?: string | null } = {}) =>
  app.fetch(new Request("http://127.0.0.1:1234/v1/start", { method: "POST", headers: { "content-type": o.ct ?? "application/json", host: o.host ?? "127.0.0.1:1234" }, body: JSON.stringify(body) }), o.ip === null ? undefined : peer(o.ip ?? "127.0.0.1"));

test("accepts owner/repo#N and a plain task (as an explicit --brief), spawning an argv array", async () => {
  const { app, close } = mk();
  calls.length = 0;
  expect((await post(app, { target: "acme/widgets#12" })).status).toBe(200);
  const second = mk();
  expect((await post(second.app, { target: "Fix the login bug in auth.ts" })).status).toBe(200);
  expect(calls.map((a) => a.slice(1))).toEqual([["start", "acme/widgets#12"], ["start", "--brief", "Fix the login bug in auth.ts"]]);
  close(); second.close();
});

test("rejects shell metacharacters, option injection, colons, .. segments and bad repo without spawning", async () => {
  const { app, close } = mk();
  calls.length = 0;
  for (const t of ["a/b#1; rm -rf /", "a/b#1 && id", "$(id)", "`id`", "x | y", "a > b", "--help", "-x", "a\nb", "quote'd", 'dq"d', "", "a\\b", "{x}", "see https://x.test/y", "../../etc/passwd", "a/../b", "..", "x ..hidden", "acme/../x#1"]) {
    expect((await post(app, { target: t })).status).toBe(400);
  }
  expect((await post(app, { target: "a/b#1", repo: "/etc" })).status).toBe(400);
  expect((await post(app, { target: 5 })).status).toBe(400);
  expect(calls.length).toBe(0);
  close();
});

test("a spoofed Host from a non-loopback peer is refused, and an unknown peer fails closed", async () => {
  const { app, close } = mk();
  calls.length = 0;
  expect((await post(app, { target: "a/b#1" }, { ip: "192.168.1.50" })).status).toBe(403);
  expect((await post(app, { target: "a/b#1" }, { ip: null })).status).toBe(403);
  expect((await post(app, { target: "a/b#1" }, { host: "evil.example.com" })).status).toBe(403);
  expect((await post(app, { target: "a/b#1" }, { ct: "text/plain" })).status).toBe(403);
  const r = await app.fetch(new Request("http://127.0.0.1:1234/v1/repos", { headers: { host: "127.0.0.1:1234" } }), peer("10.0.0.9"));
  expect(r.status).toBe(403);
  expect(calls.length).toBe(0);
  close();
});

test("the action routes are not registered on a non-loopback bind", async () => {
  const { app, close } = mk(undefined, false);
  expect((await post(app, { target: "a/b#1" })).status).toBe(404);
  close();
});

test("a second concurrent start in the same repo gets 409 until the first exits", async () => {
  let exit: () => void = () => {};
  const { app, close } = mk(async (_argv, _cwd, onExit) => { exit = onExit; return { pid: 1 }; });
  expect((await post(app, { target: "a/b#1" })).status).toBe(200);
  expect((await post(app, { target: "a/b#2" })).status).toBe(409);
  exit();
  expect((await post(app, { target: "a/b#3" })).status).toBe(200);
  close();
});

test("child env has no server secrets or bind config", () => {
  const e = childEnv({ LOKI_CONTROL_TOKEN: "t", LOKI_CONTROL_DB: "d", LOKI_CONTROL_HOST: "0.0.0.0", PORT: "1", PATH: "/bin", HOME: "/h" });
  for (const k of ["LOKI_CONTROL_TOKEN", "LOKI_CONTROL_DB", "LOKI_CONTROL_HOST", "PORT"]) expect(k in e).toBe(false);
  expect(e.PATH).toBe("/bin");
});

test("planStart builds argv with the injected binary and no shell string", () => {
  const p = planStart({ target: "a/b#3" }, [], "/bin/loki");
  expect(p.ok && p.argv).toEqual(["/bin/loki", "start", "a/b#3"]);
});
