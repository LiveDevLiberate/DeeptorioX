#!/usr/bin/env python3
"""Tests for the autorio Gym-style environment, typed observations, and store.

No real Factorio game or autorio manager is required: ``FakeManager`` mirrors
the ``factorio.FactorioClient`` surface and returns fixture payloads shaped like
the manager's real responses.
"""

from __future__ import annotations

import copy
import json
import os
import sqlite3
import tempfile
import unittest

import factorio
from autorio_gym import FactorioEnv
from autorio_trajectory import TrajectoryStore
from autorio_types import (
    FactoryObservation,
    GameInfo,
    Inventory,
    Observation,
    PlayerState,
    ResearchObservation,
    WorldObservation,
)

# ---------------------------------------------------------------------------
# Fixtures shaped like the manager's /api/agent/observe/* responses.
# ---------------------------------------------------------------------------

STATUS_PAYLOAD = {
    "running": True,
    "pid": 4242,
    "save": "test.zip",
    "startedAt": "2026-11-03T12:00:00.000Z",
    "uptimeSec": 3600,
    "lastExit": None,
    "usage": {"cpuPercent": 1.0, "rssBytes": 1024},
    "rcon": {"connected": True, "port": 27015},
}

JOB = {"job_id": "job-1", "status": "completed", "results": [{"ok": True}]}

PLAYER_PAYLOAD = {
    "player": {
        "name": "autorio",
        "x": 10.5,
        "y": -4.25,
        "direction": 4,
        "health": 100.0,
        "energy": 25000.0,
        "cursor": {"name": "iron-plate", "count": 3},
        "inventories": [
            {
                "name": "main",
                "slots": [
                    {"slot": 1, "name": "iron-plate", "count": 25},
                    {"slot": 2, "name": "coal", "count": 10},
                ],
            },
            {"name": "guns", "slots": [{"slot": 1, "name": "pistol", "count": 1}]},
            {"name": "ammo", "slots": [{"slot": 1, "name": "firearm-magazine", "count": 50}]},
        ],
        "equipment": [{"name": "solar-panel", "pos_x": 0.0, "pos_y": 0.0, "energy": 0.0}],
        "crafting_queue": [{"recipe": "iron-gear-wheel", "count": 5, "prerequisite": None}],
    },
    "counts": {
        "inventory_total": 4,
        "inventory_included": 4,
        "equipment_total": 1,
        "equipment_included": 1,
    },
}

WORLD_PAYLOAD = {
    "window": {"min_x": -2, "min_y": -2, "max_x": 2, "max_y": 2},
    "terrain": {
        "encoding": "rle_rows",
        "rows": [{"y": -2, "runs": [{"x": -2, "length": 5, "name": "grass-1"}]}],
    },
    "entities": [
        {
            "name": "iron-ore",
            "type": "resource",
            "center": {"x": 2.5, "y": 0.5},
            "occupied_tile": {"x": 2, "y": 0},
            "collision_bounds": {"left": 2.0, "top": 0.0, "right": 3.0, "bottom": 1.0},
            "direction": 0,
            "force": "neutral",
            "health": None,
        },
        {
            "name": "stone-furnace",
            "type": "furnace",
            "center": {"x": 0.5, "y": 0.5},
            "occupied_tile": {"x": 0, "y": 0},
            "collision_bounds": {"left": 0.0, "top": 0.0, "right": 1.0, "bottom": 1.0},
            "direction": 0,
            "force": "player",
            "health": 200.0,
        },
    ],
    "counts": {
        "tiles_total": 25,
        "tiles_included": 25,
        "entities_total": 2,
        "entities_included": 2,
    },
    "charted_only": True,
}

FACTORY_PAYLOAD = {
    "window": {"x": 10, "y": -4, "radius": 120},
    "counts": {"stone-furnace": {"total": 2, "statuses": {"working": 2}}},
    "problems": {"no_fuel": [], "no_power": []},
    "totals": {"no_fuel": 0, "no_power": 0},
    "fuel": {"coal_in_fuel_slots": 40, "entities_without_fuel": 0, "entities_low_fuel": 0},
    "power": {
        "networks": 1,
        "maximum_production": 900000,
        "maximum_consumption": 300000,
        "total_transfer": 250000,
        "satisfaction": 0.98,
    },
    "alerts": [],
    "plan": {"tasks": [{"name": "automate iron gears"}]},
}

RESEARCH_PAYLOAD = {
    "current": {
        "name": "automation",
        "level": 0,
        "status": "researching",
        "progress": 0.25,
        "ingredients": [{"name": "automation-science-pack", "type": "item", "amount": 10}],
        "prerequisites": [],
        "missing_prerequisites": [],
    },
    "queue": [],
    "available": [{"name": "logistics", "status": "available", "unit_count": 20}],
    "upgrades": [],
    "triggers": [],
    "locked": [{"name": "rocket-silo", "status": "locked", "unit_count": 1000}],
    "completed": [],
    "counts": {
        "available_total": 1,
        "available_included": 1,
        "locked_total": 1,
        "locked_included": 1,
        "completed_total": 0,
        "completed_included": 0,
    },
}


