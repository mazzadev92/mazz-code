"""Shopping cart."""

from .pricing import unit_price_ht, unit_price_ttc

FREE_SHIPPING_FROM = 50.0
SHIPPING = 4.9


def cart_total_ht(lines):
    return round(sum(unit_price_ht(p) * qty for p, qty in lines), 2)


def cart_total_ttc(lines):
    total = sum(unit_price_ttc(p) * qty for p, qty in lines)
    if total < FREE_SHIPPING_FROM:
        total += SHIPPING
    return round(total, 2)
