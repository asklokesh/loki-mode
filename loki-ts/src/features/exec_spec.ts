// PROTO executable-spec-first (LOKI_E10_EXEC_SPEC=1, off by default). New file: no existing module turns issue text into
// base-red executable checks on the lean path (wall.ts is a blind agentic session the lean path skips; spec_file.ts extracts
// prose clauses only). Fold target if adopted: the lean branch of engine10/stages/wall.ts plus seal.ts failThenPass.
//
// Three steps, only the middle one uses a model:
//   1. extractSpecAtoms: deterministic. Examples (fenced code), expectation claims, named symbols, ranked solution options.
//   2. One tools-free Haiku completion: atoms plus the REAL source of each named symbol (sighted, unlike the Wall) -> one
//      test file whose test names carry the atom id they cover.
//   3. redFilter: run the file on the base tree. A case that fails by assertion is a done-definition and fail-then-pass
//      proof; a case green on base is a regression guard only; a file that does not build proves nothing and is dropped.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const execSpecEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.LOKI_E10_EXEC_SPEC === "1";
export const SPEC_FILE_GO = "loki_spec_test.go";
export const SPEC_TEST_PREFIX = "TestLokiSpec_";

export type AtomKind = "example" | "claim" | "site" | "option" | "location" | "parity";
export interface SpecAtom { id: string; kind: AtomKind; text: string; lang?: string; section?: string }
export interface ResolvedSite { symbol: string; file: string; line: number; source: string; /** whole declaration up to MAX_BODY_LINES, for deterministic scans only */ body?: string }
export interface SpecAtoms { atoms: SpecAtom[]; sites: ResolvedSite[] }

