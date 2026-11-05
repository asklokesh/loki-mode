// PROTOTYPE (invention A, "relation cases"): when an issue states an invariance, the harness writes binding Go cases
// F(R(v)) == F(v) without asserting any guessed value. The reference F(v) is RECORDED on the base tree (where the issue
// says unwrapped values already work), so the only "expected value" is the base program's own behavior.
// Deterministic, no model call. In the product this belongs in exec_spec.ts (PR 536) as one more atom kind; it lives here
// because that module is not on main yet.
//
//   relation:   wrapping (the issue names %w, errors.As/Is, Unwrap or "wrapped") -> R(x) = fmt.Errorf("loki: %w", x)
//   strict:     every bare `x.(T)` / `x.(T)` with ok, in the base code, where T is a named interface of the package
//   F:          an exported function the issue names whose body (or a same-package callee) holds a strict check
//   observer:   package-level func vars and io.Writer vars that F's reach mentions: func calls are recorded with their
//               arguments; writer output is recorded as present/absent only (the issue never fixes the message text)
//   values:     built from the package's own constructors of T; string args "a"/"b", int args 3/5, variadic error args get
//               two members of another strictly-checked type with different payloads (twin-site's pair input)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RelCase { id: string; type: string; v: string; rv: string; why: string }
export interface RelSpec { fn: string; relation: "wrap"; cases: RelCase[]; observer: { funcs: { name: string; params: string }[]; writers: string[] }; test: string }

export const statesWrapRelation = (issue: string): boolean => /%w\b|\berrors\.(?:As|Is)\b|\bUnwrap\b|\bwrapped\b|\bwrapping\b/i.test(issue);

function decls(src: string) {
  const ifaces = [...src.matchAll(/^type\s+([A-Z]\w*)\s+interface\b/gm)].map((m) => m[1]!);
  const funcs = [...src.matchAll(/^func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*([^{]*)\{/gm)].map((m) => ({ name: m[1]!, params: m[2]!.trim(), ret: m[3]!.trim(), at: m.index! }));
  const bodyOf = (at: number): string => { let d = 0, i = src.indexOf("{", at); const s = i; for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) break; } return src.slice(s, i + 1); };
  const vars = [...src.matchAll(/^var\s+([A-Z]\w*)\s*(?:=\s*func\s*\(([^)]*)\)|(io\.Writer))/gm)].map((m) => ({ name: m[1]!, params: m[2], writer: !!m[3] }));
  return { ifaces, funcs: funcs.map((f) => ({ ...f, body: bodyOf(f.at) })), vars };
}

