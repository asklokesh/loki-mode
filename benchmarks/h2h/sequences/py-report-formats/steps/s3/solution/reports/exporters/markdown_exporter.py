"""Markdown table exporter."""

from ..summary import format_cents


def export_markdown(rows):
    """A Markdown table with a header, an alignment row and one row per SummaryRow."""
    lines = ["| Region | Units | Revenue |", "| --- | ---: | ---: |"]
    for row in rows:
        region = row.region.replace("|", "\\|")
        lines.append(f"| {region} | {row.units} | {format_cents(row.revenue_cents)} |")
    return "\n".join(lines) + "\n"
