import pytest

from reports import SummaryRow
from reports.exporters import EXPORTERS, available_formats, export
from reports.exporters.markdown_exporter import export_markdown

ROWS = [SummaryRow("west", 4, 3349), SummaryRow("east", 2, 900)]


def test_markdown_table():
    assert export_markdown(ROWS) == (
        "| Region | Units | Revenue |\n"
        "| --- | ---: | ---: |\n"
        "| west | 4 | 33.49 |\n"
        "| east | 2 | 9.00 |\n"
    )


def test_markdown_empty_is_header_only():
    assert export_markdown([]) == "| Region | Units | Revenue |\n| --- | ---: | ---: |\n"


def test_markdown_escapes_pipes():
    assert export_markdown([SummaryRow("a|b", 1, 5)]).endswith("| a\\|b | 1 | 0.05 |\n")


def test_available_formats_sorted():
    assert available_formats() == ["csv", "json", "markdown", "text"]


def test_export_dispatches_to_every_exporter():
    from reports.exporters.csv_exporter import export_csv
    from reports.exporters.json_exporter import export_json
    from reports.exporters.text_exporter import export_text

    assert export(ROWS, "markdown") == export_markdown(ROWS)
    assert export(ROWS, "csv") == export_csv(ROWS)
    assert export(ROWS, "json") == export_json(ROWS)
    assert export(ROWS, "text") == export_text(ROWS)
    assert EXPORTERS == {"csv": export_csv, "json": export_json, "markdown": export_markdown, "text": export_text}


def test_export_name_is_case_insensitive_and_trimmed():
    assert export(ROWS, "  CSV ") == export(ROWS, "csv")
    assert export(ROWS, "Markdown") == export_markdown(ROWS)


def test_unknown_format_message():
    with pytest.raises(ValueError) as err:
        export(ROWS, "xml")
    assert str(err.value) == "unknown format 'xml'; expected one of: csv, json, markdown, text"