def observation_payload() -> dict:
    """Aggregate observation payload as ``FactorioEnv.observe`` builds it."""
    return {
        "game": {
            "tick": 216000,
            "time": 3600.0,
            "speed": 1.0,
            "save": "test.zip",
            "running": True,
        },
        "player": copy.deepcopy(PLAYER_PAYLOAD),
        "world": copy.deepcopy(WORLD_PAYLOAD),
        "factory": copy.deepcopy(FACTORY_PAYLOAD),
        "research": copy.deepcopy(RESEARCH_PAYLOAD),
        "truncated": {"world": False},
    }


class FakeManager:
    """In-memory stand-in for ``factorio.FactorioClient`` recording calls."""

    def __init__(self, *, running: bool = True, save: str = "test.zip", job: dict | None = None):
        self.base_url = "http://fake.invalid"
        self.calls: list[tuple[str, tuple, dict]] = []
        self.status = copy.deepcopy(STATUS_PAYLOAD)
        self.status["running"] = running
        self.status["save"] = save
        self.status["pid"] = 4242 if running else None
        self.job = copy.deepcopy(JOB if job is None else job)
        self.start_error: Exception | None = None
        self.started: list[str] = []
        self.observe_errors: dict[str, Exception] = {}
        self.raw_observations: dict[str, dict] = {}
        self.payloads = {
            "world": copy.deepcopy(WORLD_PAYLOAD),
            "player": copy.deepcopy(PLAYER_PAYLOAD),
            "factory": copy.deepcopy(FACTORY_PAYLOAD),
            "research": copy.deepcopy(RESEARCH_PAYLOAD),
        }

    # -- call recording ----------------------------------------------------

    def _record(self, name: str, args: tuple, kwargs: dict) -> None:
        self.calls.append((name, args, kwargs))

    def calls_named(self, name: str) -> list[tuple[tuple, dict]]:
        return [(args, kwargs) for method, args, kwargs in self.calls if method == name]

    def method_names(self) -> list[str]:
        return [method for method, _args, _kwargs in self.calls]

    # -- server status/start ----------------------------------------------

    def server_status(self):
        self._record("server_status", (), {})
        return copy.deepcopy(self.status)

    def server_start(self, save):
        self._record("server_start", (save,), {})
        if self.start_error is not None:
            raise self.start_error
        self.started.append(save)
        return {"ok": True}

    # -- observations ------------------------------------------------------

    def _observation(self, name: str) -> dict:
        error = self.observe_errors.get(name)
        if error is not None:
            raise error
        override = self.raw_observations.get(name)
        if override is not None:
            return copy.deepcopy(override)
        return {"ok": True, "data": copy.deepcopy(self.payloads[name]), "truncated": False}

    def observe_world(self, *, x=0, y=0, radius=12, include=None):
        self._record(
            "observe_world", (), {"x": x, "y": y, "radius": radius, "include": include}
        )
        return self._observation("world")

    def observe_player(self, *, inventory_slots=None, equipment_slots=None):
        self._record(
            "observe_player",
            (),
            {"inventory_slots": inventory_slots, "equipment_slots": equipment_slots},
        )
        return self._observation("player")

    def observe_factory(self, *, x=None, y=None, radius=120):
        self._record("observe_factory", (), {"x": x, "y": y, "radius": radius})
        return self._observation("factory")

    def observe_research(self, *, available=None, locked=None, completed=None):
        self._record(
            "observe_research",
            (),
            {"available": available, "locked": locked, "completed": completed},
        )
        return self._observation("research")

    # -- actions -----------------------------------------------------------

    def _job(self, name: str, args: tuple, kwargs: dict) -> dict:
        self._record(name, args, kwargs)
        return copy.deepcopy(self.job)

    def build(self, entities, *, clear=True, **options):
        return self._job("build", (entities,), {"clear": clear, **options})

    def mine(self, targets, **options):
        return self._job("mine", (targets,), dict(options))

    def move(self, targets, **options):
        return self._job("move", (targets,), dict(options))

    def rotate(self, targets, **options):
        return self._job("rotate", (targets,), dict(options))

    def set_recipe(self, targets, **options):
        return self._job("set_recipe", (targets,), dict(options))

    def launch_rocket(self, targets, **options):
        return self._job("launch_rocket", (targets,), dict(options))

    def research(self, technology, **options):
        return self._job("research", (technology,), dict(options))

    def craft(self, item, count=1, **options):
        return self._job("craft", (item,), {"count": count, **options})

    def insert(self, entity, item, count=1, **options):
        return self._job("insert", (entity, item), {"count": count, **options})

    def extract(self, entity, item, count=1, **options):
        return self._job("extract", (entity, item), {"count": count, **options})


