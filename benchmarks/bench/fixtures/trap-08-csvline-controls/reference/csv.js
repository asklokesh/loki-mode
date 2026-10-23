function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let i = 0;
  while (true) {
    if (line[i] === '"') {
      i += 1;
      let closed = false;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
          closed = true;
          i += 1;
          break;
        }
        cur += line[i];
        i += 1;
      }
      if (!closed) throw new SyntaxError("unterminated quote");
    }
    while (i < line.length && line[i] !== ",") { cur += line[i]; i += 1; }
    fields.push(cur);
    cur = "";
    if (i >= line.length) break;
    i += 1;
  }
  return fields;
}

module.exports = { parseCsvLine };
