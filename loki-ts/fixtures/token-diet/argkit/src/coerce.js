import { SpecError } from "./spec.js";

export function coerce(opt, value) {
  switch (opt.type) {
    case "bool":
      if (value === true || value === "true" || value === "1" || value === "yes") return true;
      if (value === false || value === "false" || value === "0" || value === "no") return false;
      throw new SpecError(`--${opt.name} expects a boolean, got ${value}`);
    case "number": {
      const n = Number(value);
      if (value === "" || Number.isNaN(n)) throw new SpecError(`--${opt.name} expects a number, got ${value}`);
      return n;
    }
    case "list":
      return String(value).split(",").map((s) => s.trim()).filter(Boolean);
    default:
      return String(value);
  }
}

export function assign(values, opt, value) {
  const v = coerce(opt, value);
  if (opt.type === "list") values[opt.name] = [...(values[opt.name] ?? []), ...v];
  else values[opt.name] = v;
}
