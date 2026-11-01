"""CSV exporter."""

from ..summary import format_cents


def _csv_field(value):
    text = str(value)
    if any(ch in text for ch in ',"\n'):
        return '"' + text.replace('"', '""') + '"'
    return text


def export_csv(rows):
    """Header region,units,revenue then one line per row; every line ends with a newline."""
    lines = ["region,units,revenue"]
    for row in rows:
        fields = (row.region, row.units, format_cents(row.revenue_cents))
        lines.append(",".join(_csv_field(f) for f in fields))
    return "\n".join(lines) + "\n"
