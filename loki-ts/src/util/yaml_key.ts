// loki-ts/src/util/yaml_key.ts -- a two-level yaml key reader (no YAML dependency).
// yamlKey(text, "budgets", "run_cap_s") reads `budgets:` then `  run_cap_s: v`. Only a key at the
// block's FIRST-CHILD indent counts, so `budgets.per_stage.run_cap_s` (a deeper key of the same
// name) is ignored. CRLF is normalized; a trailing comment is stripped; quotes are removed.
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function yamlKey(text: string, parent: string, key: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
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
    const v = kv[1]!.replace(/(^|[ \t]+)#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
    return v === "" ? null : v;
  }
  return null;
}
