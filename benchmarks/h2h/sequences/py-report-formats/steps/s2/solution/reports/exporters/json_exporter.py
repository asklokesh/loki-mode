"""JSON exporter."""

import json

from ..summary import format_cents


def export_json(rows):
    """A JSON array of {region, units, revenue} objects, indented by 2, ending with a newline."""
    data = [
        {"region": row.region, "units": row.units, "revenue": format_cents(row.revenue_cents)}
        for row in rows
    ]
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"
