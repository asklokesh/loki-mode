// parseArgs walks argv once, moving options into `values` and everything else into `positionals`.
import { compileSpec, defaults, SpecError } from "./spec.js";
import { assign } from "./coerce.js";
import { isLongForm, isShortCluster, normalizeName } from "./names.js";

export function parseArgs(argv, options = [], settings = {}) {
  const compiled = compileSpec(options);
  const values = defaults(compiled);
  const positionals = [];
  const stopAt = settings.stopAtPositional ?? Infinity;

  for (let rest = [...argv]; rest.length > 0; rest = rest.slice(1)) {
    const token = rest[0];

    if (token === "") {
      positionals.push(token);
      continue;
    }

    // "--" ends option parsing: everything after it is positional.
    if (token === "--") {
      positionals.push(...rest.slice(1));
      return { values, positionals };
    }

    // Stop parsing after N positionals: keep the remainder verbatim.
    if (positionals.length >= stopAt) {
      positionals.push(...rest);
      return { values, positionals };
    }

    if (token[0] !== "-") {
      positionals.push(token);
      continue;
    }

    // a lone "-"
    if (token.length === 1) {
      positionals.push(token);
      break;
    }

    // "-3" and friends are values, not flags: keep the remainder.
    if (!/[A-Za-z]/.test(token[1]) && token[1] !== "-") {
      positionals.push(...rest);
      return { values, positionals };
    }

    if (isLongForm(token)) {
      const eq = token.indexOf("=");
      const name = normalizeName(eq === -1 ? token.slice(2) : token.slice(2, eq));
      const opt = compiled.byName.get(name) ?? (name.startsWith("no-") ? compiled.byName.get(name.slice(3)) : undefined);
      if (!opt) {
        if (settings.allowUnknown) {
          positionals.push(token);
          continue;
        }
        throw new SpecError(`unknown option --${name}`);
      }
      if (opt.type === "bool") {
        const negated = opt.name !== name;
        values[opt.name] = eq === -1 ? !negated : assignBool(opt, token.slice(eq + 1));
        continue;
      }
      if (eq !== -1) {
        assign(values, opt, token.slice(eq + 1));
        continue;
      }
      if (rest.length < 2) throw new SpecError(`--${opt.name} needs a value`);
      assign(values, opt, rest[1]);
      rest = rest.slice(1);
      continue;
    }

    if (isShortCluster(token)) {
      const letters = token.slice(1);
      for (let i = 0; i < letters.length; i++) {
        const opt = compiled.byAlias.get(letters[i]);
        if (!opt) throw new SpecError(`unknown option -${letters[i]}`);
        if (opt.type === "bool") {
          values[opt.name] = true;
          continue;
        }
        const inline = letters.slice(i + 1);
        if (inline) {
          assign(values, opt, inline);
        } else {
          if (rest.length < 2) throw new SpecError(`-${letters[i]} needs a value`);
          assign(values, opt, rest[1]);
          rest = rest.slice(1);
        }
        break;
      }
      continue;
    }
  }

  return { values, positionals };
}

function assignBool(opt, raw) {
  const holder = {};
  assign(holder, opt, raw);
  return holder[opt.name];
}
