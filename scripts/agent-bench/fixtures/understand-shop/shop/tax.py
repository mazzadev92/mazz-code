"""VAT rates by product category."""

DEFAULT_RATE = 0.20
RATES = {
    'book': 0.055,
    'food': 0.055,
    'medicine': 0.021,
}


def rate_for(category):
    return RATES.get(category, DEFAULT_RATE)
