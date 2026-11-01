"""Small descriptive statistics on lists of numbers."""


def mean(values):
    """Arithmetic mean. Raises ValueError on an empty list."""
    if not values:
        raise ValueError('mean of an empty list')
    return sum(values) / len(values)


def variance(values):
    """Population variance. Raises ValueError on an empty list."""
    m = mean(values)
    return sum((v - m) ** 2 for v in values) / len(values)
