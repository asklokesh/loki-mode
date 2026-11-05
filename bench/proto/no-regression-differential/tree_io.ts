// Scratch-tree Io for the no-regression differential experiments: one tree per patch, where the base and patched states
// share one path (switched with git apply forward and -R), so no output differs only by where the tree lives.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runGoProbe } from "../../../loki-ts/src/features/probes.ts";
import type { NrdIo } from "../../../loki-ts/src/features/no_regression.ts";

export const HERMETIC_GO_ENV = { GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: "local" };

export function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 180_000, env: { ...process.env, ...env } });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** `src` is copied to `dir`; `patch` (or null for a no-op patch) is applied -p1 for the patched state. */
export function treeIo(src: string, dir: string, patch: string | null, go: { moduleRoot?: string; pkgDir: string; pkg: string; env?: Record<string, string> }): NrdIo & { dir: string; oracle(oracleFile: string, run: string): boolean } {
  cpSync(src, dir, { recursive: true });
  const root = join(dir, go.moduleRoot ?? ""), env = go.env ?? HERMETIC_GO_ENV;
  let state: "base" | "patched" = "base";
  const to = (s: "base" | "patched"): void => {
    if (s !== state && patch) {
      const r = sh(dir, "git", ["apply", ...(s === "base" ? ["-R"] : []), "-p1", patch]);
      if (!r.ok) throw new Error(`git apply ${patch}: ${r.out}`);
    }
    state = s;
  };
  return {
    dir,
    run(s, program) { to(s); return { ...runGoProbe({ moduleRoot: root, pkgDir: go.pkgDir, pkg: go.pkg, program, env }), roots: [dir] }; },
    oracle(oracleFile, run) {
      to("patched");
      const o = join(root, go.pkgDir, "zz_oracle_test.go");
      cpSync(oracleFile, o);
      try { return sh(root, "go", ["test", "-count=1", "-run", run, `./${go.pkgDir}`], env).ok; } finally { rmSync(o, { force: true }); }
    },
  };
}
