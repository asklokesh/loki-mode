// PROTOTYPE (proto/no-regression-differential): behavioral probes shared by the candidate tournament
// (features/tournament.ts) and the no-regression differential (features/no_regression.ts). A probe program is
// model-written code that calls the code under test on concrete inputs and prints one JSON line per case; it asserts
// nothing. This module parses that output, pulls the program out of a model reply, and runs a program in a tree:
// node for JavaScript, `go test` for Go. New file because both mechanisms run the same programs and neither owns the other.
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainTestEnv, spawnGroupSync } from "../util/check_result.ts";

export interface ProbeRun { [probeId: string]: string }
export interface Probe { id: string; desc: string; kind?: string }
/** One execution of a probe program. `program` is the text that actually ran (the Go runner may prune cases that do not compile). */
export interface ProbeExec { stdout: string; program: string; pruned: { id: string; error: string }[]; error?: string }

/** Printed before every JSON line by the Go helper, so JSON that the code under test prints itself is never read as a probe. */
export const PROBE_PREFIX = "LOKI_PROBE ";

/** Parse probe stdout into id -> canonical output, plus each probe's desc and kind. When any line carries PROBE_PREFIX only
 *  prefixed lines count. The first line for an id wins; other lines are ignored. */
export function parseProbeOutput(stdout: string): { run: ProbeRun; probes: Probe[] } {
  const run: ProbeRun = {}, probes: Probe[] = [];
  const lines = stdout.split("\n");
  const prefixed = lines.some((l) => l.trimStart().startsWith(PROBE_PREFIX));
  for (const line of lines) {
    let t = line.trim();
    if (prefixed) { if (!t.startsWith(PROBE_PREFIX)) continue; t = t.slice(PROBE_PREFIX.length).trim(); }
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as { id?: unknown; desc?: unknown; out?: unknown; kind?: unknown };
      if (typeof o.id !== "string" || Object.prototype.hasOwnProperty.call(run, o.id)) continue;
      run[o.id] = typeof o.out === "string" ? o.out : JSON.stringify(o.out);
      probes.push({ id: o.id, desc: typeof o.desc === "string" ? o.desc : o.id, ...(typeof o.kind === "string" ? { kind: o.kind } : {}) });
    } catch { /* not a probe line */ }
  }
  return { run, probes };
}

export function extractProgram(text: string): string {
  const m = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text);
  return m ? m[1]! : text;
}

const realOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
/** Mask what differs between two runs of identical code in different places: the tree's own paths, the temp root, and heap addresses. */
export function normalizeOut(s: string, roots: string[]): string {
  const all = [...new Set([...roots, tmpdir()].flatMap((r) => (r ? [r, realOr(r)] : [])))].sort((a, b) => b.length - a.length);
  let o = s;
  for (const r of all) o = o.split(r).join("<ROOT>");
  return o.replace(/0x[0-9a-f]{6,}/gi, "0x<ADDR>");
}

export function runNodeProbe(dir: string, program: string, timeoutMs = 20_000): ProbeExec {
  const file = join(dir, "__probe.mjs");
  writeFileSync(file, program);
  try {
    const r = spawnGroupSync("node", ["__probe.mjs"], { cwd: dir, timeoutMs, env: plainTestEnv() });
    return { stdout: r.output, program, pruned: [] };
  } finally { rmSync(file, { force: true }); }
}

// ---- Go runner: the model writes func lokiCases() made of lokiCase(...) statements; the harness adds the test function and helpers ----
export const GO_PROBE_FILE = "zz_loki_probe_test.go";
export const GO_HELPER_FILE = "zz_loki_probe_helpers_test.go";
export const GO_PROBE_TEST = "TestLokiProbe";