const CODE_LANG = /^(go|golang|ts|typescript|js|javascript|tsx|jsx|py|python|rs|rust|java|console|bash|sh|shell)$/i;
const LOCATION_SECTION = /\b(location|relevant code|current code|source|where)\b/i;
const OPTION_SECTION = /\b(possible solutions?|suggested (?:fix|direction|solution)|proposed (?:fix|solution)s?|options?|alternatives?)\b/i;
const CLAIM = /\binstead of\b|\bends up with\b|\bexits? with\b|\breturns?\b[^.]*`|\bshould\b|\bexpected\b|\bmust\b|==/i;
const IDENT = /^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*(?:\(\))?$/;
const MAX_ATOMS = 16, MAX_SITE_LINES = 45, MAX_BODY_LINES = 400, MAX_SITES = 6, ANCHOR_PAD = 12;

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
    const n = atoms.filter((a) => a.kind === kind).length + 1;
    atoms.push({ id: `${kind === "location" ? "L" : kind === "parity" ? "P" : kind[0]!.toUpperCase()}${n}`, kind, text: text.trim(), ...extra });
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
        if (IDENT.test(b[1]!) && !SRC_EXT.test(sym) && !/\.(md|json|ya?ml|toml|mod)$/.test(sym) && !seenSym.has(sym) && /[A-Z_]|\w\.\w/.test(sym)) { seenSym.add(sym); add("site", sym, { section: head }); }
      }
    }
  }
  return atoms;
}

const SRC_EXT = /\.(go|ts|tsx|js|mjs|py|rs|java)$/;
function sourceFiles(dir: string, root = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules" || e === "vendor" || e === "dist") continue;
    const p = join(dir, e), st = statSync(p);
    if (st.isDirectory()) sourceFiles(p, root, out); else if (SRC_EXT.test(e) && !/_test\.go$|\.test\.|\.spec\./.test(e)) out.push(relative(root, p));
    if (out.length > 4000) break;
  }
  return out;
}

/** A definition of the symbol's last segment, in any of the common declaration shapes. */
function defRe(name: string): RegExp {
  const n = name.replace(/[$]/g, "\\$");
  return new RegExp(`^\\s*(?:func\\s+(?:\\([^)]*\\)\\s*)?${n}\\s*[(\\[]|type\\s+${n}\\b|(?:var|const)\\s+${n}\\b|(?:export\\s+)?(?:async\\s+)?function\\s+${n}\\b|(?:export\\s+)?(?:const|let|class|interface)\\s+${n}\\b|def\\s+${n}\\b|class\\s+${n}\\b|(?:pub\\s+)?fn\\s+${n}\\b)`);
}

/** Resolve site atoms to their definitions in the repo; external symbols (fmt.Errorf) resolve to nothing and stay prose.
 *  Then one hop: a same-file function a resolved site calls is shown too (the issue names Report; the bug may sit in its helper). */
export function resolveSites(atoms: SpecAtom[], repoDir: string): ResolvedSite[] {
  const files = sourceFiles(repoDir), out: ResolvedSite[] = [];
  // distinctive lines of the code the report quotes; a long site shows its head plus a window around the first anchor hit
  const anchors = atoms.filter((a) => a.kind === "location").flatMap((a) => a.text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12 && !l.startsWith("//")));
  const names = atoms.filter((x) => x.kind === "site").map((a) => a.text);
  const tryResolve = (symbol: string, only?: string): void => {
    const name = symbol.split(".").pop()!, re = defRe(name);
    for (const f of only ? [only] : files) {
      const lines = readFileSync(join(repoDir, f), "utf8").split("\n"), i = lines.findIndex((l) => re.test(l));
      if (i < 0) continue;
      let end = i + 1, depth = 0, opened = false; // the declaration through its closing brace, capped at MAX_BODY_LINES
      for (let k = i; k < Math.min(lines.length, i + MAX_BODY_LINES); k++) {
        for (const ch of lines[k]!) { if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--; }
        end = k + 1; if (opened && depth <= 0) break; if (!opened && k > i) break;
      }
      const body = lines.slice(i, end);
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
  for (const n of names) { if (out.length >= MAX_SITES) break; tryResolve(n); }
  for (const s of [...out]) for (const c of s.source.matchAll(/\b([a-zA-Z_]\w*)\(/g)) {
    if (out.length >= MAX_SITES + 3) break;
    if (!out.some((o) => o.symbol.split(".").pop() === c[1]) && /^func\b/.test(s.source.trimStart())) tryResolve(c[1]!, s.file);
  }
  return out;
}

// A normalized copy of an input: Go strings.TrimSpace/ToLower/..., JS .trim()/.toLowerCase(), Python .strip()/.lower().
const NORM_GO = /\b([A-Za-z_]\w*)\s*:?=\s*strings\.(TrimSpace|ToLower|ToUpper|TrimLeft|TrimRight|Trim|TrimPrefix|TrimSuffix)\(\s*([^,()]+?)\s*[,)]/g;
const NORM_DOT = /\b(?:const|let|var)?\s*([A-Za-z_]\w*)\s*=\s*([\w.\[\]]+?)\.(trim|trimStart|trimEnd|toLowerCase|toUpperCase|strip|lower|upper)\(\)/g;
const PERTURB: Record<string, string> = { TrimSpace: "surround it with spaces", Trim: "surround it with the trimmed characters", TrimLeft: "prefix it with the trimmed characters", TrimRight: "suffix it with the trimmed characters", TrimPrefix: "add the trimmed prefix", TrimSuffix: "add the trimmed suffix", ToLower: "give it upper-case letters", ToUpper: "give it lower-case letters", trim: "surround it with spaces", trimStart: "prefix it with spaces", trimEnd: "suffix it with spaces", strip: "surround it with spaces", toLowerCase: "give it upper-case letters", lower: "give it upper-case letters", toUpperCase: "give it lower-case letters", upper: "give it lower-case letters" };
/** Deterministic parity atoms: the code the report quotes reads a normalized copy N of a raw input R, and the enclosing
 *  site passes R itself elsewhere (the sibling branches). The case to cover is the reported situation with the triggering
 *  input perturbed so N and R differ. Fires only when the report quotes code (a location atom) that uses N. */
export function parityAtoms(atoms: SpecAtom[], sites: ResolvedSite[]): SpecAtom[] {
  const locs = atoms.filter((a) => a.kind === "location"), out: SpecAtom[] = [];
  if (!locs.length) return out;
  for (const s of sites) {
    const src = s.body ?? s.source;
    const hits = [...src.matchAll(NORM_GO)].map((m) => ({ n: m[1]!, fn: m[2]!, r: m[3]!.trim() })).concat([...src.matchAll(NORM_DOT)].map((m) => ({ n: m[1]!, fn: m[3]!, r: m[2]!.trim() })));
    for (const h of hits) {
      const nRe = new RegExp(`\\b${h.n}\\b`), rEsc = h.r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rawUses = src.split("\n").filter((l) => new RegExp(rEsc).test(l) && !nRe.test(l)).length;
      if (!locs.some((l) => nRe.test(l.text)) || rawUses === 0 || out.some((o) => o.text.includes(`\`${h.n}\``))) continue;
      out.push({ id: `P${out.length + 1}`, kind: "parity", text: `The quoted code reads \`${h.n}\`, the ${h.fn} copy of \`${h.r}\`, while ${rawUses} other line(s) of ${s.symbol} use \`${h.r}\` itself. Reproduce the reported situation with the input that reaches the quoted code changed so ${h.fn} alters it (${PERTURB[h.fn] ?? "make the normalized and raw forms differ"}), and assert the result the other branches give for raw input.` });
    }
  }
  return out;
}

