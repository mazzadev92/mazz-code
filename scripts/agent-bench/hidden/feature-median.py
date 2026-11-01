# Hidden check for feature-median: run from the task workspace.
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.getcwd())
import stats  # noqa: E402


class Hidden(unittest.TestCase):
    def test_median(self):
        self.assertEqual(stats.median([3, 1, 2]), 2)
        self.assertEqual(stats.median([4, 1, 3, 2]), 2.5)
        self.assertEqual(stats.median([7]), 7)
        values = [5, 3, 9]
        stats.median(values)
        self.assertEqual(values, [5, 3, 9], 'the input list must not be modified')

    def test_median_empty(self):
        with self.assertRaises(ValueError):
            stats.median([])

    def test_project_tests_cover_median_and_pass(self):
        with open(os.path.join('tests', 'test_stats.py'), encoding='utf-8') as f:
            self.assertIn('median', f.read())
        r = subprocess.run([sys.executable, os.path.join('tests', 'test_stats.py')], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-500:])


if __name__ == '__main__':
    unittest.main()
