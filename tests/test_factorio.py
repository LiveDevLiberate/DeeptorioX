import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import factorio


class ParsingTests(unittest.TestCase):
    def test_entities_and_targets_match_api_shapes(self):
        self.assertEqual(
            factorio.parse_entities(["stone-furnace,1,2,4"]),
            [{"name": "stone-furnace", "anchor": {"x": 1, "y": 2}, "direction": 4}],
        )
        self.assertEqual(
            factorio.parse_targets(["1.5,-2,iron-gear-wheel"], True),
            [{"x": 1.5, "y": -2, "recipe": "iron-gear-wheel"}],
        )

    def test_compact_removes_none_recursively(self):
        self.assertEqual(
            factorio.compact({"a": None, "b": [{"c": None, "d": 1}]}),
            {"b": [{"d": 1}]},
        )

    def test_explicit_help_succeeds(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = factorio.run(["server-status", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("server-status", stderr.getvalue())

    def test_cli_failure_is_json_and_nonzero(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = factorio.run(["unknown-command"])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(stdout.getvalue())["ok"])


class ClientTests(unittest.TestCase):
    def test_rocket_launch_submits_targets_and_job_options(self):
        client = factorio.FactorioClient()
        targets = [{"x": 10, "y": -12}, {"x": 30, "y": 20}]
        with patch.object(client, "submit_action", return_value={"job_id": "launch"}) as submit:
            client.launch_rocket(targets, detach=True, idempotency_key="launch-1")
        submit.assert_called_once_with("launch-rocket", {"targets": targets}, detach=True, idempotency_key="launch-1")

    def test_build_clears_obstacles_by_default(self):
        client = factorio.FactorioClient()
        entities = [{"name": "stone-furnace", "anchor": {"x": 1, "y": 2}}]
        with patch.object(client, "submit_action", return_value={"job_id": "build"}) as submit:
            client.build(entities)
            client.build(entities, clear=False)
        self.assertEqual(submit.call_args_list, [
            unittest.mock.call("build", {"entities": entities, "clear_obstacles": True}),
            unittest.mock.call("build", {"entities": entities, "clear_obstacles": False}),
        ])

    def test_rocket_launch_cli_batches_targets_and_reports_rejection(self):
        for result_ok in [True, False]:
            stdout = io.StringIO()
            job = {"status": "completed", "results": [{"ok": result_ok}]}
            with patch("factorio.submit_action_job", return_value=job) as submit, redirect_stdout(stdout):
                code = factorio.run(["act-launch-rocket", "--target", "10,-12", "--target", "30,20", "--idempotency-key", "launch-1"])
            self.assertEqual(code, 0 if result_ok else 1)
            self.assertEqual(json.loads(stdout.getvalue())["ok"], result_ok)
            submit.assert_called_once_with(factorio.DEFAULT_BASE, "launch-rocket", {"targets": [{"x": 10, "y": -12}, {"x": 30, "y": 20}]}, detach=False, idempotency_key="launch-1")

    def test_observation_route_and_none_compaction(self):
        client = factorio.FactorioClient("http://example.invalid/")
        with patch("factorio.http_request", return_value={"ok": True}) as request:
            response = client.observe_player(inventory_slots=3)
        self.assertEqual(response, {"ok": True})
        request.assert_called_once_with(
            "http://example.invalid",
            "POST",
            "/api/agent/observe/player",
            {"limits": {"inventory_slots": 3, "equipment_slots": None}},
        )

    def test_detached_action_returns_submission(self):
        client = factorio.FactorioClient()
        with patch.object(client, "request", return_value={"job_id": "abc", "status": "queued"}):
            job = client.craft("iron-gear-wheel", 2, detach=True, idempotency_key="key")
        self.assertEqual(job["job_id"], "abc")

    def test_save_management_routes(self):
        client = factorio.FactorioClient()
        with patch.object(client, "request", return_value={"ok": True}) as request:
            client.create_save("automation-test")
            client.save_active_game()
        self.assertEqual(
            request.call_args_list[0].args,
            ("POST", "/api/saves", {"name": "automation-test"}),
        )
        self.assertEqual(
            request.call_args_list[1].args,
            ("POST", "/api/server/save"),
        )

    def test_wait_for_job_reaches_terminal_state(self):
        client = factorio.FactorioClient(poll_interval=0)
        states = [
            {"job_id": "abc", "status": "running"},
            {"job_id": "abc", "status": "completed", "results": [{"ok": True}]},
        ]
        with patch.object(client, "job_status", side_effect=states):
            job = client.wait_for_job("abc")
        self.assertEqual(job["status"], "completed")
        self.assertTrue(factorio.action_job_ok(job))

    def test_action_job_rejects_raw_or_failed_results(self):
        self.assertFalse(factorio.action_job_ok({"status": "completed", "results": ["lua error"]}))
        self.assertFalse(factorio.action_job_ok({"status": "completed", "results": [{"ok": False}]}))

    def test_belt_line_entities_sets_directions(self):
        east = factorio.belt_line_entities({"x": 0, "y": 0}, {"x": 4, "y": 0})
        self.assertEqual(len(east), 5)
        self.assertTrue(all(entity["direction"] == 4 for entity in east))
        north = factorio.belt_line_entities({"x": 0, "y": 5}, {"x": 0, "y": 2})
        self.assertEqual([(entity["x"], entity["y"]) for entity in north], [(0, 5), (0, 4), (0, 3), (0, 2)])
        self.assertTrue(all(entity["direction"] == 0 for entity in north))
        with self.assertRaises(ValueError):
            factorio.belt_line_entities({"x": 0, "y": 0}, {"x": 2, "y": 2})

    def test_wait_until_and_inventory_condition(self):
        client = factorio.FactorioClient(poll_interval=0)
        self.assertEqual(client.wait_until(lambda: "ready"), "ready")
        with self.assertRaises(TimeoutError):
            client.wait_until(lambda: False, timeout=0)
        payload = {"data": {"player": {"inventories": [
            {"slots": [{"name": "iron-plate", "count": 12}]},
        ]}}}
        with patch.object(client, "observe_player", return_value=payload):
            counts = client.wait_for_item("iron-plate", 10)
        self.assertEqual(counts["iron-plate"], 12)

    def test_loader_entity_direction_and_spacing(self):
        cases = [
            ((0, 0), (2, 0), (1, 0, 4)),
            ((2, 0), (0, 0), (1, 0, 12)),
            ((0, 0), (0, 2), (0, 1, 8)),
            ((0, 2), (0, 0), (0, 1, 0)),
        ]
        for source, target, (x, y, direction) in cases:
            entity = factorio.loader_entity({"x": source[0], "y": source[1]}, {"x": target[0], "y": target[1]})
            self.assertEqual((entity["x"], entity["y"], entity["direction"]), (x, y, direction))
        with self.assertRaises(ValueError):
            factorio.loader_entity({"x": 0, "y": 0}, {"x": 1, "y": 0})
        with self.assertRaises(ValueError):
            factorio.loader_entity({"x": 0, "y": 0}, {"x": 2, "y": 2})

    def test_craft_waits_for_products_and_times_out(self):
        client = factorio.FactorioClient(poll_interval=0)
        job = {"status": "completed", "results": [{"ok": True, "energy": 0.5, "products": [
            {"name": "copper-cable", "amount": 2, "type": "item"},
        ]}]}
        with patch.object(client, "inventory_counts", side_effect=[
            {"copper-cable": 0}, {"copper-cable": 0}, {"copper-cable": 2},
        ]), patch.object(client, "submit_action", return_value=job):
            self.assertIs(client.craft("copper-cable", 1), job)
        with patch.object(client, "inventory_counts", return_value={}), \
                patch.object(client, "submit_action", return_value=job):
            with self.assertRaises(TimeoutError):
                client.craft("copper-cable", 1, wait_timeout=0)


if __name__ == "__main__":
    unittest.main()
