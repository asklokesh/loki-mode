"""Sales tax for invoices."""

from .money import to_cents


def invoice_tax_cents(lines, rate):
    """Tax in cents for a list of invoice lines at `rate` percent (8.25 means 8.25%)."""
    subtotal = sum(line.qty * line.unit_price for line in lines)
    return to_cents(subtotal * rate / 100)
