'use strict';
// loki-seal delivery contract (D45, A-04c).
//
// Design. A green suite only proves the existing tests pass, not that the user's request was
// delivered. This module derives a "delivery contract" from the user's request and the Stop hook
// refuses "done" while a contract item has no passing test tied to it. Deterministic, no model
// calls, no network.
//
// 1. Source. The hook input carries transcript_path (JSONL). The FIRST user message with text is the
//    request. Local spec files it names (.md .txt .rst .adoc, relative or absolute, resolved against
//    the repo root, must stay inside the root, max 200 KB, max 5 files) are read too. URLs and bare
//    issue references (#123) are never fetched.
//    A spec file is read ONLY when the request marks it ("spec: x.md", "per x.md", "implement x.md").
// 2. Items. A line is an acceptance item when it is a bullet or checkbox ("-", "*", "+", "1."), or
//    when a sentence contains must / shall / needs to / has to / required / cannot. Conversational
//    should / make sure / never, pasted output and question-style requests are not requirements.
//    Items need 2+ keywords. Under-derive: when in doubt, "no contract" (exit 0), never a block.
//    Markers are stripped, duplicates dropped, at most 30 items. Contract blocks use their own
//    release counter (cblocks) so they cannot drain the integrity valve.
// 3. Keywords. Item text is lowercased and split on non-alphanumerics, camelCase and snake_case.
//    Stopwords and modal words are dropped; a light stemmer folds plurals and -ing/-ed. An item
//    with no keyword left carries no checkable meaning and is ignored.
// 4. Mapping. Test names (it/test/describe titles, def test_x, func TestX, plus the file name) are
//    tokenised the same way. An item is covered by a test sharing at least min(n, 2) and at least
//    ceil(n/2) of its n keywords, and the test body must contain an assertion. An item with no
//    covering test is UNMATCHED.
// 5. Verdicts (decided by the caller): no items = "NOT VERIFIED: no contract"; unreadable or missing
//    transcript = NOT VERIFIED with the reason (never throws); any UNMATCHED item or a covering test
//    that is failing = NOT VERIFIED naming the item.
const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 30;
const MAX_SPEC_FILES = 5;
const MAX_SPEC_BYTES = 200 * 1024;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