/** Fixed text first (cache-stable), run-specific text after. */
export const GENERATOR_RULES = [
  "You turn a bug report into a small Go test file that defines done. You cannot run anything; reply with exactly one ```go fenced block and nothing else.",
  `Every test function is named ${SPEC_TEST_PREFIX}<AtomId>_<Short> where <AtomId> is the id of the atom it covers (E1, C2, S3, ...).`,
  "Write one test per example atom, reproducing it and asserting the outcome the report says is correct.",
  "Write one test per site atom whose definition is shown below and that the report says is defective: put that site in the defective situation the report describes, even when the report gives no example for it. A combination the report names in words but never shows is exactly what to cover.",
  "Write one test per parity atom, exactly as it describes: the perturbed input is the one that reaches the quoted code, not some other argument.",
  "Only call identifiers that appear in the definitions or the existing test shown below; never invent helpers the package lacks. Use only the standard library. No t.Skip, no os.Exit, no network, no sleeps.",
  "Assert exact values. A test that would pass before the fix proves nothing.",
].join("\n");

export function buildGeneratorBrief(atoms: SpecAtom[], sites: ResolvedSite[], pkgClause: string, styleSample: string): string {
  const atomLines = atoms.filter((a) => a.kind !== "location").map((a) => `[${a.id}] ${a.kind}${a.section ? ` (section: ${a.section})` : ""}: ${a.kind === "example" ? `\n${a.text}` : a.text}`);
  const siteLines = sites.map((s) => `--- ${s.symbol} at ${s.file}:${s.line}\n${s.source}`);
  return [GENERATOR_RULES, `The file starts with: ${pkgClause}`, `Atoms extracted from the report:\n${atomLines.join("\n")}`, `Definitions of the named sites (current, buggy code):\n${siteLines.join("\n") || "(none resolved)"}`, `Existing test in this package (style and helpers you may reuse):\n${styleSample.slice(0, 2500)}`].join("\n\n");
}

