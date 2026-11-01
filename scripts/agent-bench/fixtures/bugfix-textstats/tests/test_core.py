import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from textstats import top_words, word_count  # noqa: E402


class TextStatsTest(unittest.TestCase):
    def test_spaces(self):
        self.assertEqual(word_count('un deux  trois'), 3)

    def test_tabs_and_newlines(self):
        self.assertEqual(word_count('un\tdeux\n trois'), 3)

    def test_top_words_ignores_punctuation_tokens(self):
        self.assertEqual(top_words('Le chat -- le chien !', 2), [('le', 2), ('chat', 1)])


if __name__ == '__main__':
    unittest.main()
