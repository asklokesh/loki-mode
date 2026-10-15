def line_total(unit_price, qty, discount_pct):
    gross = unit_price * qty
    return gross - gross * discount_pct / 100.0


def with_tax(amount, tax_pct):
    return round(amount * (1 + tax_pct / 100.0), 2)
