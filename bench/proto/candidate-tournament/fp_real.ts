// False-positive check of the Go probe runner on real Go repos that are not in the benchmark corpus, with no model call.
// A spurious disagreement is the tournament's harmful false positive: two trees that behave the same but print different probe
// lines would reach the judge and could displace a correct agent tree. This builds deterministic generic probes (every exported
// top-level function whose parameters are all simple types, called on a fixed input corpus), runs them through the real runner
// three times (twice in copy A, once in copy B at another path) and counts cases whose line differs. Usage:
//   bun fp_real.ts <work-dir> <module-dir>...      (module dirs are read-only sources, e.g. from the Go module cache)
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseProbeOutput, PROBE_MARK, runGoProbe, stableIds } from "../../../loki-ts/src/features/tournament.ts";

const [work, ...mods] = process.argv.slice(2) as [string, ...string[]];
const STR = ['""', '" "', '"a"', '"A b"', '" -x "', '"--flag=v"', '"\\"q u\\""', "\"'s'\"", '"a\\\\b"', '"1.2.3"', '"v1.0.0-rc.1+b"', '"KEY=val"', '"\\u65e5\\u672c \\u8a9e"', '"\\t\\n"', '"../x"', '"*.go"'];
const VAL: Record<string, string[]> = {
  string: STR, int: ["0", "1", "-1", "1024"], int64: ["0", "1", "-1", "1 << 40"], uint64: ["0", "1", "1 << 40"], float64: ["0", "1.5", "-2"], bool: ["true", "false"], rune: ["'a'", "' '", "'\\u65e5'"],
  "[]string": ["nil", "[]string{}", '[]string{"a"}', '[]string{"", " x "}', '[]string{"-v", "--", "a b"}'], "[]byte": ["nil", '[]byte("")', '[]byte("a=b")', '[]byte(" -x ")'], "...string": ['"a"', '"a", "b"', '" x ", "--y"'],
};
const SIDE_EFFECT = /^(Load|Overload|Exec|Write|Remove|Set|Unset|Run|Serve|Listen|Open|Create|Mkdir|Chdir|Exit|Fatal|Panic|Print|Fprint|Must)/;

