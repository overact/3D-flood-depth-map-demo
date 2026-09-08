"""Population units, masking, and clipping regressions; no network access."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np
from rasterio.transform import from_origin

spec = importlib.util.spec_from_file_location("worldpop", Path(__file__).resolve().parents[1] / "tools/fetch_worldpop_population.py")
worldpop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worldpop)


class WorldPopTests(unittest.TestCase):
    def setUp(self):
        self.values = np.ma.array([[10.0, 20.0], [0.0, -99999]], mask=[[0, 0], [0, 1]])
        self.transform = from_origin(152, -31, 1 / 1200, 1 / 1200)
        self.bounds = (152, -31 - 2 / 1200, 152 + 2 / 1200, -31)

    def test_counts_are_conserved_without_turning_nodata_into_zero(self):
        cells, stats, grid = worldpop.build_cells(self.values, self.transform, self.bounds, (0, 0))
        self.assertEqual(sum(c[1] for c in cells), 30)
        self.assertEqual((stats["positiveCells"], stats["zeroCells"], stats["noDataCells"]), (2, 1, 1))
        self.assertEqual((grid["nx"], grid["ny"]), (2, 2))
        self.assertAlmostEqual(cells[1][2] / cells[0][2], 2, places=5)

    def test_partitioned_edge_counts_add_back_to_the_original(self):
        w, s, e, n = self.bounds
        cut = w + 0.5 / 1200
        left, _, _ = worldpop.build_cells(self.values, self.transform, (w, s, cut, n), (0, 0))
        right, _, _ = worldpop.build_cells(self.values, self.transform, (cut, s, e, n), (0, 0))
        self.assertAlmostEqual(sum(c[1] for c in left + right), 30, places=5)
        self.assertAlmostEqual(left[0][1], 5, places=5)
        self.assertEqual(left[0][2], right[0][2]) # clipping changes counts, not density

    def test_unmasked_negative_population_fails(self):
        self.values[0, 0] = -1
        with self.assertRaises(ValueError):
            worldpop.build_cells(self.values, self.transform, self.bounds, (0, 0))


if __name__ == "__main__":
    unittest.main()
