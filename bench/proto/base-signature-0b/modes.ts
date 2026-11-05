// Check 0B, part 2: for each untouched test file and the package tsc, compare head against a base worktree whose dependencies are
// provided three ways: "guarded" (origin/main baseDepsLinker: refuses when depsSeeHead), "head" (PR #522 linkHeadDeps: head node_modules
// linked wholesale), "faithful" (this proto's linkBaseFaithfulDeps). Real runOnce, failIds, sameErrors and the tsc diagnostic regex.
import { mkdtempSync, rmSync, existsSync, symlinkSync } from "node:fs"; import { join, relative, dirname } from "node:path"; import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { baseDepsLinker, linkBaseFaithfulDeps } from "../../../loki-ts/src/util/base_guard.ts";
import { runOnce } from "../../../loki-ts/src/engine10/stages/verify.ts";
import { failIds, sameErrors, errorsById, comparableIds } from "../../../loki-ts/src/engine10/failures.ts";
const [repo, baseSha, pkg, ...tests] = process.argv.slice(2) as [string, string, string, ...string[]];
const sig = new AbortController().signal;
const linkHeadDeps = (baseDir: string, cwd: string): void => { for (let d = cwd; d.startsWith(baseDir); d = dirname(d)) { const src = join(repo, relative(baseDir, d)); for (const n of ["node_modules"]) { if (existsSync(join(src, n)) && !existsSync(join(d, n))) symlinkSync(join(src, n), join(d, n)); } if (d === baseDir) break; } };
const TSC_DIAG = /^(\S.*?)(?:\(\d+,\d+\)|:\d+:\d+)\s*(?::|-)\s*error (TS\d+)/gm;
const keys = (o: string) => [...o.matchAll(TSC_DIAG)].map((m) => `${m[1]!.trim()}|${m[2]}`);
const vt = (cwd: string, f: string) => runOnce("npx", ["--no-install", "vitest", "run", f], cwd, sig, { timeoutMs: 90_000 });
const tsc = (cwd: string) => runOnce("npx", ["--no-install", "tsc", "--noEmit", "-p", "."], cwd, sig, { timeoutMs: 90_000 });
const head: Record<string, { ok: boolean; ids: string[]; out: string }> = {};
for (const f of tests) { const r = await vt(join(repo, pkg), f); head[f] = { ok: r.ok, ids: failIds(r.out), out: r.out }; }
const ht = await tsc(join(repo, pkg)); const headKeys = keys(ht.out);
const rows: unknown[] = [];
for (const mode of ["guarded", "head", "faithful"] as const) {
  const dir = mkdtempSync(join(tmpdir(), "inv3-0b-"));
  try {
    execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, baseSha], { stdio: "ignore" });
    const cwd = join(dir, pkg); let linked: boolean;
    const t0 = Date.now();
    if (mode === "guarded") { const l = baseDepsLinker(dir, repo); linked = l(cwd); if (linked) l(dir); }
    else if (mode === "head") { linkHeadDeps(dir, cwd); linked = true; }
    else linked = linkBaseFaithfulDeps(dir, repo, cwd);
    const linkMs = Date.now() - t0;
    for (const f of tests) {
      const h = head[f]!; if (h.ok) { rows.push({ mode, test: f, head: "pass" }); continue; }
      const b = await vt(cwd, f), bids = b.ok ? [] : failIds(b.out);
      const knownRed = h.ids.length > 0 && comparableIds(h.ids).every((i) => bids.includes(i));
      rows.push({ mode, linked, linkMs, test: f, head_ids: h.ids, base_ok: b.ok, base_ids: bids, knownRed, sameError: knownRed && sameErrors(errorsById(h.out), b.out, h.ids), base_head: b.out.split("\n").find((l) => /Error|error|not found/.test(l))?.slice(0, 140) });
    }
    const bt = await tsc(cwd), bk = new Set(keys(bt.out));
    rows.push({ mode, linked, tsc_head: headKeys, tsc_base_missing: headKeys.filter((k) => !bk.has(k)), tsc_all_on_base: headKeys.length > 0 && headKeys.every((k) => bk.has(k)), tsc_base_first: bt.out.split("\n")[0]?.slice(0, 120) });
  } finally { try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", dir], { stdio: "ignore" }); } catch {} rmSync(dir, { recursive: true, force: true }); }
}
for (const r of rows) console.log(JSON.stringify(r));
