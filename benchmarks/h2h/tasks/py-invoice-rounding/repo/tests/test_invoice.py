import pytest

from billing import Invoice, format_cents, to_cents


def test_format_cents():
    assert format_cents(1999) == "19.99"
    assert format_cents(5) == "0.05"
    assert format_cents(0) == "0.00"


def test_to_cents_whole_amounts():
    assert to_cents(5) == 500
    assert to_cents(2.5) == 250


def test_round_amount_invoice():
    inv = Invoice("INV-1", 10)
    inv.add("Bolt", 2, 5)
    inv.add("Nut", 4, 2.5)
    assert inv.subtotal_cents() == 2000
    assert inv.tax_cents() == 200
    assert inv.total_cents() == 2200


def test_render_layout():
    inv = Invoice("INV-2", 10)
    inv.add("Bolt", 2, 5)
    assert inv.render() == (
        "INVOICE INV-2\n"
        "2 x Bolt @ 5.00 = 10.00\n"
        "Subtotal: 10.00\n"
        "Tax (10%): 1.00\n"
        "Total: 11.00\n"
    )


def test_qty_must_be_positive():
    with pytest.raises(ValueError):
        Invoice("INV-3", 0).add("Bolt", 0, 1)
