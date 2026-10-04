// FC-25: a git call from the token-holding supervisor must never run a core.fsmonitor plant in the agent's repo.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunCapS } from "../../src/util/run_cap.ts";
import { tokenFreeEnv, safeGit } from "../../src/util/safe_git.ts";
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
  expect(e).toEqual({ KEEP: "1" });
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
test("FC-25b LFS: a global pointer filter with required=true and in-tree routing still yields clean status and pointer blobs through safeGit", () => {
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
