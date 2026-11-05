// Minimal CLI argument parser.
export function parseArgs(argv, defs = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const arg = raw.trim();
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-") {
      positional.push(arg);
      break;
    }
    if (arg.startsWith("--")) {
      const [name, value] = arg.slice(2).split("=", 2);
      if (defs[name] === "string") {
        flags[name] = value !== undefined ? value : argv[++i];
      } else {
        flags[name] = true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true;
      continue;
    }
    positional.push(raw);
  }
  return { flags, positional };
}