const BULLET = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;
// Prose only counts with strong modals. Conversational should / make sure / never / ensure are NOT requirements.
const MODAL = /\b(?:must|shall|needs?\s+to|has\s+to|have\s+to|required?|cannot)\b/i;
// Requests that ask for an explanation carry no delivery contract.
const QUESTION = /^\s*(?:(?:can|could|would)\s+you\s+|please\s+)?(?:explain|summari[sz]e|describe|what|why|how|where|who|show\s+me|tell\s+me|walk\s+me)\b/i;
// Pasted output (paths, git status, log lines, stack frames) is not a requirement.
const PASTED = /(?:^|\s)(?:modified|deleted|new file|renamed|untracked|error|warn(?:ing)?|info|debug|at):?\s|[\w.-]+\/[\w.-]+\.\w+|\b\w+\.\w{1,4}:\d+|\d{2}:\d{2}:\d{2}|->|=>|^[MADRU?]{1,2}\s+\S/i;
const MIN_KEYWORDS = 2;
// A bare file mention is never a spec. The request must mark it: "spec: x.md", "per x.md", "implement x.md".
const SPEC_MARK = "(?:\\bspec(?:ification)?s?\\s*[:=]\\s*|\\b(?:per|implement|implements|implementing|according\\s+to|as\\s+specified\\s+in)\\s+(?:the\\s+)?(?:spec\\s+(?:in\\s+|at\\s+)?)?)[`\"']?";
const ASSERT = /\bassert\w*\s*[.(]|^\s*assert\s|\bexpect\s*\(|\bself\.assert\w+|\bt\.(?:Error|Fatal|Fail)\w*\(|\bassert\w*!\s*\(|\brequire\.[A-Z]\w*\(|\bpytest\.raises\s*\(|\.should\b/m;
// One left-to-right scan so quotes inside comments and comment markers inside strings are handled
// correctly. Comments (// , # , /* ... */ multi-line) and Python triple-quoted strings (multi-line) are
// removed; quoted literals become "". With keep=true the output has the same length (noise blanked,
// string literals kept) so declaration positions and names survive.
// A / starts a regex literal (not a division) after an operator, an opening bracket, a separator, a
// regex-preceding keyword or at the start of the file.
function regexAllowed(out) {
  const t = out.replace(/\s+$/, '');
  if (!t) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(t)) return true;
  return /(?:^|[^\w$.])(?:return|typeof|case|in|of|else|do|void|throw|delete|new|yield|await)$/.test(t);
}
function lex(s, keep) {
  const blank = (t) => t.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    let end = -1;
    if (c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      end = j < 0 ? n : j + 2;
      out += keep ? blank(s.slice(i, end)) : ' ';
    } else if ((c === '/' && s[i + 1] === '/') || (c === '#' && s[i + 1] !== '[' && (i === 0 || /\s/.test(s[i - 1])))) {
      const j = s.indexOf('\n', i);
      end = j < 0 ? n : j;
      if (keep) out += blank(s.slice(i, end));
    } else if ((c === '"' || c === "'") && s[i + 1] === c && s[i + 2] === c) {
      const j = s.indexOf(c + c + c, i + 3);
      end = j < 0 ? n : j + 3;
      out += keep ? blank(s.slice(i, end)) : '""';
    } else if (c === '`') {
      // Template literal: may span lines; ${...} holds code but is treated as part of the literal.
      let k = i + 1;
      let depth = 0;
      while (k < n && !(s[k] === '`' && depth === 0)) {
        if (s[k] === '\\') k++;
        else if (s[k] === '$' && s[k + 1] === '{') { depth++; k++; } else if (s[k] === '}' && depth > 0) depth--;
        k++;
      }
      if (k < n) { end = k + 1; out += keep ? s.slice(i, end) : '""'; }
    } else if (c === '/' && regexAllowed(out)) {
      // Regex literal: one line, / inside a [class] or after a backslash does not close it.
      let k = i + 1;
      let cls = false;
      while (k < n && s[k] !== '\n' && (cls || s[k] !== '/')) {
        if (s[k] === '\\') k++;
        else if (s[k] === '[') cls = true;
        else if (s[k] === ']') cls = false;
        k++;
      }
      if (k < n && s[k] === '/') {
        while (k + 1 < n && /[a-z]/i.test(s[k + 1])) k++;
        end = k + 1;
        out += keep ? s.slice(i, end) : '""';
      }
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && s[k] !== c && s[k] !== '\n') { if (s[k] === '\\') k++; k++; }
      if (k < n && s[k] === c) { end = k + 1; out += keep ? s.slice(i, end) : '""'; }
    }
    if (end < 0) { out += c; i++; } else i = end;
  }
  return out;
}
const stripNoise = (s) => lex(s, false);
// Prose that is chat, not a requirement on the system: a sentence that opens with I, I'm, I've, I'll, I'd,
// we, we're, we've, we'll, let me or let's, a tool-version note ("Node 20 is required"), or a status ("needs to be done").
// Deliberately narrow: words like before, by, release, version, you and ci appear in real promises.
const CHAT = /^\s*(?:i|i'm|i've|i'll|i'd|we|we're|we've|we'll|let\s+me|let's)\b|^\s*(?:node(?:js)?|npm|yarn|pnpm|python\d*|pip|java|jdk|ruby|golang|cargo)\s+v?\d|\b(?:be|get)\s+(?:done|finished|ready|merged|fixed)\b/i;
const STOP = new Set(('a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those ' +
  'must should shall need needs has have had do does did not no can cannot will would could may might make sure ensure require required requires ' +
  'please also just so too very any all each every some there their they them we you i me my our your when where which who what how than into ' +
  'about over under up out only own same such via per new support supports').split(/\s+/));

function stem(w) {
  if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
  if (w.length > 4 && /ed$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(?:ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

function keywords(text, dropStop = true) {
  const parts = String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    const s = stem(p);
    if (s.length > 1 && !(dropStop && (STOP.has(p) || STOP.has(s)))) out.add(s);
  }
  return [...out];
}

function extractItems(text, filtered) {
  const items = [];
  let inFence = false;
  for (const raw of String(text).split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const b = BULLET.exec(raw);
    if (b) { if (!PASTED.test(b[1]) && b[1].length <= 160) items.push(b[1].trim()); continue; }
    if (PASTED.test(raw)) continue;
    // Prose: split into sentences and keep those with a modal verb.
    for (const s0 of raw.split(/(?<=[.!?])\s+|;\s+|,\s+(?=(?:and\s+)?(?:please|can|could|would)\b)/i)) {
      const s = s0.trim();
      if (!(MODAL.test(s) && s.length > 3)) continue;
      if (CHAT.test(s)) { if (Array.isArray(filtered) && keywords(s).length >= MIN_KEYWORDS) filtered.push(s.replace(/\s+/g, ' ').slice(0, 120)); } else items.push(s);
    }
  }
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const t = it.replace(/\s+/g, ' ').slice(0, 200);
    const k = t.toLowerCase();
    if (seen.has(k) || keywords(t).length < MIN_KEYWORDS) continue; // under-derive: 1-keyword items are too vague to block on
    seen.add(k);
    out.push(t);
  }
  return out;
}

function firstUserText(raw) {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || (e.type !== 'user' && !(e.message && e.message.role === 'user')) || e.isMeta) continue;
    const c = e.message ? e.message.content : e.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '';
    // Skip harness-injected pseudo messages (command caveats, system reminders) and empty ones.
    if (text.trim() && !/^\s*<(?:local-command|command-name|system-reminder|user-prompt-submit-hook)/.test(text)) return text;
  }
  return null;
}

function readCapped(file, max) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    let s = buf.toString('utf8', 0, n);
    if (st.size > max) s = s.slice(0, s.lastIndexOf('\n') + 1); // drop a possibly cut last line
    return s;
  } finally { fs.closeSync(fd); }
}