class EnvTestCase(unittest.TestCase):
    """Shared helper that builds an environment around a fake client."""

    def make_env(self, manager: FakeManager | None = None, **kwargs) -> tuple[FactorioEnv, FakeManager]:
        manager = FakeManager() if manager is None else manager
        options: dict = {"client": manager, "autostart": False}
        options.update(kwargs)
        env = FactorioEnv(**options)
        self.addCleanup(env.close)
        return env, manager


# ---------------------------------------------------------------------------
# Typed observations
# ---------------------------------------------------------------------------


class TypedObservationTests(unittest.TestCase):
    def test_aggregate_parses_manager_shapes(self):
        observation = Observation.from_dict(observation_payload())
        self.assertEqual(observation.game.tick, 216000)
        self.assertEqual(observation.game.time, 3600.0)
        self.assertEqual(observation.game.save, "test.zip")
        self.assertIs(observation.game.running, True)

        player = observation.player
        self.assertEqual(player.name, "autorio")
        self.assertEqual(player.position, {"x": 10.5, "y": -4.25})
        self.assertEqual(player.health, 100.0)
        self.assertEqual(player.direction, 4)
        self.assertEqual(player.inventory["iron-plate"], 25)
        self.assertEqual(player.inventory["coal"], 10)
        self.assertEqual(player.inventory["firearm-magazine"], 50)
        self.assertEqual(player.inventory["unobtainium"], 0)
        self.assertEqual(player.inventory.total_items, 86)
        self.assertEqual(player.crafting_queue[0]["recipe"], "iron-gear-wheel")

        world = observation.world
        self.assertEqual(len(world.entities), 2)
        self.assertEqual(world.entities[0]["type"], "resource")
        self.assertEqual(world.terrain["encoding"], "rle_rows")
        self.assertEqual(world.counts["entities_included"], 2)
        self.assertEqual(world.window["max_x"], 2)

        factory = observation.factory
        self.assertEqual(factory.power["satisfaction"], 0.98)
        self.assertEqual(factory.fuel["coal_in_fuel_slots"], 40)
        self.assertEqual(factory.plan["tasks"][0]["name"], "automate iron gears")
        self.assertEqual(factory.alerts, [])

        research = observation.research
        self.assertEqual(research.current["name"], "automation")
        self.assertEqual(research.available[0]["name"], "logistics")
        self.assertEqual(research.counts["available_total"], 1)

    def test_raw_keeps_original_payload(self):
        payload = observation_payload()
        observation = Observation.from_dict(payload)
        self.assertEqual(observation.raw["player"], PLAYER_PAYLOAD)
        self.assertEqual(observation.raw["truncated"], {"world": False})
        self.assertEqual(observation.raw["game"]["tick"], 216000)

    def test_to_dict_round_trips_and_is_json_serializable(self):
        observation = Observation.from_dict(observation_payload())
        data = observation.to_dict()
        self.assertEqual(Observation.from_dict(data).to_dict(), data)
        # Unknown aggregate keys land in ``extra`` and survive the round trip.
        self.assertTrue(json.dumps(data))
        self.assertNotIn("raw", data)

    def test_missing_and_malformed_keys_use_defaults(self):
        observation = Observation.from_dict({})
        self.assertEqual(observation.game.tick, 0)
        self.assertEqual(observation.game.time, 0.0)
        self.assertEqual(observation.game.speed, 1.0)
        self.assertIsNone(observation.game.save)
        self.assertIsNone(observation.player.name)
        self.assertEqual(observation.player.position, {})
        self.assertEqual(observation.player.inventory.counts, {})
        self.assertEqual(observation.world.entities, [])
        self.assertIsNone(observation.research.current)
        self.assertEqual(Observation.from_dict(None).to_dict()["game"]["tick"], 0)

        tolerant = Observation.from_dict(
            {"player": "nonsense", "world": None, "factory": [], "research": 3, "game": "x"}
        )
        self.assertEqual(tolerant.player.name, None)
        self.assertEqual(tolerant.world.entities, [])
        self.assertEqual(tolerant.to_dict()["factory"]["alerts"], [])

    def test_unknown_keys_are_preserved(self):
        player = PlayerState.from_dict(
            {"name": "p", "x": 1, "y": 2, "future_field": {"a": 1}}
        )
        self.assertEqual(player.extra["future_field"], {"a": 1})
        self.assertEqual(player.to_dict()["future_field"], {"a": 1})

        game = GameInfo.from_dict({"tick": "120", "time": "2.5", "extra_key": "v"})
        self.assertEqual(game.tick, 120)
        self.assertEqual(game.time, 2.5)
        self.assertEqual(game.to_dict()["extra_key"], "v")

        world = WorldObservation.from_dict({"entities": "bad", "future": [1, 2]})
        self.assertEqual(world.entities, [])
        self.assertEqual(world.to_dict()["future"], [1, 2])

        factory = FactoryObservation.from_dict({"alerts": "bad", "plan": {"id": 7}})
        self.assertEqual(factory.alerts, [])
        self.assertEqual(factory.plan, {"id": 7})

        research = ResearchObservation.from_dict({"current": "bad", "queue": None})
        self.assertIsNone(research.current)
        self.assertEqual(research.queue, [])

    def test_player_wrapper_and_inventory_forms(self):
        wrapped = PlayerState.from_dict({"player": copy.deepcopy(PLAYER_PAYLOAD["player"])})
        self.assertEqual(wrapped.name, "autorio")
        self.assertEqual(wrapped.inventory["pistol"], 1)

        inventory = Inventory.from_dict(PLAYER_PAYLOAD["player"]["inventories"])
        self.assertEqual(inventory["iron-plate"], 25)
        self.assertIn("coal", inventory)
        self.assertNotIn("unobtainium", inventory)
        self.assertEqual(inventory.get("unobtainium", 7), 7)
        self.assertEqual(len(inventory), 4)

        counted = Inventory.from_dict({"counts": {"iron-plate": "7", "coal": 2}})
        self.assertEqual(counted["iron-plate"], 7)
        self.assertEqual(counted.counts, {"iron-plate": 7, "coal": 2})

        inferred = Inventory.from_dict(
            {"slots": [{"name": "coal", "count": 4}, {"name": "coal", "count": 6}, "junk"]}
        )
        self.assertEqual(inferred["coal"], 10)
        self.assertEqual(Inventory.counts_from_slots([{"name": None, "count": 1}]), {})

        self.assertEqual(Inventory.from_dict(inferred.to_dict()), inferred)

    def test_inventory_rejects_non_string_keys(self):
        with self.assertRaises(TypeError):
            Inventory.from_dict({"counts": {"coal": 1}})[0]


