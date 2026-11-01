from reports import Sale, SummaryRow, summarize
from reports.exporters.csv_exporter import export_csv


def test_csv_header_and_rows_in_given_order():
    rows = [SummaryRow("west", 4, 3349), SummaryRow("east", 2, 900)]
    assert export_csv(rows) == "region,units,revenue\nwest,4,33.49\neast,2,9.00\n"


def test_csv_from_summary():
    sales = [Sale("north", "mug", 10, 12345), Sale("south", "cap", 1, 5)]
    assert export_csv(summarize(sales)) == "region,units,revenue\nnorth,10,1234.50\nsouth,1,0.05\n"


def test_csv_empty_is_just_the_header():
    assert export_csv([]) == "region,units,revenue\n"


def test_csv_quotes_fields_with_commas():
    assert export_csv([SummaryRow("Portland, OR", 1, 100)]) == 'region,units,revenue\n"Portland, OR",1,1.00\n'


def test_csv_doubles_inner_quotes():
    assert export_csv([SummaryRow('the "big" one', 2, 250)]) == 'region,units,revenue\n"the ""big"" one",2,2.50\n'


def test_csv_quotes_newlines_and_leaves_plain_fields_alone():
    out = export_csv([SummaryRow("a\nb", 1, 1), SummaryRow("plain region", 0, 0)])
    assert out == 'region,units,revenue\n"a\nb",1,0.01\nplain region,0,0.00\n'
