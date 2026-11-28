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
await leg("merge rate: per week from PR state, no PR not counted, unknown never read as not merged", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
  const done = (o: Record<string, unknown>) => row({ verdict: "VERIFIED", status: "completed", ...o });
  const rows = [done({ pr_url: pr(1) }), done({ pr_url: pr(2) }), done({ pr_url: pr(3) }), done({ pr_url: pr(4) }), done({}), done({ pr_url: pr(5) }), row({ status: "running", pr_url: pr(6) }),
    done({ pr_url: pr(7), started_at: "2026-11-10T10:00:00Z" })];
  const st = (s: "merged" | "open" | "closed") => ({ state: s });
  const view = { states: { [pr(1)]: st("merged"), [pr(2)]: st("merged"), [pr(3)]: st("open"), [pr(4)]: st("closed") }, checking: false }; // pr 5 and 7 have no answer
  const m = model.mergeWeekly(rows, view), w = model.weekly(rows, now);
  const cur = m.get(w[0].start), old = m.get(w[1].start);
  eq([cur.merged, cur.open, cur.closed, cur.none, cur.unknown, cur.checking], [2, 1, 1, 1, 1, 0], "this week counts (running run left out)");
  eq(cur.rate, 0.5, "rate is merged over the known PR states only: no PR and unknown are not in it");
  eq([old.unknown, old.rate], [1, null], "a week whose only PR is unknown has no rate, not 0%");
  eq(model.prKind(done({ pr_url: pr(5) }), { states: {}, checking: true }), "checking", "asked, not answered yet");
  eq(model.prKind(done({ pr_url: pr(5) }), null), "checking", "no answer from the server yet");
  eq(model.prKind(done({}), view), "none", "no link");
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

// GET /v1/pr-state: gh stubbed (never a network call). Cache first, one list call per repo, failed lookups stored as nothing.
await leg("pr-state: one gh pr list per repo, answers cached, an unanswered PR stays unknown", async () => {
  const { runs: runsT, prState: prT } = await import(join(ROOT, "packages/control-plane/src/db/schema.ts"));
  const gcalls: string[][] = [];
  const listOut = JSON.stringify([{ number: 1, state: "MERGED", mergedAt: "2026-11-24T11:00:00Z" }, { number: 2, state: "OPEN", mergedAt: null }, { number: 3, state: "CLOSED", mergedAt: null }]);
  const ghImpl = async (argv: string[]) => { gcalls.push(argv); return argv[1] === "list" ? { code: 0, stdout: listOut, stderr: "" } : { code: 1, stdout: "", stderr: "not found" }; };
  const t = createApp({ dbPath: ":memory:", repoDir: ROOT, loopbackOnly: true, ghImpl: ghImpl as never });
  const base = { partialUsd: 0, measuredSessions: 0, totalSessions: 0, inputTokens: 0, outputTokens: 0, lastSeq: 1, tampered: 0 };
  for (const n of [1, 2, 3, 4]) t.db.insert(runsT).values({ ...base, sourceId: "s", runId: `r${n}`, startedAt: `2026-11-2${n}T10:00:00Z`, verdict: "VERIFIED", prUrl: `https://github.com/o/r/pull/${n}` }).run();
  t.db.insert(runsT).values({ ...base, sourceId: "s", runId: "nopr", startedAt: "2026-11-25T10:00:00Z", verdict: "VERIFIED" }).run();
  const get = async () => (await t.app.request("http://127.0.0.1/v1/pr-state", { headers: { host: "127.0.0.1" } }, peer)).json() as Promise<{ states: Record<string, { state: string }>; checking: boolean }>;
  const first = await get();
  eq(first.checking, true, "the first call answers at once and is checking");
  for (let i = 0; i < 50 && (await get()).checking; i++) await new Promise((r) => setTimeout(r, 20));
  const done = await get();
  eq(done.checking, false, "refresh finished");
  eq(Object.fromEntries(Object.entries(done.states).map(([u, s]) => [u.split("/").pop(), s.state])), { "1": "merged", "2": "open", "3": "closed" }, "states from gh; PR 4 (gh gave nothing) and the run with no PR have none");
  const lists = gcalls.filter((a) => a[1] === "list");
  eq(lists.length, 1, "one pr list per repo");
  eq(lists[0], ["pr", "list", "--repo", "o/r", "--state", "all", "--limit", "200", "--json", "number,state,mergedAt"], "fixed argv");
  eq(gcalls.filter((a) => a[1] === "view").map((a) => a[2]), ["4"], "a PR missing from the list is read singly");
  eq(t.db.select().from(prT).all().length, 3, "an unanswered PR is not stored as anything");
  const n = gcalls.length;
  await get(); await get();
  eq(gcalls.length, n, "within the retry backoff and the TTL nothing is asked again");
});
await leg("pr-state: a failing gh stores nothing, so the page reads unknown not unmerged", async () => {
  const { runs: runsT, prState: prT } = await import(join(ROOT, "packages/control-plane/src/db/schema.ts"));
  const ghImpl = async () => ({ code: 1, stdout: "", stderr: "gh: not logged in" });
  const t = createApp({ dbPath: ":memory:", repoDir: ROOT, loopbackOnly: true, ghImpl: ghImpl as never });
  t.db.insert(runsT).values({ partialUsd: 0, measuredSessions: 0, totalSessions: 0, inputTokens: 0, outputTokens: 0, lastSeq: 1, tampered: 0, sourceId: "s", runId: "a", startedAt: "2026-11-25T10:00:00Z", verdict: "VERIFIED", prUrl: "https://github.com/o/r/pull/9" }).run();
  const get = async () => (await t.app.request("http://127.0.0.1/v1/pr-state", { headers: { host: "127.0.0.1" } }, peer)).json() as Promise<{ states: Record<string, unknown>; checking: boolean }>;
  await get();
  for (let i = 0; i < 50 && (await get()).checking; i++) await new Promise((r) => setTimeout(r, 20));
  const r = await get();
  eq([r.checking, Object.keys(r.states).length, t.db.select().from(prT).all().length], [false, 0, 0], "no state and nothing stored");
  eq(model.prKind(row({ pr_url: "https://github.com/o/r/pull/9" }), { states: r.states as never, checking: r.checking }), "unknown", "the view says unknown");
});

console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