# ---------------------------------------------------------------------------
# Environment reset / observation plumbing
# ---------------------------------------------------------------------------


class EnvironmentResetTests(EnvTestCase):
    def test_reset_returns_typed_observation(self):
        env, manager = self.make_env()
        observation = env.reset()
        self.assertIsInstance(observation, Observation)
        self.assertIs(env.observation, observation)
        names = manager.method_names()
        self.assertEqual(
            names[:4],
            ["observe_world", "observe_player", "observe_factory", "observe_research"],
        )
        self.assertNotIn("server_start", names)

        self.assertEqual(observation.player.inventory["iron-plate"], 25)
        self.assertEqual(observation.game.time, 3600.0)
        self.assertEqual(observation.game.tick, 216000)
        self.assertEqual(observation.game.save, "test.zip")
        self.assertIs(observation.game.running, True)
        self.assertEqual(observation.raw["truncated"]["world"], False)

    def test_reset_applies_observation_options(self):
        env, manager = self.make_env()
        env.reset(
            {
                "x": 5,
                "y": 6,
                "radius": 20,
                "include": ["entities"],
                "factory_radius": 40,
                "inventory_slots": 10,
                "equipment_slots": 3,
                "available": 5,
                "locked": 2,
                "completed": 1,
            }
        )
        world_args, world_kwargs = manager.calls_named("observe_world")[0]
        self.assertEqual(
            world_kwargs,
            {"x": 5, "y": 6, "radius": 20, "include": ["entities"]},
        )
        _args, player_kwargs = manager.calls_named("observe_player")[0]
        self.assertEqual(player_kwargs, {"inventory_slots": 10, "equipment_slots": 3})
        _args, factory_kwargs = manager.calls_named("observe_factory")[0]
        self.assertEqual(factory_kwargs, {"x": 5, "y": 6, "radius": 40})
        _args, research_kwargs = manager.calls_named("observe_research")[0]
        self.assertEqual(research_kwargs, {"available": 5, "locked": 2, "completed": 1})

    def test_render_fetches_a_fresh_observation(self):
        env, manager = self.make_env()
        env.reset()
        manager.calls.clear()
        rendered = env.render()
        self.assertIsInstance(rendered, Observation)
        self.assertEqual(len(manager.calls_named("observe_world")), 1)

    def test_observe_rejects_failed_envelope(self):
        env, manager = self.make_env()
        env.reset()
        manager.raw_observations["world"] = {"ok": False, "error": "rcon down"}
        with self.assertRaises(RuntimeError):
            env.observe()

    def test_autostart_starts_configured_save_when_stopped(self):
        manager = FakeManager(running=False)
        env, _manager = self.make_env(manager, autostart=True, save="demo.zip")
        observation = env.reset()
        self.assertIsInstance(observation, Observation)
        self.assertEqual(manager.started, ["demo.zip"])
        self.assertEqual(len(manager.calls_named("server_start")), 1)

    def test_autostart_skips_start_when_running(self):
        manager = FakeManager(running=True)
        env, _manager = self.make_env(manager, autostart=True, save="demo.zip")
        env.reset()
        self.assertEqual(manager.started, [])
        self.assertEqual(manager.calls_named("server_start"), [])

    def test_autostart_tolerates_already_running_race(self):
        manager = FakeManager(running=False)
        manager.start_error = RuntimeError("Server already running")
        env, _manager = self.make_env(manager, autostart=True, save="demo.zip")
        observation = env.reset()
        self.assertIsInstance(observation, Observation)
        self.assertEqual(len(manager.calls_named("server_start")), 1)

    def test_autostart_without_save_attaches_without_starting(self):
        manager = FakeManager(running=False)
        env, _manager = self.make_env(manager, autostart=True, save=None)
        observation = env.reset()
        self.assertIsInstance(observation, Observation)
        self.assertEqual(manager.calls_named("server_start"), [])
        # No save means "attach": the first manager call is an observation.
        self.assertEqual(manager.method_names()[0], "observe_world")

    def test_autostart_false_never_starts(self):
        manager = FakeManager(running=False)
        env, _manager = self.make_env(manager, autostart=False, save="demo.zip")
        env.reset()
        self.assertNotIn("server_start", manager.method_names())

    def test_reset_options_save_overrides_constructor_save(self):
        manager = FakeManager(running=False)
        env, _manager = self.make_env(manager, autostart=True, save=None)
        env.reset({"save": "override.zip"})
        self.assertEqual(manager.started, ["override.zip"])

    def test_default_client_integration(self):
        env = FactorioEnv(base="http://127.0.0.1:9", autostart=False, max_steps=5)
        self.addCleanup(env.close)
        self.assertIsInstance(env.client, factorio.FactorioClient)
        self.assertEqual(env.client.base_url, "http://127.0.0.1:9")
        self.assertEqual(env.base_url, "http://127.0.0.1:9")


