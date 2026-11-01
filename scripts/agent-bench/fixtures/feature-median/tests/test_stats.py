import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import stats  # noqa: E402


class StatsTest(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(stats.mean([1, 2, 3, 4]), 2.5)

    def test_variance(self):
        self.assertEqual(stats.variance([2, 4, 4, 4, 5, 5, 7, 9]), 4.0)

    def test_empty(self):
        with self.assertRaises(ValueError):
            stats.mean([])


if __name__ == '__main__':
    unittest.main()