export function goHelpers(pkg: string): string {
  return `package ${pkg}

// Written by Loki for one probe run and deleted right after it.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"testing"
)

func ${GO_PROBE_TEST}(t *testing.T) { lokiCases() }

// lokiCase runs one case and prints its result as one JSON line; a panic is printed, never raised.
func lokiCase(id, kind, desc string, f func() any) {
	var out any
	func() {
		defer func() {
			if r := recover(); r != nil {
				out = fmt.Sprintf("PANIC: %v", r)
			}
		}()
		out = lokiValue(f())
	}()
	b, err := json.Marshal(map[string]any{"id": id, "kind": kind, "desc": desc, "out": out})
	if err != nil {
		b, _ = json.Marshal(map[string]any{"id": id, "kind": kind, "desc": desc, "out": fmt.Sprintf("%v", out)})
	}
	fmt.Println("${PROBE_PREFIX.trim()} " + string(b))
}

// lokiAll packs several return values, for example lokiAll(strconv.Atoi("7")).
func lokiAll(vs ...any) any {
	out := make([]any, len(vs))
	for i, v := range vs {
		out[i] = lokiValue(v)
	}
	return out
}

// lokiStdout returns what f prints to os.Stdout.
func lokiStdout(f func()) string {
	r, w, err := os.Pipe()
	if err != nil {
		return "PIPE: " + err.Error()
	}
	old := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() { b, _ := io.ReadAll(r); done <- string(b) }()
	func() {
		defer func() { os.Stdout = old; w.Close() }()
		f()
	}()
	return <-done
}

func lokiValue(v any) any {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case error:
		return "ERROR: " + x.Error()
	case fmt.Stringer:
		return x.String()
	case string, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return x
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		if rv.Kind() == reflect.Slice && rv.IsNil() {
			return nil
		}
		out := make([]any, rv.Len())
		for i := range out {
			out[i] = lokiValue(rv.Index(i).Interface())
		}
		return out
	case reflect.Ptr:
		if rv.IsNil() {
			return nil
		}
		return lokiValue(rv.Elem().Interface())
	}
	return fmt.Sprintf("%+v", v)
}
`;
}

/** `any` needs language version go1.18, and a module whose go.mod names an older one (pflag says go 1.12, cobra go 1.15)
 *  rejects it. Rewrites the identifier `any` outside literals and comments to the identical interface{}. */
export function goAnyCompat(src: string): string {
  let out = "", i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    let e = i + 1;
    if (c === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); e = j < 0 ? n : j; }
    else if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); e = j < 0 ? n : j + 2; }
    else if (c === "`") { const j = src.indexOf("`", i + 1); e = j < 0 ? n : j + 1; }
    else if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1; e = Math.min(n, j + 1); }
    else if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < n && /\w/.test(src[j]!)) j++;
      const w = src.slice(i, j);
      const selector = src[i - 1] === "." && src.slice(i - 3, i) !== "..."; // x.any is a field; ...any is a variadic type
      out += w === "any" && !selector ? "interface{}" : w; i = j; continue;
    }
    out += src.slice(i, e); i = e;
  }
  return out;
}

const CASE_START = /^\s*lokiCase\(\s*"([^"]+)"/;
/** Line ranges (0-based, inclusive) of each lokiCase statement inside func lokiCases(). */
export function goCaseBlocks(program: string): { id: string; start: number; end: number }[] {
  const lines = program.split("\n"), starts: { id: string; line: number }[] = [];
  lines.forEach((l, i) => { const m = CASE_START.exec(l); if (m) starts.push({ id: m[1]!, line: i }); });
  if (starts.length === 0) return [];
  let close = lines.length;
  for (let i = starts[starts.length - 1]!.line + 1; i < lines.length; i++) if (/^\}\s*$/.test(lines[i]!)) { close = i; break; }
  return starts.map((s, k) => ({ id: s.id, start: s.line, end: (k + 1 < starts.length ? starts[k + 1]!.line : close) - 1 }));
}