# ---------------------------------------------------------------------------
# Action dispatch
# ---------------------------------------------------------------------------


class ActionDispatchTests(EnvTestCase):
    DISPATCH_CASES = [
        (
            {"type": "build", "entities": [{"name": "stone-furnace", "anchor": {"x": 1, "y": 2}, "direction": 0}]},
            "build",
            ([{"name": "stone-furnace", "anchor": {"x": 1, "y": 2}, "direction": 0}],),
            {"clear": True},
        ),
        (
            {
                "type": "build",
                "entities": [{"name": "wooden-chest", "anchor": {"x": 3, "y": 4}}],
                "clear_obstacles": False,
            },
            "build",
            ([{"name": "wooden-chest", "anchor": {"x": 3, "y": 4}}],),
            {"clear": False},
        ),
        ({"type": "mine", "targets": [{"x": 1, "y": 2}]}, "mine", ([{"x": 1, "y": 2}],), {}),
        ({"type": "move", "targets": [{"x": 3, "y": 4}]}, "move", ([{"x": 3, "y": 4}],), {}),
        (
            {"type": "craft", "item": "iron-gear-wheel", "count": 3},
            "craft",
            ("iron-gear-wheel",),
            {"count": 3},
        ),
        (
            {"type": "set_recipe", "targets": [{"x": 1, "y": 2, "recipe": "iron-gear-wheel"}]},
            "set_recipe",
            ([{"x": 1, "y": 2, "recipe": "iron-gear-wheel"}],),
            {},
        ),
        ({"type": "research", "technology": "automation"}, "research", ("automation",), {}),
        (
            {"type": "insert", "entity": {"x": 1, "y": 2}, "item": "coal", "count": 5},
            "insert",
            ({"x": 1, "y": 2}, "coal"),
            {"count": 5},
        ),
        (
            {"type": "extract", "entity": {"x": 1, "y": 2}, "item": "iron-plate", "count": "all"},
            "extract",
            ({"x": 1, "y": 2}, "iron-plate"),
            {"count": "all"},
        ),
        (
            {"type": "launch_rocket", "targets": [{"x": 9, "y": 9}]},
            "launch_rocket",
            ([{"x": 9, "y": 9}],),
            {},
        ),
        ({"type": "rotate", "targets": [{"x": 2, "y": 2}]}, "rotate", ([{"x": 2, "y": 2}],), {}),
    ]

    def test_each_action_dispatches_to_client_method(self):
        for action, method, expected_args, expected_kwargs in self.DISPATCH_CASES:
            with self.subTest(action=action["type"], kwargs=expected_kwargs):
                env, manager = self.make_env()
                env.reset()
                manager.calls.clear()
                observation, reward, terminated, truncated, info = env.step(action)
                self.assertIsInstance(observation, Observation)
                self.assertEqual(reward, 0.0)
                self.assertFalse(terminated)
                self.assertFalse(truncated)
                self.assertEqual(info["step"], 0)
                self.assertEqual(info["action"], action["type"])
                self.assertEqual(info["result"], JOB)
                calls = manager.calls_named(method)
                self.assertEqual(len(calls), 1, f"expected one {method} call, got {calls}")
                self.assertEqual(calls[0][0], expected_args)
                self.assertEqual(calls[0][1], expected_kwargs)

    def test_observe_and_noop_submit_no_action(self):
        env, manager = self.make_env()
        env.reset()
        manager.calls.clear()
        observation, reward, terminated, truncated, info = env.step({"type": "noop"})
        self.assertIsNone(info["result"])
        self.assertEqual(reward, 0.0)
        self.assertIsInstance(observation, Observation)
        self.assertEqual(
            manager.method_names(),
            ["observe_world", "observe_player", "observe_factory", "observe_research", "server_status"],
        )
        env.step({"type": "observe"})

    def test_unknown_or_malformed_actions_raise_without_advancing(self):
        invalid_actions = [
            "noop",
            {},
            {"type": ""},
            {"type": "teleport", "targets": [{"x": 1, "y": 1}]},
            {"type": "mine"},
            {"type": "build", "entities": []},
            {"type": "craft", "count": 2},
            {"type": "craft", "item": "coal", "count": 0},
            {"type": "insert", "item": "coal", "count": 1},
            {"type": "extract", "entity": {"x": 1, "y": 2}, "item": "coal", "count": "many"},
            {"type": "research"},
            {"type": "move", "targets": ["bad"]},
        ]
        env, manager = self.make_env()
        env.reset()
        manager.calls.clear()
        for action in invalid_actions:
            with self.subTest(action=action):
                with self.assertRaises(ValueError):
                    env.step(action)
        self.assertEqual(env.step_index, 0)
        self.assertEqual(manager.calls, [])
        _observation, _reward, _terminated, _truncated, info = env.step({"type": "noop"})
        self.assertEqual(info["step"], 0)

    def test_step_before_reset_raises(self):
        env, _manager = self.make_env()
        with self.assertRaises(RuntimeError):
            env.step({"type": "noop"})


