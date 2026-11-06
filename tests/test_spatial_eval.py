"""Spatial/geometry evaluation fixtures: direction, path, collision."""
import unittest
from unittest.mock import patch

import factorio


class SpatialEvaluationTests(unittest.TestCase):
    def test_direction_convention_for_loaders(self):
        cases = [
            ((0, 0), (2, 0), 12),
            ((2, 0), (0, 0), 4),
            ((0, 0), (0, 2), 0),
            ((0, 2), (0, 0), 8),
        ]
        for source, target, expected in cases:
            entity = factorio.loader_entity(
                {"x": source[0], "y": source[1]},
                {"x": target[0], "y": target[1]},
            )
            self.assertEqual(entity["direction"], expected)

    def test_path_finds_orthogonal_detour(self):
        route = factorio.plan_grid_route(
            (0, 1), (4, 1),
            rows=[".....", "..#..", "....."],
            origin={"x": 0, "y": 0},
        )
        self.assertEqual(route[0], {"x": 0, "y": 1})
        self.assertEqual(route[-1], {"x": 4, "y": 1})
        self.assertGreater(len(route), 5)
        self.assertTrue(all(col != 2 or row != 1 for row, col in [(t["y"], t["x"]) for t in route]))
        for first, second in zip(route, route[1:]):
            self.assertEqual(abs(first["x"] - second["x"]) + abs(first["y"] - second["y"]), 1)

    def test_collision_check_reports_overlap(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "observe_entity_prototype",
                          return_value={"tile_size": {"width": 3, "height": 3}}), \
                patch.object(client, "observe_placement",
                             return_value={"data": {"results": [{"ok": True}, {"ok": True}]}}):
            result = client.geometry_check([
                {"name": "assembling-machine-2", "anchor": {"x": 0, "y": 0}},
                {"name": "assembling-machine-2", "anchor": {"x": 1, "y": 1}},
            ])
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["overlaps"]), 1)


if __name__ == "__main__":
    unittest.main()
