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


def area_observation(entity_count, *, types=None, total=100, truncated=False):
    """Synthetic observe-area response payload for deconstruct tests."""
    kinds = types or ["transport-belt"]
    entities = [
        {"name": f"entity-{index}", "type": kinds[index % len(kinds)],
         "x": index % 20, "y": index // 20}
        for index in range(entity_count)
    ]
    return {
        "ok": True,
        "data": {
            "ok": True,
            "area": {"x": 0, "y": 0, "radius": 64},
            "counts": {"total": total, "matched": entity_count, "included": entity_count},
            "entities": entities,
            "truncated": truncated,
            "player_only": True,
        },
    }


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

    def test_rotate_accepts_final_direction(self):
        client = factorio.FactorioClient()
        targets = [{"x": 1, "y": 2}]
        with patch.object(client, "submit_action", return_value={"job_id": "rotate"}) as submit:
            client.rotate(targets, direction=4)
            client.rotate(targets)
        self.assertEqual(submit.call_args_list, [
            unittest.mock.call("rotate", {"targets": [{"x": 1, "y": 2, "direction": 4}]}),
            unittest.mock.call("rotate", {"targets": targets}),
        ])
        with self.assertRaises(ValueError):
            client.rotate(targets, direction=2)

    def test_rotate_cli_passes_direction(self):
        stdout = io.StringIO()
        job = {"status": "completed", "results": [{"ok": True}]}
        with patch("factorio.submit_action_job", return_value=job) as submit, redirect_stdout(stdout):
            code = factorio.run(["act-rotate", "--target", "3,4", "--direction", "8"])
        self.assertEqual(code, 0)
        submit.assert_called_once_with(
            factorio.DEFAULT_BASE,
            "rotate",
            {"targets": [{"x": 3, "y": 4, "direction": 8}]},
            detach=False,
            idempotency_key=None,
        )

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

    def test_preview_path_submits_native_path_action(self):
        client = factorio.FactorioClient()
        with patch.object(client, "submit_action", return_value={"job_id": "path"}) as submit:
            client.preview_path(3, 4)
        submit.assert_called_once_with("path", {"targets": [{"x": 3, "y": 4}]})

    def test_path_preview_cli_submits_one_target(self):
        stdout = io.StringIO()
        job = {"status": "completed", "results": [{"ok": True, "path": [{"x": 3, "y": 4}]}]}
        with patch("factorio.submit_action_job", return_value=job) as submit, redirect_stdout(stdout):
            code = factorio.run(["path-preview", "--target", "3,4"])
        self.assertEqual(code, 0)
        submit.assert_called_once_with(
            factorio.DEFAULT_BASE,
            "path",
            {"targets": [{"x": 3, "y": 4}]},
            detach=False,
            idempotency_key=None,
        )

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

    def test_expand_blueprint_preserves_underground_subtypes(self):
        payload = blueprint_payload([
            {"entity_number": 1, "name": "underground-belt", "type": "input",
             "position": {"x": 0.5, "y": 0.5}, "direction": 4},
            {"entity_number": 2, "name": "underground-belt", "type": "output",
             "position": {"x": 4.5, "y": 0.5}, "direction": 4},
            {"entity_number": 3, "name": "pipe-to-ground", "type": "input",
             "position": {"x": 0.5, "y": 3.5}, "direction": 0},
            {"entity_number": 4, "name": "pipe-to-ground", "type": "output",
             "position": {"x": 0.5, "y": 13.5}, "direction": 0},
            {"entity_number": 5, "name": "inserter",
             "position": {"x": 6.5, "y": 0.5}, "direction": 12},
        ])
        sizes = {"underground-belt": (1, 1), "pipe-to-ground": (1, 1), "inserter": (1, 1)}
        self.assertEqual(factorio.expand_blueprint(payload, prototype_sizes=sizes), [
            {"name": "underground-belt", "anchor": {"x": 0, "y": 0},
             "direction": 4, "underground_type": "input"},
            {"name": "underground-belt", "anchor": {"x": 4, "y": 0},
             "direction": 4, "underground_type": "output"},
            {"name": "inserter", "anchor": {"x": 6, "y": 0}, "direction": 12},
            {"name": "pipe-to-ground", "anchor": {"x": 0, "y": 3},
             "direction": 0, "underground_type": "input"},
            {"name": "pipe-to-ground", "anchor": {"x": 0, "y": 13},
             "direction": 0, "underground_type": "output"},
        ])
        # Non-underground prototypes ignore a stray blueprint "type" field.
        stray = factorio.expand_blueprint(blueprint_payload([
            {"name": "stone-furnace", "type": "input",
             "position": {"x": 5, "y": 5}},
        ]), prototype_sizes={"stone-furnace": (2, 2)})
        self.assertEqual(stray, [{"name": "stone-furnace", "anchor": {"x": 4, "y": 4}}])

    def test_expand_blueprint_rejects_invalid_underground_types(self):
        with self.assertRaisesRegex(ValueError, "input.*output"):
            factorio.expand_blueprint(blueprint_payload([
                {"name": "underground-belt", "type": "sideways",
                 "position": {"x": 0.5, "y": 0.5}},
            ]))
        with self.assertRaisesRegex(ValueError, "input.*output"):
            factorio.expand_blueprint(blueprint_payload([
                {"name": "pipe-to-ground", "position": {"x": 0.5, "y": 0.5}},
            ]))

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
    def test_observe_map_overview_png_format(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "request", return_value={"png_base64": "x"}) as request:
            client.observe_map_overview(x=1, y=2, radius=64, size=32, format="png")
        request.assert_called_once_with(
            "POST",
            "/api/agent/observe/map-overview",
            {"window": {"x": 1, "y": 2, "radius": 64}, "size": 32, "format": "png"},
        )

    def test_observe_map_overview_svg_format(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "request", return_value={"rows": []}) as request:
            client.observe_map_overview(x=1, y=2, radius=64, size=32, format="svg")
        request.assert_called_once_with(
            "POST",
            "/api/agent/observe/map-overview",
            {"window": {"x": 1, "y": 2, "radius": 64}, "size": 32, "format": "svg"},
        )

    def test_observe_map_overview_payload(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "request", return_value={"rows": ["?@."]}) as request:
            self.assertEqual(
                client.observe_map_overview(x=10, y=-20, radius=256, size=80),
                {"rows": ["?@."]},
            )
        request.assert_called_once_with(
            "POST",
            "/api/agent/observe/map-overview",
            {"window": {"x": 10, "y": -20, "radius": 256}, "size": 80},
        )

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

    def test_build_blueprint_passes_underground_subtypes_to_chunks(self):
        client = factorio.FactorioClient(poll_interval=0)
        blueprint = blueprint_text([
            {"entity_number": 1, "name": "underground-belt", "type": "input",
             "position": {"x": 0.5, "y": 0.5}, "direction": 4},
            {"entity_number": 2, "name": "underground-belt", "type": "output",
             "position": {"x": 4.5, "y": 0.5}, "direction": 4},
        ])
        chunks = []

        def fake_build(entities, *, clear=True):
            chunks.append([dict(entity) for entity in entities])
            return {"status": "completed",
                    "results": [{"ok": True} for _ in entities]}

        with patch.object(client, "build", side_effect=fake_build):
            result = client.build_blueprint(
                blueprint, prototype_sizes={"underground-belt": (1, 1)})
        self.assertTrue(result["ok"])
        self.assertEqual([entity.get("underground_type") for entity in chunks[0]],
                         ["input", "output"])
        self.assertFalse(any("underground" in warning for warning in result["warnings"]))

        invalid = blueprint_text([
            {"name": "underground-belt", "type": "sideways",
             "position": {"x": 0.5, "y": 0.5}},
        ])
        with patch.object(client, "build") as build:
            with self.assertRaisesRegex(ValueError, "input.*output"):
                client.build_blueprint(
                    invalid, prototype_sizes={"underground-belt": (1, 1)})
        build.assert_not_called()

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


class TelemetryObservationTests(unittest.TestCase):
    def test_observation_wrappers_match_endpoint_payloads(self):
        client = factorio.FactorioClient()
        with patch.object(client, "request", return_value={"ok": True, "data": {}}) as request:
            self.assertEqual(client.observe_production(), {"ok": True, "data": {}})
            client.observe_fluids(x=1, y=2, radius=16)
            client.observe_combat(radius=8)
            client.observe_area(
                3, 4, radius=12, limit=5,
                types=["assembling-machine-1"], filters=["iron-plate"], player_only=True)
        self.assertEqual(request.call_args_list, [
            unittest.mock.call("POST", "/api/agent/observe/production", {}),
            unittest.mock.call("POST", "/api/agent/observe/fluids",
                               {"x": 1, "y": 2, "radius": 16}),
            unittest.mock.call("POST", "/api/agent/observe/combat",
                               {"x": None, "y": None, "radius": 8}),
            unittest.mock.call("POST", "/api/agent/observe/area", {
                "window": {"x": 3, "y": 4, "radius": 12},
                "limit": 5,
                "types": ["assembling-machine-1"],
                "filters": ["iron-plate"],
                "player_only": True,
            }),
        ])

    def test_observe_production_retries_telemetry_not_ready_once(self):
        client = factorio.FactorioClient(poll_interval=0)
        responses = [
            RuntimeError("telemetry not ready"),
            {"ok": True, "data": {"samples": 2}},
        ]
        with patch.object(client, "request", side_effect=responses) as request, \
                patch("factorio.time.sleep") as sleep:
            result = client.observe_production()
        self.assertEqual(result["data"]["samples"], 2)
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(0.5)

        with patch.object(client, "request", side_effect=RuntimeError("RCON not connected")):
            with self.assertRaisesRegex(RuntimeError, "RCON"):
                client.observe_production()

        with patch.object(client, "request",
                          side_effect=[RuntimeError("telemetry not ready")] * 2) as request, \
                patch("factorio.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "telemetry not ready"):
                client.observe_production()
        self.assertEqual(request.call_count, 2)

    def test_copy_settings_routes_and_dry_run_alias(self):
        client = factorio.FactorioClient()
        targets = [{"source": {"x": 1, "y": 2}, "target": {"x": 3, "y": 4}}]
        with patch.object(client, "request", return_value={"ok": True}) as request:
            client.copy_settings(targets)
            client.copy_settings(targets, dry_run=True)
            client.copy_settings_check(targets)
        self.assertEqual(request.call_args_list, [
            unittest.mock.call("POST", "/api/agent/act/copy-settings", {"targets": targets}),
            unittest.mock.call("POST", "/api/agent/observe/copy-settings", {"targets": targets}),
            unittest.mock.call("POST", "/api/agent/observe/copy-settings", {"targets": targets}),
        ])

    def test_observe_snapshot_aggregates_parts_and_partial_failure(self):
        client = factorio.FactorioClient()
        with patch.object(client, "observe_player",
                          return_value={"ok": True, "data": {"player": {"x": 1}}}), \
                patch.object(client, "observe_factory",
                             return_value={"data": {"totals": {}}}) as factory, \
                patch.object(client, "observe_research",
                             return_value={"data": {"completed": []}}), \
                patch.object(client, "observe_production",
                             return_value={"data": {"production_per_minute": {"iron-plate": 10}}}):
            snapshot = client.observe_snapshot(5, 6, radius=32)
        self.assertTrue(snapshot["ok"])
        self.assertEqual(snapshot["player"], {"player": {"x": 1}})
        self.assertEqual(snapshot["factory"], {"totals": {}})
        self.assertEqual(snapshot["research"], {"completed": []})
        self.assertEqual(snapshot["production"], {"production_per_minute": {"iron-plate": 10}})
        factory.assert_called_once_with(x=5, y=6, radius=32)
        self.assertNotIn("errors", snapshot)

        failing = factorio.FactorioClient()
        with patch.object(failing, "observe_player", return_value={"data": {}}), \
                patch.object(failing, "observe_factory",
                             side_effect=RuntimeError("RCON not connected")), \
                patch.object(failing, "observe_research", return_value={"data": {}}), \
                patch.object(failing, "observe_production", return_value={"data": {}}):
            snapshot = failing.observe_snapshot()
        self.assertFalse(snapshot["ok"])
        self.assertEqual(snapshot["factory"],
                         {"ok": False, "error": "RCON not connected"})
        self.assertEqual(snapshot["errors"],
                         [{"part": "factory", "error": "RCON not connected"}])

    def test_wait_for_production_requires_stable_polls(self):
        client = factorio.FactorioClient(poll_interval=0)
        responses = [
            {"data": {"production_per_minute": {"iron-plate": 3}}},
            {"data": {"production_per_minute": {"iron-plate": 12}}},
            {"data": {"production_per_minute": {"iron-plate": 15}}},
        ]
        with patch.object(client, "observe_production", side_effect=responses), \
                patch("factorio.time.sleep") as sleep:
            result = client.wait_for_production(
                "iron-plate", 10, timeout=60, interval=1, stable_polls=2)
        self.assertEqual(result["production_per_minute"]["iron-plate"], 15)
        self.assertEqual(sleep.call_count, 2)

        with patch.object(client, "observe_production",
                          side_effect=[RuntimeError("telemetry not ready")] + responses[-2:]), \
                patch("factorio.time.sleep"):
            recovered = client.wait_for_production("iron-plate", 10, timeout=60, interval=1)
        self.assertEqual(recovered["production_per_minute"]["iron-plate"], 15)

        with patch.object(client, "observe_production", return_value={
            "data": {"production_per_minute": {"iron-plate": 1}},
        }), patch("factorio.time.sleep"):
            with self.assertRaisesRegex(TimeoutError, "did not reach 10/min"):
                client.wait_for_production("iron-plate", 10, timeout=0, interval=0)

    def test_wait_for_fluid_polls_the_fluid_aggregate(self):
        client = factorio.FactorioClient(poll_interval=0)

        def observation(amount):
            return {"data": {"fluids": {"water": {"name": "water", "amount": amount}},
                             "counts": {}}}

        with patch.object(client, "observe_fluids", side_effect=[
            observation(10), observation(60),
        ]), patch("factorio.time.sleep"):
            data = client.wait_for_fluid("water", 50, timeout=60, interval=1)
        self.assertEqual(data["fluids"]["water"]["amount"], 60)

        with patch.object(client, "observe_fluids", return_value=observation(10)), \
                patch("factorio.time.sleep"):
            with self.assertRaisesRegex(TimeoutError, "did not reach 50"):
                client.wait_for_fluid("water", 50, timeout=0, interval=0)


class PlannerTests(unittest.TestCase):
    def test_plan_pipe_line_is_l_shaped_x_first(self):
        entities = factorio.plan_pipe_line({"x": 0, "y": 0}, {"x": 3, "y": 2})
        self.assertEqual(
            [(entity["anchor"]["x"], entity["anchor"]["y"]) for entity in entities],
            [(0, 0), (1, 0), (2, 0), (3, 0), (3, 1), (3, 2)],
        )
        self.assertTrue(all(entity["name"] == "pipe" and entity["direction"] == 0
                            for entity in entities))
        reverse = factorio.plan_pipe_line({"x": 2, "y": 0}, {"x": 0, "y": 2})
        self.assertEqual(
            [(entity["anchor"]["x"], entity["anchor"]["y"]) for entity in reverse],
            [(2, 0), (1, 0), (0, 0), (0, 1), (0, 2)],
        )
        self.assertEqual(factorio.plan_pipe_line((2, 2), (2, 2)), [])
        with self.assertRaisesRegex(ValueError, "integer"):
            factorio.plan_pipe_line({"x": 0.5, "y": 0}, (1, 0))

    def test_plan_underground_belt_line_pairs_all_directions(self):
        def layout(entities):
            return [
                (entity["name"], entity["anchor"]["x"], entity["anchor"]["y"],
                 entity.get("direction"), entity.get("underground_type"))
                for entity in entities
            ]

        east = layout(factorio.plan_underground_belt_line((0, 0), (10, 0)))
        self.assertEqual(east, [
            ("underground-belt", 0, 0, 4, "input"),
            ("underground-belt", 4, 0, 4, "output"),
            ("transport-belt", 5, 0, 4, None),
            ("underground-belt", 6, 0, 4, "input"),
            ("underground-belt", 10, 0, 4, "output"),
        ])
        west = layout(factorio.plan_underground_belt_line((10, 0), (0, 0)))
        self.assertEqual(west, [
            ("underground-belt", 10, 0, 12, "input"),
            ("underground-belt", 6, 0, 12, "output"),
            ("transport-belt", 5, 0, 12, None),
            ("underground-belt", 4, 0, 12, "input"),
            ("underground-belt", 0, 0, 12, "output"),
        ])
        south = layout(factorio.plan_underground_belt_line((0, 0), (0, 10)))
        self.assertEqual(south, [
            ("underground-belt", 0, 0, 8, "input"),
            ("underground-belt", 0, 4, 8, "output"),
            ("transport-belt", 0, 5, 8, None),
            ("underground-belt", 0, 6, 8, "input"),
            ("underground-belt", 0, 10, 8, "output"),
        ])
        north = layout(factorio.plan_underground_belt_line((0, 10), (0, 0)))
        self.assertEqual(north, [
            ("underground-belt", 0, 10, 0, "input"),
            ("underground-belt", 0, 6, 0, "output"),
            ("transport-belt", 0, 5, 0, None),
            ("underground-belt", 0, 4, 0, "input"),
            ("underground-belt", 0, 0, 0, "output"),
        ])
        anchors = [(entity["anchor"]["x"], entity["anchor"]["y"])
                   for entity in factorio.plan_underground_belt_line((0, 0), (10, 0))]
        self.assertEqual(len(anchors), len(set(anchors)))
        self.assertEqual(factorio.plan_underground_belt_line((0, 0), (0, 10))[0]
                         ["underground_type"], "input")

    def test_plan_underground_belt_line_tiers_and_distances(self):
        fast = factorio.plan_underground_belt_line((0, 0), (13, 0), name="fast-transport-belt")
        self.assertEqual([entity["name"] for entity in fast],
                         ["fast-underground-belt"] * 2 + ["fast-transport-belt"] * 7)
        self.assertEqual(fast[1]["anchor"]["x"], 6)

        express = factorio.plan_underground_belt_line(
            (0, 0), (20, 0), name="express-transport-belt")
        self.assertEqual(
            [(entity["anchor"]["x"], entity.get("underground_type")) for entity in express],
            [(0, "input"), (8, "output"), (9, None),
             (10, "input"), (18, "output"), (19, None), (20, None)],
        )

        # Underground entity names are accepted as the tier argument too.
        via_underground = factorio.plan_underground_belt_line(
            (0, 0), (6, 0), name="fast-underground-belt")
        self.assertEqual(via_underground[0]["name"], "fast-underground-belt")
        self.assertEqual([entity["anchor"]["x"] for entity in via_underground], [0, 6])

        custom = factorio.plan_underground_belt_line((0, 0), (5, 0), max_distance=2)
        self.assertEqual(
            [(entity["name"], entity["anchor"]["x"], entity.get("underground_type"))
             for entity in custom],
            [("underground-belt", 0, "input"), ("underground-belt", 2, "output"),
             ("transport-belt", 3, None), ("transport-belt", 4, None),
             ("transport-belt", 5, None)],
        )

        # Lines shorter than a pair and tails fall back to surface belts.
        short = factorio.plan_underground_belt_line((0, 0), (2, 0))
        self.assertTrue(all(entity["name"] == "transport-belt" for entity in short))
        tail = factorio.plan_underground_belt_line((0, 0), (8, 0))
        self.assertEqual(
            [(entity["name"], entity["anchor"]["x"]) for entity in tail],
            [("underground-belt", 0), ("underground-belt", 4),
             ("transport-belt", 5), ("transport-belt", 6),
             ("transport-belt", 7), ("transport-belt", 8)],
        )

        # Modded tiers keep the requested surface name with the base underground
        # belt and the conservative distance 4.
        modded = factorio.plan_underground_belt_line((0, 0), (4, 0), name="modded-belt")
        self.assertEqual(
            [(entity["name"], entity["anchor"]["x"], entity.get("underground_type"))
             for entity in modded],
            [("underground-belt", 0, "input"), ("underground-belt", 4, "output")],
        )

        for bad_distance in (0, -1, 2.5):
            with self.assertRaisesRegex(ValueError, "positive integer"):
                factorio.plan_underground_belt_line((0, 0), (10, 0), max_distance=bad_distance)
        with self.assertRaisesRegex(ValueError, "straight"):
            factorio.plan_underground_belt_line((0, 0), (5, 5))
        with self.assertRaisesRegex(ValueError, "distinct"):
            factorio.plan_underground_belt_line((2, 2), (2, 2))

    def test_plan_underground_pipe_line_layout(self):
        pipes = factorio.plan_underground_pipe_line((0, 0), (12, 0))
        self.assertEqual(
            [(entity["name"], entity["anchor"]["x"], entity["anchor"]["y"],
              entity.get("direction"), entity.get("underground_type"))
             for entity in pipes],
            [("pipe-to-ground", 0, 0, 4, "input"),
             ("pipe-to-ground", 10, 0, 4, "output"),
             ("pipe", 11, 0, 0, None),
             ("pipe", 12, 0, 0, None)],
        )
        custom = factorio.plan_underground_pipe_line((0, 0), (4, 0), max_distance=3)
        self.assertEqual(
            [(entity["name"], entity["anchor"]["x"], entity.get("underground_type"))
             for entity in custom],
            [("pipe-to-ground", 0, "input"), ("pipe-to-ground", 3, "output"),
             ("pipe", 4, None)],
        )
        vertical = factorio.plan_underground_pipe_line((0, 0), (0, 11))
        self.assertEqual(
            [(entity["name"], entity["anchor"]["y"], entity.get("direction"))
             for entity in vertical],
            [("pipe-to-ground", 0, 8), ("pipe-to-ground", 10, 8), ("pipe", 11, 0)],
        )
        for bad_distance in (0, 1.5, "x"):
            with self.assertRaisesRegex(ValueError, "positive integer"):
                factorio.plan_underground_pipe_line((0, 0), (10, 0), max_distance=bad_distance)
        with self.assertRaisesRegex(ValueError, "straight"):
            factorio.plan_underground_pipe_line((0, 0), (3, 3))
        with self.assertRaisesRegex(ValueError, "distinct"):
            factorio.plan_underground_pipe_line((1, 1), (1, 1))

    def test_plan_power_network_covers_area_and_targets(self):
        poles = factorio.plan_power_network({"x": 0, "y": 0, "radius": 4})
        self.assertEqual(
            [(pole["anchor"]["x"], pole["anchor"]["y"]) for pole in poles],
            [(-2, -2), (3, -2), (-2, 3), (3, 3)],
        )
        self.assertTrue(all(pole["name"] == "small-electric-pole" for pole in poles))
        targets = factorio.plan_power_network([
            {"x": 1, "y": 1},
            {"x": 10, "y": 1},
            {"name": "small-electric-pole", "anchor": {"x": 2, "y": 0}},
        ])
        # The existing pole at (2, 0) is deduped; its target box is not re-covered.
        self.assertEqual(
            [(pole["anchor"]["x"], pole["anchor"]["y"]) for pole in targets],
            [(3, 1), (8, 1)],
        )
        self.assertEqual(
            [pole["name"] for pole in factorio.plan_power_network(
                {"x": 0, "y": 0, "radius": 4}, big_pole_every=2)],
            ["small-electric-pole", "big-electric-pole",
             "small-electric-pole", "big-electric-pole"],
        )
        with self.assertRaisesRegex(ValueError, "at least one"):
            factorio.plan_power_network([])
        with self.assertRaisesRegex(ValueError, "non-pole"):
            factorio.plan_power_network([{"name": "small-electric-pole",
                                          "anchor": {"x": 0, "y": 0}}])

    def test_plan_power_line_is_straight_and_uses_wire_spacing(self):
        self.assertEqual(
            [pole["anchor"]["x"] for pole in factorio.plan_power_line(
                (0, 0), (70, 0), pole="big-electric-pole")],
            [0, 30, 60, 70],
        )
        self.assertEqual(
            [pole["anchor"]["y"] for pole in factorio.plan_power_line(
                (5, 0), (5, -9), pole="medium-electric-pole")],
            [0, -9],
        )
        with self.assertRaisesRegex(ValueError, "straight horizontal or vertical"):
            factorio.plan_power_line((0, 0), (5, 5), pole="big-electric-pole")
        with self.assertRaisesRegex(ValueError, "spacing"):
            factorio.plan_power_line((0, 0), (20, 0), pole="small-electric-pole", spacing=20)
        self.assertIn("build-power-line", factorio.COMMAND_USAGE)
        self.assertIn("build-power-line", factorio.GLOBAL_USAGE)

    def test_substation_planner_uses_large_supply_grid(self):
        small = factorio.plan_power_network({"x": 0, "y": 0, "radius": 17})
        substations = factorio.plan_power_network(
            {"x": 0, "y": 0, "radius": 17}, pole="substation")
        self.assertLess(len(substations), len(small))
        xs = [pole["anchor"]["x"] for pole in substations]
        self.assertTrue(all((x + 8) % 18 == 0 for x in xs))

    def test_plan_inserter_pairs_places_and_dedupes(self):
        machines = [{"anchor": {"x": 0, "y": 0}},
                    {"anchor": {"x": 4, "y": 0}},
                    {"anchor": {"x": 8, "y": 0}}]
        pairs = factorio.plan_inserter_pairs(machines)
        self.assertEqual(
            [(entity["anchor"]["x"], entity["anchor"]["y"], entity["direction"])
             for entity in pairs],
            [(-1, 1, 4), (3, 1, 4), (7, 1, 4), (11, 1, 4)],
        )
        west = factorio.plan_inserter_pairs(machines, direction="west")
        self.assertTrue(all(entity["direction"] == 12 for entity in west))
        south = factorio.plan_inserter_pairs(
            [{"anchor": {"x": 0, "y": 0}}, {"anchor": {"x": 0, "y": 4}}],
            direction="south")
        self.assertEqual(
            [(entity["anchor"]["x"], entity["anchor"]["y"], entity["direction"])
             for entity in south],
            [(1, -1, 8), (1, 3, 8), (1, 7, 8)],
        )
        wide = factorio.plan_inserter_pairs(
            [{"anchor": {"x": 0, "y": 0}, "width": 5, "height": 1}])
        self.assertEqual(
            [(entity["anchor"]["x"], entity["anchor"]["y"]) for entity in wide],
            [(-1, 0), (5, 0)],
        )
        with self.assertRaisesRegex(ValueError, "direction"):
            factorio.plan_inserter_pairs(machines, direction="up")

    def test_plan_mining_outpost_lays_drills_belts_and_chest(self):
        ore = [{"x": x, "y": y} for x in range(6) for y in range(3)]
        plan = factorio.plan_mining_outpost(ore)
        drills = [(entity["anchor"]["x"], entity["anchor"]["y"])
                  for entity in plan["entities"]
                  if entity["name"] == "electric-mining-drill"]
        self.assertEqual(drills, [(0, 0), (3, 0)])
        belts = [(entity["anchor"]["x"], entity["anchor"]["y"], entity["direction"])
                 for entity in plan["entities"] if entity["name"] == "transport-belt"]
        self.assertEqual(belts, [(x, 3, 4) for x in range(6)])
        self.assertIn({"name": "inserter",
                       "anchor": {"x": 6, "y": 3}, "direction": 4}, plan["entities"])
        self.assertIn({"name": "iron-chest", "anchor": {"x": 7, "y": 3}},
                      plan["entities"])
        self.assertTrue(any("need power" in warning for warning in plan["warnings"]))

        # Ore in the output-belt gap rows is reported as uncovered.
        multi_row = factorio.plan_mining_outpost(
            [{"x": x, "y": y} for x in range(3) for y in range(6)])
        self.assertTrue(any("not covered" in warning for warning in multi_row["warnings"]))

        area_plan = factorio.plan_mining_outpost(
            {"x": 0, "y": 0, "radius": 4}, drill_grid=(5, 5), output=None)
        self.assertTrue(area_plan["entities"])
        self.assertTrue(any("assumes ore fills" in warning
                            for warning in area_plan["warnings"]))
        with self.assertRaisesRegex(ValueError, "ore tile"):
            factorio.plan_mining_outpost([])

    def test_plan_defense_line_spacing_walls_and_ammo(self):
        plan = factorio.plan_defense_line((0, 0), (20, 0), ammo_chest="wooden-chest")
        turrets = [(entity["anchor"]["x"], entity["anchor"]["y"], entity["direction"])
                   for entity in plan["entities"] if entity["name"] == "gun-turret"]
        self.assertEqual(turrets, [(0, 0, 8), (8, 0, 8), (16, 0, 8)])
        walls = [entity for entity in plan["entities"] if entity["name"] == "stone-wall"]
        self.assertEqual([wall["anchor"]["x"] for wall in walls], list(range(21)))
        self.assertTrue(all(wall["anchor"]["y"] == 2 for wall in walls))
        chests = [(entity["anchor"]["x"], entity["anchor"]["y"])
                  for entity in plan["entities"] if entity["name"] == "wooden-chest"]
        self.assertEqual(chests, [(0, -2), (8, -2), (16, -2)])
        self.assertEqual(
            [(entity["anchor"]["x"], entity["anchor"]["y"]) for entity in plan["entities"]
             if entity["name"] == "inserter"],
            [(0, -1), (8, -1), (16, -1)],
        )

        vertical = factorio.plan_defense_line((5, 0), (5, 12), spacing=6, wall=None)
        turrets = [(entity["anchor"]["x"], entity["anchor"]["y"], entity["direction"])
                   for entity in vertical["entities"] if entity["name"] == "gun-turret"]
        self.assertEqual(turrets, [(5, 0, 4), (5, 6, 4)])
        self.assertFalse(any(entity["name"] == "stone-wall"
                             for entity in vertical["entities"]))
        with self.assertRaisesRegex(ValueError, "horizontal or vertical"):
            factorio.plan_defense_line((0, 0), (4, 4))
        with self.assertRaisesRegex(ValueError, "spacing"):
            factorio.plan_defense_line((0, 0), (10, 0), spacing=1)


class PlanBuildAndBuilderTests(unittest.TestCase):
    def test_plan_build_chunks_placement_and_reports_blockers(self):
        client = factorio.FactorioClient(poll_interval=0)
        entities = [{"name": "transport-belt", "anchor": {"x": index, "y": 0}}
                    for index in range(60)]
        calls = []

        def fake_placement(placements):
            calls.append(len(placements))
            results = [{"ok": True, "can_place": True} for _ in placements]
            if len(calls) == 2:
                results[5] = {"ok": False, "can_place": False, "error": "blocked",
                              "diagnostics": {"tile_names": ["water"]}}
            return {"ok": True, "data": {"results": results}}

        with patch.object(client, "observe_placement", side_effect=fake_placement), \
                patch.object(client, "inventory_counts",
                             return_value={"transport-belt": 100}):
            result = client.plan_build(entities)
        self.assertEqual(calls, [50, 10])
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["blockers"]), 1)
        self.assertEqual(result["blockers"][0]["index"], 55)
        self.assertEqual(result["blockers"][0]["name"], "transport-belt")
        self.assertEqual(result["blockers"][0]["error"], "blocked")
        self.assertEqual(result["missing_items"], [])
        self.assertFalse(result["truncated"])

        with patch.object(client, "observe_placement", return_value={
            "data": {"results": [{"ok": True, "can_place": True},
                                 {"ok": True, "can_place": True}]},
        }), patch.object(client, "inventory_counts",
                         return_value={"transport-belt": 1}):
            result = client.plan_build([
                {"name": "transport-belt", "anchor": {"x": 0, "y": 0}},
                {"name": "inserter", "anchor": {"x": 1, "y": 0}},
            ])
        self.assertFalse(result["ok"])
        self.assertEqual(result["missing_items"], [
            {"name": "inserter", "required": 1, "available": 0, "missing": 1},
        ])
        with patch.object(client, "observe_placement", return_value={
            "data": {"results": [{"ok": True, "can_place": True}]},
        }), patch.object(client, "inventory_counts",
                         side_effect=RuntimeError("player unavailable")):
            resilient = client.plan_build([{"name": "pipe", "anchor": {"x": 0, "y": 0}}])
        self.assertTrue(resilient["ok"])
        self.assertEqual(resilient["missing_items"], [])
        self.assertIn("inventory unavailable", resilient["warning"])
        with self.assertRaisesRegex(ValueError, "at least one entity"):
            client.plan_build([])

    def test_build_pipe_line_plans_and_submits_chunks(self):
        client = factorio.FactorioClient(poll_interval=0)
        calls = []

        def fake_build(entities, *, clear=True):
            calls.append((len(entities), clear))
            return {"job_id": f"job-{len(calls)}", "status": "completed",
                    "results": [{"ok": True} for _ in entities]}

        with patch.object(client, "build", side_effect=fake_build):
            result = client.build_pipe_line((0, 0), (120, 0), clear=False)
        self.assertEqual([size for size, _ in calls], [50, 50, 21])
        self.assertTrue(all(clear is False for _, clear in calls))
        self.assertTrue(result["ok"])
        self.assertEqual(result["chunks"], 3)
        self.assertEqual(len(result["entities"]), 121)
        self.assertEqual(result["job_ids"], ["job-1", "job-2", "job-3"])

    def test_builders_accept_plans_propagate_warnings_and_skip_empty(self):
        client = factorio.FactorioClient(poll_interval=0)
        plan = [{"name": "pipe", "anchor": {"x": 0, "y": 0}, "direction": 0}]
        with patch.object(client, "build", return_value={
            "status": "completed", "results": [{"ok": True}],
        }) as build:
            result = client.build_pipe_line(plan=plan)
        self.assertEqual(result["entities"], plan)
        build.assert_called_once_with(plan, clear=True)
        self.assertTrue(result["ok"])

        with patch.object(client, "build") as build:
            empty = client.build_pipe_line((2, 2), (2, 2))
        self.assertEqual(empty["chunks"], 0)
        self.assertTrue(empty["ok"])
        build.assert_not_called()

        def fake_build(entities, *, clear=True):
            return {"status": "completed",
                    "results": [{"ok": True} for _ in entities]}

        with patch.object(client, "build", side_effect=fake_build):
            outpost = client.build_mining_outpost(
                [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 2, "y": 0}])
            power = client.build_power_network({"x": 0, "y": 0, "radius": 4})
            defense = client.build_defense_line((0, 0), (16, 0), wall=None)
            inserter_pairs = client.build_inserter_pairs(
                [{"anchor": {"x": 0, "y": 0}}])
        self.assertTrue(outpost["ok"])
        self.assertTrue(any("need power" in warning for warning in outpost["warnings"]))
        self.assertTrue(power["ok"])
        self.assertEqual(len(power["entities"]), 4)
        self.assertTrue(defense["ok"])
        self.assertTrue(any("single wall layer" in warning for warning in defense["warnings"]))
        self.assertEqual(len(inserter_pairs["entities"]), 2)

        with patch.object(client, "build", side_effect=RuntimeError("queue unavailable")):
            failed = client.build_defense_line((0, 0), (16, 0), wall=None)
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["failed_chunk"], 0)
        self.assertIn("queue unavailable", failed["error"])


    def test_build_underground_lines_use_shared_executor(self):
        client = factorio.FactorioClient(poll_interval=0)
        chunks = []

        def fake_build(entities, *, clear=True):
            chunks.append(([dict(entity) for entity in entities], clear))
            return {"job_id": f"job-{len(chunks)}", "status": "completed",
                    "results": [{"ok": True} for _ in entities]}

        with patch.object(client, "build", side_effect=fake_build):
            result = client.build_underground_belt_line((0, 0), (10, 0), clear=False)
        self.assertTrue(result["ok"])
        self.assertEqual(result["chunks"], 1)
        built, clear = chunks[0]
        self.assertFalse(clear)
        self.assertEqual([entity.get("underground_type") for entity in built],
                         ["input", "output", None, "input", "output"])
        self.assertEqual(
            [(entity["anchor"]["x"], entity["anchor"]["y"]) for entity in built],
            [(0, 0), (4, 0), (5, 0), (6, 0), (10, 0)],
        )

        plan = [{"name": "underground-belt", "anchor": {"x": 3, "y": 3},
                 "direction": 4, "underground_type": "input"}]
        with patch.object(client, "build", return_value={
            "status": "completed", "results": [{"ok": True}],
        }) as build:
            planned = client.build_underground_belt_line(plan=plan)
        build.assert_called_once_with(plan, clear=True)
        self.assertEqual(planned["entities"], plan)

        chunks.clear()
        with patch.object(client, "build", side_effect=fake_build):
            pipe_result = client.build_underground_pipe_line((10, 0), (0, 0))
        self.assertTrue(pipe_result["ok"])
        # Distance 10 over a 10-tile span: one pair reaches the end, no connector.
        self.assertEqual([entity.get("underground_type") for entity in chunks[0][0]],
                         ["input", "output"])
        self.assertTrue(all(entity["direction"] == 12 for entity in chunks[0][0]))

        with patch.object(client, "build") as build:
            empty = client.build_underground_pipe_line(plan=[])
        build.assert_not_called()
        self.assertTrue(empty["ok"])
        self.assertEqual(empty["chunks"], 0)

        # Server-side subtype/item errors are surfaced unchanged in results.
        with patch.object(client, "build", return_value={
            "status": "completed",
            "results": [{"ok": False, "error": "invalid_underground_type"}],
        }):
            failed = client.build_underground_belt_line((0, 0), (4, 0))
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["results"][0]["error"], "invalid_underground_type")

        # Fatal chunk failures stop the remaining chunks and report failed_chunk.
        many = [{"name": "transport-belt", "anchor": {"x": index, "y": 0},
                 "direction": 4} for index in range(60)]
        with patch.object(client, "build", side_effect=[
            {"status": "completed", "results": [{"ok": True}] * 50},
            RuntimeError("queue down"),
        ]):
            stopped = client.build_underground_belt_line(plan=many)
        self.assertFalse(stopped["ok"])
        self.assertEqual(stopped["failed_chunk"], 1)
        self.assertIn("queue down", stopped["error"])
        self.assertEqual(len(stopped["job_ids"]), 1)