function specFiles(text, root) {
  const found = [];
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return found; }
  // Only a path directly after a spec marker is read; a bare mention (for example "fix the typo in README.md") never is.
  const rx = new RegExp(SPEC_MARK + '((?:\\.{0,2}\\/)?(?:[\\w.@-]+\\/)*[\\w.@-]+\\.(?:md|txt|rst|adoc))(?=$|[\\s)"\'`>\\],.:;])', 'gi');
  for (const m of text.matchAll(rx)) {
    if (found.length >= MAX_SPEC_FILES) break;
    if (/:\/\//.test(m[1])) continue;
    try {
      const real = fs.realpathSync(path.resolve(root, m[1]));
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
      if (found.some((f) => f.real === real)) continue;
      const st = fs.statSync(real);
      if (!st.isFile() || st.size > MAX_SPEC_BYTES) continue;
      found.push({ real, rel: path.relative(realRoot, real) });
    } catch { /* missing or unreadable spec path: ignore */ }
  }
  return found;
}

// Never throws. status: 'ok' (items.length > 0) | 'none' (no contract) | 'unreadable' (reason).
function deriveContract(input, root) {
  try {
    const tp = input && input.transcript_path;
    if (typeof tp !== 'string' || !tp) return { status: 'unreadable', reason: 'no transcript_path in hook input', items: [] };
    let raw;
    try { raw = readCapped(tp, MAX_TRANSCRIPT_BYTES); } catch (e) { return { status: 'unreadable', reason: `transcript not readable (${e.code || e.message})`, items: [] }; }
    const text = firstUserText(raw);
    if (text === null) return { status: 'none', items: [], sources: [] };
    const sources = ['request'];
    if (QUESTION.test(text)) return { status: 'none', items: [], sources, filtered: [] };
    const filtered = [];
    let all = extractItems(text, filtered);
    for (const f of specFiles(text, root)) {
      try { all = all.concat(extractItems(readCapped(f.real, MAX_SPEC_BYTES), filtered)); sources.push(f.rel); } catch { /* skip unreadable spec */ }
    }
    const seen = new Set();
    const items = all.filter((i) => !seen.has(i.toLowerCase()) && seen.add(i.toLowerCase())).slice(0, MAX_ITEMS);
    return { status: items.length ? 'ok' : 'none', items, sources, filtered };
  } catch (e) {
    return { status: 'unreadable', reason: `contract derivation failed (${(e && e.message) || e})`, items: [] };
  }
}

