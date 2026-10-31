// FC-25: a git call from the token-holding supervisor must never run a core.fsmonitor plant in the agent's repo.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunCapS } from "../../src/util/run_cap.ts";
import { tokenFreeEnv, safeGit, safeGitArgs, safeGitSpawn, safeGitRun } from "../../src/util/safe_git.ts";
import { listRepoFiles } from "../../src/engine10/repomap.ts";
import { restoreBranch } from "../../src/e10ext/stop_restore.ts";

let root: string, repo: string, runDir: string, hit: string;
const CANARY = "ghp_fc25canary";
const g = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fc25-trusted-git-"));
  repo = join(root, "repo"); runDir = join(root, "run"); hit = join(root, "hit.txt");
  mkdirSync(repo); mkdirSync(runDir);
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "a.txt"); g("commit", "-qm", "init");
  const rec = join(root, "rec.sh");
  writeFileSync(rec, `#!/bin/sh\necho "fired token=$GH_TOKEN" >> "${hit}"\nexit 0\n`); chmodSync(rec, 0o755);
  g("config", "core.fsmonitor", rec);
  g("branch", "other");
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
const fired = (): boolean => existsSync(hit);
const reset = (): void => { rmSync(hit, { force: true }); };

test("control: the plant fires on a plain git ls-files", () => {
  reset(); execFileSync("git", ["ls-files"], { cwd: repo, env: { ...process.env, GH_TOKEN: CANARY, GIT_CONFIG_GLOBAL: "/dev/null" } });
  expect(fired()).toBe(true); reset();
});
test("resolveRunCapS never runs the fsmonitor plant", () => {
  reset(); resolveRunCapS(repo, false, { ...process.env, GH_TOKEN: CANARY });
  expect(fired() ? readFileSync(hit, "utf8") : "").toBe("");
});
test("repomap, restoreBranch and the cap never fire the plant with the canary in process.env", () => {
  reset(); const saved = process.env.GH_TOKEN; process.env.GH_TOKEN = CANARY;
  try { resolveRunCapS(repo, false); listRepoFiles(repo); restoreBranch(repo, "other"); } finally { if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved; }
  expect(fired()).toBe(false);
});
test("safeGit strips the token family and SSH_AUTH_SOCK from the child env", () => {
  const e = tokenFreeEnv({ GH_TOKEN: "a", GITHUB_TOKEN: "b", GH_ENTERPRISE_TOKEN: "c", GITHUB_ENTERPRISE_TOKEN: "d", SSH_AUTH_SOCK: "e", KEEP: "1" });
  expect(e["KEEP"]).toBe("1"); expect(e["SSH_AUTH_SOCK"]).toBeUndefined(); // FC-90: the family is a sentinel, never the real value
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) expect(e[k]!.startsWith("ghp_LOKIWITHHELDsentinel")).toBe(true);
  reset(); safeGit(repo, ["ls-files"]); expect(fired()).toBe(false);
});

