"""A tiny CSV reader for config exports. One record per line, no embedded newlines."""


def parse_line(line: str) -> list[str]:
    fields: list[str] = []
    buf = ""
    quoted = False  # the current field was a quoted field
    in_quotes = False
    i = 0
    while i < len(line):
        ch = line[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < len(line) and line[i + 1] == '"':
                    buf += '"'
                    i += 1
                else:
                    in_quotes = False
            else:
                buf += ch
        elif ch == '"':
            in_quotes = True
            quoted = True
            buf = ""
        elif ch == ",":
            fields.append(buf if quoted else buf.strip())
            buf = ""
            quoted = False
        elif not quoted:
            buf += ch
        i += 1
    fields.append(buf if quoted else buf.strip())
    return fields


def parse_text(text: str) -> list[dict[str, str]]:
    """Parses a header line plus records into dicts keyed by the header names."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return []
    header = parse_line(lines[0])
    return [dict(zip(header, parse_line(ln))) for ln in lines[1:]]
