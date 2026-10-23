function isPlain(v) {
  if (v === null || typeof v !== "object") return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlain(v)) return deepMerge({}, v);
  return v;
}

function deepMerge(a, b) {
  const out = {};
  for (const k of Object.keys(a)) {
    if (k === "__proto__") continue;
    out[k] = clone(a[k]);
  }
  for (const k of Object.keys(b)) {
    if (k === "__proto__") continue;
    if (isPlain(b[k]) && isPlain(out[k])) out[k] = deepMerge(out[k], b[k]);
    else out[k] = clone(b[k]);
  }
  return out;
}

module.exports = { deepMerge };
