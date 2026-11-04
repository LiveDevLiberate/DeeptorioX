import base64
import io
import json
import os
import tempfile
import unittest
import zlib
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import factorio


def blueprint_payload(entities):
    return {
        "blueprint": {
            "item": "blueprint",
            "version": 562949953421312,
            "entities": entities,
        }
    }


def blueprint_text(entities):
    return factorio.encode_blueprint_string(blueprint_payload(entities))


def compressed_payload(data, version_byte=0):
    payload = data if version_byte is None else bytes([version_byte]) + data
    return base64.b64encode(zlib.compress(payload, 9)).decode("ascii")


def belt_blueprint(entity_count):
    """A grid of 1x1 belts in blueprint JSON order (row-major, no gaps)."""
    entities = [
        {
            "entity_number": index + 1,
            "name": "transport-belt",
            "position": {"x": (index % 20) + 0.5, "y": (index // 20) + 0.5},
            "direction": 4,
        }
        for index in range(entity_count)
    ]
    return blueprint_text(entities)


BELT_SIZES = {"transport-belt": {"width": 1, "height": 1}}


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


class BlueprintCodecTests(unittest.TestCase):
    def test_round_trip_is_stable_and_accepts_versioned_and_legacy_strings(self):
        payload = blueprint_payload([
            {"entity_number": 1, "name": "transport-belt",
             "position": {"x": 0.5, "y": 0.5}, "direction": 4},
            {"entity_number": 2, "name": "assembling-machine-2",
             "position": {"x": 10.5, "y": 10.5}, "recipe": "iron-gear-wheel"},
        ])
        text = factorio.encode_blueprint_string(payload)
        self.assertIsInstance(text, str)
        # Canonical Factorio wire format: version character, then base64(zlib(JSON)).
        self.assertTrue(text.startswith(factorio.BLUEPRINT_VERSION_PREFIX))
        self.assertEqual(
            json.loads(zlib.decompress(base64.b64decode(text[1:])).decode("utf-8")), payload)
        self.assertEqual(factorio.decode_blueprint_string(text), payload)
        # Encoding the same payload again is byte-stable.
        self.assertEqual(factorio.encode_blueprint_string(payload), text)
        # Copied strings may carry surrounding whitespace or omitted padding.
        self.assertEqual(factorio.decode_blueprint_string(" \n" + text + "\n"), payload)
        self.assertEqual(factorio.decode_blueprint_string(text.rstrip("=")), payload)
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        # Older version prefixes and versionless third-party strings still decode.
        self.assertEqual(factorio.decode_blueprint_string("1" + compressed_payload(body, version_byte=None)), payload)
        self.assertEqual(factorio.decode_blueprint_string(compressed_payload(body, version_byte=None)), payload)
        # An in-payload version byte (some third-party encoders) is tolerated.
        self.assertEqual(factorio.decode_blueprint_string(compressed_payload(body, version_byte=1)), payload)
        # Bare legacy payloads (no outer "blueprint" wrapper) still decode.
        bare = {"item": "blueprint", "entities": []}
        self.assertEqual(
            factorio.decode_blueprint_string(factorio.encode_blueprint_string(bare)), bare)

    def test_decode_rejects_corrupt_base64_zlib_and_json(self):
        with self.assertRaisesRegex(ValueError, "empty"):
            factorio.decode_blueprint_string("   ")
        with self.assertRaisesRegex(ValueError, "base64"):
            factorio.decode_blueprint_string("not*base64!")
        with self.assertRaisesRegex(ValueError, "zlib"):
            factorio.decode_blueprint_string(base64.b64encode(b"plain text").decode("ascii"))
        with self.assertRaisesRegex(ValueError, "JSON"):
            factorio.decode_blueprint_string(compressed_payload(b"{not json"))
        with self.assertRaisesRegex(ValueError, "JSON"):
            factorio.decode_blueprint_string(
                factorio.BLUEPRINT_VERSION_PREFIX + compressed_payload(b"{not json", version_byte=None))
        with self.assertRaisesRegex(ValueError, "object"):
            factorio.decode_blueprint_string(compressed_payload(b"[1,2]"))
        with self.assertRaisesRegex(ValueError, "version"):
            factorio.decode_blueprint_string(compressed_payload(b"{}", version_byte=9))
        truncated = zlib.compress(b'{"blueprint":{}}', 9)[:-4]
        with self.assertRaisesRegex(ValueError, "zlib"):
            factorio.decode_blueprint_string(base64.b64encode(truncated).decode("ascii"))

    def test_expand_blueprint_converts_centers_to_top_left_anchors(self):
        payload = blueprint_payload([
            {"entity_number": 3, "name": "assembling-machine-2",
             "position": {"x": 5.5, "y": 5.5}},
            {"entity_number": 1, "name": "transport-belt",
             "position": {"x": 0.5, "y": 0.5}, "direction": 4},
            {"entity_number": 2, "name": "inserter",
             "position": {"x": 8.5, "y": 4.5}, "direction": 12},
        ])
        sizes = {
            "assembling-machine-2": {"width": 3, "height": 3},
            "transport-belt": {"width": 1, "height": 1},
            "inserter": (1, 1),
        }
        self.assertEqual(factorio.expand_blueprint(payload, prototype_sizes=sizes), [
            {"name": "transport-belt", "anchor": {"x": 0, "y": 0}, "direction": 4},
            {"name": "assembling-machine-2", "anchor": {"x": 4, "y": 4}},
            {"name": "inserter", "anchor": {"x": 8, "y": 4}, "direction": 12},
        ])

    def test_expand_blueprint_rotates_footprints_for_east_west(self):
        sizes = {"splitter": {"width": 2, "height": 1}}
        north = factorio.expand_blueprint(blueprint_payload([
            {"name": "splitter", "position": {"x": 12, "y": 7.5}, "direction": 0},
        ]), prototype_sizes=sizes)
        self.assertEqual(north, [
            {"name": "splitter", "anchor": {"x": 11, "y": 7}, "direction": 0},
        ])
        east = factorio.expand_blueprint(blueprint_payload([
            {"name": "splitter", "position": {"x": 12.5, "y": 8}, "direction": 4},
        ]), prototype_sizes=sizes)
        self.assertEqual(east, [
            {"name": "splitter", "anchor": {"x": 12, "y": 7}, "direction": 4},
        ])

    def test_expand_blueprint_applies_anchor_offset_and_deterministic_order(self):
        payload = blueprint_payload([
            {"entity_number": 9, "name": "transport-belt",
             "position": {"x": 8.5, "y": 3.5}},
            {"entity_number": 2, "name": "transport-belt",
             "position": {"x": 0.5, "y": 0.5}},
            {"entity_number": 4, "name": "transport-belt",
             "position": {"x": 4.5, "y": 0.5}},
        ])
        moved = factorio.expand_blueprint(
            payload, anchor=(100, -20), offset=(1, 2), prototype_sizes=BELT_SIZES)
        self.assertEqual(
            [(entity["anchor"]["x"], entity["anchor"]["y"]) for entity in moved],
            [(101, -18), (105, -18), (109, -15)],
        )

    def test_expand_blueprint_assumes_one_tile_for_unknown_footprints(self):
        expanded = factorio.expand_blueprint(blueprint_payload([
            {"name": "stone-furnace", "position": {"x": 20, "y": 20}},
            {"name": "transport-belt", "position": {"x": 0.5, "y": 0.5}},
        ]))
        # No size map: 1x1 is assumed, so a 2x2 furnace anchor is approximate.
        self.assertEqual(expanded, [
            {"name": "transport-belt", "anchor": {"x": 0, "y": 0}},
            {"name": "stone-furnace", "anchor": {"x": 20, "y": 20}},
        ])

    def test_expand_blueprint_validates_entities_and_payloads(self):
        with self.assertRaisesRegex(ValueError, "no name"):
            factorio.expand_blueprint(blueprint_payload([{"position": {"x": 0, "y": 0}}]))
        with self.assertRaisesRegex(ValueError, "position"):
            factorio.expand_blueprint(blueprint_payload([{"name": "transport-belt"}]))
        with self.assertRaisesRegex(ValueError, "finite"):
            factorio.expand_blueprint(blueprint_payload([
                {"name": "transport-belt", "position": {"x": float("nan"), "y": 0}},
            ]))
        with self.assertRaisesRegex(ValueError, "direction"):
            factorio.expand_blueprint(blueprint_payload([
                {"name": "transport-belt", "position": {"x": 0.5, "y": 0.5}, "direction": 99},
            ]))
        with self.assertRaisesRegex(ValueError, "blueprint books"):
            factorio.expand_blueprint({"blueprint_book": {"blueprints": []}})
        with self.assertRaisesRegex(ValueError, "blueprint"):
            factorio.expand_blueprint({"item": "blueprint"})
        self.assertEqual(factorio.expand_blueprint(blueprint_payload([])), [])

    def test_blueprint_required_items_counts_placeables_and_contents(self):
        payload = blueprint_payload([
            {"name": "transport-belt", "position": {"x": 0.5, "y": 0.5}},
            {"name": "transport-belt", "position": {"x": 1.5, "y": 0.5}},
            {"name": "inserter", "position": {"x": 2.5, "y": 0.5},
             "items": {"iron-plate": 3}},
            {"name": "wooden-chest", "position": {"x": 3.5, "y": 0.5},
             "items_in_inventory": {"coal": 5}},
        ])
        self.assertEqual(factorio.blueprint_required_items(payload), {
            "transport-belt": 2,
            "inserter": 1,
            "iron-plate": 3,
            "wooden-chest": 1,
            "coal": 5,
        })
        self.assertEqual(
            factorio.blueprint_required_items(
                factorio.encode_blueprint_string(payload),
                item_names={"transport-belt": "fast-transport-belt"},
            )["fast-transport-belt"],
            2,
        )
        self.assertEqual(factorio.blueprint_entities_count(payload), 4)
        self.assertEqual(factorio.blueprint_entities_count(blueprint_text([])), 0)


class BlueprintClientTests(unittest.TestCase):
    def test_build_blueprint_chunks_builds_and_aggregates(self):
        client = factorio.FactorioClient(poll_interval=0)
        calls = []

        def fake_build(entities, *, clear=True):
            calls.append(([dict(entity) for entity in entities], clear))
            return {
                "job_id": f"job-{len(calls)}",
                "status": "completed",
                "results": [{
                    "ok": True,
                    "clearing": {
                        "ok": True,
                        "cleared": [{"name": "tree"}],
                        "skipped": [],
                        "pending_remaining": 0,
                    },
                } for _ in entities],
            }

        with patch.object(client, "build", side_effect=fake_build):
            result = client.build_blueprint(belt_blueprint(120), prototype_sizes=BELT_SIZES)
        self.assertEqual([len(chunk) for chunk, _ in calls], [50, 50, 20])
        self.assertTrue(all(clear for _, clear in calls))
        self.assertEqual(calls[0][0][0]["anchor"], {"x": 0, "y": 0})
        self.assertTrue(result["ok"])
        self.assertEqual(result["blueprint_entities"], 120)
        self.assertEqual(result["chunks"], 3)
        self.assertEqual(len(result["results"]), 120)
        self.assertEqual(result["clearing"], {
            "ok": True, "cleared": 120, "skipped": [], "pending_remaining": 0,
        })
        self.assertEqual(result["job_ids"], ["job-1", "job-2", "job-3"])
        self.assertNotIn("failed_chunk", result)

    def test_build_blueprint_honors_clear_chunk_size_and_caps_at_50(self):
        client = factorio.FactorioClient(poll_interval=0)
        calls = []

        def fake_build(entities, *, clear=True):
            calls.append((len(entities), clear))
            return {"status": "completed",
                    "results": [{"ok": True} for _ in entities]}

        with patch.object(client, "build", side_effect=fake_build):
            result = client.build_blueprint(
                belt_blueprint(60), prototype_sizes=BELT_SIZES, max_per_job=7, clear=False)
        self.assertEqual([size for size, _ in calls], [7] * 8 + [4])
        self.assertTrue(all(clear is False for _, clear in calls))
        self.assertEqual(result["max_per_job"], 7)
        calls.clear()
        with patch.object(client, "build", side_effect=fake_build):
            capped = client.build_blueprint(
                belt_blueprint(60), prototype_sizes=BELT_SIZES, max_per_job=500)
        self.assertEqual([size for size, _ in calls], [50, 10])
        self.assertEqual(capped["max_per_job"], 50)

    def test_build_blueprint_stops_on_fatal_chunk(self):
        client = factorio.FactorioClient(poll_interval=0)
        calls = 0

        def fake_build(entities, *, clear=True):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("queue unavailable")
            return {"status": "completed", "results": [{"ok": True} for _ in entities]}

        with patch.object(client, "build", side_effect=fake_build):
            result = client.build_blueprint(belt_blueprint(120), prototype_sizes=BELT_SIZES)
        self.assertFalse(result["ok"])
        self.assertEqual(result["failed_chunk"], 1)
        self.assertIn("queue unavailable", result["error"])
        self.assertEqual(len(result["results"]), 50)
        self.assertEqual(len(result["job_ids"]), 1)

        failed_status = factorio.FactorioClient(poll_interval=0)
        responses = [
            {"status": "completed", "results": [{"ok": True}] * 50},
            {"status": "failed", "error": "RCON not connected"},
        ]
        with patch.object(failed_status, "build", side_effect=responses):
            stopped = failed_status.build_blueprint(
                belt_blueprint(120), prototype_sizes=BELT_SIZES)
        self.assertFalse(stopped["ok"])
        self.assertEqual(stopped["failed_chunk"], 1)
        self.assertIn("RCON not connected", stopped["error"])

    def test_build_blueprint_dry_run_returns_placement_and_missing_items(self):
        client = factorio.FactorioClient(poll_interval=0)
        blueprint = blueprint_text([
            {"entity_number": 1, "name": "transport-belt",
             "position": {"x": 0.5, "y": 0.5}},
            {"entity_number": 2, "name": "transport-belt",
             "position": {"x": 1.5, "y": 0.5}},
            {"entity_number": 3, "name": "assembling-machine-2",
             "position": {"x": 5.5, "y": 0.5}},
        ])
        sizes = {
            "transport-belt": {"width": 1, "height": 1},
            "assembling-machine-2": {"width": 3, "height": 3},
        }
        with patch.object(client, "build", side_effect=AssertionError("dry run must not build")), \
                patch.object(client, "observe_placement", return_value={
                    "ok": True, "data": {"results": [{"ok": True, "can_place": True}]},
                }) as placement, \
                patch.object(client, "inventory_counts", return_value={
                    "transport-belt": 5, "iron-gear-wheel": 1,
                }):
            result = client.build_blueprint(blueprint, dry_run=True, prototype_sizes=sizes)
        self.assertEqual(len(result["entities"]), 3)
        self.assertEqual(result["placement"]["results"], [{"ok": True, "can_place": True}])
        self.assertEqual(result["missing_items"], [{
            "name": "assembling-machine-2",
            "required": 1,
            "available": 0,
            "missing": 1,
        }])
        self.assertFalse(result["ok"])
        self.assertEqual(placement.call_count, 1)

        ready = factorio.FactorioClient(poll_interval=0)
        with patch.object(ready, "build", side_effect=AssertionError("dry run must not build")), \
                patch.object(ready, "observe_placement", return_value={"data": {"results": []}}), \
                patch.object(ready, "inventory_counts", return_value={
                    "transport-belt": 5, "assembling-machine-2": 1,
                }):
            complete = ready.build_blueprint(blueprint, dry_run=True, prototype_sizes=sizes)
        self.assertEqual(complete["missing_items"], [])
        self.assertTrue(complete["ok"])

    def test_build_blueprint_fetches_prototype_sizes_when_missing(self):
        client = factorio.FactorioClient(poll_interval=0)
        footprints = {
            "transport-belt": {"tile_size": {"width": 1, "height": 1}},
            "assembling-machine-2": {"tile_size": {"width": 3, "height": 3}},
        }
        built = []

        def fake_build(entities, *, clear=True):
            built.append(entities)
            return {"status": "completed", "results": [{"ok": True} for _ in entities]}

        with patch.object(client, "observe_entity_prototype",
                          side_effect=lambda name: {"ok": True, "data": footprints[name]}) as prototype, \
                patch.object(client, "build", side_effect=fake_build):
            result = client.build_blueprint(blueprint_text([
                {"name": "transport-belt", "position": {"x": 0.5, "y": 0.5}},
                {"name": "assembling-machine-2", "position": {"x": 10.5, "y": 10.5}},
            ]))
        self.assertEqual(prototype.call_count, 2)
        self.assertEqual(built[0][1]["anchor"], {"x": 9, "y": 9})
        self.assertTrue(result["ok"])
        self.assertEqual(result["warnings"], [])

    def test_build_blueprint_warns_and_falls_back_when_lookup_fails(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "observe_entity_prototype",
                          side_effect=RuntimeError("prototype endpoint down")), \
                patch.object(client, "build", return_value={
                    "status": "completed", "results": [{"ok": True}],
                }):
            result = client.build_blueprint(blueprint_text([
                {"name": "stone-furnace", "position": {"x": 5, "y": 5}},
            ]))
        self.assertTrue(result["ok"])
        self.assertTrue(any("prototype lookup failed" in warning for warning in result["warnings"]))
        self.assertTrue(any("assuming 1x1" in warning for warning in result["warnings"]))

    def test_build_blueprint_warns_about_underground_subtypes(self):
        client = factorio.FactorioClient(poll_interval=0)
        blueprint = blueprint_text([
            {"entity_number": 1, "name": "underground-belt", "type": "input",
             "position": {"x": 0.5, "y": 0.5}, "direction": 4},
            {"entity_number": 2, "name": "underground-belt", "type": "output",
             "position": {"x": 4.5, "y": 0.5}, "direction": 8},
        ])
        with patch.object(client, "build", return_value={
            "status": "completed", "results": [{"ok": True}, {"ok": True}],
        }):
            result = client.build_blueprint(
                blueprint, prototype_sizes={"underground-belt": (1, 1)})
        self.assertTrue(any("underground input" in warning for warning in result["warnings"]))
        self.assertTrue(any("underground output" in warning for warning in result["warnings"]))

    def test_build_blueprint_rejects_empty_blueprint_and_bad_limits(self):
        client = factorio.FactorioClient(poll_interval=0)
        with self.assertRaisesRegex(ValueError, "no entities"):
            client.build_blueprint(blueprint_text([]))
        with self.assertRaisesRegex(ValueError, "at least 1"):
            client.build_blueprint(belt_blueprint(1), prototype_sizes=BELT_SIZES, max_per_job=0)
        with self.assertRaisesRegex(ValueError, "base64"):
            client.build_blueprint("not*base64!")


class BlueprintCliTests(unittest.TestCase):
    def test_act_build_blueprint_requires_input(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = factorio.run(["act-build-blueprint"])
        self.assertEqual(code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["cmd"], "act-build-blueprint")
        self.assertIn("Missing --blueprint", payload["error"])

    def test_act_build_blueprint_reads_file_and_passes_options(self):
        result = {
            "ok": True,
            "blueprint_entities": 1,
            "entities": [{"name": "transport-belt", "anchor": {"x": 10, "y": 20}}],
            "results": [{"ok": True}],
            "chunks": 1,
            "job_ids": ["job-1"],
        }
        with tempfile.TemporaryDirectory() as temp:
            blueprint_path = os.path.join(temp, "plan.txt")
            with open(blueprint_path, "w", encoding="utf-8") as handle:
                handle.write("blueprint-file-content")
            stdout = io.StringIO()
            with patch("factorio.FactorioClient.build_blueprint",
                       return_value=result) as build, redirect_stdout(stdout):
                code = factorio.run([
                    "act-build-blueprint",
                    "--blueprint-file", blueprint_path,
                    "--anchor", "10,20",
                    "--dry-run",
                    "--no-clear",
                ])
        self.assertEqual(code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["cmd"], "act-build-blueprint")
        self.assertEqual(payload["data"], result)
        build.assert_called_once_with(
            "blueprint-file-content",
            anchor={"x": 10, "y": 20},
            dry_run=True,
            clear=False,
        )

    def test_act_build_blueprint_failure_is_json_and_propagates_failed_chunk(self):
        stdout = io.StringIO()
        with patch("factorio.FactorioClient.build_blueprint",
                   side_effect=ValueError("blueprint string is empty")), redirect_stdout(stdout):
            code = factorio.run(["act-build-blueprint", "--blueprint", ""])
        self.assertEqual(code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertIn("empty", payload["error"])

        failed = {"ok": False, "failed_chunk": 1, "error": "queue unavailable"}
        stdout = io.StringIO()
        with patch("factorio.FactorioClient.build_blueprint", return_value=failed), \
                redirect_stdout(stdout):
            code = factorio.run(["act-build-blueprint", "--blueprint", "abc"])
        self.assertEqual(code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["data"]["failed_chunk"], 1)

    def test_help_lists_the_blueprint_command(self):
        self.assertIn("act-build-blueprint", factorio.COMMAND_USAGE)
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = factorio.run(["act-build-blueprint", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("--blueprint-file", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