/** The relation spec, or null when the issue states no wrap relation or nothing qualifies. `files` are the package's non-test .go files at BASE. */
export function relationSpec(issue: string, files: Record<string, string>, pkg: string): RelSpec | null {
  if (!statesWrapRelation(issue)) return null;
  const src = Object.values(files).join("\n"), d = decls(src);
  const strictIn = (body: string): string[] => [...body.matchAll(/\.\(\s*([A-Z]\w*)\s*\)/g)].map((m) => m[1]!).filter((t) => d.ifaces.includes(t));
  const named = new Set([...issue.matchAll(/`([A-Z]\w*)\s*(?:\(|`)/g)].map((m) => m[1]!));
  const reach = (name: string, seen = new Set<string>()): string[] => { const f = d.funcs.find((x) => x.name === name); if (!f || seen.has(name)) return []; seen.add(name); return [f.body, ...d.funcs.filter((g) => new RegExp(`\\b${g.name}\\s*\\(`).test(f.body)).flatMap((g) => reach(g.name, seen))]; };
  const F = d.funcs.find((f) => named.has(f.name) && /^\w+\s+error$/.test(f.params) && strictIn(reach(f.name).join("\n")).length > 0);
  if (!F) return null;
  const body = reach(F.name).join("\n"), strict = [...new Set(strictIn(body))];
  const ctor = (t: string) => d.funcs.find((f) => /^[A-Z]/.test(f.name) && f.ret === t);
  const args = (params: string, k: number, members: string[] = []): string | null => {
    if (!params) return "";
    const out: string[] = [];
    for (const p of params.split(",").map((x) => x.trim())) {
      const ty = p.split(/\s+/).pop()!;
      if (ty === "string") out.push(JSON.stringify(k === 0 ? "a" : "b"));
      else if (ty === "int") out.push(String(k === 0 ? 3 : 5));
      else if (ty === "...error" && members.length) out.push(...members);
      else return null;
    }
    return out.join(", ");
  };
  const R = (x: string) => `fmt.Errorf("loki: %w", ${x})`;
  const cases: RelCase[] = [];
  const leaf = strict.filter((t) => { const c = ctor(t); return c && !c.params.includes("...error"); });
  for (const t of strict) {
    const c = ctor(t); if (!c) continue;
    if (!c.params.includes("...error")) {
      const a = args(c.params, 0); if (a === null) continue;
      const v = `${c.name}(${a})`; cases.push({ id: `${t}_wrapped`, type: t, v, rv: R(v), why: `${t} is checked with a bare assertion in ${F.name}'s reach; a wrapped ${t} must behave as the bare one does on base` });
    } else {
      const lc = leaf.map((x) => ctor(x)!).find(Boolean); if (!lc) continue;
      const m0 = `${lc.name}(${args(lc.params, 0)})`, m1 = `${lc.name}(${args(lc.params, 1)})`;
      const v = `${c.name}(${m0}, ${m1})`;
      cases.push({ id: `${t}_wrapped`, type: t, v, rv: R(v), why: `a wrapped ${t} holding two different ${leaf[0]} members must behave as the bare one does on base` });
      cases.push({ id: `${t}_members_wrapped`, type: t, v, rv: `${c.name}(${R(m0)}, ${R(m1)})`, why: `${t} members wrapped one by one must behave as bare members do on base` });
    }
  }
  if (!cases.length) return null;
  const obsFuncs = d.vars.filter((v) => v.params !== undefined && new RegExp(`\\b${v.name}\\s*\\(`).test(body)).map((v) => ({ name: v.name, params: v.params! }));
  const obsWriters = d.vars.filter((v) => v.writer && new RegExp(`\\b${v.name}\\b`).test(body)).map((v) => v.name);
  const rec = obsFuncs.map((f, i) => { const ps = f.params.split(",").map((p, j) => `p${j} ${p.trim().split(/\s+/).pop()}`).join(", "); return `\told${i} := ${f.name}\n\t${f.name} = func(${ps}) { trace = append(trace, fmt.Sprint("${f.name}", ${f.params.split(",").map((_, j) => `p${j}`).join(", ")})) }\n\tdefer func() { ${f.name} = old${i} }()`; }).join("\n");
  const wr = obsWriters.map((w, i) => `\tbufOld${i} := ${w}\n\tvar buf${i} bytes.Buffer\n\t${w} = &buf${i}\n\tdefer func() { ${w} = bufOld${i}; trace = append(trace, fmt.Sprint("${w}.written=", buf${i}.Len() > 0)) }()`).join("\n");
  const test = `package ${pkg}

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

var _ = bytes.NewBuffer

func lokiRelObserve(f func()) (out string) {
	var trace []string
	defer func() { out = fmt.Sprint(trace) }()
${rec}
${wr}
	f()
	return
}

func TestLokiRelation(t *testing.T) {
	for _, c := range []struct{ id string; v, rv func() error }{
${cases.map((c) => `\t\t{${JSON.stringify(c.id)}, func() error { return ${c.v} }, func() error { return ${c.rv} }},`).join("\n")}
	} {
		ref := lokiRelObserve(func() { ${F.name}(c.v()) })
		rel := lokiRelObserve(func() { ${F.name}(c.rv()) })
		b, _ := json.Marshal(map[string]string{"id": c.id, "ref": ref, "rel": rel})
		fmt.Println("LOKI_REL " + string(b))
	}
}
`;
  return { fn: F.name, relation: "wrap", cases, observer: { funcs: obsFuncs, writers: obsWriters }, test };
}

export interface RelObs { id: string; ref: string; rel: string }
export const parseRel = (out: string): RelObs[] => out.split("\n").filter((l) => l.includes("LOKI_REL ")).map((l) => JSON.parse(l.slice(l.indexOf("LOKI_REL ") + 9)) as RelObs);

/** Binding verdict per case: patched ref and patched rel must both equal the BASE ref. red_on_base: base rel differs from base ref. */
export function judgeRel(base: RelObs[], head: RelObs[]): { id: string; redOnBase: boolean; pass: boolean; detail: string }[] {
  return base.map((b) => {
    const h = head.find((x) => x.id === b.id);
    const pass = !!h && h.ref === b.ref && h.rel === b.ref;
    return { id: b.id, redOnBase: b.rel !== b.ref, pass, detail: h ? `base ref ${b.ref} | head ref ${h.ref} | head rel ${h.rel}` : "case did not run on head" };
  });
}

export function goPackageFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))) out[f] = readFileSync(join(dir, f), "utf8");
  return out;
}

/** The binding form handed to the implement session: the same cases, asserting that each wrapped value behaves exactly as the
 *  bare value did on the BASE tree. The embedded strings are the base program's recorded behavior, never a guessed value. */
export function sealedTest(spec: RelSpec, base: RelObs[], pkg: string): string {
  const want = new Map(base.map((b) => [b.id, b.ref]));
  return spec.test
    .replace(/func TestLokiRelation\(t \*testing\.T\) \{[\s\S]*$/, `func TestLokiRelation(t *testing.T) {
	// Each wrapped value must behave exactly as the bare value behaved before the change (recorded on the original code).
	for _, c := range []struct{ id, want string; v, rv func() error }{
${spec.cases.map((c) => `\t\t{${JSON.stringify(c.id)}, ${JSON.stringify(want.get(c.id) ?? "")}, func() error { return ${c.v} }, func() error { return ${c.rv} }},`).join("\n")}
	} {
		if got := lokiRelObserve(func() { ${spec.fn}(c.v()) }); got != c.want {
			t.Errorf("%s: the unwrapped value now behaves differently: got %s, before the change %s", c.id, got, c.want)
		}
		if got := lokiRelObserve(func() { ${spec.fn}(c.rv()) }); got != c.want {
			t.Errorf("%s: wrapped value: got %s, want %s (what the unwrapped value does)", c.id, got, c.want)
		}
	}
}
`)
    .replace('\t"encoding/json"\n', "")
    .replace(/^package \w+/, `package ${pkg}`);
}
