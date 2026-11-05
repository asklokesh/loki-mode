// Hermetic tests for the twin-site pair prototype: pure selection and verdict rules, the hunk parser, and real-runner
// end-to-end cases (python3 and go) that build their own temp fixtures and skip when the toolchain is missing.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHunks, selectGuards, twinPairCheck, verdictPost, verdictPre, type ProbeChain } from "../../../loki-ts/src/features/twin_pair.ts";

const o = (ret: string, extra: Record<string, unknown> = {}) => ({ ret, out: "", ...extra });
function chain(cands: ProbeChain["cands"], variants: ProbeChain["variants"]): ProbeChain {
  return { lang: "py", file: "m.py", func: "f", subject: "v", line: 1, sites: [{ id: "s1", kind: "exact", line: 2, src: "type(v) is int" }, { id: "s2", kind: "isinstance", line: 4, src: "isinstance(v, bool)" }], order: ["s1", "s2"], variants, cands };
}
const broaden = { id: "b1", kind: "broaden" as const, site: "s1", order: ["s1", "s2"] };

describe("selection", () => {
  test("a value the later site takes at base, which a broadened earlier site would take, is a pair input", () => {
    const g = selectGuards([chain([{ key: "k", src: "True", preds: { s1: false, s2: true }, vpreds: { b1: true }, obs: { real: o("TRUE"), real2: o("TRUE"), identity: o("TRUE"), b1: o("1") } }], [broaden])], "pre");
    expect(g.length).toBe(1);
    expect(g[0]!.comps).toEqual(["ret"]);
    expect(g[0]!.ref).toEqual({ ret: "TRUE" });
    expect(g[0]!.alt).toEqual({ ret: "1" });
  });
  test("a component that differs between two real runs never counts", () => {
    const g = selectGuards([chain([{ key: "k", src: "True", preds: { s1: false, s2: true }, vpreds: { b1: true }, obs: { real: o("TRUE", { out: "t1" }), real2: o("TRUE", { out: "t2" }), identity: o("TRUE", { out: "t1" }), b1: o("TRUE", { out: "t3" }) } }], [broaden])], "pre");
    expect(g.length).toBe(0);
  });
  test("a component the faithful copy does not reproduce never counts", () => {
    const g = selectGuards([chain([{ key: "k", src: "True", preds: { s1: false, s2: true }, vpreds: { b1: true }, obs: { real: o("TRUE"), real2: o("TRUE"), identity: o("1"), b1: o("1") } }], [broaden])], "pre");
    expect(g.length).toBe(0);
  });
  test("a swap is guarded at base only when the later site also wins some input on its own (not a dead branch)", () => {
    const swap = { id: "w", kind: "swap" as const, site: "s1", site2: "s2", order: ["s2", "s1"] };
    const both = { key: "a", src: "x", preds: { s1: true, s2: true }, vpreds: {}, obs: { real: o("A"), real2: o("A"), identity: o("A"), w: o("B") } };
    expect(selectGuards([chain([both], [swap])], "pre").length).toBe(0);
    const onlyJ = { key: "b", src: "y", preds: { s1: false, s2: true }, vpreds: {}, obs: { real: o("B"), real2: o("B"), identity: o("B"), w: o("B") } };
    expect(selectGuards([chain([both, onlyJ], [swap])], "pre").length).toBe(1);
  });
});

describe("verdicts", () => {
  const g = selectGuards([chain([{ key: "k", src: "True", preds: { s1: false, s2: true }, vpreds: { b1: true }, obs: { real: o("TRUE"), real2: o("TRUE"), identity: o("TRUE"), b1: o("1") } }], [broaden])], "pre")[0]!;
  const seen = (ret: string) => ({ key: "q", obs: { real: o(ret), real2: o(ret) } });
  test("pre: same outcome is kept, the variant's outcome is inverted, anything else is only advisory", () => {
    expect(verdictPre(g, seen("TRUE"))).toBe("kept");
    expect(verdictPre(g, seen("1"))).toBe("inverted");
    expect(verdictPre(g, seen("yes"))).toBe("changed");
    expect(verdictPre(g, { key: "q", missing: true })).toBe("unknown");
  });
  test("post: red only when restoring precedence gives base's outcome back, and only for inputs the base chain dispatched", () => {
    const pg = { ...g, mode: "post" as const, ref: { ret: "1" }, alt: { ret: "TRUE" } };
    const base = (ret: string, preds = { s1: false, s2: true }) => ({ key: "q", preds, order: ["s1", "s2"], obs: { real: o(ret), real2: o(ret) } });
    expect(verdictPost(pg, base("TRUE"))).toBe("precedence-regression");
    expect(verdictPost(pg, base("1"))).toBe("same-as-base");
    expect(verdictPost(pg, base("other"))).toBe("changed");
    expect(verdictPost(pg, base("TRUE", { s1: false, s2: false }))).toBe("unhandled-at-base");
  });
});

test("hunks on both sides", () => {
  const h = parseHunks("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -3,2 +3,4 @@ def f\n@@ -10 +12,0 @@\n");
  expect(h).toEqual([{ path: "x.py", old: [[3, 4], [10, 10]], new: [[3, 6], [12, 12]] }]);
});

const has = (cmd: string, arg: string) => spawnSync(cmd, [arg], { encoding: "utf8" }).status === 0;
const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...a], { cwd, encoding: "utf8" });

