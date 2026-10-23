function isPlain(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = isPlain(b[k]) && isPlain(a[k]) ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}

module.exports = { deepMerge };
