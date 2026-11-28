// Driver for tests/min/control-ui.sh: the dashboard's view logic and the Start route it uses. Prints "PASS <leg>" or "FAIL <leg>: <why>".
// A spawn stub stands in for `loki start`: no real run is ever started here.
// Usage: bun control-ui.ts <repo root>
import { join } from "node:path";
const ROOT = process.argv[2]!;
const ui = join(ROOT, "packages/control-plane/ui/src");
const model = await import(join(ui, "lib/model.ts"));
const nw = await import(join(ui, "components/NewWork.tsx")).catch(() => null);
const { createApp } = await import(join(ROOT, "packages/control-plane/src/server/app.ts"));

const out: string[] = [];
const leg = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => out.push(`PASS ${name}`), (e: Error) => out.push(`FAIL ${name}: ${e.message}`));
const eq = (a: unknown, b: unknown, w: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };

const row = (o: Record<string, unknown>) => ({ source_id: "s", run_id: "r", origin_repo: "o/r", issue_ref: null, title: null, task_source: null, provider: null, model: null, started_at: "2026-11-24T10:00:00Z", ended_at: null, verdict: null, pr_url: null, pr_draft: null, cost_usd: null, partial_usd: null, measured_sessions: 0, total_sessions: 0, input_tokens: null, output_tokens: null, wall_s: null, last_seq: 0, last_event_at: null, tampered: false, conflict: false, attested: true, sig_checked: true, ...o });
const none = new Set<string>();

await leg("running run is Running, never Needs you", () => eq(model.bucket(row({ status: "running" }), none, none), "running", "bucket"));
await leg("a running run holding a question is Needs you", () => eq(model.bucket(row({ status: "running" }), new Set(["s/r"]), none), "needs", "bucket"));
await leg("PARTIAL and FAILED need the person; VERIFIED without a PR is Delivered", () => {
  eq(model.bucket(row({ verdict: "PARTIAL", status: "completed" }), none, none), "needs", "partial");
  eq(model.bucket(row({ verdict: "FAILED", status: "completed" }), none, none), "needs", "failed");
  eq(model.bucket(row({ verdict: "SPEC_CONFLICT", status: "completed" }), none, none), "needs", "spec conflict (the blocked question)");
  eq(model.bucket(row({ verdict: "VERIFIED", status: "completed" }), none, none), "delivered", "verified");
});
await leg("VERIFIED with an open PR needs a look until dismissed", () => {
  const r = row({ verdict: "VERIFIED", status: "completed", pr_url: "https://github.com/o/r/pull/1" });
  eq(model.bucket(r, none, none), "needs", "open pr");
  eq(model.bucket(r, none, new Set(["s/r"])), "delivered", "dismissed");
});
await leg("an unattested VERIFIED is never plain VERIFIED (FC-08)", () => {
  const r = row({ verdict: "VERIFIED", status: "completed", attested: false });
  eq(model.verdictOf(r), "UNVERIFIED", "label");
  eq(model.bucket(r, none, none), "needs", "bucket");
});
await leg("stage table folds unknown stages into the one before", () => {
  eq(model.stageIndex("intake"), 0, "intake");
  eq(model.stageIndex("implement"), 2, "implement");
  eq(model.stageIndex("prove"), 3, "prove");
  eq(model.stageIndex("seal"), 4, "seal");
  eq(model.stageIndex("something_new", 3), 3, "unknown");
  eq(model.stageNow([{ stage: "intake" }, { stage: "plan" }, { stage: "mystery" }], null), 1, "furthest");
});
await leg("unpriced cost reads unpriced, never $0", () => {
  eq(model.money({ cost_usd: null, partial_usd: null }), "unpriced", "null");
  eq(model.money({ cost_usd: null, partial_usd: 1.5 }), "$1.50+", "partial");
  eq(model.money({ cost_usd: 0, partial_usd: null }), "$0.00", "measured zero");
});
await leg("weekly spend counts unpriced runs apart", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const w = model.weekly([row({ verdict: "VERIFIED", status: "completed", cost_usd: 2 }), row({ verdict: "FAILED", status: "completed" }), row({ verdict: "VERIFIED", status: "completed", cost_usd: 1, started_at: "2026-11-10T10:00:00Z" })], now);
  eq(w.length, 2, "weeks");
  eq([w[0].runs, w[0].verified, w[0].failed, w[0].usd, w[0].unpriced], [2, 1, 1, 2, 1], "this week");
});
if (nw) await leg("an issue URL becomes owner/repo#N", () => {
  eq(nw.normalizeTarget("https://github.com/acme/api/issues/42"), "acme/api#42", "url");
  eq(nw.normalizeTarget("  fix the typo "), "fix the typo", "brief");
});