# ---------------------------------------------------------------------------
# Rewards, termination and truncation
# ---------------------------------------------------------------------------


class RewardAndTerminationTests(EnvTestCase):
    def test_default_reward_is_zero(self):
        env, _manager = self.make_env()
        env.reset()
        _observation, reward, terminated, truncated, _info = env.step({"type": "noop"})
        self.assertEqual(reward, 0.0)
        self.assertFalse(terminated)
        self.assertFalse(truncated)
        self.assertEqual(env.total_reward, 0.0)

    def test_reward_fn_receives_action_result_and_observation(self):
        seen = []

        def reward_fn(action, result, observation):
            seen.append((action, result, observation))
            return observation.player.inventory["iron-plate"] - 20

        env, _manager = self.make_env(reward_fn=reward_fn)
        env.reset()
        observation, reward, _terminated, _truncated, _info = env.step({"type": "noop"})
        self.assertEqual(reward, 5.0)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][0], {"type": "noop"})
        self.assertEqual(seen[0][1], None)
        self.assertIs(seen[0][2], observation)
        self.assertEqual(env.total_reward, 5.0)

    def test_reward_fn_none_and_invalid_returns(self):
        env, _manager = self.make_env(reward_fn=lambda action, result, observation: None)
        env.reset()
        self.assertEqual(env.step({"type": "noop"})[1], 0.0)

        bad_env, _manager = self.make_env(
            reward_fn=lambda action, result, observation: "not-a-number"
        )
        bad_env.reset()
        with self.assertRaises(TypeError):
            bad_env.step({"type": "noop"})

    def test_episode_level_reward_fn_override(self):
        env, _manager = self.make_env(reward_fn=lambda action, result, observation: 1.0)
        env.reset({"reward_fn": lambda action, result, observation: 42.0})
        self.assertEqual(env.step({"type": "noop"})[1], 42.0)

    def test_task_verifier_two_arguments_terminates(self):
        env, _manager = self.make_env(
            task_verifier=lambda result, observation: observation.player.inventory["iron-plate"] >= 25
        )
        env.reset()
        observation, _reward, terminated, truncated, info = env.step({"type": "noop"})
        self.assertIsInstance(observation, Observation)
        self.assertTrue(terminated)
        self.assertFalse(truncated)
        self.assertTrue(info["verification"])
        self.assertTrue(env.done)
        with self.assertRaises(RuntimeError):
            env.step({"type": "noop"})

    def test_task_verifier_single_argument_and_dict_result(self):
        env, _manager = self.make_env(
            task_verifier=lambda observation: observation.player.health is not None
        )
        env.reset()
        self.assertTrue(env.step({"type": "noop"})[2])

        dict_env, _manager = self.make_env(task_verifier=lambda result, observation: {"done": True})
        dict_env.reset()
        self.assertTrue(dict_env.step({"type": "noop"})[2])

        false_env, _manager = self.make_env(task_verifier=lambda observation: False)
        false_env.reset()
        self.assertFalse(false_env.step({"type": "noop"})[2])

    def test_max_steps_truncates(self):
        env, _manager = self.make_env(max_steps=2)
        env.reset()
        self.assertFalse(env.step({"type": "noop"})[3])
        _observation, _reward, terminated, truncated, info = env.step({"type": "noop"})
        self.assertFalse(terminated)
        self.assertTrue(truncated)
        self.assertEqual(info["step"], 1)
        self.assertTrue(env.done)
        with self.assertRaises(RuntimeError):
            env.step({"type": "noop"})

    def test_max_steps_none_never_truncates(self):
        env, _manager = self.make_env(max_steps=None)
        env.reset()
        for _ in range(3):
            self.assertFalse(env.step({"type": "noop"})[3])

    def test_terminal_job_status_truncates(self):
        for status in ("failed", "cancelled"):
            with self.subTest(status=status):
                manager = FakeManager(job={"job_id": "j", "status": status})
                env, _manager = self.make_env(manager)
                env.reset()
                _observation, _reward, terminated, truncated, info = env.step(
                    {"type": "research", "technology": "automation"}
                )
                self.assertFalse(terminated)
                self.assertTrue(truncated)
                self.assertEqual(info["terminal_status"], status)

    def test_reset_restarts_finished_episode(self):
        env, _manager = self.make_env(max_steps=1)
        env.reset()
        env.step({"type": "noop"})
        self.assertTrue(env.done)
        env.reset()
        self.assertFalse(env.done)
        self.assertEqual(env.step_index, 0)
        self.assertEqual(env.total_reward, 0.0)


