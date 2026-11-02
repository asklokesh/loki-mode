from billing import Invoice


def test_unit_price_with_float_noise_is_exact():
    inv = Invoice("A", 0)
    line = inv.add("Widget", 3, 19.99)
    assert line.unit_cents == 1999
    assert inv.subtotal_cents() == 5997


def test_small_prices_do_not_lose_a_cent():
    inv = Invoice("B", 0)
    assert inv.add("Cable", 1, 0.29).amount_cents == 29
    assert inv.add("Clip", 1, 1.15).amount_cents == 115
    assert inv.subtotal_cents() == 144


def test_unit_price_rounds_half_up_to_cents():
    inv = Invoice("C", 0)
    assert inv.add("Washer", 1, 0.125).unit_cents == 13
    assert inv.add("Spring", 2, 0.125).amount_cents == 26


def test_tax_example_from_report():
    inv = Invoice("D", 8.25)
    inv.add("Widget", 3, 19.99)
    assert inv.subtotal_cents() == 5997
    assert inv.tax_cents() == 495
    assert inv.total_cents() == 6492


def test_tax_half_cent_rounds_up():
    inv = Invoice("E", 5)
    inv.add("Pen", 1, 0.50)
    assert inv.tax_cents() == 3
    assert inv.total_cents() == 53


def test_tax_is_rounded_per_line_then_summed():
    inv = Invoice("F", 5)
    inv.add("Sticker", 1, 0.10)
    inv.add("Badge", 1, 0.10)
    assert inv.tax_cents() == 2
    assert inv.total_cents() == 22


def test_per_line_rounding_beats_rounding_the_sum():
    inv = Invoice("G", 5)
    for name in ("A", "B", "C"):
        inv.add(name, 1, 0.30)
    assert inv.subtotal_cents() == 90
    assert inv.tax_cents() == 6
    assert inv.total_cents() == 96


def test_tenths_sum_cleanly():
    inv = Invoice("H", 10)
    inv.add("Dime", 1, 0.1)
    inv.add("Two dimes", 1, 0.2)
    assert inv.subtotal_cents() == 30
    assert inv.tax_cents() == 3
    assert inv.total_cents() == 33


def test_render_matches_corrected_totals():
    inv = Invoice("INV-7", 8.25)
    inv.add("Widget", 3, 19.99)
    inv.add("Cable", 2, 0.29)
    assert inv.render() == (
        "INVOICE INV-7\n"
        "3 x Widget @ 19.99 = 59.97\n"
        "2 x Cable @ 0.29 = 0.58\n"
        "Subtotal: 60.55\n"
        "Tax (8.25%): 5.00\n"
        "Total: 65.55\n"
    )
