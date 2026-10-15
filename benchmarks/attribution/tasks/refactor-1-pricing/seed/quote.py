def quote_total(lines, tax_pct):
    total = 0.0
    for unit_price, qty, discount_pct in lines:
        gross = unit_price * qty
        total += gross - gross * discount_pct / 100.0
    return round(total * (1 + tax_pct / 100.0), 2)
