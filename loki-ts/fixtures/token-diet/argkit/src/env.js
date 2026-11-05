import { compileSpec } from "./spec.js";
import { assign } from "./coerce.js";
import { envKey } from "./names.js";

// fromEnv fills option values from environment variables named <PREFIX>_<OPTION>.
export function fromEnv(options, env = process.env, prefix = "ARGKIT") {
  const { options: opts } = compileSpec(options);
  const values = {};
  for (const opt of opts) {
    const raw = env[envKey(prefix, opt.name)];
    if (raw === undefined) continue;
    assign(values, opt, raw);
  }
  return values;
}

export function merge(...layers) {
  return Object.assign({}, ...layers.filter(Boolean));
}
