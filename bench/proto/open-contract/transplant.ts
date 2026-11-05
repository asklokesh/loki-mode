// PROTOTYPE: sibling test transplant (round-2 judge, item C). P8's precedentFor finds sibling implementations of the contract an
// open choice names; their visible tests are generalized into templates with two slots, TYPE (the sibling's type name) and RET
// (the sibling's member return type), and filled with the target. Deterministic, no model call.
// Binding rule: a template statement is binding only when 2 or more siblings share it byte for byte after generalization (so
// its values are a repo convention, not a guess) AND the issue says the target should behave like its siblings or lists
// acceptable outputs. Everything else is advisory.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Transplant { binding: boolean; why: string; statements: string[]; test: string | null; siblings: string[] }

/** Top-level statements of a Go function body (brace depth 1), each as its exact source text. */
function statements(body: string): string[] {
  const out: string[] = []; let cur: string[] = [], depth = 0;
  for (const line of body.split("\n")) {
    cur.push(line);
    for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth--; }
    if (depth === 0 && cur.join("").trim()) { out.push(cur.join("\n").trim()); cur = []; }
  }
  return out;
}
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const saysLikeSiblings = (issue: string): boolean => /\blike (?:the )?(?:other|its sibling|the rest)|\bsame (?:way|as the other)|\bconsistent with\b|\bacceptable outputs?\b/i.test(issue);

/** `precedent` is the precedentFor text (it names each sibling as `sibling <file>:<line> func (s T) member() RET`). */
export function transplant(issue: string, repoDir: string, precedent: string, target: { type: string; member: string; ret: string; pkg: string }, testFiles: string[]): Transplant {
  const sibs = [...precedent.matchAll(/sibling \S+ func \(\w+ \*?(\w+)\) (\w+)\(\) ([^{]+?) \{/g)].filter((m) => m[2] === target.member).map((m) => ({ type: m[1]!, ret: m[3]!.trim() }));
  const tests = testFiles.map((f) => readFileSync(join(repoDir, f), "utf8")).join("\n");
  const bodies = new Map<string, string[]>();
  for (const s of sibs) {
    const fn = new RegExp(`^func (Test\\w*${esc(s.type)}\\w*)\\(t \\*testing\\.T\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(tests);
    if (fn) bodies.set(s.type, statements(fn[2]!).map((st) => st.replace(new RegExp(`\\b${esc(s.type)}\\b`, "g"), "TYPE").replace(new RegExp(`(var \\w+ )${esc(s.ret)}$`, "m"), "$1RET")));
  }
  const count = new Map<string, number>();
  for (const sts of bodies.values()) for (const st of new Set(sts)) count.set(st, (count.get(st) ?? 0) + 1);
  // a shared statement that declares a variable carries the statement using it along (the pair is the case)
  const all = [...count].filter(([, n]) => n >= 2).map(([st]) => st);
  const decl = (st: string): string | null => /^var (\w+) /.exec(st)?.[1] ?? null;
  const shared = all.filter((st) => { const v = decl(st); return v === null || all.some((o) => o !== st && new RegExp(`\\b${v}\\b`).test(o)); }); // a lone declaration is not a case
  if (!shared.some((st) => decl(st) === null)) shared.length = 0;
  const binding = shared.length > 0 && saysLikeSiblings(issue);
  const fill = (st: string): string => st.replace(/\bTYPE\b/g, target.type).replace(/\bRET\b/g, target.ret);
  const imports = [...new Set([...target.ret.matchAll(/\b([a-z]\w*)\./g)].map((m) => m[1]!))];
  const test = shared.length ? `package ${target.pkg}\n\nimport (\n\t"testing"\n${imports.map((i) => `\t"${i}"\n`).join("")})\n\n// Transplanted from ${[...bodies.keys()].join(", ")}: statements ${shared.length > 0 ? "at least two of them share" : ""}.\nfunc TestLokiTransplant_${target.type}${target.member}(t *testing.T) {\n${shared.map((st) => "\t" + fill(st).split("\n").join("\n")).join("\n")}\n}\n` : null;
  return { binding, why: binding ? `${shared.length} statement(s) shared by 2+ siblings, and the issue asks for sibling behavior` : shared.length ? "shared statements exist but the issue does not ask for sibling behavior: advisory" : "no statement shared by 2 siblings", statements: shared.map(fill), test, siblings: [...bodies.keys()] };
}
