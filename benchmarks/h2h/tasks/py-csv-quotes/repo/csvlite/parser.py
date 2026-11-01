"""A tiny CSV reader for config exports. One record per line, no embedded newlines."""


def parse_line(line: str) -> list[str]:
    fields: list[str] = []
    buf = ""
    in_quotes = False
    for ch in line:
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == "," and not in_quotes:
            fields.append(buf.strip())
            buf = ""
        else:
            buf += ch
    if buf:
        fields.append(buf.strip())
    return fields


def parse_text(text: str) -> list[dict[str, str]]:
    """Parses a header line plus records into dicts keyed by the header names."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return []
    header = parse_line(lines[0])
    return [dict(zip(header, parse_line(ln))) for ln in lines[1:]]