const BANNED = /\bt\.Skip|\bos\.Exit\b|\bnet\/http\b|time\.Sleep/;
/** Pull the go block; refuse anything that cannot serve as a check. Returns the file text or a named refusal. */
export function parseGenerated(reply: string, pkgClause: string): { file: string } | { refused: string } {
  const m = reply.match(/```go\n([\s\S]*?)```/);
  if (!m) return { refused: "exec_spec_no_go_block" };
  const file = m[1]!;
  if (!file.trimStart().startsWith(pkgClause)) return { refused: `exec_spec_wrong_package: expected ${pkgClause}` };
  if (BANNED.test(file)) return { refused: "exec_spec_banned_call" };
  const names = [...file.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((x) => x[1]!);
  if (names.length === 0 || names.some((n) => !n.startsWith(SPEC_TEST_PREFIX))) return { refused: "exec_spec_bad_test_names" };
  return { file };
}

export interface RedFilterResult { built: boolean; red: string[]; green: string[]; buildError?: string; durationS: number }
/** Run the spec file on the tree as it stands; per-test outcome from go test -json. The file is removed afterwards. */
export function redFilterGo(repoDir: string, pkgRel: string, file: string, timeoutMs = 120_000): RedFilterResult {
  const dest = join(repoDir, pkgRel, SPEC_FILE_GO), t0 = Date.now();
  writeFileSync(dest, file, "utf8");
  try {
    const r = spawnSync("go", ["test", "-count=1", "-json", "-run", `^${SPEC_TEST_PREFIX}`, `./${pkgRel || "."}`], { cwd: repoDir, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, GOFLAGS: "-mod=mod" } });
    const red = new Set<string>(), green = new Set<string>(); let buildFail = false; const out: string[] = [];
    for (const line of (r.stdout ?? "").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const ev = JSON.parse(line) as { Action?: string; Test?: string; Output?: string };
        if (ev.Output) out.push(ev.Output);
        if (ev.Test && !ev.Test.includes("/") && ev.Action === "fail") red.add(ev.Test);
        if (ev.Test && !ev.Test.includes("/") && ev.Action === "pass") green.add(ev.Test);
        if (!ev.Test && ev.Action === "fail" && red.size === 0 && green.size === 0) buildFail = true;
      } catch { /* non-JSON build output */ }
    }
    if (red.size + green.size === 0) buildFail = true;
    return { built: !buildFail, red: [...red], green: [...green], ...(buildFail ? { buildError: (r.stdout + (r.stderr ?? "")).slice(-1200) } : {}), durationS: (Date.now() - t0) / 1000 };
  } finally { if (existsSync(dest)) rmSync(dest); }
}

/** Atom ids a red test covers, read from the test names. */
export const coveredAtoms = (red: string[]): Set<string> => new Set(red.map((n) => n.slice(SPEC_TEST_PREFIX.length).split("_")[0]!));

/** The implement brief block: the red tests are what done means; uncovered site atoms are listed as a checklist. */
export function implementBlock(pkgRel: string, red: string[], green: string[], atoms: SpecAtom[], sites: ResolvedSite[], specFile = ""): string {
  const cov = coveredAtoms(red), resolved = new Set(sites.map((s) => s.symbol));
  const redBodies = red.map((n) => specFile.split(new RegExp(`^func ${n}\\(`, "m"))[1]?.split(/^func /m)[0] ?? "").join("\n");
  const unchecked = atoms.filter((a) => a.kind === "site" && resolved.has(a.text) && !cov.has(a.id) && !new RegExp(`\\b${a.text.split(".").pop()}\\b`).test(redBodies)).map((a) => a.text);
  return [
    `Executable spec: ${join(pkgRel, SPEC_FILE_GO)} was written from the task before you started and is read-only. These tests fail on the current code and define done; make every one pass without editing the file:`,
    ...red.map((n) => `- ${n}`),
    ...(green.length ? [`These already pass and must keep passing: ${green.join(", ")}`] : []),
    ...(unchecked.length ? [`Named sites no spec test covers; handle each one the task describes: ${unchecked.join(", ")}`] : []),
    "Run only this package's tests; the harness runs the rest.",
  ].join("\n");
}
