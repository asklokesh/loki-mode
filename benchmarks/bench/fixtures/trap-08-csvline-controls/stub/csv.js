function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "") fields.push(cur);
  return fields;
}

module.exports = { parseCsvLine };
