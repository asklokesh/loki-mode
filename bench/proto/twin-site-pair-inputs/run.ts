// PROTO driver for twin-site pair inputs (no model calls).
//   bun run.ts fixture <fixtureDir> <variantName> <relPathOfChangedFile> <scratchDir>
//       base = fixtureDir/repo at HEAD; head = the same with variants/<variantName>.<ext> copied over relPath.
//   bun run.ts replay <repoDir> <scratchDir> <maxCommits> [lang] [since]
//       for each non-merge commit C (newest first) with parent P that changes a non-test .py or .go file containing
//       type-test syntax, run twinPairCheck(P, C) in two detached worktrees; one JSON line per commit to stdout.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseHunks, twinPairCheck, type TwinPairRun } from "../../../loki-ts/src/features/twin_pair.ts";

const sh = (cmd: string, args: string[], cwd: string, timeout = 120_000) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024 });
const git = (cwd: string, ...a: string[]) => sh("git", ["-c", "core.hooksPath=/dev/null", ...a], cwd);

function summary(r: TwinPairRun) {
  return {
    pre_guards: r.pre, post_guards: r.post, errors: r.errors, probed: r.probed,
    verdicts: r.findings.reduce<Record<string, number>>((m, f) => ((m[`${f.guard.mode}:${f.verdict}`] = (m[`${f.guard.mode}:${f.verdict}`] ?? 0) + 1), m), {}),
    red: r.findings.filter((f) => f.red).map((f) => ({ mode: f.guard.mode, func: f.guard.func, file: f.guard.file, src: f.guard.src, variant: f.guard.variant, detail: f.detail, text: f.text })),
    changed: r.findings.filter((f) => f.verdict === "changed").map((f) => ({ mode: f.guard.mode, func: f.guard.func, src: f.guard.src, variant: f.guard.variant, detail: f.detail })),
  };
}

function fixture(fx: string, variant: string, rel: string, scratch: string) {
  const base = join(scratch, "base"), head = join(scratch, "head");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  cpSync(join(fx, "repo"), base, { recursive: true });
  cpSync(join(fx, "repo"), head, { recursive: true });
  const ext = rel.split(".").pop();
  cpSync(join(fx, "variants", `${variant}.${ext}`), join(head, rel));
  const diff = git(head, "diff", "-U0", "--no-color", "HEAD").stdout;
  const t0 = Date.now();
  const r = twinPairCheck(base, head, parseHunks(diff), { timeoutMs: 300_000 });
  console.log(JSON.stringify({ fixture: fx.split("/").pop(), variant, ms: Date.now() - t0, ...summary(r) }, null, 1));
}

const TYPE_SYNTAX: Record<string, RegExp> = { py: /\bisinstance\(|\btype\([^)]*\)\s*(is|==|in)\b|__class__\s+is\b/, go: /\.\([A-Za-z*][\w.*]*\)|\.\(type\)|errors\.As\(/ };

function replay(repo: string, scratch: string, max: number, lang = "", since = "") {
  mkdirSync(scratch, { recursive: true });
  const wp = join(scratch, "wt-parent"), wc = join(scratch, "wt-commit");
  for (const w of [wp, wc]) if (!existsSync(w)) git(repo, "worktree", "add", "--detach", "-f", w, "HEAD");
  const revs = git(repo, "rev-list", "--no-merges", `--max-count=${max}`, ...(since ? [`--since=${since}`] : []), "HEAD").stdout.split("\n").filter(Boolean);
  for (const c of revs) {
    const p = git(repo, "rev-parse", `${c}^`).stdout.trim();
    if (!p) continue;
    const diff = git(repo, "diff", "-U0", "--no-color", "--no-renames", p, c).stdout;
    const files = parseHunks(diff).filter((f) => /\.(py|go)$/.test(f.path) && !/_test\.go$|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/.test(f.path) && (!lang || f.path.endsWith("." + lang)));
    // cheap prefilter: the changed file has type-test syntax at either side (the engines decide the rest)
    const hit = files.filter((f) => {
      const l = f.path.endsWith(".py") ? "py" : "go";
      const at = (rev: string) => git(repo, "show", `${rev}:${f.path}`).stdout ?? "";
      return TYPE_SYNTAX[l]!.test(at(p)) || TYPE_SYNTAX[l]!.test(at(c));
    });
    if (hit.length === 0) { console.log(JSON.stringify({ commit: c, files: files.length, prefilter: 0 })); continue; }
    const okP = git(wp, "checkout", "--detach", "-f", "-q", p).status === 0, okC = git(wc, "checkout", "--detach", "-f", "-q", c).status === 0;
    if (!okP || !okC) { console.log(JSON.stringify({ commit: c, error: "checkout" })); continue; }
    git(wp, "clean", "-fdq"); git(wc, "clean", "-fdq");
    const t0 = Date.now();
    const r = twinPairCheck(wp, wc, hit, { timeoutMs: 300_000, env: { GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" } });
    git(wp, "checkout", "-f", "-q", "."); git(wc, "checkout", "-f", "-q", ".");
    console.log(JSON.stringify({ commit: c, files: files.length, prefilter: hit.length, ms: Date.now() - t0, ...summary(r) }));
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "fixture") fixture(rest[0]!, rest[1]!, rest[2]!, rest[3]!);
else if (mode === "replay") replay(rest[0]!, rest[1]!, +(rest[2] ?? "200"), rest[3] ?? "", rest[4] ?? "");
else { console.error("usage: run.ts fixture|replay ..."); process.exit(2); }
void readFileSync;