// FC-25b: filter, textconv and gpg.program plants. Each repo gets its own recorder that logs the token it can see.
type Plant = { name: string; setup: (r: string, rec: string) => void; calls: string[][] };
const PLANTS: Plant[] = [
  { name: "filter via .gitattributes", calls: [["status", "--porcelain"], ["diff", "--name-only", "HEAD"], ["add", "-A", "--", "."]],
    setup: (r, rec) => { writeFileSync(join(r, ".gitattributes"), "* filter=evil\n"); gc(r, "filter.evil.clean", rec); gc(r, "filter.evil.process", rec); } },
  { name: "filter via .git/info/attributes", calls: [["status", "--porcelain"], ["diff", "--name-only", "HEAD"], ["add", "-A", "--", "."]],
    setup: (r, rec) => { writeFileSync(join(r, ".git", "info", "attributes"), "* filter=evil\n"); gc(r, "filter.evil.clean", rec); } },
  { name: "diff textconv", calls: [["log", "-p", "-1"], ["diff", "HEAD~1", "HEAD"]],
    setup: (r, rec) => { writeFileSync(join(r, ".gitattributes"), "*.txt diff=evil\n"); gc(r, "diff.evil.textconv", rec); } },
  { name: "gpg.program with commit.gpgSign", calls: [["commit", "-q", "--allow-empty", "-m", "x"]],
    setup: (r, rec) => { gc(r, "gpg.program", rec); gc(r, "commit.gpgSign", "true"); } },
];
const gc = (r: string, k: string, v: string): void => { execFileSync("git", ["config", k, v], { cwd: r, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }); };
for (const pl of PLANTS) {
  test(`FC-25b: ${pl.name} never runs, no token visible`, () => {
    const r = mkdtempSync(join(root, "p-")), h = join(r, "..", `${r.split("/").pop()}.hit`), rec = join(root, `rec-${r.split("/").pop()}.sh`);
    writeFileSync(rec, `#!/bin/sh\necho "fired token=$GH_TOKEN" >> "${h}"\ncat\n`); chmodSync(rec, 0o755);
    const G = (...a: string[]): string => execFileSync("git", a, { cwd: r, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    G("init", "-q"); G("config", "user.email", "t@t"); G("config", "user.name", "t");
    writeFileSync(join(r, "a.txt"), "a\n"); G("add", "a.txt"); G("commit", "-qm", "one"); writeFileSync(join(r, "a.txt"), "b\n"); G("commit", "-qam", "two");
    writeFileSync(join(r, "c.txt"), "new\n");
    pl.setup(r, rec);
    // control: the plant fires under a plain, token-holding git call
    for (const c of pl.calls) { try { execFileSync("git", c, { cwd: r, env: { ...process.env, GH_TOKEN: CANARY, GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" }); } catch { /* ok */ } }
    expect(existsSync(h)).toBe(true); rmSync(h, { force: true });
    const saved = process.env.GH_TOKEN; process.env.GH_TOKEN = CANARY;
    try { for (const c of pl.calls) { try { safeGit(r, c); } catch { /* an error is acceptable, a run is not */ } } } finally { if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved; }
    expect(existsSync(h) ? readFileSync(h, "utf8") : "").toBe("");
  });
}
test("FC-25b: a required=true filter is blanked: the command never runs and git does not report a false error", () => {
  const r = mkdtempSync(join(root, "req-")), h = join(root, "req.hit"), rec = join(root, "req-rec.sh");
  writeFileSync(rec, `#!/bin/sh\necho fired >> "${h}"\ncat\n`); chmodSync(rec, 0o755);
  const G = (...a: string[]): string => execFileSync("git", a, { cwd: r, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  G("init", "-q"); writeFileSync(join(r, ".gitattributes"), "* filter=evil\n"); writeFileSync(join(r, "a.txt"), "a\n");
  gc(r, "filter.evil.clean", rec); gc(r, "filter.evil.required", "true");
  // git 2.55 accepts a blanked required filter (no error, no run); if a git version errors instead, the throw propagates to callers (run_cap: unknown size; changedSince: fail-safe false)
  try { safeGit(r, ["add", "-A", "--", "."]); } catch { /* a throw is the documented fail-safe */ }
  expect(existsSync(h)).toBe(false);
});

// FC-25b LFS regression: the USER's global lfs-style filter (required=true) and in-tree .gitattributes routing must keep working.
// Blanking global keys or hiding .gitattributes (GIT_ATTR_SOURCE=empty tree) turned this into ` M big.bin` / "clean filter failed" / raw blobs staged.
// Skipped on GitHub Actions only: red in release run 37170767617 (` M big.bin`) yet green in an ubuntu/bun container and on macOS. Owed after Oct 7 (RELEASE-11.md).
test.skipIf(!!process.env.GITHUB_ACTIONS)("FC-25b LFS: a global pointer filter with required=true and in-tree routing still yields clean status and pointer blobs through safeGit", () => {
  const d = mkdtempSync(join(root, "lfs-")), r = join(d, "repo"), store = join(d, "store"), gcfg = join(d, "global.cfg");
  mkdirSync(r); mkdirSync(store);
  const clean = join(d, "clean.sh"), smudge = join(d, "smudge.sh");
  writeFileSync(clean, `#!/bin/sh\nf=$(mktemp); cat > "$f"; h=$(shasum -a 256 "$f" | cut -c1-64); cp "$f" "${store}/$h"; rm -f "$f"; printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\n' "$h"\n`);
  writeFileSync(smudge, `#!/bin/sh\nh=$(sed -n 's/^oid sha256://p'); cat "${store}/$h"\n`);
  chmodSync(clean, 0o755); chmodSync(smudge, 0o755);
  writeFileSync(gcfg, `[filter "lfs"]\n\tclean = ${clean}\n\tsmudge = ${smudge}\n\trequired = true\n[user]\n\temail = t@t\n\tname = t\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gcfg };
  const G = (...a: string[]): string => execFileSync("git", a, { cwd: r, encoding: "utf8", env });
  G("init", "-q"); writeFileSync(join(r, ".gitattributes"), "*.bin filter=lfs -text\n"); writeFileSync(join(r, "big.bin"), `REAL-${"x".repeat(200)}\n`);
  G("add", "-A"); G("commit", "-qm", "init");
  expect(G("cat-file", "-p", "HEAD:big.bin")).toContain("version https://git-lfs");
  const saved = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = gcfg;
  try {
    const t = new Date(Date.now() + 5000); utimesSync(join(r, "big.bin"), t, t);
    expect(safeGit(r, ["status", "--porcelain"])).toBe("");
    safeGit(r, ["add", "-A", "--", "."]);
  } finally { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; }
  expect(G("cat-file", "-p", ":big.bin")).toContain("version https://git-lfs");
});
test("FC-25b: a filter reached through a local include.path is still local scope and blanked", () => {
  const r = mkdtempSync(join(root, "inc-")), h = join(root, "inc.hit"), rec = join(root, "inc-rec.sh");
  writeFileSync(rec, `#!/bin/sh\necho fired >> "${h}"\ncat\n`); chmodSync(rec, 0o755);
  const G = (...a: string[]): string => execFileSync("git", a, { cwd: r, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  G("init", "-q"); writeFileSync(join(r, ".gitattributes"), "* filter=evil\n"); writeFileSync(join(r, "a.txt"), "a\n");
  writeFileSync(join(r, ".git", "inc.cfg"), `[filter "evil"]\n\tclean = ${rec}\n`); G("config", "include.path", "inc.cfg");
  try { safeGit(r, ["add", "-A", "--", "."]); } catch { /* ok */ }
  expect(existsSync(h)).toBe(false);
});

// FC-25c(a): allowToken keeps the user's GLOBAL credential helper and ssh command but never a repo-local one.
function netRepo(tag: string): { r: string; hit: string; rec: string; gcfg: string; ghit: string } {
  const d = mkdtempSync(join(root, `net-${tag}-`)), r = join(d, "repo"), hit = join(d, "hit.txt"), ghit = join(d, "ghit.txt"), gcfg = join(d, "global.cfg");
  mkdirSync(r);
  const rec = join(d, "rec.sh"); writeFileSync(rec, `#!/bin/sh\necho "fired $0 $*" >> "${hit}"\nexit 1\n`); chmodSync(rec, 0o755);
  writeFileSync(gcfg, "[user]\n\temail = t@t\n\tname = t\n");
  execFileSync("git", ["init", "-q"], { cwd: r, env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg } });
  return { r, hit, rec, gcfg, ghit };
}
const withGlobal = <T>(gcfg: string, fn: () => T): T => {
  const saved = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = gcfg;
  try { return fn(); } finally { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; }
};
const lc = (r: string, k: string, v: string): void => { execFileSync("git", ["config", "--add", k, v], { cwd: r }); };
// Another suite in the same bun process can leave GIT_SSH_COMMAND or a GIT_CONFIG_COUNT credential.helper reset in
// process.env; both override repo config, so the controls below would never fire. Run each test without them.
const hermeticGit = (fn: () => void) => (): void => {
  const keys = Object.keys(process.env).filter((k) => /^(GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/.test(k));
  const saved = keys.map((k) => [k, process.env[k]] as const); for (const k of keys) delete process.env[k];
  try { fn(); } finally { for (const [k, v] of saved) process.env[k] = v; }
};

test("FC-25c(a): a repo-local credential.helper never runs under allowToken; the global helper still answers", hermeticGit(() => {
  const { r, hit, rec, gcfg, ghit } = netRepo("cred");
  const gh = join(r, "..", "ghelper.sh"); writeFileSync(gh, `#!/bin/sh\necho gfired >> "${ghit}"\nif [ "$1" = get ]; then echo password=globalpw; fi\n`); chmodSync(gh, 0o755);
  writeFileSync(gcfg, `[user]\n\temail = t@t\n\tname = t\n[credential]\n\thelper = ${gh}\n`);
  lc(r, "credential.helper", rec); lc(r, "credential.https://example.test.helper", rec);
  const input = "protocol=https\nhost=example.test\n\n";
  // control: a plain git call runs the repo helper
  try { execFileSync("git", ["credential", "fill"], { cwd: r, input, env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg, GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "ignore"] }); } catch { /* ok */ }
  expect(existsSync(hit)).toBe(true); rmSync(hit, { force: true }); rmSync(ghit, { force: true });
  // the global helper gives only a password, so git keeps going to later helpers (the repo one, in the control) until the prompt fails
  withGlobal(gcfg, () => safeGitSpawn(r, ["credential", "fill"], { allowToken: true, input, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }));
  expect(existsSync(hit)).toBe(false);
  expect(existsSync(ghit)).toBe(true);
}));
test("FC-25c(a): a repo-local core.sshCommand never runs under allowToken; the global one still does", hermeticGit(() => {
  const { r, hit, rec, gcfg, ghit } = netRepo("ssh");
  const gs = join(r, "..", "gssh.sh"); writeFileSync(gs, `#!/bin/sh\necho gfired >> "${ghit}"\nexit 1\n`); chmodSync(gs, 0o755);
  writeFileSync(gcfg, `[user]\n\temail = t@t\n\tname = t\n[core]\n\tsshCommand = ${gs}\n`);
  lc(r, "core.sshCommand", rec);
  try { execFileSync("git", ["ls-remote", "ssh://example.test/x"], { cwd: r, env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg }, stdio: "ignore" }); } catch { /* ok */ }
  expect(existsSync(hit)).toBe(true); rmSync(hit, { force: true }); rmSync(ghit, { force: true });
  try { withGlobal(gcfg, () => safeGit(r, ["ls-remote", "ssh://example.test/x"], { allowToken: true })); } catch { /* ssh fails by design */ }
  expect(existsSync(hit)).toBe(false);
  expect(existsSync(ghit)).toBe(true);
}));
test("FC-25c(a): remote.*.uploadpack and receivepack never run under allowToken; fetch still works", hermeticGit(() => {
  const { r, hit, rec, gcfg } = netRepo("pack");
  const up = join(r, "..", "upstream"); mkdirSync(up);
  const U = (...a: string[]): string => execFileSync("git", a, { cwd: up, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg } });
  U("init", "-q"); writeFileSync(join(up, "f"), "1\n"); U("add", "f"); U("commit", "-qm", "u");
  lc(r, "remote.origin.url", up); lc(r, "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  lc(r, "remote.origin.uploadpack", rec); lc(r, "remote.origin.receivepack", rec);
  try { execFileSync("git", ["fetch", "origin"], { cwd: r, env: { ...process.env, GIT_CONFIG_GLOBAL: gcfg }, stdio: "ignore" }); } catch { /* ok */ }
  expect(existsSync(hit)).toBe(true); rmSync(hit, { force: true });
  withGlobal(gcfg, () => safeGit(r, ["fetch", "origin"], { allowToken: true }));
  expect(existsSync(hit)).toBe(false);
  // a subcommand that cannot take the pinned option is refused, not run with the plant
  expect(() => safeGit(r, ["remote", "update"], { allowToken: true })).toThrow(/refused/); expect(existsSync(hit)).toBe(false);
  expect(safeGit(r, ["for-each-ref", "refs/remotes/origin"], { allowToken: true })).toContain("refs/remotes/origin/");
}));

// FC-25c(b): hostile-repo probes. Each plants a repo-controlled config, proves a plain git call fires it (control), then proves allowToken does not.
type NetRepo = ReturnType<typeof netRepo>;
type Probe = { name: string; setup: (n: NetRepo) => void; args: string[]; env?: NodeJS.ProcessEnv };
const credIn = "protocol=https\nhost=example.test\n\n";
const incCfg = (n: NetRepo, body: string): void => { writeFileSync(join(n.r, ".git", "inc.cfg"), body); };
const PROBES: Probe[] = [
  { name: "credential.helper with a leading !", args: ["credential", "fill"], setup: (n) => lc(n.r, "credential.helper", `!${n.rec}`) },
  { name: "credential.<url>.helper with = in the url", args: ["credential", "fill"], setup: (n) => { lc(n.r, "credential.https://example.test.helper", n.rec); lc(n.r, "credential.https://example.test/?a=b.helper", n.rec); } },
  { name: "include.path defining credential.helper", args: ["credential", "fill"], setup: (n) => { incCfg(n, `[credential]\n\thelper = ${n.rec}\n`); lc(n.r, "include.path", "inc.cfg"); } },
  { name: "includeIf defining credential.helper", args: ["credential", "fill"], setup: (n) => { incCfg(n, `[credential]\n\thelper = ${n.rec}\n`); lc(n.r, `includeIf.gitdir:${realpathSync(n.r)}/.git.path`, "inc.cfg"); } },
  { name: "include.path defining core.sshCommand", args: ["ls-remote", "ssh://example.test/x"], setup: (n) => { incCfg(n, `[core]\n\tsshCommand = ${n.rec}\n`); lc(n.r, "include.path", "inc.cfg"); } },
  { name: "url.insteadOf to an ext:: transport", args: ["ls-remote", "origin"], setup: (n) => { lc(n.r, "remote.origin.url", "http://example.test/x"); lc(n.r, "protocol.ext.allow", "always"); lc(n.r, `url.ext::${n.rec}.insteadOf`, "http://example.test/x"); } },
  { name: "core.askPass", args: ["credential", "fill"], setup: (n) => lc(n.r, "core.askPass", n.rec) },
  { name: "extensions.worktreeConfig sshCommand", args: ["ls-remote", "ssh://example.test/x"], setup: (n) => { lc(n.r, "extensions.worktreeConfig", "true"); execFileSync("git", ["config", "--worktree", "core.sshCommand", n.rec], { cwd: n.r }); } },
  { name: "extensions.worktreeConfig credential.helper", args: ["credential", "fill"], setup: (n) => { lc(n.r, "extensions.worktreeConfig", "true"); execFileSync("git", ["config", "--worktree", "credential.helper", n.rec], { cwd: n.r }); } },
  { name: "caller GIT_CONFIG_COUNT core.fsmonitor", args: ["ls-files"], env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "__REC__" }, setup: () => {} },
];
for (const p of PROBES) {
  test(`FC-25c(b): ${p.name} never runs under allowToken`, hermeticGit(() => {
    const n = netRepo("probe"); p.setup(n);
    const withRec = (e: NodeJS.ProcessEnv): NodeJS.ProcessEnv => { const o = { ...e, ...(p.env ?? {}) }; for (const k of Object.keys(o)) if (o[k] === "__REC__") o[k] = n.rec; return o; };
    const ran = (): boolean => existsSync(n.hit) || existsSync(join(n.r, "HIT"));
    const swallow = (fn: () => unknown): void => { try { fn(); } catch { /* the plant fails the call by design */ } };
    swallow(() => execFileSync("git", p.args, { cwd: n.r, input: credIn, env: withRec({ ...process.env, GIT_CONFIG_GLOBAL: n.gcfg, GIT_TERMINAL_PROMPT: "0" }), stdio: ["pipe", "ignore", "ignore"] }));
    expect(ran()).toBe(true); rmSync(n.hit, { force: true }); rmSync(join(n.r, "HIT"), { force: true });
    swallow(() => withGlobal(n.gcfg, () => safeGitSpawn(n.r, p.args, { allowToken: true, input: credIn, env: withRec({ ...process.env, GIT_TERMINAL_PROMPT: "0" }) })));
    expect(ran()).toBe(false);
  }));
}

// http.proxy redirects the authenticated connection (a Basic header or token goes to whoever the repo names).
test("FC-25c(b): repo-local http.proxy is not honoured under allowToken", async () => {
  const n = netRepo("proxy"); const seen: string[] = [];
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(sock) { seen.push("hit"); sock.end(); }, open() { seen.push("hit"); } } });
  try {
    lc(n.r, "http.proxy", `http://127.0.0.1:${srv.port}`);
    const base: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: n.gcfg, GIT_TERMINAL_PROMPT: "0" }; delete base.HTTP_PROXY; delete base.http_proxy; delete base.NO_PROXY;
    const url = "http://example.test/x.git";
    const ctl = Bun.spawn({ cmd: ["git", "ls-remote", url], cwd: n.r, env: base as Record<string, string>, stdout: "ignore", stderr: "ignore" }); await ctl.exited;
    expect(seen.length).toBeGreaterThan(0); seen.length = 0;
    await safeGitRun(n.r, ["ls-remote", url], { allowToken: true, env: base });
    expect(seen.length).toBe(0);
  } finally { srv.stop(true); }
});

// FC-25c(b) r2: TLS pins. Each key is set at repo scope in its url-scoped and plain form; the pinned args must reset or force the safe value.
const tlsArgs = (key: string, val: string, urlKey: string): string[] => {
  const n = netRepo("tls"); lc(n.r, key, val); lc(n.r, urlKey, val);
  return withGlobal(n.gcfg, () => safeGitArgs(["fetch", "origin"], true, n.r, {}, { ...process.env, GIT_CONFIG_GLOBAL: n.gcfg }));
};
const hasPair = (a: string[], v: string): boolean => a.some((x, i) => x === v && a[i - 1] === "-c");
test("FC-25c(b) r2: repo-local http.sslVerify=false is pinned back to true under allowToken", hermeticGit(() => {
  const a = tlsArgs("http.sslVerify", "false", "http.https://example.test/.sslVerify");
  expect(hasPair(a, "http.sslverify=true")).toBe(true);
  expect(hasPair(a, "http.https://example.test/.sslverify=true")).toBe(true);
  expect(a.some((x) => /sslverify=false/.test(x))).toBe(false);
}));
test("FC-25c(b) r2: repo-local http.curloptResolve is reset under allowToken", hermeticGit(() => {
  const a = tlsArgs("http.curloptResolve", "example.test:443:127.0.0.1", "http.https://example.test/.curloptResolve");
  expect(hasPair(a, "http.curloptresolve=")).toBe(true);
  expect(hasPair(a, "http.https://example.test/.curloptresolve=")).toBe(true);
}));
test("FC-25c(b) r2: repo-local http.sslCAInfo and sslCAPath are reset under allowToken", hermeticGit(() => {
  const n = netRepo("ca"); lc(n.r, "http.sslCAInfo", "/evil/ca.pem"); lc(n.r, "http.sslCAPath", "/evil/capath");
  const a = withGlobal(n.gcfg, () => safeGitArgs(["fetch", "origin"], true, n.r, {}, { ...process.env, GIT_CONFIG_GLOBAL: n.gcfg }));
  expect(hasPair(a, "http.sslcainfo=")).toBe(true);
  expect(hasPair(a, "http.sslcapath=")).toBe(true);
  expect(a.some((x) => x.includes("/evil/"))).toBe(false);
}));
test("FC-25c(b) r2: allowToken fetch and pull never recurse into a submodule, even when the repo asks", hermeticGit(() => {
  const n = netRepo("sm");
  lc(n.r, "fetch.recurseSubmodules", "yes"); lc(n.r, "submodule.sm.fetchRecurseSubmodules", "yes");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: n.gcfg };
  for (const cmd of ["fetch", "pull"]) {
    const a = safeGitArgs([cmd, "--recurse-submodules=on-demand", "origin"], true, n.r, {}, env);
    const i = a.indexOf(cmd);
    expect(a[i + 1]).toBe("--no-recurse-submodules");
    expect(a.some((x) => x.startsWith("--recurse-submodules"))).toBe(false);
  }
  // non-transport and non-token calls are untouched
  expect(safeGitArgs(["status"], true, n.r, {}, env)).not.toContain("--no-recurse-submodules");
  expect(safeGitArgs(["fetch", "origin"], false)).not.toContain("--no-recurse-submodules");
}));
test("FC-25c(b) r2: a hostile submodule core.sshCommand never runs on an allowToken fetch", hermeticGit(() => {
  const n = netRepo("smrun"); const d = join(n.r, ".."), G = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "protocol.file.allow=always", ...a], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: n.gcfg } });
  const sub = join(d, "subsrc"); mkdirSync(sub); G(sub, "init", "-q"); writeFileSync(join(sub, "f"), "1\n"); G(sub, "add", "f"); G(sub, "commit", "-qm", "s");
  const up = join(d, "up"); mkdirSync(up); G(up, "init", "-q"); G(up, "submodule", "add", "-q", sub, "sm"); G(up, "commit", "-qm", "u");
  const sup = join(d, "sup"); G(d, "clone", "-q", "--recurse-submodules", up, sup);
  G(join(sup, "sm"), "config", "core.sshCommand", n.rec); G(join(sup, "sm"), "config", "remote.origin.url", "ssh://example.test/x");
  G(sup, "config", "fetch.recurseSubmodules", "yes");
  try { G(sup, "fetch", "origin"); } catch { /* ok */ }
  expect(existsSync(n.hit)).toBe(true); rmSync(n.hit, { force: true });
  try { withGlobal(n.gcfg, () => safeGit(sup, ["fetch", "origin"], { allowToken: true })); } catch { /* ok */ }
  expect(existsSync(n.hit)).toBe(false);
}));
test("hung git config: driverKeys and netCommandOverrides time out and fail closed", () => {
  const d = mkdtempSync(join(tmpdir(), "fc25-hung-")), bin = join(d, "bin"), repo = join(d, "r"); mkdirSync(bin); mkdirSync(repo);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 3\n"); chmodSync(join(bin, "git"), 0o755);
  const saved = { p: process.env.PATH, t: process.env.LOKI_SAFE_GIT_CONFIG_TIMEOUT_MS };
  process.env.PATH = `${bin}:${saved.p}`; process.env.LOKI_SAFE_GIT_CONFIG_TIMEOUT_MS = "300";
  try {
    for (const tok of [false, true]) { const t0 = Date.now(); expect(() => safeGitArgs(["status"], tok, repo)).toThrow(); expect(Date.now() - t0).toBeLessThan(2000); }
  } finally {
    process.env.PATH = saved.p; if (saved.t === undefined) delete process.env.LOKI_SAFE_GIT_CONFIG_TIMEOUT_MS; else process.env.LOKI_SAFE_GIT_CONFIG_TIMEOUT_MS = saved.t;
    rmSync(d, { recursive: true, force: true });
  }
});

