"""Invoices made of priced lines with a single sales tax rate."""

from .money import format_cents, to_cents
from .tax import invoice_tax_cents


class Line:
    def __init__(self, description, qty, unit_price):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self.description = description
        self.qty = qty
        self.unit_price = unit_price

    @property
    def unit_cents(self):
        return to_cents(self.unit_price)

    @property
    def amount_cents(self):
        return self.qty * self.unit_cents


class Invoice:
    def __init__(self, number, tax_rate):
        self.number = number
        self.tax_rate = tax_rate
        self.lines = []

    def add(self, description, qty, unit_price):
        line = Line(description, qty, unit_price)
        self.lines.append(line)
        return line

    def subtotal_cents(self):
        return sum(line.amount_cents for line in self.lines)

    def tax_cents(self):
        return invoice_tax_cents(self.lines, self.tax_rate)

    def total_cents(self):
        return self.subtotal_cents() + self.tax_cents()

    def render(self):
        out = [f"INVOICE {self.number}"]
        for line in self.lines:
            out.append(
                f"{line.qty} x {line.description} @ {format_cents(line.unit_cents)}"
                f" = {format_cents(line.amount_cents)}"
            )
        out.append(f"Subtotal: {format_cents(self.subtotal_cents())}")
        out.append(f"Tax ({self.tax_rate:g}%): {format_cents(self.tax_cents())}")
        out.append(f"Total: {format_cents(self.total_cents())}")
        return "\n".join(out) + "\n"
