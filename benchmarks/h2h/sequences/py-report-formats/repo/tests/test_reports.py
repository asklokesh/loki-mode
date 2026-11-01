from reports import Sale, SummaryRow, format_cents, summarize
from reports.exporters.text_exporter import export_text

SALES = [
    Sale("west", "mug", 3, 450),
    Sale("east", "mug", 2, 450),
    Sale("west", "cap", 1, 1999),
]


def test_summarize_groups_by_region_sorted():
    assert summarize(SALES) == [SummaryRow("east", 2, 900), SummaryRow("west", 4, 3349)]


def test_format_cents():
    assert format_cents(123450) == "1234.50"
    assert format_cents(5) == "0.05"


def test_export_text_table():
    assert export_text(summarize(SALES)) == (
        "REGION         UNITS     REVENUE\n"
        "east               2        9.00\n"
        "west               4       33.49\n"
    )


def test_export_text_empty():
    assert export_text([]) == "REGION         UNITS     REVENUE\n"
