// Executable spec first (on by default; LOKI_E10_EXEC_SPEC=0 opts out). New file because no module turns issue text into base-red
// executable checks: engine10/stages/wall.ts is a blind agentic session the lean path skips (E-64) and util/spec_file.ts extracts
// prose clauses only. wall.ts owns the wiring (its lean branch calls execSpecAuthor and seals the result through installWall).
//
// Steps, only the second uses a model:
//   1. Deterministic atoms from the issue text: examples, quoted locations, claims, named sites, options, plus two atoms read
//      from the real source: parity (a quoted line reads a normalized copy while sibling lines use the raw value) and pair
//      (two named sites one input reaches, the ordering class).
//   2. One Haiku completion with no repo tools: atoms plus the real source of each resolved site -> one test file in the repo's
//      runner (go test, pytest or vitest; same atoms, a language-specific emitter).
//   3. Base red filter, run by the harness on the base tree, per case: red by assertion is kept, green or erroring is not.
//      Only a kept case whose expected values the issue itself states is BINDING and is sealed as a Wall file (verify runs it on
//      the change, so it counts as proof only when red on base and green on the change, both harness runs). Every other case is
//      advisory: listed in the implement brief, never sealed, never blocking.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describeJudgeOutcome, toolLessCall } from "../runner/sdk_invoker.ts";
import { resolveClaudeModel } from "../util/claude_model.ts";
import { assertionFailure, commandFor, plainTestEnv, pytestKindsAreAssertion, spawnGroupSync, stripAnsi, vitestErrorsAreAssertion } from "../util/check_result.ts";
import { escapeRegex } from "../util/regex_escape.ts";

export const execSpecEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !["0", "off", "false"].includes((env.LOKI_E10_EXEC_SPEC ?? "").trim().toLowerCase()); // default on; LOKI_E10_EXEC_SPEC=0 opts out
export const EXEC_SPEC_BRIEF_FILE = "exec-spec-brief.txt"; // <runDir>/, read by implement.ts
export const EXEC_SPEC_TELEMETRY_FILE = "exec-spec.json"; // <runDir>/, read by seal.ts for the receipt's exec_spec block

export type AtomKind = "example" | "claim" | "site" | "option" | "location" | "parity" | "pair";
export interface SpecAtom { id: string; kind: AtomKind; text: string; lang?: string; section?: string }
export interface ResolvedSite { symbol: string; file: string; line: number; source: string; /** whole declaration up to MAX_BODY_LINES, for deterministic scans only */ body?: string }

const CODE_LANG = /^(go|golang|ts|typescript|js|javascript|tsx|jsx|py|python|rs|rust|java|console|bash|sh|shell)$/i;
const LOCATION_SECTION = /\b(location|relevant code|current code|source|where)\b/i;
const OPTION_SECTION = /\b(possible solutions?|suggested (?:fix|direction|solution)|proposed (?:fix|solution)s?|options?|alternatives?)\b/i;
const CLAIM = /\binstead of\b|\bends up with\b|\bexits? with\b|\breturns?\b[^.]*`|\bshould\b|\bexpected\b|\bmust\b|==/i;
const IDENT = /^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*(?:\(\))?$/;
const SRC_EXT = /\.(go|ts|tsx|js|mjs|py|rs|java)$/;
const MAX_ATOMS = 16, MAX_SITE_LINES = 45, MAX_BODY_LINES = 400, MAX_SITES = 6, ANCHOR_PAD = 12, MAX_PAIRS = 2;
const ID_PREFIX: Record<AtomKind, string> = { example: "E", claim: "C", site: "S", option: "O", location: "L", parity: "P", pair: "X" };

/** Split markdown into {section, body} while keeping fenced blocks intact. */
function sections(task: string): { head: string; body: string }[] {
  const out: { head: string; body: string }[] = []; let head = "", buf: string[] = [], fence = false;
  for (const line of task.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && /^#{1,6}\s+/.test(line)) { out.push({ head, body: buf.join("\n") }); head = line.replace(/^#+\s+/, "").trim(); buf = []; continue; }
    buf.push(line);
  }
  out.push({ head, body: buf.join("\n") });
  return out.filter((s) => s.body.trim() !== "");
}

/** Deterministic: a pure function of the task text, so the same issue gives the same atoms and ids. */
export function extractSpecAtoms(task: string): SpecAtom[] {
  const atoms: SpecAtom[] = [], seenSym = new Set<string>();
  const add = (kind: AtomKind, text: string, extra: Partial<SpecAtom> = {}): void => {
    if (atoms.length >= MAX_ATOMS) return;
    atoms.push({ id: `${ID_PREFIX[kind]}${atoms.filter((a) => a.kind === kind).length + 1}`, kind, text: text.trim(), ...extra });
  };
  for (const { head, body } of sections(task)) {
    // examples: fenced code in a code language, outside a "Location" section (that code is the bug, not a case)
    for (const m of body.matchAll(/```([\w-]*)\n([\s\S]*?)```/g)) {
      const lang = m[1] ?? "", code = m[2] ?? "";
      if (!CODE_LANG.test(lang) || code.trim() === "") continue;
      add(LOCATION_SECTION.test(head) ? "location" : "example", code, { lang, section: head });
    }
    const prose = body.replace(/```[\s\S]*?```/g, " ");
    if (OPTION_SECTION.test(head)) for (const m of prose.matchAll(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/gm)) add("option", m[1]!, { section: head });
    for (const sent of prose.split(/(?<=[.!?])\s+|\n\s*\n/)) {
      const s = sent.replace(/\s+/g, " ").trim();
      if (s.length < 12 || s.length > 400) continue;
      if (CLAIM.test(s) || /^expected/i.test(head)) add("claim", s, { section: head });
      for (const b of s.matchAll(/`([^`\n]{1,80})`/g)) {
        const sym = b[1]!.replace(/\(\)$/, "");
        const call = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\(/.exec(b[1]!)?.[1]; // a call in a code span names its callee in any case: `slug("A B")`
        const named = IDENT.test(b[1]!) && /[A-Z_]|\w\.\w/.test(sym) ? sym : IDENT.test(b[1]!) && task.includes(`${sym}(`) ? sym : call;
        if (named && !SRC_EXT.test(named) && !/\.(md|json|ya?ml|toml|mod)$/.test(named) && !seenSym.has(named)) { seenSym.add(named); add("site", named, { section: head }); }
      }
    }
  }
  return atoms;
}

function sourceFiles(dir: string, root = dir, out: string[] = []): string[] {
  let entries: string[] = []; try { entries = readdirSync(dir).sort(); } catch { return out; }
  for (const e of entries) {
    if (out.length > 4000) break;
    if (e.startsWith(".") || e === "node_modules" || e === "vendor" || e === "dist") continue;
    const p = join(dir, e); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) sourceFiles(p, root, out); else if (SRC_EXT.test(e) && !/_test\.go$|\.test\.|\.spec\.|^test_.*\.py$|_test\.py$/.test(e)) out.push(relative(root, p));
  }
  return out;
}

/** A definition of the symbol's last segment, in any of the common declaration shapes. */
export function defRe(name: string): RegExp {
  const n = name.replace(/[$]/g, "\\$");
  return new RegExp(`^\\s*(?:func\\s+(?:\\([^)]*\\)\\s*)?${n}\\s*[(\\[]|type\\s+${n}\\b|(?:var|const)\\s+${n}\\b|(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\b|(?:export\\s+)?(?:const|let|class|interface)\\s+${n}\\b|(?:async\\s+)?def\\s+${n}\\b|class\\s+${n}\\b|(?:pub\\s+)?fn\\s+${n}\\b)`);
}

