// An option spec: { name, alias?, type: "bool" | "string" | "number" | "list", default?, describe? }
import { normalizeName } from "./names.js";

export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecError";
  }
}

export function compileSpec(options = []) {
  const byName = new Map();
  const byAlias = new Map();
  for (const raw of options) {
    if (!raw || typeof raw.name !== "string") throw new SpecError("option needs a name");
    const opt = { type: "bool", ...raw, name: normalizeName(raw.name) };
    if (!["bool", "string", "number", "list"].includes(opt.type)) throw new SpecError(`unknown type ${opt.type} for ${opt.name}`);
    if (byName.has(opt.name)) throw new SpecError(`duplicate option ${opt.name}`);
    byName.set(opt.name, opt);
    if (opt.alias) {
      if (opt.alias.length !== 1) throw new SpecError(`alias for ${opt.name} must be one character`);
      if (byAlias.has(opt.alias)) throw new SpecError(`duplicate alias ${opt.alias}`);
      byAlias.set(opt.alias, opt);
    }
  }
  return { byName, byAlias, options: [...byName.values()] };
}

export function defaults(compiled) {
  const out = {};
  for (const opt of compiled.options) {
    if (opt.default !== undefined) out[opt.name] = opt.default;
    else if (opt.type === "bool") out[opt.name] = false;
    else if (opt.type === "list") out[opt.name] = [];
  }
  return out;
}
