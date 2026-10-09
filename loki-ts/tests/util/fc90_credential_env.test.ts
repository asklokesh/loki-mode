// FC-90 (P9): a harness-run test command never carries the user's ambient GitHub credential. The credential here is PLANTED in a fake HOME
// (a gh hosts.yml with a fake oauth_token, a fake global git credential helper), so the test never depends on the real user's login.
// Each leg has a positive control (the raw env DOES see the planted credential) so a green result is not an absence-of-output artifact.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainTestEnv } from "../../src/util/check_result.ts";

const FAKE_GH = "gho_FAKEPLANTEDOAUTHTOKEN0123456789abcdef";
const FAKE_PW = "FAKEPLANTEDGITPASSWORD9876";
const have = (bin: string): boolean => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const HAVE_GH = have("gh"); // skip reason when absent: the gh legs need the gh binary; the git legs always run
let root = "", home = "";

// A parent env that carries the planted credential through HOME, XDG_CONFIG_HOME and a global gitconfig, and no real token vars.
const parentEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env["PATH"], HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", TMPDIR: root });
const sh = (cmd: string, env: NodeJS.ProcessEnv, input = "") => spawnSync("sh", ["-c", cmd], { encoding: "utf8", env: env as Record<string, string>, input, timeout: 30_000, cwd: root });
const FILL = "protocol=https\nhost=github.com\n\n";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "loki-fc90-"))); home = join(root, "home");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), `github.com:\n    oauth_token: ${FAKE_GH}\n    user: fakeuser\n    git_protocol: https\n`);
  const helper = join(root, "fake-helper.sh");
  writeFileSync(helper, `#!/bin/sh\necho username=fakeuser\necho password=${FAKE_PW}\n`); chmodSync(helper, 0o755);
  writeFileSync(join(home, ".gitconfig"), `[user]\n\tname = Fake Identity\n\temail = fake@example.invalid\n[credential]\n\thelper = ${helper}\n`);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("FC-90 the token family is a sentinel, not absent", () => {
  test("every var is a non-working sentinel (gh never falls back to its keyring), a planted real value is replaced", () => {
    const e = plainTestEnv({ ...parentEnv(), GH_TOKEN: "ghp_REALLOOKING", GITHUB_TOKEN: "x", SSH_AUTH_SOCK: "/s" });
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) expect(e[k]?.startsWith("ghp_LOKIWITHHELDsentinel")).toBe(true);
    expect(e["SSH_AUTH_SOCK"]).toBeUndefined();
  });
});

describe("FC-90 gh credential store", () => {
  test.skipIf(!HAVE_GH)("control: a raw env with the planted hosts.yml DOES yield the planted token", () => {
    expect(sh("gh auth token", parentEnv()).stdout.trim()).toBe(FAKE_GH);
  });
  test.skipIf(!HAVE_GH)("a test command under plainTestEnv cannot read the planted token and is not logged in", () => {
    const env = plainTestEnv(parentEnv());
    const tok = sh("gh auth token", env);
    expect(tok.stdout + tok.stderr).not.toContain(FAKE_GH);
    const st = sh("gh auth status", env);
    expect(st.status).not.toBe(0);
    expect(st.stdout + st.stderr).not.toContain(FAKE_GH);
  });
  test.skipIf(!HAVE_GH)("a named-account read (which ignores the env token) finds nothing: GH_CONFIG_DIR is an empty dir", () => {
    const env = plainTestEnv(parentEnv());
    expect(env["GH_CONFIG_DIR"]).toBeTruthy();
    expect(readdirSync(env["GH_CONFIG_DIR"]!)).toEqual([]);
    expect(sh("gh auth token --user fakeuser", parentEnv()).stdout.trim()).toBe(FAKE_GH);
    const r = sh("gh auth token --user fakeuser", env);
    expect(r.stdout + r.stderr).not.toContain(FAKE_GH);
  });
});

