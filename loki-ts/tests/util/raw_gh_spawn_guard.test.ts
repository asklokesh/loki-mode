// FC-25 / FC-40 guard (D91 finding class 1): a raw spawn of `gh` in loki-ts/src, or a raw `git push` / `gh pr create` in the
// bash sources, must be allowlisted with a reason. Raw `git` in loki-ts/src is covered by fc25_raw_spawn_guard.test.ts.
// Pushes in bash go through _loki_trusted_push (autonomy/run.sh). Allowlist: guard-allowlists/raw-gh-spawn.txt (TS) and
// guard-allowlists/raw-bash-push.txt (bash).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { REPO, SRC, walk, filesMatching, loadAllowlist, checkAllowlist } from "./_guard_lib.ts";

export const GH_RAW = /(?:[(\[]|execer\(|spawn\(|run\()\s*"gh"\s*[,)]/;
// Executable push / PR creation. Excludes log, printf and echo lines (advisory text) and comment lines.
export const BASH_PUSH = /(^|[;&|(]\s*|\$\(\s*|"\$\w+"\s+|_loki_net\s+)(git(\s+-C\s+\S+)?\s+push|gh\s+pr\s+create)\b/;

export function bashPushFiles(): string[] {
  const files = [...walk(join(REPO, "autonomy"), [".sh"]), join(REPO, "autonomy", "loki")];
  const hits: string[] = [];
  for (const f of files) {
    const src = require("node:fs").readFileSync(f, "utf8") as string;
    const bad = src.split("\n").some((l) => {
      const t = l.trim();
      if (t.startsWith("#") || /^(log_\w+|printf|echo)\b/.test(t) || /^["'].*(git push|gh pr create)/.test(t)) return false;
      return BASH_PUSH.test(l) || /^\s*git(\s+-C\s+\S+)?\s+push\b/.test(l) || /^\s*(pr_url=.*)?\$?\(?\s*gh\s+pr\s+create\b/.test(l);
    });
    if (bad) hits.push(f.slice(REPO.length + 1));
  }
  return hits;
}

test("no raw gh spawn in loki-ts/src outside the allowlist", () => {
  const r = checkAllowlist(filesMatching(walk(SRC), GH_RAW), loadAllowlist("raw-gh-spawn.txt"));
  expect(r.unlisted).toEqual([]);
  expect(r.stale).toEqual([]);
  expect(r.noReason).toEqual([]);
});

test("no raw git push or gh pr create in the bash sources outside the allowlist", () => {
  const r = checkAllowlist(bashPushFiles(), loadAllowlist("raw-bash-push.txt"));
  expect(r.unlisted).toEqual([]);
  expect(r.stale).toEqual([]);
  expect(r.noReason).toEqual([]);
});