# ---------------------------------------------------------------------------
# Trajectory store
# ---------------------------------------------------------------------------


class TrajectoryStoreTests(unittest.TestCase):
    def test_episode_and_step_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "nested", "deeper", "trajectory.db")
            store = TrajectoryStore(path)
            try:
                self.assertEqual(store.list_episodes(), [])
                episode_id = store.start_episode(
                    {"name": "demo", "save": "test.zip", "max_steps": 10}
                )
                self.assertIsInstance(episode_id, int)
                observation = Observation.from_dict(observation_payload())
                store.record_step(
                    episode_id,
                    0,
                    {"type": "noop"},
                    observation,
                    1.5,
                    False,
                    False,
                    {"step": 0},
                )
                store.record_step(
                    episode_id,
                    1,
                    {"type": "build", "entities": [{"name": "wooden-chest"}]},
                    observation,
                    -0.5,
                    True,
                    False,
                    {"step": 1, "result": {"status": "completed"}},
                )
                store.end_episode(episode_id, 1.0, "terminated")

                episodes = store.list_episodes()
                self.assertEqual(len(episodes), 1)
                episode = episodes[0]
                self.assertEqual(episode["id"], episode_id)
                self.assertEqual(episode["name"], "demo")
                self.assertEqual(episode["config"]["save"], "test.zip")
                self.assertEqual(episode["total_reward"], 1.0)
                self.assertEqual(episode["step_count"], 2)
                self.assertEqual(episode["status"], "terminated")
                self.assertIsNotNone(episode["ended_at"])
                self.assertTrue(episode["started_at"].endswith("Z"))

                steps = store.get_steps(episode_id)
                self.assertEqual([step["step_index"] for step in steps], [0, 1])
                self.assertEqual(steps[0]["action"], {"type": "noop"})
                self.assertEqual(steps[0]["reward"], 1.5)
                self.assertFalse(steps[0]["terminated"])
                self.assertFalse(steps[0]["truncated"])
                self.assertEqual(steps[0]["info"], {"step": 0})
                self.assertEqual(steps[1]["action"]["type"], "build")
                self.assertTrue(steps[1]["terminated"])
                self.assertEqual(steps[1]["observation"]["player"]["inventory"]["counts"]["iron-plate"], 25)
                self.assertEqual(steps[1]["observation"]["game"]["tick"], 216000)
                self.assertTrue(json.dumps(steps[1]["observation"]))
                self.assertEqual(store.get_episode(episode_id)["status"], "terminated")
                self.assertIsNone(store.get_episode(999))
                self.assertEqual(store.get_steps(999), [])
            finally:
                store.close()

            connection = sqlite3.connect(path)
            try:
                journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
            finally:
                connection.close()
            self.assertEqual(str(journal_mode).lower(), "wal")

    def test_writes_validate_episode_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TrajectoryStore(os.path.join(directory, "trajectory.db"))
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    store.record_step(999, 0, {"type": "noop"}, {}, 0.0, False, False, {})
                with self.assertRaises(KeyError):
                    store.end_episode(999, 0.0, "closed")
                self.assertEqual(store.list_episodes(), [])
            finally:
                store.close()

    def test_close_is_idempotent_and_blocks_use(self):
        store = TrajectoryStore(":memory:")
        store.close()
        store.close()
        with self.assertRaises(RuntimeError):
            store.list_episodes()
        with self.assertRaises(RuntimeError):
            store.start_episode({"name": "late"})

    def test_context_manager(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "trajectory.db")
            with TrajectoryStore(path) as store:
                episode_id = store.start_episode({"name": "ctx"})
                store.end_episode(episode_id, 0.0, "closed")
            with TrajectoryStore(path) as reopened:
                self.assertEqual(len(reopened.list_episodes()), 1)


