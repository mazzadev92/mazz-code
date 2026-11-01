from .cart import cart_total_ttc

CATALOG = {
    'roman': {'price': 18.0, 'category': 'book'},
    'casque': {'price': 59.0, 'category': 'audio', 'promo': 0.1},
}


def demo():
    lines = [(CATALOG['roman'], 1), (CATALOG['casque'], 1)]
    return cart_total_ttc(lines)


if __name__ == '__main__':
    print(demo())