describe("FC-90 git credential helpers", () => {
  test("control: a raw env with the planted global helper DOES return the planted password", () => {
    expect(sh("git credential fill", { ...parentEnv(), GIT_TERMINAL_PROMPT: "0" }, FILL).stdout).toContain(`password=${FAKE_PW}`);
  });
  test("credential fill under plainTestEnv returns no password", () => {
    const r = sh("git credential fill", plainTestEnv(parentEnv()), FILL);
    expect(r.stdout + r.stderr).not.toContain(FAKE_PW);
    expect(r.stdout).not.toContain("password=");
    expect(r.status).not.toBe(0);
  });
  test("the user's identity and ordinary local git survive the hardening", () => {
    const env = plainTestEnv(parentEnv());
    expect(sh("git config user.name", env).stdout.trim()).toBe("Fake Identity");
    expect(sh("git config user.email", env).stdout.trim()).toBe("fake@example.invalid");
    const d = join(root, "repo"); mkdirSync(d);
    expect(sh(`cd ${d} && git init -q && git commit -q --allow-empty -m x && git log --format=%an -1`, env).stdout.trim()).toBe("Fake Identity");
  });
  test("existing GIT_CONFIG_COUNT entries are kept and the helper reset is appended once", () => {
    const e = plainTestEnv({ ...parentEnv(), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Operator" });
    expect(e["GIT_CONFIG_COUNT"]).toBe("2");
    expect([e["GIT_CONFIG_KEY_0"], e["GIT_CONFIG_VALUE_0"], e["GIT_CONFIG_KEY_1"], e["GIT_CONFIG_VALUE_1"]]).toEqual(["user.name", "Operator", "credential.helper", ""]);
    expect(plainTestEnv(e)["GIT_CONFIG_COUNT"]).toBe("2");
    expect(e["GIT_TERMINAL_PROMPT"]).toBe("0"); expect(e["GCM_INTERACTIVE"]).toBe("never");
  });
});

describe("FC-90 a parent GIT_CONFIG_PARAMETERS helper", () => {
  const quoted = (helper: string): string => `'credential.helper'='${helper}'`;
  test("control: a parent GIT_CONFIG_PARAMETERS helper DOES serve the planted password on the raw env", () => {
    const helper = join(root, "params-helper.sh");
    writeFileSync(helper, `#!/bin/sh\necho username=paramuser\necho password=${FAKE_PW}\n`); chmodSync(helper, 0o755);
    const raw = { ...parentEnv(), HOME: join(root, "nohome"), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_PARAMETERS: quoted(helper) };
    expect(sh("git credential fill", raw, FILL).stdout).toContain(`password=${FAKE_PW}`);
    const hard = plainTestEnv(raw);
    expect(hard["GIT_CONFIG_PARAMETERS"]!.endsWith(`${quoted("")}`)).toBe(true);
    const r = sh("git credential fill", hard, FILL);
    expect(r.stdout + r.stderr).not.toContain(FAKE_PW);
    expect(r.status).not.toBe(0);
  });
  test("the reset is appended once and an unset GIT_CONFIG_PARAMETERS stays unset", () => {
    const e = plainTestEnv({ ...parentEnv(), GIT_CONFIG_PARAMETERS: "'user.name'='X'" });
    expect(e["GIT_CONFIG_PARAMETERS"]).toBe("'user.name'='X' 'credential.helper'=''");
    expect(plainTestEnv(e)["GIT_CONFIG_PARAMETERS"]).toBe(e["GIT_CONFIG_PARAMETERS"]);
    expect(plainTestEnv(parentEnv())["GIT_CONFIG_PARAMETERS"]).toBeUndefined();
  });
});

describe("FC-90 the scoped GH_CONFIG_DIR lifecycle", () => {
  const countDirs = (d: string): number => readdirSync(d).filter((n) => n.startsWith("loki-gh-config-")).length;
  const src = (rel: string): string => JSON.stringify(join(import.meta.dir, "../../src", rel));
  const prelude = `import { plainTestEnv } from ${src("util/check_result.ts")};
import { tokenFreeEnv } from ${src("util/safe_git.ts")};
import { withholdGithubTokens } from ${src("runner/github_token.ts")};
import { statSync } from "node:fs";
for (let i = 0; i < 25; i++) { plainTestEnv(); tokenFreeEnv(); withholdGithubTokens({}, () => {}); }
const d = plainTestEnv()["GH_CONFIG_DIR"]!;
process.stdout.write(d + "\\n" + (statSync(d).mode & 0o777).toString(8));`;
  const runChild = (tmp: string, extra: Record<string, string> = {}) => {
    const f = join(root, `child-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(f, prelude);
    return spawnSync(process.execPath, [f], { encoding: "utf8", env: { PATH: process.env["PATH"], TMPDIR: tmp, ...extra } as Record<string, string> });
  };
  test("many env builds in one process leave one mode-700 dir in TMPDIR while alive and none after exit", () => {
    const tmp = mkdtempSync(join(root, "tmp-"));
    expect(countDirs(tmp)).toBe(0);
    const r = runChild(tmp);
    expect(r.status).toBe(0);
    const [dir, mode] = r.stdout.split("\n");
    expect(realpathSync(tmp) + "/").toBe(dir!.slice(0, realpathSync(tmp).length + 1));
    expect(mode).toBe("700");
    expect(countDirs(tmp)).toBe(0);
  });
  test("under LOKI_RUN_TMP the dir lives in the run's own dir, nothing lands in TMPDIR, and it is removed on exit", () => {
    const tmp = mkdtempSync(join(root, "tmp-")), run = mkdtempSync(join(root, "run-"));
    const r = runChild(tmp, { LOKI_RUN_TMP: run });
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n")[0]).toContain(realpathSync(run));
    expect(countDirs(tmp)).toBe(0); expect(countDirs(run)).toBe(0);
  });
  test("a child killed by SIGTERM removes its dir and still dies with 143", () => {
    const tmp = mkdtempSync(join(root, "tmp-"));
    const f = join(root, "sigterm-child.ts");
    writeFileSync(f, `import { plainTestEnv } from ${src("util/check_result.ts")};
plainTestEnv(); setTimeout(() => {}, 20000); process.kill(process.pid, "SIGTERM");`);
    const r = spawnSync(process.execPath, [f], { encoding: "utf8", env: { PATH: process.env["PATH"], TMPDIR: tmp } as Record<string, string>, timeout: 30_000 });
    expect(r.status).toBe(143);
    expect(countDirs(tmp)).toBe(0);
  });
  test("a host process.once SIGTERM handler registered BEFORE ours keeps control of shutdown", () => {
    const tmp = mkdtempSync(join(root, "tmp-")), marker = join(root, "host-shutdown.marker");
    const f = join(root, "sigterm-host-child.ts");
    writeFileSync(f, `import { writeFileSync } from "node:fs";
import { plainTestEnv } from ${src("util/check_result.ts")};
process.once("SIGTERM", () => { setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, "done"); process.exit(0); }, 200); });
plainTestEnv(); setTimeout(() => {}, 20000); process.kill(process.pid, "SIGTERM");`);
    const r = spawnSync(process.execPath, [f], { encoding: "utf8", env: { PATH: process.env["PATH"], TMPDIR: tmp } as Record<string, string>, timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(countDirs(tmp)).toBe(0);
  });
});
