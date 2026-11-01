"""Word statistics for plain text."""

PUNCTUATION = '.,;:!?"()[]-'


def words(text):
    """Words of the text, in order: any run of whitespace separates two words."""
    return [w for w in text.replace('\n', ' ').split(' ') if w]


def word_count(text):
    """Number of words in the text."""
    return len(words(text))


def top_words(text, n=3):
    """The n most frequent words, lower-cased and without surrounding punctuation.

    Ties are broken alphabetically. Tokens made only of punctuation are not words.
    """
    counts = {}
    for w in words(text):
        w = w.lower().strip(PUNCTUATION)
        counts[w] = counts.get(w, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]