/** The declaration at line i through its closing brace (or, for Python, its indented block), capped at MAX_BODY_LINES. */
export function declarationAt(lines: string[], i: number): string[] {
  let end = i + 1;
  if (/^\s*(?:async\s+)?(?:def|class)\s/.test(lines[i]!) && /:\s*(?:#.*)?$/.test(lines[i]!)) {
    const ind = lines[i]!.match(/^\s*/)![0].length;
    for (let k = i + 1; k < Math.min(lines.length, i + MAX_BODY_LINES); k++) { const l = lines[k]!; if (l.trim() !== "" && l.match(/^\s*/)![0].length <= ind) break; end = k + 1; }
    return lines.slice(i, end);
  }
  let depth = 0, opened = false;
  for (let k = i; k < Math.min(lines.length, i + MAX_BODY_LINES); k++) {
    for (const ch of lines[k]!) { if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--; }
    end = k + 1; if (opened && depth <= 0) break; if (!opened && k > i + 3) break;
  }
  return lines.slice(i, end);
}

/** Resolve site atoms to their definitions in the repo; external symbols (fmt.Errorf) resolve to nothing and stay prose.
 *  Then one hop: a same-file function a resolved site calls is shown too (the issue names Report; the bug may sit in its helper). */
export function resolveSites(atoms: SpecAtom[], repoDir: string): ResolvedSite[] {
  const files = sourceFiles(repoDir), out: ResolvedSite[] = [], cache = new Map<string, string[]>();
  const linesOf = (f: string): string[] => { let l = cache.get(f); if (!l) { try { l = readFileSync(join(repoDir, f), "utf8").split("\n"); } catch { l = []; } cache.set(f, l); } return l; };
  // distinctive lines of the code the report quotes; a long site shows its head plus a window around the first anchor hit
  const anchors = atoms.filter((a) => a.kind === "location").flatMap((a) => a.text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12 && !l.startsWith("//") && !l.startsWith("#")));
  const tryResolve = (symbol: string, only?: string): void => {
    const name = symbol.split(".").pop()!, re = defRe(name);
    for (const f of only ? [only] : files) {
      const lines = linesOf(f), i = lines.findIndex((l) => re.test(l));
      if (i < 0) continue;
      const body = declarationAt(lines, i);
      let source = body.slice(0, MAX_SITE_LINES).join("\n");
      if (body.length > MAX_SITE_LINES) {
        const hit = body.findIndex((l, k) => k >= MAX_SITE_LINES && anchors.some((a) => l.trim() === a));
        if (hit >= 0) source += `\n\t// ... (lines ${i + MAX_SITE_LINES + 1}-${i + Math.max(MAX_SITE_LINES, hit - ANCHOR_PAD)} omitted)\n` + body.slice(Math.max(MAX_SITE_LINES, hit - ANCHOR_PAD), hit + ANCHOR_PAD).join("\n");
        source += "\n\t// ... (rest omitted)";
      }
      out.push({ symbol, file: f, line: i + 1, source, body: body.join("\n") });
      break;
    }
  };
  for (const a of atoms) { if (a.kind !== "site") continue; if (out.length >= MAX_SITES) break; tryResolve(a.text); }
  for (const s of [...out]) for (const c of (s.body ?? s.source).matchAll(/\b([a-zA-Z_]\w*)\(/g)) {
    if (out.length >= MAX_SITES + 3) break;
    if (!out.some((o) => o.symbol.split(".").pop() === c[1]) && c[1] !== s.symbol.split(".").pop()) tryResolve(c[1]!, s.file);
  }
  return out;
}

// A normalized copy of an input: Go strings.TrimSpace/ToLower/..., JS .trim()/.toLowerCase(), Python .strip()/.lower(). A property
// write (this.#x.method = value.toUpperCase()) is not a local copy: the name must not follow a dot (got 30023f73fd, the probe's one fire).
const NORM_GO = /\b([A-Za-z_]\w*)\s*:?=\s*strings\.(TrimSpace|ToLower|ToUpper|TrimLeft|TrimRight|Trim|TrimPrefix|TrimSuffix)\(\s*([^,()]+?)\s*[,)]/g;
const NORM_DOT = /(?<![\w$#.])(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*=\s*([\w.[\]]+?)\.(trim|trimStart|trimEnd|toLowerCase|toUpperCase|strip|lstrip|rstrip|lower|upper)\(\)/g;
const PERTURB: Record<string, string> = { TrimSpace: "surround it with spaces", Trim: "surround it with the trimmed characters", TrimLeft: "prefix it with the trimmed characters", TrimRight: "suffix it with the trimmed characters", TrimPrefix: "add the trimmed prefix", TrimSuffix: "add the trimmed suffix", ToLower: "give it upper-case letters", ToUpper: "give it lower-case letters", trim: "surround it with spaces", trimStart: "prefix it with spaces", trimEnd: "suffix it with spaces", strip: "surround it with spaces", lstrip: "prefix it with spaces", rstrip: "suffix it with spaces", toLowerCase: "give it upper-case letters", lower: "give it upper-case letters", toUpperCase: "give it lower-case letters", upper: "give it lower-case letters" };
/** Deterministic parity atoms: the code the report quotes reads a normalized copy N of a raw input R, and the enclosing site
 *  passes R itself elsewhere (the sibling branches). The WHOLE function body is scanned (a 45-line excerpt cap hid cli-2418's
 *  firstArg at line 82). Fires only when the report quotes code (a location atom) that uses N. */
export function parityAtoms(atoms: SpecAtom[], sites: ResolvedSite[]): SpecAtom[] {
  const locs = atoms.filter((a) => a.kind === "location"), out: SpecAtom[] = [];
  if (!locs.length) return out;
  for (const s of sites) {
    const src = s.body ?? s.source;
    const hits = [...src.matchAll(NORM_GO)].map((m) => ({ n: m[1]!, fn: m[2]!, r: m[3]!.trim() })).concat([...src.matchAll(NORM_DOT)].map((m) => ({ n: m[1]!, fn: m[3]!, r: m[2]!.trim() })));
    for (const h of hits) {
      if (h.n === h.r) continue; // x = x.trim() rebinds the raw value itself: no sibling can still read the raw form
      const nRe = new RegExp(`\\b${h.n}\\b`), rRe = new RegExp(`(?<![\\w.])${escapeRegex(h.r)}(?![\\w])`);
      const rawUses = src.split("\n").filter((l) => rRe.test(l) && !nRe.test(l)).length;
      if (!locs.some((l) => nRe.test(l.text)) || rawUses === 0 || out.some((o) => o.text.includes(`\`${h.n}\``))) continue;
      out.push({ id: `P${out.length + 1}`, kind: "parity", text: `The quoted code reads \`${h.n}\`, the ${h.fn} copy of \`${h.r}\`, while ${rawUses} other line(s) of ${s.symbol} use \`${h.r}\` itself. Reproduce the reported situation with the input that reaches the quoted code changed so ${h.fn} alters it (${PERTURB[h.fn] ?? "make the normalized and raw forms differ"}), and assert the result the other branches give for raw input.` });
    }
  }
  return out;
}

/** Deterministic pair atoms (the ordering class, cli-2478): two NAMED sites that one input reaches, because a third resolved
 *  site's body (its declaration line excluded) reaches both. One test feeds a single input that is both cases at once, so a fix
 *  that handles each alone but checks them in the wrong order stays red. At most MAX_PAIRS. */
export function pairAtoms(atoms: SpecAtom[], sites: ResolvedSite[]): SpecAtom[] {
  const named = atoms.filter((a) => a.kind === "site").map((a) => a.text), out: SpecAtom[] = [];
  const last = (s: string): string => s.split(".").pop()!;
  const mentions = (body: string, n: string): boolean => new RegExp(`(?<![\\w$])${last(n).replace(/[$]/g, "\\$")}(?![\\w$])`).test(body);
  for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) {
    if (out.length >= MAX_PAIRS) return out;
    const a = named[i]!, b = named[j]!;
    if (last(a) === last(b)) continue;
    const via = sites.find((s) => { const own = last(s.symbol), body = (s.body ?? s.source).split("\n").slice(1).join("\n"); return own !== last(a) && own !== last(b) && mentions(body, a) && mentions(body, b); }); // a third site's body reaches both; a caller and its own callee are one path, not a pair
    if (!via) continue;
    out.push({ id: `X${out.length + 1}`, kind: "pair", text: `\`${a}\` and \`${b}\` are both reached from ${via.symbol} (${via.file}:${via.line}). Write one test whose single input is both cases at once (for example a value that is, or wraps, both), and assert the outcome the report gives for that combination.` });
  }
  return out;
}

// ---------- language-specific emitters ----------
export type SpecRunner = "go" | "pytest" | "vitest";
export interface Emitter {
  runner: SpecRunner; fence: RegExp; fileName: string; prefix: string;
  names(file: string): string[]; banned: RegExp; rules: string;
  /** Turn one case off without breaking the build: Go and Python rename it so the runner no longer collects it; vitest drops its block. null when the case cannot be located. */
  disable(file: string, name: string): string | null;
  /** The body of one case, for coverage and the binding read. */
  body(file: string, name: string): string;
}
const blockAfter = (file: string, startRe: RegExp, endRe: RegExp, eofOk = false): { start: number; end: number } | null => {
  const lines = file.split("\n"), s = lines.findIndex((l) => startRe.test(l)); if (s < 0) return null;
  for (let k = s + 1; k < lines.length; k++) if (endRe.test(lines[k]!)) return { start: s, end: eofOk ? k - 1 : k };
  return eofOk ? { start: s, end: lines.length - 1 } : null;
};
const esc = escapeRegex;
const sliceLines = (file: string, b: { start: number; end: number } | null): string => b ? file.split("\n").slice(b.start, b.end + 1).join("\n") : "";
const COMMON_RULES = (prefix: string): string[] => [
  `Every test is named ${prefix}<AtomId>_<Short> where <AtomId> is the id of the atom it covers (E1, C2, S3, P1, X1, ...).`,
  "Write one test per example atom, reproducing it and asserting the outcome the report says is correct.",
  "Write one test per site atom whose definition is shown below and that the report says is defective: put that site in the defective situation the report describes, even when the report gives no example for it. A combination the report names in words but never shows is exactly what to cover.",
  "Write one test per parity atom and one per pair atom, exactly as each describes.",
  "In every test, put the expected value in a variable named want, built from literals, and compare the result to it. Use the exact values the report states; when the report states none, still write the test.",
  "Only call identifiers that appear in the definitions or the existing test shown below; never invent helpers the package lacks. No skips, no process exits, no network, no sleeps, no subprocesses.",
  "A test that would pass before the fix proves nothing.",
];
export const EMITTERS: Record<SpecRunner, Emitter> = {
  go: {
    runner: "go", fence: /```go\n([\s\S]*?)```/, fileName: "loki_wall_spec_test.go", prefix: "TestLokiSpec_",
    names: (f) => [...f.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((x) => x[1]!),
    banned: /\bt\.Skip|\bos\.Exit\b|"net\/http"|"net"|"os\/exec"|time\.Sleep/,
    rules: ["You turn a bug report into a small Go test file that defines done. You cannot run anything; reply with exactly one ```go fenced block and nothing else.", ...COMMON_RULES("TestLokiSpec_"), "Use only the standard library and the package under test (same package clause, so unexported names are reachable)."].join("\n"),
    disable: (f, n) => { const re = new RegExp(`^func ${esc(n)}\\(t \\*testing\\.T\\)`, "m"); return re.test(f) ? f.replace(re, `func lokiSpecAdvisory${n.slice("TestLokiSpec".length)}(t *testing.T)`) : null; },
    body: (f, n) => sliceLines(f, blockAfter(f, new RegExp(`^func ${esc(n)}\\(`), /^}/)),
  },
  pytest: {
    runner: "pytest", fence: /```(?:python|py)\n([\s\S]*?)```/, fileName: "loki_wall_spec_test.py", prefix: "test_loki_spec_",
    names: (f) => [...f.matchAll(/^def (test_\w+)\(/gm)].map((x) => x[1]!),
    banned: /\bpytest\.skip|\bpytest\.mark\.skip|\bsys\.exit\b|\bos\._exit\b|\btime\.sleep\b|^\s*import (?:socket|subprocess|requests|urllib)\b|^\s*from (?:socket|subprocess|requests|urllib)\b/m,
    rules: ["You turn a bug report into a small pytest test file that defines done. You cannot run anything; reply with exactly one ```python fenced block and nothing else.", ...COMMON_RULES("test_loki_spec_").map((r) => r.replace("<AtomId>", "<atomid in lower case>")), "Write plain module-level test functions with bare assert statements; import the code under test the way the existing test does."].join("\n"),
    disable: (f, n) => { const re = new RegExp(`^def ${esc(n)}\\(`, "m"); return re.test(f) ? f.replace(re, `def _advisory_${n.slice("test_".length)}(`) : null; },
    body: (f, n) => sliceLines(f, blockAfter(f, new RegExp(`^def ${esc(n)}\\(`), /^\S/, true)),
  },
  vitest: {
    runner: "vitest", fence: /```(?:ts|typescript|js|javascript)\n([\s\S]*?)```/, fileName: "loki_wall_spec.test.ts", prefix: "LokiSpec_",
    names: (f) => [...f.matchAll(/^(?:test|it)\(\s*["'`](LokiSpec_[^"'`]+|[^"'`]+)["'`]/gm)].map((x) => x[1]!),
    banned: /\.(?:skip|todo|only)\b|\bprocess\.exit\b|\bsetTimeout\b|\bfetch\(|child_process|\bvi\.mock\b/,
    rules: ["You turn a bug report into a small vitest test file that defines done. You cannot run anything; reply with exactly one ```ts fenced block and nothing else.", ...COMMON_RULES("LokiSpec_"), 'Import test and expect from "vitest". Write every case as a top-level test("LokiSpec_<AtomId>_<Short>", () => { ... }); call whose closing line is exactly "});" with no indentation. Import the code under test with the relative specifier given below.'].join("\n"),
    disable: (f, n) => { const b = blockAfter(f, new RegExp(`^(?:test|it)\\(\\s*["'\`]${esc(n)}["'\`]`), /^}\);?\s*$/); if (!b) return null; const l = f.split("\n"); l.splice(b.start, b.end - b.start + 1); return l.join("\n"); },
    body: (f, n) => sliceLines(f, blockAfter(f, new RegExp(`^(?:test|it)\\(\\s*["'\`]${esc(n)}["'\`]`), /^}\);?\s*$/)),
  },
};

/** Atom id a case covers, read from its name (TestLokiSpec_S3_X, test_loki_spec_s3_x, LokiSpec_S3_X). */
export const atomIdOf = (e: Emitter, name: string): string => (name.slice(e.prefix.length).split("_")[0] ?? "").toUpperCase();

export function buildGeneratorBrief(e: Emitter, atoms: SpecAtom[], sites: ResolvedSite[], header: string, styleSample: string): string {
  const atomLines = atoms.filter((a) => a.kind !== "location").map((a) => `[${a.id}] ${a.kind}${a.section ? ` (section: ${a.section})` : ""}: ${a.kind === "example" ? `\n${a.text}` : a.text}`);
  const siteLines = sites.map((s) => `--- ${s.symbol} at ${s.file}:${s.line}\n${s.source}`);
  return [e.rules, header, `Atoms extracted from the report:\n${atomLines.join("\n")}`, `Definitions of the named sites (current, buggy code):\n${siteLines.join("\n") || "(none resolved)"}`, `Existing test (style and helpers you may reuse):\n${styleSample.slice(0, 2500) || "(none)"}`].join("\n\n");
}

/** Pull the fenced block; refuse anything that cannot serve as a check. Returns the file text or a named refusal. */
export function parseGenerated(e: Emitter, reply: string, mustStart = ""): { file: string } | { refused: string } {
  const m = reply.match(e.fence);
  if (!m) return { refused: "exec_spec_no_code_block" };
  const file = m[1]!;
  if (mustStart && !file.trimStart().startsWith(mustStart)) return { refused: `exec_spec_wrong_package: expected ${mustStart}` };
  if (e.banned.test(file)) return { refused: "exec_spec_banned_call" };
  const names = e.names(file);
  if (names.length === 0 || names.some((n) => !n.startsWith(e.prefix)) || new Set(names).size !== names.length) return { refused: "exec_spec_bad_test_names" };
  return { file };
}

// ---------- binding: only values one issue example states may define done ----------
/** One issue example: a fenced block, or one prose sentence with its code spans. `strs` are the whole values it states (whole code spans
 *  and quoted strings, never a fragment of either); `nums` are number tokens inside its code (a number in plain prose never counts). */
export interface IssueUnit { strs: Set<string>; nums: Set<string> }
const NUM_TOKEN = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g;
const quotedIn = (t: string): string[] => [...t.matchAll(/"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'/g)].map((m) => m[1] ?? m[2] ?? "");
export function issueUnits(task: string): IssueUnit[] {
  const units: IssueUnit[] = [];
  for (const m of task.matchAll(/```[\w-]*\n([\s\S]*?)```/g)) units.push({ strs: new Set(quotedIn(m[1]!)), nums: new Set(m[1]!.match(NUM_TOKEN) ?? []) });
  const prose = task.replace(/```[\s\S]*?```/g, "\n\n");
  for (const sent of prose.split(/(?<=[.!?])\s+(?=[A-Z`])|\n\s*\n/)) {
    const spans = [...sent.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!), outside = sent.replace(/`[^`\n]+`/g, " ");
    if (!spans.length && !quotedIn(outside).length) continue;
    units.push({ strs: new Set([...spans, ...spans.flatMap(quotedIn), ...quotedIn(outside)]), nums: new Set(spans.flatMap((x) => x.match(NUM_TOKEN) ?? [])) });
  }
  return units;
}
const unescape = (s: string): string => s.replace(/\\(["'\\nt`])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
const LITERAL = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`([^`]*)`|(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])/g;
const literalsOf = (text: string): { v: string; num: boolean }[] => [...text.matchAll(LITERAL)].map((m) => (m[4] !== undefined ? { v: m[4], num: true } : { v: unescape(m[1] ?? m[2] ?? m[3] ?? ""), num: false }));
const WANT_ASSIGN = /^\s*(?:(?:const|let|var)\s+)?want\b\s*(?::=|=(?!=))/;
/** The literal values of the want assignment in one case (true/false/nil/None/null are neutral, not values). */
export function wantLiterals(body: string): string[] | null {
  const lines = body.split("\n"), i = lines.findIndex((l) => WANT_ASSIGN.test(l));
  if (i < 0) return null;
  let text = "", depth = 0;
  for (let k = i; k < lines.length; k++) { const l = lines[k]!; text += `${l}\n`; for (const ch of l.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, "")) { if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--; } if (depth <= 0) break; }
  return literalsOf(text.replace(/^[^=]*?(?::=|=)/, "")).map((x) => x.v);
}
/** Every literal a case asserts with or feeds in: its body minus the declaration line, failure-message calls and comments. */
export function caseLiterals(body: string): { v: string; num: boolean }[] {
  const code = body.split("\n").slice(1).filter((l) => !/^\s*(?:t\.(?:Fatal|Fatalf|Error|Errorf|Log|Logf|Helper)\(|\/\/|#)/.test(l)).join("\n");
  return literalsOf(code);
}
/** A case is BINDING only when (1) want is assigned exactly once from at least one literal and compared after that, and (2) every
 *  literal the case uses (the call input and the expected value) is stated, whole, by ONE issue example. A fragment of a span
 *  ("bad" in `error: bad input`), an input the issue never shows, or a number that only appears in prose is advisory. */
export function isBinding(body: string, task: string, units = issueUnits(task)): boolean {
  const lines = body.split("\n"), assigns = lines.filter((l) => WANT_ASSIGN.test(l) || /^\s*want\s*(?:\+=|-=)/.test(l)).length;
  const want = wantLiterals(body), at = lines.findIndex((l) => WANT_ASSIGN.test(l));
  if (assigns !== 1 || !want || want.length === 0 || !lines.slice(at + 1).some((l) => /\bwant\b/.test(l))) return false;
  const lits = caseLiterals(body);
  return units.some((u) => lits.every((x) => (x.num ? u.nums.has(x.v) : u.strs.has(x.v))));
}

// ---------- base red filter (harness-run, per case; red-by-assertion is util/check_result.ts's one rule per runner) ----------
export type CaseState = "red" | "green" | "error";
export interface RedFilterResult { built: boolean; cases: Record<string, CaseState>; error?: string; durationS: number }

function parseGo(out: string, names: string[]): RedFilterResult["cases"] | null {
  const linesByTest = new Map<string, string[]>(), state: Record<string, CaseState> = {}; let any = false;
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev: { Action?: string; Test?: string; Output?: string }; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.Action === "build-fail") return null;
    const t = ev.Test?.split("/")[0]; if (!t || !names.includes(t)) continue; any = true;
    linesByTest.set(t, [...(linesByTest.get(t) ?? []), line]);
    if (ev.Test!.includes("/")) continue;
    if (ev.Action === "pass") state[t] = "green";
    if (ev.Action === "fail") state[t] = assertionFailure("go", linesByTest.get(t)!.join("\n")) ? "red" : "error"; // the Wall's rule, fed this test's own events
  }
  return any ? state : null;
}
const xmlUnescape = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
function parseJunit(xml: string, names: string[]): RedFilterResult["cases"] | null {
  const state: Record<string, CaseState> = {};
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? "", inner = m[2] ?? "";
    if (!names.includes(name)) { if (/<error\b/.test(inner)) return null; continue; } // a collection error is reported on a synthetic case
    const fail = /<failure\b[^>]*?message="([^"]*)"/.exec(inner);
    if (/<error\b|<skipped\b/.test(inner)) state[name] = "error";
    else if (/<failure\b/.test(inner)) { const msg = xmlUnescape(fail?.[1] ?? "").trim(), kinds = msg ? [msg] : [...xmlUnescape(inner).matchAll(/^E\s+((?:assert\b|[A-Za-z_.]*(?:Error|Exception))\S*)/gm)].map((k) => k[1]!); state[name] = pytestKindsAreAssertion(kinds) ? "red" : "error"; }
    else state[name] = "green";
  }
  return Object.keys(state).length ? state : null;
}
function parseVitestJson(json: string, names: string[]): RedFilterResult["cases"] | null {
  let r: { testResults?: { status?: string; message?: string; assertionResults?: { title?: string; status?: string; failureMessages?: string[] }[] }[] };
  try { r = JSON.parse(json); } catch { return null; }
  const state: Record<string, CaseState> = {};
  for (const f of r.testResults ?? []) for (const a of f.assertionResults ?? []) {
    const n = a.title ?? ""; if (!names.includes(n)) continue;
    state[n] = a.status === "passed" ? "green" : a.status === "failed" && vitestErrorsAreAssertion((a.failureMessages ?? []).join("\n")) ? "red" : "error";
  }
  return Object.keys(state).length ? state : null;
}

/** Write the file at dest, run it once with the repo's own runner command plus a machine-readable reporter, read every case,
 *  then remove the file. A file that does not build, or no case read, proves nothing (built false). */
export function redFilter(e: Emitter, repoDir: string, destRel: string, file: string, timeoutMs = 120_000): RedFilterResult {
  const dest = join(repoDir, destRel), t0 = Date.now(), names = e.names(file);
  const rep = mkdtempSync(join(tmpdir(), "loki-execspec-")), repFile = join(rep, e.runner === "pytest" ? "junit.xml" : "report.json");
  mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, file, "utf8");
  try {
    const c = commandFor({ runner: e.runner, path: destRel }, repoDir);
    const args = e.runner === "pytest" ? [...c.args, "-p", "no:cacheprovider", `--junitxml=${repFile}`] : e.runner === "vitest" ? [...c.args, "--reporter=json", `--outputFile=${repFile}`] : c.args;
    const r = spawnGroupSync(c.cmd, args, { cwd: c.cwd, timeoutMs, env: plainTestEnv() });
    const out = stripAnsi(r.output), rep1 = existsSync(repFile) ? readFileSync(repFile, "utf8") : "";
    const cases = e.runner === "go" ? parseGo(out, names) : e.runner === "pytest" ? parseJunit(rep1, names) : parseVitestJson(rep1, names);
    return cases ? { built: true, cases, durationS: (Date.now() - t0) / 1000 } : { built: false, cases: {}, error: out.slice(-1200), durationS: (Date.now() - t0) / 1000 };
  } finally { rmSync(dest, { force: true }); rmSync(rep, { recursive: true, force: true }); }
}

// ---------- selection and the implement brief ----------
export interface SpecSelection { file: string; binding: string[]; advisory: { name: string; why: string }[]; guards: string[] }
/** Split the cases: binding = red by assertion on base AND isBinding (input and expected value from one issue example); advisory = red but not issue-stated;
 *  guards = green on base (regression guards, advisory only); error cases are dropped. The sealed file keeps only binding cases. */
export function selectCases(e: Emitter, file: string, base: RedFilterResult, task: string): SpecSelection {
  const units = issueUnits(task), binding: string[] = [], advisory: { name: string; why: string }[] = [], guards: string[] = [];
  let sealed = file;
  for (const n of e.names(file)) {
    const st = base.cases[n], b = e.body(file, n);
    if (st === "red" && isBinding(b, task, units)) { binding.push(n); continue; }
    if (st === "red") advisory.push({ name: n, why: "red on base, but its input or expected value is not stated whole by one issue example" });
    else if (st === "green") guards.push(n);
    sealed = e.disable(sealed, n) ?? sealed;
  }
  return { file: sealed, binding, advisory, guards };
}

/** Named sites (resolved in the repo) that no binding case's body names. */
export function uncoveredSites(e: Emitter, binding: string[], full: string, atoms: SpecAtom[], sites: ResolvedSite[]): string[] {
  const resolved = new Set(sites.map((s) => s.symbol)), bodies = binding.map((n) => e.body(full, n)).join("\n");
  return atoms.filter((a) => a.kind === "site" && resolved.has(a.text) && !new RegExp(`\\b${esc(a.text.split(".").pop()!)}\\b`).test(bodies)).map((a) => a.text.split(".").pop()!);
}
// A site is defective only when the defect or request words attach to its own span: it is the subject of a clause that states a defect
// or asks for behavior ("`Split` drops args", "`Split` should return ...", "`Split` is wrong"), or the object of a fix verb ("Fix `Split`").
// A comparison ("like `Join` does", "as `Join` does", "see `Join`"), a negated scope ("should not change `Report`", "does not affect
// `Report`") and a verdict of health ("`Report` is fine") never make a site defective, and neither does a span elsewhere in the sentence.
const DEFECT_OR_ASK = /\binstead of\b|\bshould\b|\bexpected\b|\bmust\b|\bneeds? to\b|\b(?:bug|wrong|broken|mishandl\w*|drops?|dropped|fails?|failing|ignores?|ignored|incorrect\w*|crash\w*|panics?|regress\w*|missing|loses?|lost|never|doesn't|does not|isn't|is not|stops? at|stops? on)\b/i; // explicit defect or request words only: "returns" and "gives" describe behavior, they do not name a defect
const HEALTHY = /^\s*(?:\w+\s+){0,2}(?:is|are|works?|stays?|remains?|looks?)\s+(?:fine|correct|ok|okay|right|unaffected|unchanged|good|already correct)\b|\b(?:returns?|gives?|produces?|prints?|yields?)\s+the\s+(?:right|correct|expected)\b/i;
const HEALTHY_TAIL = /^\s*which\s+(?:is|are)\s+(?:correct|fine|right|ok|okay|expected|intended)\b/i; // ", which is correct" clears the clause before it
const FIX_VERB = /\b(?:fix|fixes|fixing|change|update|correct|repair|handle|make)\s+`([^`\n]{1,80})`/gi;
const spanId = (span: string): string | null => { const id = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(span)?.[1]; return id ? id.split(".").pop()! : null; };
/** The named sites (last segment) the issue calls defective or asks to change, read clause by clause. */
export function defectSites(task: string): Set<string> {
  const out = new Set<string>(), prose = task.replace(/```[\s\S]*?```/g, "\n\n");
  const spans: string[] = [], masked = prose.replace(/`([^`\n]+)`/g, (_, x: string) => `\`@${spans.push(x) - 1}\``); // split on punctuation outside code spans only
  const unmask = (t: string): string => t.replace(/`@(\d+)`/g, (_, i: string) => `\`${spans[Number(i)]}\``);
  for (const unit of masked.split(/(?<=[.!?])\s+(?=[A-Z`])|\n\s*\n|\n(?=\s*(?:[-*]|\d+[.)])\s)/)) {
    // a contrast ("A returns X but B returns Y instead of Z", "A returns the right shape, B should ...") is two clauses: only the side
    // carrying the defect words marks its subject
    const clauses = unit.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").split(/;|:\s|,\s*(?=(?:which|but|and|so|while|whereas|though)\b|`)|\s+(?=(?:but|whereas|while)\s)/i).map(unmask), marks: (string | null)[] = [];
    for (const [ci, clause] of clauses.entries()) {
      let mark: string | null = null;
      const plural = /^\s*(?:both\s+|also\s+)?`([^`\n]{1,80})`\s+and\s+`([^`\n]{1,80})`(.*)$/is.exec(clause); // "Both `A` and `B` should ...": a plural subject marks each
      if (plural) { const pred = plural[3]!.replace(/`[^`\n]*`/g, " "); if (!HEALTHY.test(pred) && DEFECT_OR_ASK.test(pred)) for (const x of [plural[1]!, plural[2]!]) { const id = spanId(x); if (id) out.add(id); } }
      const designed = (t: string | undefined): boolean => !!t && /\bby design\b|\bas (?:intended|designed|expected)\b|\bintended\b|\b(?:is|are)\s+(?:fine|correct|expected|intended|right|ok|okay)\b/i.test(t);
      if (ci > 0 && /^\s*which\b/i.test(clause) && !HEALTHY_TAIL.test(clause) && !HEALTHY.test(clause) && !designed(clause) && !designed(clauses[ci + 1]) && DEFECT_OR_ASK.test(clause.replace(/`[^`\n]*`/g, " "))) { // a which-clause followed by "by design" or "is fine" is healthy // "`Report` calls `Split`, which stops ...": the which-clause describes the last span before it
        const prev = [...clauses[ci - 1]!.matchAll(/`([^`\n]{1,80})`/g)].pop(); const id = prev ? spanId(prev[1]!) : null; if (id) out.add(id);
      }
      for (const m of clause.matchAll(FIX_VERB)) { const before = clause.slice(0, m.index); if (!/\b(?:not|never|n't)\s+$/i.test(before)) { const id = spanId(m[1]!); if (id) out.add(id); } } // "Fix `X`", never "should not change `X`"
      const subj = /^\s*(?:(?:the|a|an|also|and|but|so|now|then|here|still|whereas|while)\s+)*`([^`\n]{1,80})`(.*)$/is.exec(clause); // the clause's subject span and its predicate
      if (subj) { const pred = subj[2]!.replace(/`[^`\n]*`/g, " "); if (!HEALTHY.test(pred) && DEFECT_OR_ASK.test(pred)) mark = spanId(subj[1]!); }
      if (HEALTHY_TAIL.test(clause) && marks.length) marks[marks.length - 1] = null;
      marks.push(mark);
    }
    for (const m of marks) if (m) out.add(m);
  }
  return out;
}
/** Seal's input (engine10/stages/seal.ts specSiteGap): uncovered sites the issue names in a defect or request sentence. Seal caps the run
 *  below VERIFIED on each one the diff did not touch and no agent-independent passing test names. */
export const capSites = (uncovered: string[], task: string): string[] => { const d = defectSites(task); return uncovered.filter((x) => d.has(x)); };
export function implementBlock(e: Emitter, destRel: string, sel: SpecSelection, full: string, atoms: SpecAtom[], sites: ResolvedSite[]): string {
  const unchecked = uncoveredSites(e, sel.binding, full, atoms, sites);
  const adv = [...sel.advisory, ...sel.guards.map((name) => ({ name, why: "passes on base: keep it passing" }))];
  return [
    ...(sel.binding.length ? [`Executable spec: ${destRel} was written from the task before you started and is read-only. These tests fail on the current code, assert values the task itself states, and define done; make every one pass without editing the file:`, ...sel.binding.map((n) => `- ${n}`)] : []),
    ...(adv.length ? [`Advisory spec cases (not required, never blocking; a hint at the intended behavior, possibly wrong):\n${adv.map((a) => `- ${a.why}:\n${e.body(full, a.name).slice(0, 900)}`).join("\n")}`] : []),
    ...(unchecked.length ? [`Named sites no binding spec test covers; handle each one the task describes (the run cannot read VERIFIED until a passing test that is not yours names each): ${unchecked.join(", ")}`] : []),
  ].join("\n");
}

// ---------- the generator seam ----------
/** One completion with no repo tools. The default is toolLessCall (runner/sdk_invoker.ts): no tools, no agent loop, thinking low, priced
 *  into the run's child ledger (phase exec_spec) and refused once the run dollar cap is reached. Under LOKI_E10_INVOKER=cli every model call
 *  goes through the configured CLI, so the generator does too (sessionGenerator: an empty temp directory, every tool but Write disallowed).
 *  Tests replace it with setExecSpecGenerator. A generator returns the reply text, null for no reply, or { none } with the reason. */
export type SpecGenerator = (brief: string, o: { model: string; iterationId: string; signal: AbortSignal; maxTokens?: number; meter?: { usd?: number | null } }) => Promise<string | null | { none: string }>; // meter.usd: the call's dollars when the generator prices it itself
let generatorOverride: SpecGenerator | null = null;
export const setExecSpecGenerator = (g: SpecGenerator | null): void => { generatorOverride = g; };
export const execSpecModel = (env: NodeJS.ProcessEnv = process.env): string => env.LOKI_E10_EXEC_SPEC_MODEL || "haiku";
export const EXEC_SPEC_LEDGER_PHASE = "exec_spec";
export function toolLessGenerator(repoDir: string): SpecGenerator {
  return async (brief, o) => {
    if (o.signal.aborted) return null;
    const r = await toolLessCall({ model: resolveClaudeModel(o.model), prompt: brief, maxTokens: o.maxTokens ?? 4096, thinking: "low", timeoutMs: 120_000, ledger: { lokiDir: join(repoDir, ".loki"), phase: EXEC_SPEC_LEDGER_PHASE } });
    if (o.meter) o.meter.usd = r.usd;
    if (r.outcome.kind === "ok") return r.outcome.value;
    return r.outcome.kind === "budget" ? { none: "the run dollar cap is reached, no generator call was made" } : { none: `the generator call ended ${describeJudgeOutcome(r.outcome)}` };
  };
}
export const defaultGenerator = (sessions: Parameters<typeof sessionGenerator>[0], repoDir: string, env: NodeJS.ProcessEnv = process.env): SpecGenerator =>
  env.LOKI_E10_INVOKER === "cli" ? sessionGenerator(sessions) : toolLessGenerator(repoDir);
export const EXEC_SPEC_REPLY = "spec_reply.md";
export function sessionGenerator(sessions: { run(o: Record<string, unknown>): Promise<{ exit: number | null; killed: boolean }> }): SpecGenerator {
  return async (brief, o) => {
    const cwd = mkdtempSync(join(tmpdir(), "loki-execspec-gen-"));
    try {
      const r = await sessions.run({ stage: "wall", brief: `${brief}\n\nWrite that reply, and nothing else, to the file ${EXEC_SPEC_REPLY} in the current directory with the Write tool; use no other tool.`, tier: "development", model: o.model, iterationId: o.iterationId, limitS: 120, maxOutputTokens: o.maxTokens ?? 4096, effort: "low", disallowedTools: "Bash,Read,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite", signal: o.signal, cwd });
      if (r.killed || r.exit === null) return null;
      const p = join(cwd, EXEC_SPEC_REPLY); return existsSync(p) ? readFileSync(p, "utf8") : null;
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  };
}

// ---------- relation cases (Go): binding invariance checks recorded on the base tree, no model call ----------
// When the issue states a wrap relation (%w, errors.As/Is, Unwrap, "wrapped"), the harness writes one case per named interface type the
// base code checks with a bare `x.(T)` inside the reach of a named function F(err error): F(R(v)) must behave exactly as F(v) did on the
// BASE tree, with R(x) = fmt.Errorf("loki: %w", x). Behavior is what F returns plus the package's func-variable calls (with arguments)
// and whether each io.Writer variable it reaches was written (never the text: the issue does not fix it). The reference is RECORDED
// on the base tree, never F(v) on the changed tree: an ordering fix that changes the bare value too would otherwise pass.
export const RELATION_FILE_GO = "loki_wall_relation_test.go";
export const RELATION_WRAP_PREFIX = "loki: "; // the wrap's own text: a recorded observation that contains it carries message text, never behavior
const OBSERVABLE_ARG = /^(?:u?int(?:8|16|32|64)?|float(?:32|64)|bool|byte|rune)$/;
// The issue must ASK about wrapped errors: a sentence or list item that names a wrapped error (%w, "wrapped error", "error wrapped",
// errors.As/Is, Unwrap) and states a defect or request about it. "text is wrapped at 80 columns" or "Do not use errors.Is here" is not one.
const WRAP_TERM = /%w\b|\bwrapped\s+(?:\w+\s+)?errors?\b|\berrors?\s+(?:that\s+(?:is|are|was|were)\s+|is\s+|are\s+)?wrapped\b|\berrors\.(?:As|Is)\b|\bUnwrap\b/i;
const WRAP_ASK = /\bshould\b|\bmust\b|\bhandled?\b|\bhandles\b|\binstead of\b|\bnever\b|\bignor(?:e|es|ed)\b|\bnot\s+(?:recogni[sz]ed|handled|retried|found|seen|detected|matched|treated)\b|\bfails?\b|\bmisses\b|\b(?:does|did|is|are)\s+not\b|\b(?:doesn't|didn't|isn't|aren't)/i;
// Not a request about handling wrapped errors: a negated wrap ("should not wrap the error with %w", "never wrap"), advice against the
// helpers ("Do not use errors.Is"), or a sentence about the message text ("the wrapped error message is too long").
const WRAP_NEGATED = /\b(?:do not|don't|never|avoid|should not|shouldn't|must not|mustn't|stop)\s+(?:\w+\s+){0,2}?(?:use|call|add|wrap(?:ping)?)\b/i;
const WRAP_TEXT = /\bwrapped\s+(?:\w+\s+)?errors?(?:'s)?\s+(?:message|text|string|output)\b|\b(?:message|text|string)\s+of\s+(?:the\s+|a\s+)?wrapped\b/i;
export const statesWrapRelation = (task: string): boolean => task.replace(/```[\s\S]*?```/g, "\n\n").split(/(?<=[.!?])\s+(?=[A-Z`])|\n\s*\n|\n(?=\s*(?:[-*]|\d+[.)])\s)/).some((u) => WRAP_TERM.test(u) && WRAP_ASK.test(u) && !WRAP_NEGATED.test(u) && !WRAP_TEXT.test(u));
export interface RelCase { id: string; type: string; v: string; rv: string }
export interface RelSpec { fn: string; returns: boolean; cases: RelCase[]; observe: string }
interface GoDecls { ifaces: string[]; funcs: { name: string; params: string; ret: string; body: string }[]; vars: { name: string; params?: string; writer: boolean }[] }
function goDecls(src: string): GoDecls {
  const ifaces = [...src.matchAll(/^type\s+([A-Z]\w*)\s+interface\b/gm)].map((m) => m[1]!);
  const bodyOf = (at: number): string => { let d = 0, i = src.indexOf("{", at); const st = i; for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) break; } return src.slice(st, i + 1); };
  const funcs = [...src.matchAll(/^func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*([^{]*)\{/gm)].map((m) => ({ name: m[1]!, params: m[2]!.trim(), ret: m[3]!.trim(), body: bodyOf(m.index!) }));
  const vars = [...src.matchAll(/^var\s+([A-Z]\w*)\s*(?:=\s*func\s*\(([^)]*)\)|(io\.Writer))/gm)].map((m) => ({ name: m[1]!, ...(m[2] !== undefined ? { params: m[2] } : {}), writer: !!m[3] }));
  return { ifaces, funcs, vars };
}
/** The relation spec for the package holding a named site, or null when the issue states no wrap relation or nothing qualifies. */
export function relationSpec(task: string, files: string[], pkg: string, named: Set<string>): RelSpec | null {
  if (!statesWrapRelation(task)) return null;
  const d = goDecls(files.join("\n"));
  const strictIn = (body: string): string[] => [...body.matchAll(/\.\(\s*([A-Z]\w*)\s*\)/g)].map((m) => m[1]!).filter((t) => d.ifaces.includes(t));
  const reach = (name: string, seen = new Set<string>()): string[] => { const f = d.funcs.find((x) => x.name === name); if (!f || seen.has(name)) return []; seen.add(name); return [f.body, ...d.funcs.filter((g) => new RegExp(`\\b${g.name}\\s*\\(`).test(f.body)).flatMap((g) => reach(g.name, seen))]; };
  const F = d.funcs.find((f) => named.has(f.name) && /^[A-Z]/.test(f.name) && /^\w+\s+error$/.test(f.params) && strictIn(reach(f.name).join("\n")).length > 0);
  if (!F) return null;
  const body = reach(F.name).join("\n"), strict = [...new Set(strictIn(body))], ctor = (t: string) => d.funcs.find((f) => /^[A-Z]/.test(f.name) && f.ret === t);
  const args = (params: string, k: number, members: string[] = []): string | null => {
    if (!params) return "";
    const out: string[] = [];
    for (const p of params.split(",").map((x) => x.trim())) { const ty = p.split(/\s+/).pop()!; if (ty === "string") out.push(JSON.stringify(k === 0 ? "a" : "b")); else if (ty === "int") out.push(String(k === 0 ? 3 : 5)); else if (ty === "...error" && members.length) out.push(...members); else return null; }
    return out.join(", ");
  };
  const R = (x: string): string => `fmt.Errorf("${RELATION_WRAP_PREFIX}%w", ${x})`, cases: RelCase[] = [];
  const leaf = strict.filter((t) => { const c = ctor(t); return c && !c.params.includes("...error"); });
  for (const t of strict) {
    const c = ctor(t); if (!c) continue;
    if (!c.params.includes("...error")) { const a = args(c.params, 0); if (a === null) continue; const v = `${c.name}(${a})`; cases.push({ id: `${t}_wrapped`, type: t, v, rv: R(v) }); continue; }
    const lc = leaf.map((x) => ctor(x)!).find(Boolean); if (!lc) continue;
    const a0 = args(lc.params, 0), a1 = args(lc.params, 1); if (a0 === null || a1 === null) continue;
    const m0 = `${lc.name}(${a0})`, m1 = `${lc.name}(${a1})`, v = `${c.name}(${m0}, ${m1})`;
    cases.push({ id: `${t}_wrapped`, type: t, v, rv: R(v) }, { id: `${t}_members_wrapped`, type: t, v, rv: `${c.name}(${R(m0)}, ${R(m1)})` });
  }
  if (!cases.length) return null;
  const obsFuncs = d.vars.filter((v) => v.params !== undefined && new RegExp(`\\b${v.name}\\s*\\(`).test(body));
  const obsWriters = d.vars.filter((v) => v.writer && new RegExp(`\\b${v.name}\\b`).test(body)).map((v) => v.name);
  const rec = obsFuncs.map((f, i) => { const ps = f.params!.split(",").filter((x) => x.trim()), sig = ps.map((p, j) => `p${j} ${p.trim().split(/\s+/).pop()}`).join(", "); const shown = ps.map((p, j) => (OBSERVABLE_ARG.test(p.trim().split(/\s+/).pop()!) ? `p${j}` : null)).filter((x): x is string => x !== null); return `\told${i} := ${f.name}\n\t${f.name} = func(${sig}) { trace = append(trace, fmt.Sprint(${[JSON.stringify(f.name), ...shown].join(", ")})) }\n\tdefer func() { ${f.name} = old${i} }()`; }).join("\n"); // a call is recorded with its numeric and bool arguments only: a string or error argument carries message text, which the issue never fixes and the wrap changes
  const wr = obsWriters.map((w, i) => `\tbufOld${i} := ${w}\n\tvar buf${i} bytes.Buffer\n\t${w} = &buf${i}\n\tdefer func() { ${w} = bufOld${i}; trace = append(trace, fmt.Sprint("${w}.written=", buf${i}.Len() > 0)) }()`).join("\n");
  const observe = `func lokiRelObserve(f func() string) (out string) {\n\tvar trace []string\n\tdefer func() { out = fmt.Sprint(trace) }()\n${rec}\n${wr}\n\tif r := f(); r != "" {\n\t\ttrace = append(trace, "ret="+r)\n\t}\n\treturn\n}`;
  return { fn: F.name, returns: F.ret !== "", cases, observe };
}
const relCall = (spec: RelSpec, x: string): string => spec.returns ? `func() string { return fmt.Sprint(${spec.fn}(${x})) }` : `func() string { ${spec.fn}(${x}); return "" }`;
const relHeader = (pkg: string): string => `package ${pkg}\n\nimport (\n\t"bytes"\n\t"fmt"\n\t"testing"\n)\n\nvar _ = bytes.NewBuffer\n`;
/** The record program: prints F(v) and F(R(v)) per case, run on the BASE tree only. */
export const relationRecordTest = (spec: RelSpec, pkg: string): string => `${relHeader(pkg)}\n${spec.observe}\n\nfunc TestLokiRelRecord(t *testing.T) {\n${spec.cases.map((c) => `\tfmt.Println("LOKI_REL " + ${JSON.stringify(c.id)} + "\\t" + lokiRelObserve(${relCall(spec, c.v)}) + "\\t" + lokiRelObserve(${relCall(spec, c.rv)}))`).join("\n")}\n}\n`;
/** The sealed form: one case per relation, each asserting the bare and the wrapped value both behave as the bare value did on base. */
export function relationSealedTest(spec: RelSpec, pkg: string, ref: Map<string, string>): string {
  return `${relHeader(pkg)}\n${spec.observe}\n${spec.cases.filter((c) => ref.has(c.id)).map((c, i) => `
func TestLokiSpec_R${i + 1}_${c.id}(t *testing.T) {
\twant := ${JSON.stringify(ref.get(c.id))} // recorded on the original code: what the bare value did before the change
\tif got := lokiRelObserve(${relCall(spec, c.v)}); got != want {
\t\tt.Errorf("the bare value now behaves differently: got %s, before the change %s", got, want)
\t}
\tif got := lokiRelObserve(${relCall(spec, c.rv)}); got != want {
\t\tt.Errorf("the wrapped value: got %s, want %s (what the bare value does)", got, want)
\t}
}`).join("\n")}\n`;
}
/** Record on the base tree: id -> [bare, wrapped]. Null when the record program does not build or prints nothing. */
export function recordRelation(repoDir: string, destRel: string, file: string, timeoutMs = 120_000): Map<string, [string, string]> | null {
  const dest = join(repoDir, destRel); writeFileSync(dest, file, "utf8");
  try {
    const c = commandFor({ runner: "go", path: destRel }, repoDir), args = c.args[0] === "test" ? ["test", "-count=1", ...c.args.slice(1)] : c.args, r = spawnGroupSync(c.cmd, args, { cwd: c.cwd, timeoutMs, env: plainTestEnv() }), out = new Map<string, [string, string]>(); // -count=1: a cached result would make the second record agree trivially
    for (const line of stripAnsi(r.output).split("\n")) {
      let text = line; if (line.startsWith("{")) { try { text = (JSON.parse(line) as { Output?: string }).Output ?? ""; } catch { continue; } }
      const m = /^LOKI_REL (\S+)\t(.*)\t(.*)$/.exec(text.replace(/\n$/, "")); if (m) out.set(m[1]!, [m[2]!, m[3]!]);
    }
    return out.size ? out : null;
  } finally { rmSync(dest, { force: true }); }
}
export interface RelationOutcome { targetRel: string; file: string; cases: string[]; fn: string; types: string[] }
/** Relation cases for a Go repo: recorded on base, only the cases red on base sealed (a wrapped value that already behaves like the bare
 *  one proves nothing), confirmed red once more in their sealed form. Binding by construction: no value is guessed. */
export function relationCasesGo(task: string, repoDir: string, sites: ResolvedSite[], atoms: SpecAtom[]): RelationOutcome | null {
  if (!statesWrapRelation(task)) return null;
  const named = new Set(atoms.filter((a) => a.kind === "site").map((a) => a.text.split(".").pop()!));
  for (const dir of [...new Set(sites.filter((s) => s.file.endsWith(".go")).map((s) => dirname(s.file)))]) {
    let files: string[] = []; try { files = readdirSync(join(repoDir, dir)).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).sort().map((f) => readFileSync(join(repoDir, dir, f), "utf8")); } catch { continue; }
    const pkg = /^package\s+(\w+)/m.exec(files[0] ?? "")?.[1]; if (!pkg) continue;
    const spec = relationSpec(task, files, pkg, named); if (!spec) continue;
    const targetRel = join(dir, RELATION_FILE_GO); if (existsSync(join(repoDir, targetRel))) continue;
    const prog = relationRecordTest(spec, pkg), rec = recordRelation(repoDir, targetRel, prog), rec2 = rec ? recordRelation(repoDir, targetRel, prog) : null; if (!rec || !rec2) continue;
    const stable = (id: string, bare: string, wrapped: string): boolean => { const b = rec2.get(id); return !!b && b[0] === bare && b[1] === wrapped; }; // recorded twice: a case whose observation varies between runs proves nothing
    const ref = new Map([...rec].filter(([id, [bare, wrapped]]) => bare !== wrapped && stable(id, bare, wrapped) && !bare.includes(RELATION_WRAP_PREFIX.trim()) && !wrapped.includes(RELATION_WRAP_PREFIX.trim())).map(([id, [bare]]) => [id, bare]));
    if (!ref.size) continue;
    const file = relationSealedTest(spec, pkg, ref), e = EMITTERS.go, check = redFilter(e, repoDir, targetRel, file), red = e.names(file).filter((n) => check.cases[n] === "red");
    if (!check.built || red.length === 0) continue;
    let sealed = file; for (const n of e.names(file)) if (!red.includes(n)) sealed = e.disable(sealed, n) ?? sealed;
    return { targetRel, file: sealed, cases: red, fn: spec.fn, types: [...new Set(spec.cases.filter((c) => red.some((n) => n.endsWith(`_${c.id}`))).map((c) => c.type))] };
  }
  return null;
}

// ---------- the author: atoms -> one call -> base red filter -> selection ----------
export interface ExecSpecPlan { runner: SpecRunner; targetRel: string; header: string; mustStart: string; style: string }
/** Where the spec file goes and what it must start with: Go in the package of the first resolved site (in-package, so unexported
 *  names are reachable); pytest and vitest beside an existing test of that runner, else beside the first site. */
export function planFor(runner: SpecRunner, repoDir: string, sites: ResolvedSite[], existingTests: string[]): ExecSpecPlan | null {
  const first = sites[0]; if (!first) return null;
  const read = (p: string): string => { try { return readFileSync(join(repoDir, p), "utf8"); } catch { return ""; } };
  if (runner === "go") {
    const goSite = sites.find((s) => s.file.endsWith(".go")); if (!goSite) return null;
    const pkg = /^package\s+(\w+)/m.exec(read(goSite.file))?.[1]; if (!pkg) return null;
    const dir = dirname(goSite.file), style = existingTests.find((t) => dirname(t) === dir && t.endsWith("_test.go"));
    return { runner, targetRel: join(dir, EMITTERS.go.fileName), header: `The file starts with: package ${pkg}`, mustStart: `package ${pkg}`, style: style ? read(style) : "" };
  }
  const ext = runner === "pytest" ? /\.py$/ : /\.(ts|tsx|js|mjs|jsx)$/, site = sites.find((s) => ext.test(s.file)); if (!site) return null;
  const style = existingTests.find((t) => (runner === "pytest" ? /\.py$/ : /\.(test|spec)\.[cm]?[jt]sx?$/).test(t));
  const dir = style ? dirname(style) : dirname(site.file), targetRel = join(dir, EMITTERS[runner].fileName);
  if (runner === "pytest") return { runner, targetRel, header: `The file is ${targetRel}; the code under test is in ${site.file}.`, mustStart: "", style: style ? read(style) : "" };
  let spec = relative(dir, site.file).replace(/\.(ts|tsx|js|mjs|jsx)$/, ""); if (!spec.startsWith(".")) spec = `./${spec}`;
  return { runner, targetRel, header: `The file is ${targetRel}; import the code under test from "${spec}".`, mustStart: "", style: style ? read(style) : "" };
}

export interface ExecSpecOutcome { status: "sealed" | "advisory_only" | "skipped"; reason: string; runner?: SpecRunner; targetRel?: string; file?: string; brief?: string; atoms: number; sites: number; binding: string[]; advisory: string[]; guards: string[]; dropped: string[]; uncoveredSites?: string[]; relation?: RelationOutcome; generatorUsd?: number | null; /** LOKI_E10_TOURNAMENT, Go: the repaired probe cases, the package, the full generated file (binding and advisory) and the named sites no binding case covers */ probe?: string; probeSkip?: string; pkg?: string; specFile?: string; unchecked?: string[]; /** SPEED-EXEC-SPEC-PREFETCH: "hit" when the first generator reply was the one intake started, "miss" when intake started one for another brief */ prefetch?: "hit" | "miss"; durationS: number }
type ExecSpecInput = Parameters<typeof execSpecAuthor>[0];
/** The deterministic start of execSpecAuthor: the runner, the resolved sites, the atoms and where the spec goes, or why the exec spec does not run (with the outcome's extra fields). */
function specPrelude(o: Pick<ExecSpecInput, "task" | "repoDir" | "runners" | "existingTests">): { runner: SpecRunner; atoms0: SpecAtom[]; sites: ResolvedSite[]; atoms: SpecAtom[]; e: Emitter; plan: ExecSpecPlan } | { skip: string; atoms0: SpecAtom[]; extra: Partial<ExecSpecOutcome> } {
  const atoms0 = extractSpecAtoms(o.task), runner = (["go", "pytest", "vitest"] as SpecRunner[]).find((r) => o.runners.includes(r));
  if (!runner) return { skip: "exec spec: no supported runner (go, pytest, vitest)", atoms0, extra: {} };
  const sites = resolveSites(atoms0, o.repoDir);
  if (sites.length === 0) return { skip: "exec spec: no named site resolved in the repo", atoms0, extra: {} };
  const atoms = [...atoms0, ...parityAtoms(atoms0, sites), ...pairAtoms(atoms0, sites)], e = EMITTERS[runner], plan = planFor(runner, o.repoDir, sites, o.existingTests);
  if (!plan) return { skip: `exec spec: no ${runner} site to place the spec beside`, atoms0, extra: { sites: sites.length } };
  if (existsSync(join(o.repoDir, plan.targetRel))) return { skip: `exec spec: ${plan.targetRel} already exists`, atoms0, extra: { sites: sites.length } };
  return { runner, atoms0, sites, atoms, e, plan };
}
/** The generator brief and its output cap for one ask (`withProbe`: the Go probe rules ride along, a larger cap). */
function generatorAsk(pre: { e: Emitter; atoms: SpecAtom[]; sites: ResolvedSite[]; plan: ExecSpecPlan }, probing: ExecSpecInput["probe"] | undefined, withProbe: boolean, repoDir: string): { brief: string; maxTokens?: number } {
  const brief = [buildGeneratorBrief(pre.e, pre.atoms, pre.sites, pre.plan.header, pre.plan.style), ...(withProbe && probing ? [probing.rules, ...(probing.ledger ? [probing.ledger(pre.sites, repoDir)] : [])].filter(Boolean) : [])].join("\n\n");
  return { brief, ...(withProbe && probing ? { maxTokens: 16384 } : {}) }; // a cap, not a typical size: spec plus probe measured 5.3k to 14k output tokens on Haiku
}
/** SPEED-EXEC-SPEC-PREFETCH (LOKI_E10_EXEC_SPEC_PREFETCH=0 opts out): intake starts the first generator call as soon as the repo map and the test map exist, so the model writes the
 *  spec while intake runs the baseline. The Wall stage's call takes it only when its brief, model and cap are byte-identical (the same call, made earlier); any difference makes a fresh
 *  call, so what the spec is built from never changes. The tool-less generator only: a session generator would run a Wall session during intake. One pending call per repo. */
export const execSpecPrefetchOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_EXEC_SPEC_PREFETCH !== "0" && env.LOKI_E10_INVOKER !== "cli" && execSpecEnabled(env);
interface Prefetched { key: string; reply: Promise<string | null | { none: string }>; meter: { usd?: number | null } }
const prefetched = new Map<string, Prefetched>(); // repoDir -> the one pending call
const prefetchKey = (model: string, maxTokens: number | undefined, brief: string): string => `${model}\0${maxTokens ?? ""}\0${brief}`;
/** Starts the call execSpecAuthor's first ask will make, and returns true when it did. Never throws; a prelude that skips starts nothing. */
export function prefetchExecSpec(o: ExecSpecInput, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (!execSpecPrefetchOn(env) || o.signal.aborted) return false;
    const pre = specPrelude(o);
    if ("skip" in pre) return false;
    const probing = pre.runner === "go" ? o.probe : undefined, a = generatorAsk(pre, probing, !!probing, o.repoDir), model = execSpecModel(env), meter: { usd?: number | null } = {};
    const gen = generatorOverride ?? toolLessGenerator(o.repoDir), reply = gen(a.brief, { model, iterationId: o.iterationId, signal: o.signal, meter, ...(a.maxTokens ? { maxTokens: a.maxTokens } : {}) });
    reply.catch(() => { /* awaited by the Wall stage, or dropped */ });
    prefetched.set(o.repoDir, { key: prefetchKey(model, a.maxTokens, a.brief), reply, meter });
    return true;
  } catch { return false; }
}
/** Test seam: forget any pending prefetch. */
export const resetExecSpecPrefetch = (): void => { prefetched.clear(); };
/** `probe` (features/tournament.ts probeIntake, passed by wall.ts only when LOKI_E10_TOURNAMENT is not 0): for Go, its rules are appended to the generator brief and the reply may carry a second block of probe cases, kept apart from the spec. */
export async function execSpecAuthor(o: { task: string; repoDir: string; runners: string[]; existingTests: string[]; sessions: Parameters<typeof sessionGenerator>[0]; iterationId: string; signal: AbortSignal; probe?: { rules: string; /** dynamic lines appended after the rules (the no-regression keep ledger), "" for none */ ledger?(sites: ResolvedSite[], repoDir: string): string; take(reply: string, pkg: string): { reply: string; probe?: string; refused?: string } } }): Promise<ExecSpecOutcome> {
  let priced: number | null | undefined; // the generator call's dollars when it prices itself (toolLessCall); undefined: read from the session's iteration id
  let prefetch: ExecSpecOutcome["prefetch"]; // SPEED-EXEC-SPEC-PREFETCH telemetry
  const t0 = Date.now(), pre0 = specPrelude(o), atoms0 = pre0.atoms0, done = (status: ExecSpecOutcome["status"], reason: string, extra: Partial<ExecSpecOutcome> = {}): ExecSpecOutcome => ({ status, reason, atoms: atoms0.length, sites: 0, binding: [], advisory: [], guards: [], dropped: [], durationS: (Date.now() - t0) / 1000, ...(priced !== undefined ? { generatorUsd: priced } : {}), ...(prefetch ? { prefetch } : {}), ...extra });
  if ("skip" in pre0) { if (prefetched.has(o.repoDir)) prefetch = "miss"; prefetched.delete(o.repoDir); return done("skipped", pre0.skip, pre0.extra); }
  const { runner, sites, atoms, e, plan } = pre0;
  // Relation cases first: deterministic, no model call, binding by construction (recorded on base).
  const rel = runner === "go" ? relationCasesGo(o.task, o.repoDir, sites, atoms) : null, relDir = rel ? dirname(rel.targetRel) : null;
  const relLine = rel ? `Relation cases: ${rel.targetRel} was written by the harness from the wrap relation the task states and is read-only. Each checks that ${rel.fn} treats a wrapped value exactly as it treated the bare value on the original code (recorded there, not guessed); make every one pass: ${rel.cases.join(", ")}` : "";
  const withRel = (r: ExecSpecOutcome): ExecSpecOutcome => {
    if (!rel) return r;
    const gen0 = r.status === "sealed" && r.file && r.targetRel && dirname(r.targetRel) === relDir ? r : null; // one Wall directory per run: a generated spec elsewhere stays advisory
    const binding = [...(gen0 ? r.binding : []), ...rel.cases], covered = [gen0?.file ?? "", rel.fn, ...rel.types].join("\n"), resolved = new Set(sites.map((x) => x.symbol)); // a relation case covers its function and the type it wraps
    const uncov = capSites(atoms.filter((a) => a.kind === "site" && resolved.has(a.text)).map((a) => a.text.split(".").pop()!), o.task).filter((x) => !new RegExp(`\\b${esc(x)}\\b`).test(covered));
    return { ...r, status: "sealed", reason: `exec spec: ${binding.length} binding case(s) red on base (${rel.cases.length} relation)`, runner: "go", binding, uncoveredSites: uncov, brief: [relLine, r.brief ?? ""].filter(Boolean).join("\n"), relation: rel, ...(gen0 ? {} : { file: undefined, targetRel: undefined }) };
  };
  const gen = generatorOverride ?? defaultGenerator(o.sessions, o.repoDir);
  const probing = runner === "go" ? o.probe : undefined, pkg = plan.mustStart.replace(/^package\s+/, "");
  const ask = async (withProbe: boolean): Promise<string | null | { none: string }> => {
    const a = generatorAsk({ e, atoms, sites, plan }, probing, withProbe, o.repoDir), model = execSpecModel(), early = prefetched.get(o.repoDir);
    prefetched.delete(o.repoDir); // taken or stale: never reused by a later ask
    const hit = early && early.key === prefetchKey(model, a.maxTokens, a.brief) ? early : null;
    if (early) prefetch = hit ? "hit" : "miss";
    let meter: { usd?: number | null } = {}, r: string | null | { none: string };
    if (hit) { r = await hit.reply.catch(() => null); meter = hit.meter; }
    else r = await gen(a.brief, { model, iterationId: o.iterationId, signal: o.signal, meter, ...(a.maxTokens ? { maxTokens: a.maxTokens } : {}) });
    if (meter.usd !== undefined) priced = priced === null || meter.usd === null ? null : (priced ?? 0) + meter.usd;
    return r;
  };
  let reply0 = await ask(!!probing), taken = probing && typeof reply0 === "string" ? probing.take(reply0, pkg) : null;
  let parsed = typeof reply0 === "string" ? parseGenerated(e, taken ? taken.reply : reply0, plan.mustStart) : null;
  let probeSkip: string | undefined;
  if (probing && (!parsed || "refused" in parsed)) { // a probe never costs the run its spec: ask again for the spec alone, as without the tournament
    probeSkip = `the combined spec and probe reply was unusable (${!parsed ? (reply0 && typeof reply0 === "object" ? reply0.none : "no reply") : parsed.refused}); the spec was asked for again without the probe`;
    taken = null; reply0 = await ask(false);
    parsed = typeof reply0 === "string" ? parseGenerated(e, reply0, plan.mustStart) : null;
  }
  if (reply0 === null || typeof reply0 !== "string" || !parsed) return withRel(done("skipped", `exec spec: ${reply0 ? (reply0 as { none: string }).none : "the generator wrote no reply"}`, { sites: sites.length, runner }));
  if ("refused" in parsed) return withRel(done("skipped", `exec spec: ${parsed.refused}`, { sites: sites.length, runner }));
  const base = redFilter(e, o.repoDir, plan.targetRel, parsed.file);
  if (!base.built) return withRel(done("skipped", "exec spec: the generated file did not build on the base tree; it proves nothing and was dropped", { sites: sites.length, runner, dropped: e.names(parsed.file) }));
  const sel = selectCases(e, parsed.file, base, o.task), dropped = e.names(parsed.file).filter((n) => base.cases[n] === "error" || base.cases[n] === undefined);
  let binding = sel.binding;
  if (binding.length) { // the pruned file is what gets sealed: confirm on base that it still builds and every kept case is still red
    const again = redFilter(e, o.repoDir, plan.targetRel, sel.file);
    if (!again.built || binding.some((n) => again.cases[n] !== "red")) { sel.advisory.push(...binding.map((name) => ({ name, why: "red on base alone, not once pruned" }))); binding = []; }
  }
  const brief = implementBlock(e, plan.targetRel, { ...sel, binding }, parsed.file, atoms, sites), extra = { runner, targetRel: plan.targetRel, sites: sites.length, brief, binding, advisory: sel.advisory.map((a) => a.name), guards: sel.guards, dropped, uncoveredSites: capSites(uncoveredSites(e, binding, parsed.file, atoms, sites), o.task), ...(probing ? { pkg, specFile: parsed.file, unchecked: uncoveredSites(e, binding, parsed.file, atoms, sites), ...(taken?.probe ? { probe: taken.probe } : { probeSkip: probeSkip ?? taken?.refused ?? "probe_no_block" }) } : {}) };
  return withRel(binding.length ? done("sealed", `exec spec: ${binding.length} binding case(s) red on base`, { ...extra, file: sel.file }) : done("advisory_only", "exec spec: no binding case red on base; advisory cases only", extra));
}

/** implement.ts reads this: the exec-spec brief block the Wall stage left for this run, or null. */
export function execSpecBriefOf(runDir: string, env: NodeJS.ProcessEnv = process.env): string | null { if (!execSpecEnabled(env)) return null; try { const t = readFileSync(join(runDir, EXEC_SPEC_BRIEF_FILE), "utf8").trim(); return t || null; } catch { return null; } }