class DeconstructAreaTests(unittest.TestCase):
    def test_dry_run_forwards_observation_and_never_mines(self):
        client = factorio.FactorioClient(poll_interval=0)
        entities = [
            {"name": "transport-belt", "type": "transport-belt", "x": 0, "y": 0},
            {"name": "tree-01", "type": "tree", "x": -2, "y": 4},
        ]
        data = {
            "ok": True,
            "area": {"x": 1, "y": 2, "radius": 16},
            "counts": {"total": 12, "matched": 2, "included": 2},
            "entities": entities,
            "truncated": True,
            "player_only": False,
        }
        with patch.object(client, "observe_area",
                          return_value={"ok": True, "data": data}) as observe, \
                patch.object(client, "mine",
                             side_effect=AssertionError("dry run must not mine")) as mine:
            result = client.deconstruct_area(
                1, 2, radius=16, limit=5, types=["tree"], filters=["tree"],
                player_only=False, max_per_job=25, dry_run=True)
        observe.assert_called_once_with(
            1, 2, 16, limit=5, types=["tree"], filters=["tree"], player_only=False)
        mine.assert_not_called()
        self.assertTrue(result["ok"])
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["scanned"], 12)
        self.assertEqual(result["entities"], entities)
        self.assertEqual(result["counts"], {
            "total": 12,
            "matched": 2,
            "included": 2,
            "planned": 2,
            "by_type": {"transport-belt": 1, "tree": 1},
        })
        self.assertTrue(result["truncated"])
        self.assertEqual(result["matched"], 2)
        self.assertEqual(result["targets"], [
            {"x": 0, "y": 0, "kind": "entity", "name": "transport-belt"},
            {"x": -2, "y": 4, "kind": "entity", "name": "tree-01"},
        ])
        self.assertEqual(result["chunks"], 0)
        self.assertEqual(result["max_per_job"], 25)
        self.assertEqual(result["results"], [])
        self.assertEqual(result["job_ids"], [])

    def test_execute_chunks_50_and_aggregates_results(self):
        client = factorio.FactorioClient(poll_interval=0)
        calls = []

        def fake_mine(targets):
            calls.append([dict(target) for target in targets])
            return {"job_id": f"job-{len(calls)}", "status": "completed",
                    "results": [{"ok": True} for _ in targets]}

        with patch.object(client, "observe_area",
                          return_value=area_observation(120)), \
                patch.object(client, "mine", side_effect=fake_mine):
            result = client.deconstruct_area(0, 0, 64)
        self.assertEqual([len(chunk) for chunk in calls], [50, 50, 20])
        self.assertTrue(result["ok"])
        self.assertFalse(result["dry_run"])
        self.assertEqual(result["matched"], 120)
        self.assertEqual(result["chunks"], 3)
        self.assertEqual(result["max_per_job"], 50)
        self.assertEqual(len(result["results"]), 120)
        self.assertEqual(result["job_ids"], ["job-1", "job-2", "job-3"])
        self.assertNotIn("failed_chunk", result)

        calls.clear()
        with patch.object(client, "observe_area",
                          return_value=area_observation(60)), \
                patch.object(client, "mine", side_effect=fake_mine):
            custom = client.deconstruct_area(max_per_job=7)
        self.assertEqual([len(chunk) for chunk in calls], [7] * 8 + [4])
        self.assertEqual(custom["max_per_job"], 7)

        calls.clear()
        with patch.object(client, "observe_area",
                          return_value=area_observation(60)), \
                patch.object(client, "mine", side_effect=fake_mine):
            capped = client.deconstruct_area(max_per_job=500)
        self.assertEqual([len(chunk) for chunk in calls], [50, 10])
        self.assertEqual(capped["max_per_job"], 50)

    def test_per_entity_failures_aggregate_without_aborting(self):
        client = factorio.FactorioClient(poll_interval=0)
        calls = []

        def fake_mine(targets):
            calls.append(len(targets))
            results = [{"ok": True} for _ in targets]
            if len(calls) == 2:
                results[0] = {"ok": False, "error": "out_of_reach"}
            return {"job_id": f"job-{len(calls)}", "status": "completed",
                    "results": results}

        with patch.object(client, "observe_area",
                          return_value=area_observation(120)), \
                patch.object(client, "mine", side_effect=fake_mine):
            result = client.deconstruct_area()
        self.assertEqual(calls, [50, 50, 20])
        self.assertFalse(result["ok"])
        self.assertEqual(result["chunks"], 3)
        self.assertNotIn("failed_chunk", result)
        self.assertEqual(len(result["results"]), 120)
        self.assertEqual(result["results"][50]["error"], "out_of_reach")

    def test_fatal_chunk_stops_remaining_chunks(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "observe_area",
                          return_value=area_observation(120)), \
                patch.object(client, "mine", side_effect=[
                    {"job_id": "job-1", "status": "completed",
                     "results": [{"ok": True}] * 50},
                    RuntimeError("queue unavailable"),
                ]):
            result = client.deconstruct_area()
        self.assertFalse(result["ok"])
        self.assertEqual(result["failed_chunk"], 1)
        self.assertIn("queue unavailable", result["error"])
        self.assertEqual(len(result["results"]), 50)
        self.assertEqual(result["job_ids"], ["job-1"])

        with patch.object(client, "observe_area",
                          return_value=area_observation(120)), \
                patch.object(client, "mine", side_effect=[
                    {"job_id": "job-1", "status": "completed",
                     "results": [{"ok": True}] * 50},
                    {"status": "failed", "error": "RCON not connected"},
                ]):
            failed = client.deconstruct_area()
        self.assertEqual(failed["failed_chunk"], 1)
        self.assertIn("RCON not connected", failed["error"])

    def test_empty_area_no_op_and_error_paths(self):
        client = factorio.FactorioClient(poll_interval=0)
        empty = {"ok": True, "data": {
            "ok": True, "entities": [], "counts": {"total": 0}, "truncated": False,
        }}
        with patch.object(client, "observe_area", return_value=empty), \
                patch.object(client, "mine") as mine:
            result = client.deconstruct_area()
        mine.assert_not_called()
        self.assertTrue(result["ok"])
        self.assertEqual(result["chunks"], 0)
        self.assertEqual(result["results"], [])
        self.assertEqual(result["job_ids"], [])
        self.assertEqual(result["counts"]["planned"], 0)

        with patch.object(client, "observe_area", return_value={
            "ok": True, "data": {"ok": False, "error": "no_character"},
        }):
            with self.assertRaisesRegex(RuntimeError, "no_character"):
                client.deconstruct_area()
        with patch.object(client, "observe_area",
                          side_effect=RuntimeError("RCON not connected")):
            with self.assertRaisesRegex(RuntimeError, "RCON"):
                client.deconstruct_area()
        with patch.object(client, "observe_area") as observe:
            with self.assertRaisesRegex(ValueError, "at least 1"):
                client.deconstruct_area(max_per_job=0)
        observe.assert_not_called()

        malformed = {"ok": True, "data": {
            "ok": True,
            "entities": ["bad", {"name": "no-coords"},
                         {"name": "tree-01", "type": "tree", "x": 1, "y": 2}],
            "counts": {"total": 3},
        }}
        with patch.object(client, "observe_area", return_value=malformed), \
                patch.object(client, "mine", return_value={
                    "status": "completed", "results": [{"ok": True}]}) as mine:
            result = client.deconstruct_area()
        self.assertEqual(result["targets"],
                         [{"x": 1, "y": 2, "kind": "entity", "name": "tree-01"}])
        self.assertEqual(result["counts"]["planned"], 1)

    def test_resource_entities_use_resource_mining_kind(self):
        client = factorio.FactorioClient(poll_interval=0)
        data = {"ok": True, "data": {
            "ok": True,
            "entities": [
                {"name": "iron-ore", "type": "resource", "x": 5, "y": 6},
                {"name": "stone-furnace", "type": "furnace", "x": 7, "y": 8},
            ],
            "counts": {"total": 2, "matched": 2, "included": 2},
        }}
        with patch.object(client, "observe_area", return_value=data), \
                patch.object(client, "mine", return_value={
                    "status": "completed", "results": [{"ok": True}, {"ok": True}],
                }):
            result = client.deconstruct_area(types=["resource"], player_only=False)
        self.assertEqual(result["targets"], [
            {"x": 5, "y": 6, "kind": "resource", "name": "iron-ore"},
            {"x": 7, "y": 8, "kind": "entity", "name": "stone-furnace"},
        ])


