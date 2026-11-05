// Option name helpers shared by the parser, the usage formatter and the env loader.
export function normalizeName(name) {
  return String(name).trim().replace(/_/g, "-").toLowerCase();
}

export function isLongForm(token) {
  return token.length > 2 && token.startsWith("--");
}

export function isShortCluster(token) {
  return token.length > 1 && token[0] === "-" && token[1] !== "-";
}

export function envKey(prefix, name) {
  return `${prefix}_${normalizeName(name).replace(/-/g, "_").toUpperCase()}`;
}