class EnvironmentTrajectoryTests(EnvTestCase):
    def _read_store(self, path: str) -> TrajectoryStore:
        store = TrajectoryStore(path)
        self.addCleanup(store.close)
        return store

    def test_env_records_episode_and_steps(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "autorio", "trajectories.db")
            env, _manager = self.make_env(trajectory_path=path, max_steps=10)
            env.reset({"name": "unit-test"})
            self.assertIsNotNone(env.episode_id)
            env.step({"type": "noop"})
            env.step({"type": "craft", "item": "iron-gear-wheel", "count": 2})
            env.close()

            store = self._read_store(path)
            episodes = store.list_episodes()
            self.assertEqual(len(episodes), 1)
            episode = episodes[0]
            self.assertEqual(episode["name"], "unit-test")
            self.assertEqual(episode["status"], "closed")
            self.assertEqual(episode["step_count"], 2)
            self.assertEqual(episode["config"]["max_steps"], 10)
            self.assertIsNone(episode["config"]["save"])

            steps = store.get_steps(episode["id"])
            self.assertEqual(len(steps), 2)
            self.assertEqual(steps[0]["action"], {"type": "noop"})
            self.assertEqual(steps[1]["action"]["type"], "craft")
            self.assertEqual(steps[1]["info"]["step"], 1)
            self.assertEqual(steps[1]["info"]["episode_id"], episode["id"])
            stored_observation = steps[1]["observation"]
            self.assertEqual(stored_observation["player"]["name"], "autorio")
            self.assertEqual(
                stored_observation["player"]["inventory"]["counts"]["iron-plate"], 25
            )
            self.assertEqual(stored_observation["world"]["terrain"]["encoding"], "rle_rows")
            self.assertEqual(stored_observation["factory"]["power"]["satisfaction"], 0.98)

    def test_terminated_episode_records_reward_and_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "terminated.db")
            env, _manager = self.make_env(
                trajectory_path=path,
                reward_fn=lambda action, result, observation: 2.5,
                task_verifier=lambda result, observation: True,
            )
            env.reset()
            _observation, reward, terminated, _truncated, _info = env.step({"type": "noop"})
            self.assertTrue(terminated)
            self.assertEqual(reward, 2.5)
            env.close()

            store = self._read_store(path)
            episode = store.list_episodes()[0]
            self.assertEqual(episode["status"], "terminated")
            self.assertEqual(episode["total_reward"], 2.5)
            steps = store.get_steps(episode["id"])
            self.assertTrue(steps[0]["terminated"])
            self.assertEqual(steps[0]["reward"], 2.5)
            self.assertTrue(steps[0]["info"]["verification"])

    def test_truncated_episode_records_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "truncated.db")
            env, _manager = self.make_env(trajectory_path=path, max_steps=1)
            env.reset()
            env.step({"type": "noop"})
            env.close()

            store = self._read_store(path)
            episode = store.list_episodes()[0]
            self.assertEqual(episode["status"], "truncated")
            self.assertTrue(store.get_steps(episode["id"])[0]["truncated"])

    def test_reset_abandons_previous_episode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "reset.db")
            env, _manager = self.make_env(trajectory_path=path)
            env.reset({"name": "first"})
            first_id = env.episode_id
            env.reset({"name": "second"})
            env.close()

            store = self._read_store(path)
            episodes = store.list_episodes()
            self.assertEqual(len(episodes), 2)
            self.assertEqual(episodes[0]["id"], first_id)
            self.assertEqual(episodes[0]["status"], "reset")
            self.assertIsNotNone(episodes[0]["ended_at"])
            self.assertEqual(episodes[1]["status"], "closed")


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


class EnvironmentLifecycleTests(EnvTestCase):
    def test_close_finishes_active_episode_and_blocks_use(self):
        env, _manager = self.make_env()
        env.reset()
        env.close()
        self.assertTrue(env.closed)
        env.close()  # idempotent
        with self.assertRaises(RuntimeError):
            env.reset()
        with self.assertRaises(RuntimeError):
            env.step({"type": "noop"})
        with self.assertRaises(RuntimeError):
            env.observe()

    def test_context_manager_closes_environment(self):
        manager = FakeManager()
        with FactorioEnv(client=manager, autostart=False) as env:
            env.reset()
            self.assertFalse(env.closed)
        self.assertTrue(env.closed)

    def test_invalid_max_steps_rejected(self):
        with self.assertRaises(ValueError):
            FactorioEnv(client=FakeManager(), max_steps=-1)


if __name__ == "__main__":
    unittest.main()