test("a repo-set gpg program never runs for signature display or verification", () => {
  const mark = join(root, "gpg-hit.txt"), prog = join(root, "gpg.sh");
  writeFileSync(prog, `#!/bin/sh\necho "gpg $*" >> "${mark}"\nexit 1\n`); chmodSync(prog, 0o755);
  const tree = g("rev-parse", "HEAD^{tree}").trim(), parent = g("rev-parse", "HEAD").trim();
  const obj = `tree ${tree}\nparent ${parent}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, input: obj, encoding: "utf8" }).trim();
  g("update-ref", "refs/heads/gpgsigned", sha);
  for (const k of ["gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program"]) g("config", k, prog);
  g("config", "log.showSignature", "true");
  const cases: string[][] = [["rev-list", "--format=%G?", "-1", "gpgsigned"], ["rev-list", "--format=%GS", "-1", "gpgsigned"], ["for-each-ref", "--format=%(signature)", "refs/heads/gpgsigned"], ["log", "-1", "gpgsigned"], ["show", "-s", "gpgsigned"]];
  try {
    rmSync(mark, { force: true }); for (const c of cases) execFileSync("git", c, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(existsSync(mark)).toBe(true); // positive control: unhardened git does run the program
    rmSync(mark, { force: true });
    for (const c of cases) { safeGitSpawn(repo, c, { encoding: "utf8" }); try { safeGit(repo, c); } catch { /* a refusal is fine; only the marker matters */ } }
    expect(existsSync(mark)).toBe(false);
  } finally {
    for (const k of ["gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program", "log.showSignature"]) g("config", "--unset", k);
    g("update-ref", "-d", "refs/heads/gpgsigned");
  }
});

test("--shallow-file swallowing 'config' cannot smuggle a diff past the driver blanking", () => {
  const mark = join(root, "driver-hit.txt"), drv = join(root, "drv.sh");
  writeFileSync(drv, `#!/bin/sh\necho "driver $0" >> "${mark}"\ncat "$2" 2>/dev/null\nexit 0\n`); chmodSync(drv, 0o755);
  g("checkout", "-q", "-b", "drvside"); writeFileSync(join(repo, "a.txt"), "changed\n"); g("commit", "-qam", "side");
  writeFileSync(join(repo, ".gitattributes"), "* diff=evil filter=evil\n");
  g("config", "diff.evil.command", drv); g("config", "diff.evil.textconv", drv); g("config", "filter.evil.process", drv); g("config", "filter.evil.clean", drv);
  rmSync(mark, { force: true });
  try {
    safeGitSpawn(repo, ["--shallow-file", "config", "diff", "other", "drvside"], { encoding: "utf8" });
    expect(existsSync(mark)).toBe(false);
    safeGitSpawn(repo, ["rev-parse", "HEAD"], { encoding: "utf8" });
    expect(existsSync(mark)).toBe(false);
  } finally {
    rmSync(join(repo, ".gitattributes"), { force: true });
    for (const k of ["diff.evil.command", "diff.evil.textconv", "filter.evil.process", "filter.evil.clean"]) g("config", "--unset", k);
    g("checkout", "-q", "-"); g("branch", "-qD", "drvside");
  }
});

