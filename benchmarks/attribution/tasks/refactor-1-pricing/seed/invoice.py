def invoice_total(lines, tax_pct):
    subtotal = 0.0
    for unit_price, qty, discount_pct in lines:
        gross = unit_price * qty
        subtotal += gross - gross * discount_pct / 100.0
    return round(subtotal * (1 + tax_pct / 100.0), 2)
