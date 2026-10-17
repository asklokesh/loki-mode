// loki-ts/src/util/yaml_key.ts -- a two-level yaml key reader (no YAML dependency).
// yamlKey(text, "budgets", "run_cap_s") reads `budgets:` then `  run_cap_s: v`. Only a key at the
// block's FIRST-CHILD indent counts, so `budgets.per_stage.run_cap_s` (a deeper key of the same
// name) is ignored. A one-line flow map (`budgets: { per_run: 5 }`) is read too. CRLF is normalized; a trailing comment is stripped; quotes are removed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The text of each existing, readable loki.yaml then loki.yml in repoDir (unreadable files skipped). { yamlOnly: true } reads loki.yaml only. */
export function lokiYamlTexts(repoDir: string, opts: { yamlOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const f of opts.yamlOnly ? ["loki.yaml"] : ["loki.yaml", "loki.yml"]) {
    const p = join(repoDir, f);
    if (!existsSync(p)) continue;
    try { out.push(readFileSync(p, "utf8")); } catch { /* unreadable */ }
  }
  return out;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const clean = (v: string): string => v.replace(/(^|[ \t]+)#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");

/** The value of `key` in a one-line flow map body ("a: 1, b: 'x,y'"); commas inside quotes do not split. */
function flowKey(body: string, key: string): string | null {
  const parts: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const c of body) {
    if (q) { if (c === q) q = null; cur += c; }
    else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === ",") { parts.push(cur); cur = ""; }
    else cur += c;
  }
  parts.push(cur);
  const want = new RegExp(`^\\s*${esc(key)}\\s*:\\s*(.*)$`);
  for (const part of parts) {
    const kv = want.exec(part);
    if (kv) { const v = clean(kv[1]!); return v === "" ? null : v; }
  }
  return null;
}

export function yamlKey(text: string, parent: string, key: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const flow = new RegExp(`^${esc(parent)}:[ \\t]*\\{(.*)\\}[ \\t]*(?:#.*)?$`);
  for (const l of lines) { const fm = flow.exec(l); if (fm) return flowKey(fm[1]!, key); }
  const head = new RegExp(`^${esc(parent)}:[ \\t]*(?:#.*)?$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const want = new RegExp(`^${esc(key)}:[ \\t]*(.*)$`);
  let indent: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === "" || /^[ \t]*#/.test(l)) continue;
    const m = /^([ \t]+)(\S.*)$/.exec(l);
    if (!m) break; // back at column 0: the parent block ended
    if (indent === null) indent = m[1]!;
    if (m[1] !== indent) continue; // deeper or inconsistent: not a first-child key
    const kv = want.exec(m[2]!);
    if (!kv) continue;
    const v = clean(kv[1]!);
    return v === "" ? null : v;
  }
  return null;
}
