"""Exporters turn a list of SummaryRow into one text format each, looked up by name."""

from .csv_exporter import export_csv
from .json_exporter import export_json
from .markdown_exporter import export_markdown
from .text_exporter import export_text

EXPORTERS = {
    "csv": export_csv,
    "json": export_json,
    "markdown": export_markdown,
    "text": export_text,
}


def available_formats():
    return sorted(EXPORTERS)


def export(rows, fmt):
    """Render rows with the exporter registered under fmt (case-insensitive, surrounding spaces ignored)."""
    key = fmt.strip().lower()
    if key not in EXPORTERS:
        raise ValueError(f"unknown format '{fmt}'; expected one of: {', '.join(available_formats())}")
    return EXPORTERS[key](rows)