const SKIP_NAME = /\.(?:skip|todo)\b|^x(?:it|test|describe)\b/;
const SKIP_OPT = /^\s*,\s*\{[^}]*\b(?:skip|todo)\s*(?::(?!\s*false\b)|[,}])/;
const SKIP_BODY = /\bt\.(?:skip|todo)\s*\(|\bpytest\.(?:skip|xfail)\s*\(|\bt\.Skip\w*\s*\(|\bself\.skipTest\s*\(/;
const SKIP_DECO = /@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.(?:skip\w*|expectedFailure))/;

function testNames(files) {
  const out = [];
  const rx = [
    { r: /\b(?:x?it|x?test|x?describe|suite)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)+)\1/g, name: (m) => m[2], js: true },
    { r: /((?:^[ \t]*@[^\n]*\n)*)^[ \t]*(?:async\s+)?def\s+(test_\w+)/gm, name: (m) => m[2], skip: (m) => SKIP_DECO.test(m[1]) },
    { r: /^\s*func\s+(Test\w+)\s*\(/gm, name: (m) => m[1] },
    { r: /((?:#\[[^\]]*\]\s*)+)(?:async\s+)?fn\s+(\w+)/g, name: (m) => m[2], real: (m) => /#\[(?:tokio::)?test\b/.test(m[1]), skip: (m) => /#\[ignore/.test(m[1]) },
  ];
  for (const [p, raw] of Object.entries(files)) {
    if (typeof raw !== 'string' || raw.startsWith('SYMLINK ') || !/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs)$/.test(p)) continue;
    const base = path.basename(p).replace(/\.(test|spec)\.[^.]+$|\.[^.]+$/, '');
    // Comments and docstrings are blanked first (positions kept) so a commented-out test never counts.
    const src = lex(raw, true);
    const decls = [];
    for (const x of rx) {
      for (const m of src.matchAll(x.r)) {
        if (x.real && !x.real(m)) continue;
        const describe = !!x.js && /^x?(?:describe|suite)/.test(m[0]);
        const own = x.js ? SKIP_NAME.test(m[0].split('(')[0]) || SKIP_OPT.test(src.slice(m.index + m[0].length, m.index + m[0].length + 200)) : !!(x.skip && x.skip(m));
        const ls = src.lastIndexOf('\n', m.index - 1) + 1;
        decls.push({ pos: m.index, name: x.name(m), real: !describe, describe, own, indent: m.index - ls });
      }
    }
    decls.sort((a, b) => a.pos - b.pos);
    // A test body runs from its declaration to the next declaration. A test without an assertion proves nothing.
    // A skipped describe skips every declaration nested under it (deeper indentation).
    let skipIndent = null;
    decls.forEach((d, k) => {
      if (skipIndent !== null && d.indent <= skipIndent) skipIndent = null;
      const inSkipped = skipIndent !== null;
      if (d.describe && d.own && !inSkipped) skipIndent = d.indent;
      if (!d.real) return;
      const body = src.slice(d.pos, k + 1 < decls.length ? decls[k + 1].pos : src.length);
      const stripped = stripNoise(body);
      out.push({ name: d.name, file: p, base, asserts: ASSERT.test(stripped), skipped: d.own || inSkipped || SKIP_BODY.test(stripped) });
    });
  }
  return out;
}

// Returns { matched: [{item, tests}], unmatched: [item] }.
function mapContract(items, files) {
  const tests = testNames(files).filter((t) => t.asserts && !t.skipped).map((t) => ({ ...t, kw: new Set(keywords(t.name + ' ' + t.base, false)) }));
  const matched = [];
  const unmatched = [];
  for (const item of items) {
    const kw = keywords(item);
    const need = Math.max(Math.min(kw.length, 2), Math.ceil(kw.length / 2));
    const hit = tests.filter((t) => kw.filter((w) => t.kw.has(w)).length >= need);
    if (hit.length) matched.push({ item, tests: hit.map((t) => t.name) }); else unmatched.push(item);
  }
  return { matched, unmatched };
}

// Test ids the runner reported as PASSED (never skipped, todo, ignored or failed): node TAP and spec,
// pytest -rA, go -v, cargo, jest/vitest check marks. Coverage requires membership here.
function passing(out) {
  const ids = new Set();
  const add = (x) => { if (x) ids.add(x.trim()); };
  for (const m of out.matchAll(/^\s*ok \d+ - (.+?)\s*$/gm)) if (!/\s#\s*(?:SKIP|TODO)\b/i.test(m[1])) add(m[1].replace(/\s+#\s.*$/, ''));
  for (const m of out.matchAll(/^\s*[\u2714\u2713\u221a] (.+?)\s*$/gm)) {
    if (/\s#\s*(?:SKIP|TODO)\b/i.test(m[1])) continue;
    add(m[1].replace(/\s+\(?\d[\d.]*\s?ms\)?$/, '').split(' > ').pop());
  }
  for (const m of out.matchAll(/^PASSED (\S+)/gm)) add(m[1]);
  for (const m of out.matchAll(/^\s*--- PASS: (\S+)/gm)) add(m[1]);
  for (const m of out.matchAll(/^test (\S+) \.\.\. ok$/gm)) add(m[1]);
  return [...ids];
}

module.exports = { passing, deriveContract, mapContract, extractItems, keywords, testNames, ASSERT };