/** The source of one case, for a fix brief. */
export function caseSnippet(program: string, id: string, max = 600): string {
  const b = goCaseBlocks(program).find((x) => x.id === id);
  if (!b) return "";
  const s = program.split("\n").slice(b.start, b.end + 1).join("\n").trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

const PROBE_ERR_SRC = `${GO_PROBE_FILE.replace(/\./g, "\\.")}:(\\d+):\\d+: (.+)$`;
const PROBE_ERR = new RegExp(PROBE_ERR_SRC, "gm"), PROBE_ERR_ANY = new RegExp(PROBE_ERR_SRC, "m");
const UNUSED_IMPORT = /^"([^"]+)" imported and not used/;

/** One deterministic repair pass over a probe that does not compile: drop unused imports, drop the cases holding the
 *  other error lines. Returns null when an error sits outside every case (nothing safe to drop). */
export function pruneGoProgram(program: string, output: string): { program: string; pruned: { id: string; error: string }[] } | null {
  const errs = [...output.matchAll(PROBE_ERR)].map((m) => ({ line: Number(m[1]) - 1, msg: m[2]!.trim() }));
  if (errs.length === 0) return null;
  const lines = program.split("\n"), drop = new Set<number>(), pruned: { id: string; error: string }[] = [];
  const blocks = goCaseBlocks(program);
  for (const e of errs) {
    const imp = UNUSED_IMPORT.exec(e.msg);
    if (imp) { drop.add(e.line); continue; }
    const b = blocks.find((x) => e.line >= x.start && e.line <= x.end);
    if (!b) return null;
    if (!pruned.some((p) => p.id === b.id)) pruned.push({ id: b.id, error: e.msg });
    for (let i = b.start; i <= b.end; i++) drop.add(i);
  }
  return { program: lines.filter((_, i) => !drop.has(i)).join("\n"), pruned };
}

/** Run a Go probe program as a test in the package directory (unexported identifiers and the package's test helpers are
 *  in scope), pruning cases that do not compile, at most `maxRepairs` passes. Both probe files are removed afterwards. */
export function runGoProbe(o: { moduleRoot: string; pkgDir: string; pkg: string; program: string; timeoutMs?: number; env?: Record<string, string>; maxRepairs?: number }): ProbeExec {
  const dir = join(o.moduleRoot, o.pkgDir), probeFile = join(dir, GO_PROBE_FILE), helperFile = join(dir, GO_HELPER_FILE);
  const env = { ...plainTestEnv(), ...(o.env ?? {}) }, pkgArg = `./${o.pkgDir.replace(/^\.?\/*/, "")}`.replace(/\/$/, "") || ".";
  let program = goAnyCompat(o.program.trimEnd() + "\n");
  if (!/^\s*package\s+\w+/m.test(program)) program = `package ${o.pkg}\n\n${program}`;
  const pruned: { id: string; error: string }[] = [];
  writeFileSync(helperFile, goAnyCompat(goHelpers(o.pkg)));
  try {
    for (let pass = 0; ; pass++) {
      writeFileSync(probeFile, program);
      const r = spawnGroupSync("go", ["test", "-count=1", "-vet=off", "-gcflags=-e", "-timeout=60s", "-run", `^${GO_PROBE_TEST}$`, "-v", pkgArg], { cwd: o.moduleRoot, timeoutMs: o.timeoutMs ?? 120_000, env });
      const built = !/\[build failed\]|\[setup failed\]/.test(r.output) && !PROBE_ERR_ANY.test(r.output);
      if (built) return { stdout: r.output, program, pruned, ...(r.status === null ? { error: "probe run timed out" } : {}) };
      const fix = pass < (o.maxRepairs ?? 3) ? pruneGoProgram(program, r.output) : null;
      if (!fix) return { stdout: "", program, pruned, error: `probe did not build: ${r.output.split("\n").filter((l) => /\.go:\d+:\d+: /.test(l)).slice(0, 3).join(" | ") || r.output.slice(-300)}` };
      program = fix.program; pruned.push(...fix.pruned);
    }
  } finally { rmSync(probeFile, { force: true }); rmSync(helperFile, { force: true }); }
}
