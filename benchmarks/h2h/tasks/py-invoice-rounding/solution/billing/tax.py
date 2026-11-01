"""Sales tax for invoices."""

from decimal import ROUND_HALF_UP, Decimal


def line_tax_cents(amount_cents, rate):
    """Tax on one line's amount in cents, rounded half up to a whole cent."""
    tax = Decimal(amount_cents) * Decimal(str(rate)) / 100
    return int(tax.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def invoice_tax_cents(lines, rate):
    """Tax in cents for a list of invoice lines at `rate` percent (8.25 means 8.25%).

    Tax is computed per line on that line's amount in cents, rounded half up to a
    whole cent, and the per-line results are summed."""
    return sum(line_tax_cents(line.amount_cents, rate) for line in lines)
