# Hidden check for bugfix-textstats: run from the task workspace.
import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
from textstats import top_words, word_count, words  # noqa: E402


class Hidden(unittest.TestCase):
    def test_whitespace(self):
        self.assertEqual(word_count('a\t\tb\r\n  c\x0bd'), 4)
        self.assertEqual(words(' x  y '), ['x', 'y'])
        self.assertEqual(word_count(''), 0)

    def test_punctuation(self):
        self.assertEqual(top_words('!! ?? oui, oui. non', 5), [('oui', 2), ('non', 1)])
        self.assertEqual(top_words('b a b a c', 2), [('a', 2), ('b', 2)])


if __name__ == '__main__':
    unittest.main()