function e2e(files: Record<string, string>, rel: string, variants: Record<string, string>, env: NodeJS.ProcessEnv = {}): Record<string, { red: number; verdicts: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "loki-twin-test-")), out: Record<string, { red: number; verdicts: string[] }> = {};
  try {
    const base = join(root, "base");
    for (const [p, t] of Object.entries(files)) { mkdirSync(join(base, p, ".."), { recursive: true }); writeFileSync(join(base, p), t); }
    git(base, "init", "-q"); git(base, "add", "-A"); git(base, "commit", "-q", "-m", "base");
    for (const [name, text] of Object.entries(variants)) {
      const head = join(root, name);
      spawnSync("cp", ["-R", base, head]);
      writeFileSync(join(head, rel), text);
      const r = twinPairCheck(base, head, parseHunks(git(head, "diff", "-U0", "--no-color", "HEAD").stdout), { timeoutMs: 240_000, env });
      out[name] = { red: r.findings.filter((f) => f.red).length, verdicts: r.findings.map((f) => `${f.guard.mode}:${f.verdict}`) };
    }
    return out;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const PY_BASE = `def to_cell(value):
    if value is None:
        return ""
    if type(value) is int:
        return str(value)
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, str):
        return value
    raise TypeError(type(value).__name__)
`;
test.skipIf(!has("python3", "--version"))("python: the broadened int check that steals bools is red, bool-first is green", () => {
  const r = e2e({ "cells/__init__.py": "", "cells/core.py": PY_BASE }, "cells/core.py", {
    wrong: PY_BASE.replace("type(value) is int", "isinstance(value, int)"),
    right: PY_BASE.replace(`    if type(value) is int:
        return str(value)
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
`, `    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(int(value))
`),
  });
  expect(r.wrong!.red).toBeGreaterThan(0);
  expect(r.right!.red).toBe(0);
  expect(r.right!.verdicts.length).toBeGreaterThan(0);
}, 120_000);

const GO_BASE = `package st

import (
	"fmt"
	"io"
	"os"
)

type Coder interface {
	error
	Code() int
}
type Batch interface {
	error
	Failures() []error
}
type codeErr struct{ code int }

func (e *codeErr) Error() string { return fmt.Sprint("code ", e.code) }
func (e *codeErr) Code() int     { return e.code }
func Fail(code int) Coder         { return &codeErr{code: code} }

type batchErr struct{ errs []error }

func (b *batchErr) Error() string     { return "batch" }
func (b *batchErr) Failures() []error { return b.errs }
func (b *batchErr) Unwrap() []error   { return b.errs }
func Collect(errs ...error) Batch     { return &batchErr{errs: errs} }

var Out io.Writer = os.Stderr

func Status(err error) int {
	if c, ok := err.(Coder); ok {
		fmt.Fprintln(Out, c)
		return c.Code()
	}
	if b, ok := err.(Batch); ok {
		code := 1
		for _, f := range b.Failures() {
			if c, ok := f.(Coder); ok && c.Code() > code {
				code = c.Code()
			}
		}
		return code
	}
	return 1
}
`;
const GO_AS = (first: "Coder" | "Batch") => {
  const coder = `	var c Coder
	if errors.As(err, &c) {
		fmt.Fprintln(Out, c)
		return c.Code()
	}
`, batch = `	var b Batch
	if errors.As(err, &b) {
		code := 1
		for _, f := range b.Failures() {
			if c, ok := f.(Coder); ok && c.Code() > code {
				code = c.Code()
			}
		}
		return code
	}
`;
  const body = GO_BASE.slice(GO_BASE.indexOf("func Status"));
  return GO_BASE.replace(`import (\n\t"fmt"`, `import (\n\t"errors"\n\t"fmt"`).replace(body, `func Status(err error) int {\n${first === "Coder" ? coder + batch : batch + coder}\treturn 1\n}\n`);
};
// go 1.17: the probe must compile in modules whose go directive predates `any` (measured: 15 replay commits lost)
for (const ver of ["1.22", "1.17"]) {
  test.skipIf(!has("go", "version"))(`go ${ver}: errors.As for the Coder ahead of the Batch is red, Batch first is green`, () => {
    const r = e2e({ "go.mod": `module example.com/st\n\ngo ${ver}\n`, "st.go": GO_BASE }, "st.go", { wrong: GO_AS("Coder"), right: GO_AS("Batch") });
    expect(r.wrong!.red).toBeGreaterThan(0);
    expect(r.right!.red).toBe(0);
    expect(r.right!.verdicts.length).toBeGreaterThan(0);
  }, 240_000);
}

// Measured on this machine: a shared Go build-cache entry removed by another process between compile and link made a
// probe run end with no records ("link: cannot open file ... go-build ..."), silently losing every guard of that run.
test.skipIf(!has("go", "version"))("go: a toolchain failure that names no probe line is retried, so the pre guard still decides", () => {
  const stub = mkdtempSync(join(tmpdir(), "loki-twin-gostub-")), real = spawnSync("sh", ["-c", "command -v go"], { encoding: "utf8" }).stdout.trim();
  try {
    writeFileSync(join(stub, "go"), `#!/bin/sh\nif [ "$1" = "test" ] && [ ! -f "${stub}/failed" ]; then touch "${stub}/failed"; echo "link: cannot open file /cache/go-build/ab/x-d: no such file or directory" >&2; exit 1; fi\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const r = e2e({ "go.mod": "module example.com/st\n\ngo 1.22\n", "st.go": GO_BASE }, "st.go", { wrong: GO_AS("Coder") }, { PATH: `${stub}:${process.env.PATH}` });
    expect(r.wrong!.verdicts).toContain("pre:inverted");
  } finally { rmSync(stub, { recursive: true, force: true }); }
}, 240_000);
