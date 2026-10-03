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
// 2. Items. A line is an acceptance item when it is a bullet or checkbox ("-", "*", "+", "1."), or
//    when a sentence contains must / should / shall / needs to / has to / ensure / make sure /
//    required / cannot / never. Markers are stripped, duplicates dropped, at most 30 items.
// 3. Keywords. Item text is lowercased and split on non-alphanumerics, camelCase and snake_case.
//    Stopwords and modal words are dropped; a light stemmer folds plurals and -ing/-ed. An item
//    with no keyword left carries no checkable meaning and is ignored.
// 4. Mapping. Test names (it/test/describe titles, def test_x, func TestX, plus the file name) are
//    tokenised the same way. An item is covered by a test sharing at least min(n, 2) and at least
//    ceil(n/2) of its n keywords. An item with no covering test is UNMATCHED.
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
const MODAL = /\b(?:must|should|shall|needs?\s+to|has\s+to|have\s+to|ensure|make\s+sure|required?|cannot|can't|never)\b/i;
const STOP = new Set(('a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those ' +
  'must should shall need needs has have had do does did not no can cannot will would could may might make sure ensure require required requires ' +
  'please also just so too very any all each every some there their they them we you i me my our your when where which who what how than into ' +
  'about over under up out only own same such via per new add adds added support supports').split(/\s+/));

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

function extractItems(text) {
  const items = [];
  let inFence = false;
  for (const raw of String(text).split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const b = BULLET.exec(raw);
    if (b) { items.push(b[1].trim()); continue; }
    // Prose: split into sentences and keep those with a modal verb.
    for (const s of raw.split(/(?<=[.!?])\s+/)) if (MODAL.test(s) && s.trim().length > 3) items.push(s.trim());
  }
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const t = it.replace(/\s+/g, ' ').slice(0, 200);
    const k = t.toLowerCase();
    if (seen.has(k) || keywords(t).length === 0) continue;
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
  const rx = /(?:^|[\s("'`<\[=])((?:\.{0,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(?:md|txt|rst|adoc))(?=$|[\s)"'`>\],.:;])/g;
  for (const m of text.matchAll(rx)) {
    if (found.length >= MAX_SPEC_FILES) break;
    if (/:\/\/\S*$/.test(text.slice(Math.max(0, m.index - 200), m.index + 1))) continue; // part of a URL
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
    let all = extractItems(text);
    for (const f of specFiles(text, root)) {
      try { all = all.concat(extractItems(readCapped(f.real, MAX_SPEC_BYTES))); sources.push(f.rel); } catch { /* skip unreadable spec */ }
    }
    const seen = new Set();
    const items = all.filter((i) => !seen.has(i.toLowerCase()) && seen.add(i.toLowerCase())).slice(0, MAX_ITEMS);
    return { status: items.length ? 'ok' : 'none', items, sources };
  } catch (e) {
    return { status: 'unreadable', reason: `contract derivation failed (${(e && e.message) || e})`, items: [] };
  }
}

function testNames(files) {
  const out = [];
  const rx = [
    /\b(?:it|test|describe|suite)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)+)\1/g,
    /^\s*(?:async\s+)?def\s+(test_\w+)/gm,
    /^\s*func\s+(Test\w+)\s*\(/gm,
    /#\[(?:tokio::)?test\b[^\]]*\]\s*(?:async\s+)?fn\s+(\w+)/g,
  ];
  for (const [p, src] of Object.entries(files)) {
    if (typeof src !== 'string' || src.startsWith('SYMLINK ') || !/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs)$/.test(p)) continue;
    const base = path.basename(p).replace(/\.(test|spec)\.[^.]+$|\.[^.]+$/, '');
    rx.forEach((r, i) => { for (const m of src.matchAll(r)) out.push({ name: m[i === 0 ? 2 : 1], file: p, base }); });
  }
  return out;
}

// Returns { matched: [{item, tests}], unmatched: [item] }.
function mapContract(items, files) {
  const tests = testNames(files).map((t) => ({ ...t, kw: new Set(keywords(t.name + ' ' + t.base, false)) }));
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

module.exports = { deriveContract, mapContract, extractItems, keywords, testNames };