function topLevelResults(res: string): number {
  const r = res.trim(); if (!r) return 0;
  if (!r.startsWith("(")) return 1;
  let depth = 0, n = 1;
  for (const ch of r.slice(1, -1)) { if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--; else if (ch === "," && depth === 0) n++; }
  return n;
}
function paramTypes(params: string): string[] | null {
  if (!params.trim()) return [];
  const parts = params.split(",").map((p) => p.trim()), types: string[] = [];
  let pending = 0;
  for (const p of parts) { const m = /^(?:\w+\s+)?(\.\.\.string|\[\]string|\[\]byte|\w+)$/.exec(p); if (!m) return null; if (!/\s/.test(p) && !VAL[m[1]!] ) { pending++; continue; } const t = m[1]!; for (let k = 0; k <= pending; k++) types.push(t); pending = 0; }
  if (pending) return null;
  return types.every((t) => VAL[t]) ? types : null;
}
function genCases(dir: string): { pkg: string; file: string; cases: number; funcs: string[] } | null {
  // only unconstrained files: no //go:build or // +build line, no GOOS/GOARCH file suffix (the package itself still builds normally)
  const srcs = readdirSync(dir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go") && !/_(windows|linux|freebsd|openbsd|netbsd|plan9|js|wasm|wasip1|android|ios|solaris|aix|dragonfly|illumos|amd64|arm64|386|arm)\.go$/.test(f));
  let pkg = "", lines: string[] = [];
  const funcs: string[] = [];
  for (const f of srcs) {
    const t = readFileSync(join(dir, f), "utf8");
    if (/^\/\/(?:go:build|\s*\+build)\b/m.test(t)) continue;
    const p = /^package\s+(\w+)/m.exec(t)?.[1]; if (!p || p.endsWith("_test") || p === "main") continue;
    pkg ||= p; if (p !== pkg) continue;
    for (const m of t.matchAll(/^func ([A-Z]\w*)\(([^)]*)\)\s*([^{]*)\{/gm)) {
      const name = m[1]!, types = paramTypes(m[2]!), nres = topLevelResults(m[3]!);
      if (!types || SIDE_EFFECT.test(name) || funcs.includes(name)) continue;
      funcs.push(name);
      const first = types[0], firstVals = first ? VAL[first]! : [""];
      for (let i = 0; i < Math.min(first ? 6 : 1, firstVals.length); i++) {
        const args = types.map((ty, k) => (k === 0 ? firstVals[i]! : VAL[ty]![0]!)).join(", ");
        const call = `${name}(${args})`, ret = nres === 0 ? `${call}; return nil` : nres === 1 ? `return ${call}` : `${Array.from({ length: nres }, (_, k) => `r${k}`).join(", ")} := ${call}; return []any{${Array.from({ length: nres }, (_, k) => `r${k}`).join(", ")}}`;
        lines.push(`\tlokiProbe("p${lines.length + 1}", ${JSON.stringify(call)}, func() any { ${ret} })`);
        if (lines.length >= 80) break;
      }
      if (lines.length >= 80) break;
    }
  }
  if (!pkg || lines.length === 0) return null;
  return { pkg, file: `package ${pkg}\n\nimport "testing"\n\nfunc TestLokiProbe(t *testing.T) {\n${lines.join("\n")}\n}\n`, cases: lines.length, funcs };
}
const writable = (d: string): void => { chmodSync(d, 0o755); for (const e of readdirSync(d)) { const p = join(d, e); const st = statSync(p); if (st.isDirectory()) writable(p); else chmodSync(p, 0o644); } };

const rows: Record<string, unknown>[] = [];
let totalCases = 0, totalUnstable = 0, totalRoot = 0, totalAddr = 0, built = 0;
for (const m of mods) {
  const name = basename(m).replace(/[^\w.@-]/g, "_"), A = join(work, name, "a", "tree"), B = join(work, name, "b", "copy", "tree");
  mkdirSync(join(work, name, "a"), { recursive: true }); mkdirSync(join(work, name, "b", "copy"), { recursive: true });
  cpSync(m, A, { recursive: true }); cpSync(m, B, { recursive: true }); writable(A); writable(B);
  // a module-cache dir without go.mod: its own path (decoded from the cache layout) so its subpackages still resolve
  const modPath = m.includes("/pkg/mod/") ? m.split("/pkg/mod/")[1]!.replace(/@.*$/, "").replace(/!([a-z])/g, (_, c: string) => c.toUpperCase()) : `example.com/${name.replace(/@.*/, "")}`;
  for (const d of [A, B]) if (!existsSync(join(d, "go.mod"))) writeFileSync(join(d, "go.mod"), `module ${modPath}\n\ngo 1.18\n`);
  const g = genCases(A);
  if (!g) { rows.push({ module: name, generated: 0 }); continue; }
  writeFileSync(join(work, name, "cases_test.go.txt"), g.file); // kept for replay; the runner removes its own copy after each run
  const r1 = runGoProbe(A, "", g.pkg, g.file, 90_000), r2 = runGoProbe(A, "", g.pkg, g.file, 90_000), r3 = runGoProbe(B, "", g.pkg, g.file, 90_000);
  if (!r1.built) { rows.push({ module: name, pkg: g.pkg, generated: g.cases, built: false, error: (r1.error ?? "").slice(-300) }); continue; }
  built++;
  const [a1, a2, b1] = [r1, r2, r3].map((r) => parseProbeOutput(r.stdout, PROBE_MARK).run);
  const s12 = stableIds(a1!, a2!), s13 = stableIds(a1!, b1!), printed = Object.keys(a1!).length;
  const unstable = Object.keys(a1!).filter((k) => !s12.has(k) || !s13.has(k));
  const root = Object.values(a1!).filter((v) => v.includes("<ROOT>")).length, addr = Object.values(a1!).filter((v) => v.includes("0x?")).length;
  const panics = Object.values(a1!).filter((v) => v.startsWith("PANIC:")).length, errs = Object.values(a1!).filter((v) => v.startsWith("error(")).length;
  totalCases += printed; totalUnstable += unstable.length; totalRoot += root; totalAddr += addr;
  rows.push({ module: name, pkg: g.pkg, funcs: g.funcs.length, generated: g.cases, printed, unstable: unstable.length, unstableIds: unstable.slice(0, 5), scrubbedRoot: root, scrubbedAddr: addr, panics, errors: errs, seconds: +(r1.durationS + r2.durationS + r3.durationS).toFixed(1) });
}
const summary = { modules: mods.length, built, cases: totalCases, unstable: totalUnstable, fpRate: totalCases ? totalUnstable / totalCases : null, scrubbedRoot: totalRoot, scrubbedAddr: totalAddr, rows };
writeFileSync(join(work, "fp_real.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