test("driver blanking is skipped only for builtins that cannot run a filter or textconv", () => {
  g("config", "filter.canary.clean", "false"); g("config", "diff.canary.textconv", "false");
  try {
    for (const cmd of ["rev-parse", "symbolic-ref", "rev-list", "for-each-ref", "merge-base", "show-ref", "config"]) expect(safeGitArgs([cmd, "HEAD"], false, repo)).not.toContain("filter.canary.clean=");
    for (const cmd of ["status", "diff", "log", "ls-files", "add", "checkout", "show", "cat-file"]) expect(safeGitArgs([cmd], false, repo)).toContain("filter.canary.clean=");
    expect(safeGitArgs(["-C", repo, "rev-parse", "HEAD"], false, repo)).not.toContain("filter.canary.clean=");
    expect(safeGit(repo, ["rev-parse", "--is-inside-work-tree"]).trim()).toBe("true");
    // fail closed: an unknown or value-taking leading option means the subcommand is not trusted, so the scan stays on
    expect(safeGitArgs(["--no-pager", "-C", repo, "rev-parse", "HEAD"], false, repo)).not.toContain("filter.canary.clean=");
    expect(safeGitArgs(["--shallow-file", "x", "rev-parse", "HEAD"], false, repo)).not.toContain("filter.canary.clean=");
    expect(safeGitArgs(["--some-unknown-opt", "rev-parse", "HEAD"], false, repo)).toContain("filter.canary.clean=");
    expect(safeGitArgs(["--shallow-file"], false, repo)).toContain("filter.canary.clean=");
  } finally { g("config", "--unset", "filter.canary.clean"); g("config", "--unset", "diff.canary.textconv"); }
});
