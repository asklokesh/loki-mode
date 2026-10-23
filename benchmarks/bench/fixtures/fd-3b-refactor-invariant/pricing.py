from decimal import Decimal, ROUND_HALF_UP


def invoice_total(items, tax_rate):
    """items: list of (unit_price_str, quantity_int). tax_rate: str like "0.0825"."""
    subtotal = Decimal("0")
    for unit_price, quantity in items:
        if quantity < 0:
            raise ValueError("negative quantity")
        line = (Decimal(unit_price) * quantity).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        subtotal += line
    tax = (subtotal * Decimal(tax_rate)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return subtotal + tax