class ConstructionCliTests(unittest.TestCase):
    def test_new_observe_commands_forward_to_http(self):
        with patch("factorio.http_request",
                   return_value={"ok": True, "data": {"scanned": 0}}) as http, \
                redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run([
                "observe-fluids", "--center-x", "1", "--center-y", "2", "--radius", "16"])
        self.assertEqual(code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["cmd"], "observe-fluids")
        self.assertEqual(payload["data"], {"scanned": 0})
        http.assert_called_once_with(
            factorio.DEFAULT_BASE, "POST", "/api/agent/observe/fluids",
            {"x": 1, "y": 2, "radius": 16},
        )

        with patch("factorio.http_request", return_value={"ok": True, "data": {}}) as http, \
                redirect_stdout(io.StringIO()):
            factorio.run(["observe-production"])
        http.assert_called_once_with(
            factorio.DEFAULT_BASE, "POST", "/api/agent/observe/production", {})

        with patch("factorio.http_request", return_value={"ok": True, "data": {}}) as http, \
                redirect_stdout(io.StringIO()):
            factorio.run(["observe-area", "--center-x", "3", "--center-y", "4",
                          "--radius", "12", "--limit", "5", "--types", "furnace",
                          "--filters", "iron-plate", "--player-only"])
        http.assert_called_once_with(
            factorio.DEFAULT_BASE, "POST", "/api/agent/observe/area",
            {
                "window": {"x": 3, "y": 4, "radius": 12},
                "limit": 5,
                "types": ["furnace"],
                "filters": ["iron-plate"],
                "player_only": True,
            },
        )

    def test_copy_settings_and_snapshot_cli(self):
        targets = [{"source": {"x": 1, "y": 2}, "target": {"x": 3, "y": 4}}]
        with patch("factorio.FactorioClient.copy_settings_check",
                   return_value={"ok": True, "data": {"ok": True}}) as check, \
                redirect_stdout(io.StringIO()):
            code = factorio.run([
                "observe-copy-settings", "--target", "1,2,3,4"])
        self.assertEqual(code, 0)
        check.assert_called_once_with(targets)

        with patch("factorio.FactorioClient.copy_settings",
                   return_value={"ok": True, "data": {"ok": False, "counts": {}}}) as copy, \
                redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run([
                "act-copy-settings", "--target", "1,2,3,4", "--dry-run"])
        self.assertEqual(code, 1)  # per-target failure reported in data.ok
        self.assertFalse(json.loads(stdout.getvalue())["data"]["ok"])
        copy.assert_called_once_with(targets, dry_run=True)

        with patch("factorio.FactorioClient.observe_snapshot",
                   return_value={"ok": True, "player": {}}) as snapshot, \
                redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run(["observe-snapshot", "--center-x", "5", "--radius", "8"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(stdout.getvalue())["ok"])
        snapshot.assert_called_once_with(x=5, y=None, radius=8)

        with redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run(["observe-copy-settings", "--target", "1,2"])
        self.assertEqual(code, 1)
        self.assertIn("Invalid --target", json.loads(stdout.getvalue())["error"])

    def test_build_commands_forward_planner_arguments(self):
        with patch("factorio.FactorioClient.build_pipe_line",
                   return_value={"ok": True, "chunks": 1}) as build, \
                redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run([
                "build-pipe-line", "--from", "0,0", "--to", "3,0", "--no-clear"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(stdout.getvalue())["ok"])
        build.assert_called_once_with(
            {"x": 0, "y": 0}, {"x": 3, "y": 0}, name="pipe", clear=False)

        with patch("factorio.FactorioClient.build_power_network",
                   return_value={"ok": True}) as build, redirect_stdout(io.StringIO()):
            factorio.run([
                "build-power-network", "--target", "1,1,3,3",
                "--big-pole-every", "2", "--pole", "medium-electric-pole"])
        build.assert_called_once_with(
            [{"x": 1, "y": 1, "width": 3, "height": 3}],
            pole="medium-electric-pole", big_pole_every=2, clear=True,
        )

        with patch("factorio.FactorioClient.build_inserter_pairs",
                   return_value={"ok": True}) as build, redirect_stdout(io.StringIO()):
            factorio.run([
                "build-inserter-pairs", "--entity", "0,0,3,3", "--direction", "west"])
        build.assert_called_once_with(
            [{"x": 0, "y": 0, "width": 3, "height": 3}],
            direction="west", inserter="inserter", clear=True,
        )

        with patch("factorio.FactorioClient.build_mining_outpost",
                   return_value={"ok": True}) as build, redirect_stdout(io.StringIO()):
            factorio.run([
                "build-mining-outpost", "--ore", "0,0", "--ore", "1,0",
                "--drill-size", "5,5"])
        build.assert_called_once_with(
            [{"x": 0, "y": 0}, {"x": 1, "y": 0}],
            drill="electric-mining-drill", drill_grid=(5, 5),
            output="iron-chest", clear=True,
        )

        with patch("factorio.FactorioClient.build_defense_line",
                   return_value={"ok": True}) as build, redirect_stdout(io.StringIO()):
            factorio.run([
                "build-defense-line", "--from", "0,0", "--to", "20,0",
                "--spacing", "6", "--ammo-chest", "wooden-chest", "--no-wall"])
        build.assert_called_once_with(
            {"x": 0, "y": 0}, {"x": 20, "y": 0},
            turret="gun-turret", wall=None, spacing=6,
            ammo_chest="wooden-chest", clear=True,
        )

        with patch("factorio.FactorioClient.build_power_network",
                   return_value={"ok": True}) as build, redirect_stdout(io.StringIO()):
            factorio.run(["build-power-network", "--area", "0,0,10"])
        build.assert_called_once_with(
            {"x": 0, "y": 0, "radius": 10},
            pole="small-electric-pole", big_pole_every=0, clear=True,
        )

        with patch("factorio.FactorioClient.build_mining_outpost",
                   return_value={"ok": True}) as build, redirect_stdout(io.StringIO()):
            factorio.run(["build-mining-outpost", "--area", "0,0,8"])
        build.assert_called_once_with(
            {"x": 0, "y": 0, "radius": 8},
            drill="electric-mining-drill", drill_grid=None,
            output="iron-chest", clear=True,
        )

        with redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run(["build-power-network"])
        self.assertEqual(code, 1)
        self.assertIn("Missing --target or --area",
                      json.loads(stdout.getvalue())["error"])
        with redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run(["build-defense-line", "--from", "0,0"])
        self.assertEqual(code, 1)
        self.assertIn("Missing --from or --to", json.loads(stdout.getvalue())["error"])

    def test_build_underground_commands_forward(self):
        with patch("factorio.FactorioClient.build_underground_belt_line",
                   return_value={"ok": True, "chunks": 1}) as build, \
                redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run([
                "build-underground-belt", "--from", "0,0", "--to", "10,0",
                "--name", "fast-transport-belt", "--max-distance", "5", "--no-clear"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(stdout.getvalue())["ok"])
        build.assert_called_once_with(
            {"x": 0, "y": 0}, {"x": 10, "y": 0},
            name="fast-transport-belt", max_distance=5, clear=False,
        )

        with patch("factorio.FactorioClient.build_underground_pipe_line",
                   return_value={"ok": True}) as build, redirect_stdout(io.StringIO()):
            factorio.run(["build-underground-pipe", "--from", "0,0", "--to", "12,0"])
        build.assert_called_once_with(
            {"x": 0, "y": 0}, {"x": 12, "y": 0}, max_distance=10, clear=True,
        )

        with patch("factorio.FactorioClient.build_underground_belt_line",
                   return_value={"ok": True}) as build, redirect_stdout(io.StringIO()):
            factorio.run(["build-underground-belt", "--from", "0,0", "--to", "4,0"])
        build.assert_called_once_with(
            {"x": 0, "y": 0}, {"x": 4, "y": 0},
            name="transport-belt", max_distance=None, clear=True,
        )

        with redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run(["build-underground-belt", "--from", "0,0"])
        self.assertEqual(code, 1)
        self.assertIn("Missing --from or --to", json.loads(stdout.getvalue())["error"])

        self.assertIn("underground_type", factorio.COMMAND_USAGE["act-build-blueprint"])
        self.assertIn("build-underground-pipe", factorio.COMMAND_USAGE)
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = factorio.run(["build-underground-pipe", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("--max-distance", stderr.getvalue())

    def test_deconstruct_area_cli_forwards_and_defaults(self):
        with patch("factorio.FactorioClient.deconstruct_area",
                   return_value={"ok": True, "dry_run": True}) as deconstruct, \
                redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run([
                "deconstruct-area", "--center-x", "5", "--center-y", "6",
                "--radius", "12", "--limit", "10", "--types", "tree",
                "--filters", "tree", "--include-all", "--max-per-job", "25",
                "--dry-run",
            ])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(stdout.getvalue())["ok"])
        deconstruct.assert_called_once_with(
            5, 6, 12, limit=10, types=["tree"], filters=["tree"],
            player_only=False, max_per_job=25, dry_run=True,
        )

        with patch("factorio.FactorioClient.deconstruct_area",
                   return_value={"ok": True}) as deconstruct, \
                redirect_stdout(io.StringIO()):
            factorio.run(["deconstruct-area"])
        deconstruct.assert_called_once_with(
            None, None, 64, limit=None, types=None, filters=None,
            player_only=True, max_per_job=50, dry_run=False,
        )

        with patch("factorio.FactorioClient.deconstruct_area",
                   side_effect=RuntimeError("RCON not connected")), \
                redirect_stdout(io.StringIO()) as stdout:
            code = factorio.run(["deconstruct-area"])
        self.assertEqual(code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertIn("RCON not connected", payload["error"])
        self.assertEqual(payload["cmd"], "deconstruct-area")

        self.assertIn("deconstruct-area", factorio.COMMAND_USAGE)
        self.assertIn("deconstruct-area", factorio.GLOBAL_USAGE)
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = factorio.run(["deconstruct-area", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("--include-all", stderr.getvalue())
        self.assertIn("--dry-run", stderr.getvalue())

    def test_help_lists_all_new_commands(self):
        commands = [
            "observe-production", "observe-fluids", "observe-combat", "observe-area",
            "observe-snapshot", "observe-copy-settings", "act-copy-settings",
            "deconstruct-area",
            "build-pipe-line", "build-power-network", "build-mining-outpost",
            "build-defense-line", "build-inserter-pairs",
            "build-underground-belt", "build-underground-pipe",
        ]
        for command in commands:
            self.assertIn(command, factorio.COMMAND_USAGE)
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = factorio.run(["build-pipe-line", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("--from x,y --to x,y", stderr.getvalue())


class BlueprintCliTestsExtra(unittest.TestCase):
    def test_blueprint_cli_commands_are_documented(self):
        self.assertIn("blueprint-list", factorio.COMMAND_USAGE)
        self.assertIn("blueprint-save", factorio.COMMAND_USAGE)
        self.assertIn("blueprint-list", factorio.GLOBAL_USAGE)
        self.assertIn("blueprint-save", factorio.GLOBAL_USAGE)
        self.assertIn("--source", factorio.COMMAND_USAGE["blueprint-save"])


class EntityUsageClientTests(unittest.TestCase):
    def test_entity_usage_catalog_payload_and_cli_usage(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "request", return_value={"ok": True}) as request:
            client.entity_usage_catalog()
        request.assert_called_once_with("GET", "/api/agent/observe/entity-usage-catalog")
        self.assertIn("entity-usage-catalog", factorio.COMMAND_USAGE)
        self.assertIn("entity-usage-catalog", factorio.GLOBAL_USAGE)

    def test_entity_usage_payload_and_cli_usage(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "request", return_value={"ok": True}) as request:
            client.entity_usage("splitter")
        request.assert_called_once_with(
            "POST",
            "/api/agent/observe/entity-usage",
            {"name": "splitter"},
        )
        self.assertIn("entity-usage", factorio.COMMAND_USAGE)
        self.assertIn("--name", factorio.COMMAND_USAGE["entity-usage"])
        self.assertIn("entity-usage", factorio.GLOBAL_USAGE)


class DescriptionClientTests(unittest.TestCase):
    def test_describe_payload_and_cli_usage(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.object(client, "request", return_value={"ok": True}) as request:
            client.describe("automation", kind="technology")
        request.assert_called_once_with(
            "POST",
            "/api/agent/observe/description",
            {"kind": "technology", "name": "automation"},
        )
        self.assertIn("describe", factorio.COMMAND_USAGE)
        self.assertIn("--kind", factorio.COMMAND_USAGE["describe"])
        self.assertIn("describe", factorio.GLOBAL_USAGE)


class BuildEntityNormalizationTests(unittest.TestCase):
    def test_canonical_and_shorthand_entities_are_normalized(self):
        canonical = factorio.normalize_build_entities(
            [{"name": "transport-belt", "anchor": {"x": 1, "y": 2}, "direction": 4}]
        )
        self.assertEqual(
            canonical,
            [{"name": "transport-belt", "anchor": {"x": 1, "y": 2}, "direction": 4}],
        )
        shorthand = factorio.normalize_build_entities(
            [{"name": "inserter", "x": "3", "y": 4, "direction": 0}]
        )
        self.assertEqual(
            shorthand,
            [{"name": "inserter", "anchor": {"x": 3.0, "y": 4.0}, "direction": 0}],
        )

    def test_malformed_entities_raise_instead_of_silently_building_nothing(self):
        with self.assertRaisesRegex(ValueError, "anchor"):
            factorio.normalize_build_entities([{"name": "transport-belt", "x": 1}])
        with self.assertRaisesRegex(ValueError, "name"):
            factorio.normalize_build_entities([{"anchor": {"x": 1, "y": 2}}])
        with self.assertRaisesRegex(ValueError, "JSON array"):
            factorio.normalize_build_entities({"name": "x"})
        with self.assertRaisesRegex(ValueError, "no entities"):
            factorio.normalize_build_entities([])


class ToolDiscoveryTests(unittest.TestCase):
    def test_local_and_fallback_manifests_are_available(self):
        client = factorio.FactorioClient(poll_interval=0)
        local = client.tools(local=True)
        self.assertTrue(local["local"])
        self.assertEqual(local["data"]["source"], "local")
        self.assertTrue(local["data"]["client_methods"])
        with patch.object(client, "request", side_effect=RuntimeError("offline")):
            fallback = client.tools()
        self.assertTrue(fallback["fallback"])
        self.assertEqual(fallback["data"]["source"], "local")
        self.assertTrue(fallback["data"]["client_methods"])

    def test_manager_manifest_marks_outdated_workspace_client(self):
        client = factorio.FactorioClient(poll_interval=0)
        manager = {
            "schema_version": 1,
            "sources": {"factorio.py": "different"},
            "client_methods": [],
            "cli_commands": [],
        }
        with patch.object(client, "request", return_value={"ok": True, "data": manager}):
            response = client.tools()
        self.assertTrue(response["data"]["client_outdated"])
        self.assertEqual(response["data"]["source"], "manager")


class BlueprintRegistryClientTests(unittest.TestCase):
    def test_save_and_list_blueprints(self):
        client = factorio.FactorioClient(poll_interval=0)
        wire = blueprint_text([
            {"entity_number": 1, "name": "stone-furnace", "position": {"x": 0.5, "y": 0.5}},
        ])
        with patch.object(client, "request", side_effect=[{"saved": True}, {"blueprints": []}]) as request:
            self.assertEqual(
                client.save_blueprint(
                    blueprint_payload([{"name": "stone-furnace", "position": {"x": 0, "y": 0}}]),
                    label="Smelting",
                    source="saved",
                    run_id="run-1",
                ),
                {"saved": True},
            )
            self.assertEqual(client.list_blueprints("run-1"), {"blueprints": []})
        save_call, list_call = request.call_args_list
        self.assertEqual(save_call.args[:2], ("POST", "/api/runs/run-1/blueprints"))
        self.assertEqual(save_call.args[2]["label"], "Smelting")
        self.assertEqual(list_call.args[:2], ("GET", "/api/runs/run-1/blueprints"))

    def test_active_run_blueprint_paths(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.dict(os.environ, {"AUTORIO_RUN_ID": "run-active"}, clear=False):
            with patch.object(client, "request", return_value={}) as request:
                client.save_blueprint("0")
        self.assertEqual(request.call_args.args[:2], ("POST", "/api/runs/run-active/blueprints"))

    def test_build_blueprint_auto_registers_when_run_id_is_present(self):
        client = factorio.FactorioClient(poll_interval=0)
        wire = belt_blueprint(1)
        with patch.dict(os.environ, {"AUTORIO_RUN_ID": "run-auto"}, clear=False):
            with patch.object(client, "save_blueprint") as save, patch.object(
                client, "build", return_value={"status": "completed", "results": [{"ok": True}]}
            ):
                client.build_blueprint(wire, prototype_sizes=BELT_SIZES)
        save.assert_called_once_with(wire, source="built", run_id="run-auto")

    def test_build_blueprint_skips_registry_without_run_id(self):
        client = factorio.FactorioClient(poll_interval=0)
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(client, "save_blueprint") as save, patch.object(
                client, "build", return_value={"status": "completed", "results": [{"ok": True}]}
            ):
                client.build_blueprint(belt_blueprint(1), prototype_sizes=BELT_SIZES)
        save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
