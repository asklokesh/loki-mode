"""Plain-text table exporter."""

from ..summary import format_cents


def export_text(rows):
    """Fixed-width table: region left-aligned in 12 columns, units and revenue right-aligned in 8 and 12."""
    lines = [f"{'REGION':<12}{'UNITS':>8}{'REVENUE':>12}"]
    for row in rows:
        lines.append(f"{row.region:<12}{row.units:>8}{format_cents(row.revenue_cents):>12}")
    return "\n".join(lines) + "\n"