// The Start route the New work dialog posts to.
const calls: { argv: string[]; cwd: string }[] = [];
const spawnImpl = async (argv: string[], cwd: string, onExit: () => void) => { calls.push({ argv, cwd }); onExit(); return { pid: 4242 }; };
const peer = { requestIP: () => ({ address: "127.0.0.1" }) }; // the real socket peer, as Bun.serve reports it
const checks: { argv: string[]; cwd: string }[] = [];
const checkImpl = async (argv: string[], cwd: string) => { checks.push({ argv, cwd }); return { exit: 0, output: "dry-run: stub" }; };
const { app } = createApp({ dbPath: ":memory:", repoDir: ROOT, loopbackOnly: true, spawnImpl: spawnImpl as never, checkImpl: checkImpl as never, startBin: "loki" });
const postTo = (path: string, body: unknown, headers: Record<string, string> = {}) => app.request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1", ...headers }, body: JSON.stringify(body) }, peer);
const post = (body: unknown, headers: Record<string, string> = {}) => app.request("http://127.0.0.1/v1/start", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1", ...headers }, body: JSON.stringify(body) }, peer);
await leg("start: an issue ref spawns a fixed argv in the repo", async () => {
  const r = await post({ target: "acme/api#42", repo: ROOT });
  eq(r.status, 200, "status");
  eq(calls.at(-1)?.argv, ["loki", "start", "acme/api#42"], "argv");
});
await leg("start: free text goes as an explicit brief, never a shell string", async () => {
  const r = await post({ target: "fix the typo; rm -rf /", repo: ROOT });
  eq(r.status, 400, "metacharacters refused");
  const ok = await post({ target: "fix the typo in the readme", repo: ROOT, budget: "5" });
  eq(ok.status, 200, "plain brief");
  eq(calls.at(-1)?.argv, ["loki", "start", "--brief", "fix the typo in the readme", "--budget", "5"], "argv");
});
await leg("start: a bad target or repo is a 400 and spawns nothing", async () => {
  const n = calls.length;
  eq((await post({ target: 5, repo: ROOT })).status, 400, "non-string");
  eq((await post({ target: "acme/api#1", repo: "/etc" })).status, 400, "unknown repo");
  eq(calls.length, n, "spawn count");
});
await leg("start: a cross-origin browser post is a 403", async () => {
  const n = calls.length;
  eq((await post({ target: "acme/api#1", repo: ROOT }, { origin: "https://evil.example" })).status, 403, "origin");
  eq(calls.length, n, "spawn count");
});
await leg("start: a token-protected server refuses a post without it", async () => {
  const t = createApp({ dbPath: ":memory:", repoDir: ROOT, loopbackOnly: true, token: "secret-test-token", spawnImpl: spawnImpl as never });
  const n = calls.length;
  const r = await t.app.request("http://127.0.0.1/v1/start", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify({ target: "acme/api#1", repo: ROOT }) }, peer);
  eq(r.status, 401, "status");
  eq(calls.length, n, "spawn count");
});
await leg("roles: each role becomes one fixed --<role>-model pair, on a brief and on an issue ref", async () => {
  const r = await post({ target: "fix the typo in the readme", repo: ROOT, roles: { plan: "opus", dev: "sonnet", test: "haiku", review: "sonnet", advisor: "opus", helper: undefined } });
  eq(r.status, 200, "status");
  eq(calls.at(-1)?.argv, ["loki", "start", "--brief", "fix the typo in the readme", "--plan-model", "opus", "--dev-model", "sonnet", "--test-model", "haiku", "--review-model", "sonnet", "--advisor-model", "opus"], "brief argv");
  eq((await post({ target: "acme/api#42", repo: ROOT, provider: "claude", budget: "5", roles: { dev: "haiku", review: "" } })).status, 200, "issue status");
  eq(calls.at(-1)?.argv, ["loki", "start", "acme/api#42", "--provider", "claude", "--budget", "5", "--dev-model", "haiku"], "issue argv (an empty role is left to Loki)");
});
await leg("roles: a bad value, an unknown role or a non-object is a 400 and spawns nothing", async () => {
  const n = calls.length;
  eq((await post({ target: "acme/api#1", repo: ROOT, roles: { plan: "opus; rm -rf /" } })).status, 400, "metacharacters");
  eq((await post({ target: "acme/api#1", repo: ROOT, roles: { plan: "-x" } })).status, 400, "leading dash");
  eq((await post({ target: "acme/api#1", repo: ROOT, roles: { helper: "haiku" } })).status, 400, "unknown role");
  eq((await post({ target: "acme/api#1", repo: ROOT, roles: ["opus"] })).status, 400, "array");
  eq((await post({ target: "acme/api#1", repo: ROOT, roles: "opus" })).status, 400, "string");
  eq(calls.length, n, "spawn count");
});
await leg("roles: a workspace run refuses role models", async () => {
  const n = calls.length;
  eq((await post({ target: "acme/api#1", repo: ROOT, workspace: "main", roles: { plan: "opus" } })).status, 400, "workspace + roles");
  eq(calls.length, n, "spawn count");
});
await leg("check: the same plan runs with --dry-run appended and starts nothing", async () => {
  const n = calls.length, m = checks.length;
  const r = await postTo("/v1/start/check", { target: "fix the typo in the readme", repo: ROOT, roles: { plan: "opus" } });
  eq(r.status, 200, "status");
  eq(await r.json(), { ok: true, exit: 0, output: "dry-run: stub" }, "body");
  eq(checks.at(-1)?.argv, ["loki", "start", "--brief", "fix the typo in the readme", "--plan-model", "opus", "--dry-run"], "argv");
  eq(checks.length, m + 1, "one check");
  eq(calls.length, n, "no run spawned");
});
await leg("check: a bad request is a 400, a workspace run is refused, and nothing runs", async () => {
  const m = checks.length;
  eq((await postTo("/v1/start/check", { target: "acme/api#1", repo: ROOT, roles: { plan: "bad value" } })).status, 400, "bad role");
  eq((await postTo("/v1/start/check", { target: "acme/api#1", repo: ROOT, workspace: "main" })).status, 400, "workspace");
  eq(checks.length, m, "check count");
});
await leg("check: a cross-origin post is a 403 and a token-protected server refuses without it", async () => {
  const m = checks.length;
  eq((await postTo("/v1/start/check", { target: "acme/api#1", repo: ROOT }, { origin: "https://evil.example" })).status, 403, "origin");
  const t = createApp({ dbPath: ":memory:", repoDir: ROOT, loopbackOnly: true, token: "secret-test-token", checkImpl: checkImpl as never });
  const r = await t.app.request("http://127.0.0.1/v1/start/check", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" }, body: JSON.stringify({ target: "acme/api#1", repo: ROOT }) }, peer);
  eq(r.status, 401, "token");
  eq(checks.length, m, "check count");
});
await leg("check: runCheck runs argv with no shell, caps its output and reports the exit", async () => {
  const { runCheck } = await import(join(ROOT, "packages/control-plane/src/server/spawn.ts"));
  const ok = await runCheck(["echo", "a;b $(x)"], ROOT);
  eq(ok, { exit: 0, output: "a;b $(x)" }, "echo is literal");
  const big = await runCheck(["head", "-c", "40000", "/dev/zero"], ROOT);
  if (big.output.length > 16_500) throw new Error(`output not capped: ${big.output.length}`);
  const bad = await runCheck(["false"], ROOT);
  eq(bad.exit, 1, "exit code");
  const gone = await runCheck(["no-such-binary-xyz"], ROOT);
  eq(gone.exit, null, "missing binary");
});
await leg("check: the UI helpers send only the roles that were set", async () => {
  const { pickRoles, ROLES } = await import(join(ROOT, "packages/control-plane/ui/src/components/NewWork.tsx"));
  eq(pickRoles({ plan: " opus ", dev: "", test: undefined }), { plan: "opus" }, "trimmed and filtered");
  eq(ROLES.map((r: { key: string }) => r.key), ["plan", "dev", "test", "review", "advisor"], "role keys match the --<role>-model flags");
});

console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
