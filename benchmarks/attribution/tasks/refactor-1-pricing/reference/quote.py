from pricing import line_total, with_tax


def quote_total(lines, tax_pct):
    return with_tax(sum(line_total(*ln) for ln in lines), tax_pct)
