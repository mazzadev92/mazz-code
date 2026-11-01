"""Unit prices and discounts."""

from .tax import rate_for


def unit_price_ht(product):
    price = product['price']
    if product.get('promo'):
        price *= 1 - product['promo']
    return round(price, 2)


def unit_price_ttc(product):
    return round(unit_price_ht(product) * (1 + rate_for(product['category'])), 2)
