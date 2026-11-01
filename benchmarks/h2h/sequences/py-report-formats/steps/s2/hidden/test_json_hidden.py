import json

from reports import Sale, SummaryRow, summarize
from reports.exporters.json_exporter import export_json


def test_json_exact_layout():
    rows = [SummaryRow("west", 4, 3349), SummaryRow("east", 2, 900)]
    assert export_json(rows) == (
        "[\n"
        "  {\n"
        '    "region": "west",\n'
        '    "units": 4,\n'
        '    "revenue": "33.49"\n'
        "  },\n"
        "  {\n"
        '    "region": "east",\n'
        '    "units": 2,\n'
        '    "revenue": "9.00"\n'
        "  }\n"
        "]\n"
    )


def test_json_empty_list():
    assert export_json([]) == "[]\n"


def test_json_round_trips_from_summary():
    sales = [Sale("north", "mug", 10, 12345), Sale("south", "cap", 1, 5)]
    assert json.loads(export_json(summarize(sales))) == [
        {"region": "north", "units": 10, "revenue": "1234.50"},
        {"region": "south", "units": 1, "revenue": "0.05"},
    ]


def test_json_keeps_non_ascii_and_escapes_quotes():
    out = export_json([SummaryRow('Zürich "HQ"', 1, 100)])
    assert '"region": "Zürich \\"HQ\\""' in out
    assert "\\u00fc" not in out


def test_json_key_order_is_region_units_revenue():
    out = export_json([SummaryRow("a", 1, 1)])
    assert out.index('"region"') < out.index('"units"') < out.index('"revenue"')
