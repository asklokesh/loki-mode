import { compileSpec } from "./spec.js";

export function formatUsage(program, options = [], { width = 80 } = {}) {
  const { options: opts } = compileSpec(options);
  const rows = opts.map((o) => {
    const flags = [o.alias ? `-${o.alias}` : "  ", `--${o.name}${o.type === "bool" ? "" : ` <${o.type}>`}`].join(", ");
    const tail = o.default !== undefined ? ` (default: ${JSON.stringify(o.default)})` : "";
    return [flags, (o.describe ?? "") + tail];
  });
  const pad = Math.min(Math.max(0, ...rows.map((r) => r[0].length)) + 2, Math.floor(width / 2));
  const lines = [`Usage: ${program} [options] [--] [args...]`, "", "Options:"];
  for (const [flags, text] of rows) lines.push(`  ${flags.padEnd(pad)}${wrap(text, width - pad - 2).join("\n" + " ".repeat(pad + 2))}`);
  return lines.join("\n");
}

function wrap(text, width) {
  if (!text) return [""];
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}
