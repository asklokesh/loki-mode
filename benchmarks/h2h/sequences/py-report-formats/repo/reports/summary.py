"""Sales records and the per-region summary that every exporter renders."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Sale:
    region: str
    product: str
    units: int
    unit_price_cents: int


@dataclass(frozen=True)
class SummaryRow:
    region: str
    units: int
    revenue_cents: int


def summarize(sales):
    """One SummaryRow per region, sorted by region name."""
    totals = {}
    for sale in sales:
        units, cents = totals.get(sale.region, (0, 0))
        totals[sale.region] = (units + sale.units, cents + sale.units * sale.unit_price_cents)
    return [SummaryRow(region, units, cents) for region, (units, cents) in sorted(totals.items())]


def format_cents(cents):
    """Integer cents as a plain decimal string: 123450 -> '1234.50'."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
