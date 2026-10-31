"""Fuel dock sales."""


def sales_for_month(store, month):
    """The month's sales ("2026-09"), oldest first."""
    return sorted((s for s in store.fuel_sales() if s.date.startswith(month)), key=lambda s: s.date)


def sale_cents(sale):
    return round(sale.litres * sale.price_cents_per_litre)
