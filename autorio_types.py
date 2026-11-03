#!/usr/bin/env python3
"""Typed dataclasses for observations returned by the autorio Factorio manager.

The manager's gameplay API (``/api/agent/observe/*``) returns loosely typed
JSON. These classes parse that JSON into small, predictable Python objects so a
Gym-style environment (``autorio_gym.FactorioEnv``) and a trajectory recorder
(``autorio_trajectory.TrajectoryStore``) can rely on a stable shape.

Design notes
------------
* Parsing is tolerant: missing keys fall back to documented defaults and
  unknown keys are kept in ``extra`` and re-emitted by ``to_dict``.
* Every class implements ``from_dict`` and ``to_dict``. ``to_dict`` returns
  plain, JSON-serializable values and survives a ``from_dict`` round trip.
* ``Observation.raw`` keeps the original dictionary for callers that need data
  the typed view does not model (for example per-endpoint ``truncated`` flags).
* Standard library only: importing this module does not require gymnasium,
  numpy, or Factorio to be installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, TypeVar

__all__ = [
    "FactoryObservation",
    "GameInfo",
    "Inventory",
    "Observation",
    "PlayerState",
    "ResearchObservation",
    "WorldObservation",
]

T = TypeVar("T")


# ---------------------------------------------------------------------------
# Small coercion helpers. They never raise on malformed JSON values.
# ---------------------------------------------------------------------------


def _dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, (list, tuple)) else []


def _text(value: Any, default: str | None = None) -> str | None:
    return value if isinstance(value, str) else default


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _optional_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _optional_integer(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extra(payload: dict[str, Any], known: Iterable[str]) -> dict[str, Any]:
    known_keys = set(known)
    return {key: value for key, value in payload.items() if key not in known_keys}


def _coerce(cls: type[T], value: Any) -> T:
    if isinstance(value, cls):
        return value
    return cls.from_dict(value)  # type: ignore[attr-defined]


def _dict_slots(value: Any) -> list[dict[str, Any]]:
    return [item for item in _list(value) if isinstance(item, dict)]


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------


@dataclass
class Inventory:
    """Item counts aggregated across the player's inventories.

    ``slots`` keeps the raw slot dictionaries from the manager (so fields the
    typed view does not model, such as durability or ammo, survive);
    ``counts`` aggregates ``count`` per item name. Missing items read as 0,
    which keeps agent/reward code simple::

        if observation.player.inventory["iron-plate"] >= 10: ...

    The manager spreads items over several containers (main, guns, ammo,
    armor, trash); ``from_dict`` accepts either a single container dict, a
    ``{"slots": [...]}`` payload, or the raw ``inventories`` list.
    """

    slots: list[dict[str, Any]] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @staticmethod
    def counts_from_slots(slots: Iterable[Any]) -> dict[str, int]:
        """Aggregate positive ``count`` values from raw slot dictionaries."""
        counts: dict[str, int] = {}
        for slot in slots:
            if not isinstance(slot, dict):
                continue
            name = _text(slot.get("name"))
            amount = _optional_integer(slot.get("count"))
            if not name or amount is None or amount <= 0:
                continue
            counts[name] = counts.get(name, 0) + amount
        return counts

    @classmethod
    def from_dict(cls, data: Any) -> "Inventory":
        """Parse slots/counts, a container list, or a manager ``inventories`` list."""
        if isinstance(data, list):
            slots: list[dict[str, Any]] = []
            for container in data:
                if isinstance(container, dict):
                    slots.extend(_dict_slots(container.get("slots") or container.get("items")))
                else:
                    slots.extend(_dict_slots(container))
            return cls(slots=slots, counts=cls.counts_from_slots(slots))
        payload = _dict(data)
        if payload.get("inventories") is not None and not payload.get("slots"):
            return cls.from_dict(_list(payload.get("inventories")))
        slots = _dict_slots(payload.get("slots") or payload.get("items"))
        raw_counts = payload.get("counts")
        if isinstance(raw_counts, dict):
            counts = {str(name): _integer(amount) for name, amount in raw_counts.items()}
        else:
            counts = cls.counts_from_slots(slots)
        return cls(
            slots=slots,
            counts=counts,
            extra=_extra(payload, {"slots", "items", "counts", "inventories"}),
        )

    def __getitem__(self, item: str) -> int:
        if not isinstance(item, str):
            raise TypeError("Inventory keys are item names (str)")
        return int(self.counts.get(item, 0))

    def get(self, item: str, default: int = 0) -> int:
        """Return the count of ``item``, or ``default`` when it is absent."""
        return int(self.counts.get(item, default))

    def __contains__(self, item: object) -> bool:
        return isinstance(item, str) and self.counts.get(item, 0) > 0

    def __len__(self) -> int:
        return len(self.counts)

    @property
    def total_items(self) -> int:
        """Sum of every counted item stack."""
        return sum(self.counts.values())

    def to_dict(self) -> dict[str, Any]:
        data = dict(self.extra)
        data.update({"slots": [dict(slot) for slot in self.slots], "counts": dict(self.counts)})
        return data


# ---------------------------------------------------------------------------
# Game info
# ---------------------------------------------------------------------------


@dataclass
class GameInfo:
    """Snapshot of the running game/server.

    The manager exposes server uptime rather than the in-game tick, so
    ``autorio_gym.FactorioEnv`` derives ``time``/``tick`` from the status
    payload unless it carries explicit ``time``/``tick``/``speed`` fields.
    Every field is optional and defaults to a neutral value.
    """

    tick: int = 0
    time: float = 0.0
    speed: float = 1.0
    save: str | None = None
    running: bool | None = None
    extra: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Any) -> "GameInfo":
        payload = _dict(data)
        running = payload.get("running")
        return cls(
            tick=_integer(payload.get("tick")),
            time=_number(payload.get("time")),
            speed=_number(payload.get("speed"), 1.0),
            save=_text(payload.get("save")),
            running=running if isinstance(running, bool) else None,
            extra=_extra(payload, {"tick", "time", "speed", "save", "running"}),
        )

    def to_dict(self) -> dict[str, Any]:
        data = dict(self.extra)
        data.update(
            {
                "tick": self.tick,
                "time": self.time,
                "speed": self.speed,
                "save": self.save,
                "running": self.running,
            }
        )
        return data


# ---------------------------------------------------------------------------
# Player
# ---------------------------------------------------------------------------

_PLAYER_KNOWN = {
    "name",
    "x",
    "y",
    "position",
    "direction",
    "health",
    "energy",
    "cursor",
    "inventories",
    "inventory",
    "equipment",
    "crafting_queue",
}


@dataclass
class PlayerState:
    """Character state from ``/api/agent/observe/player``.

    ``position`` is ``{"x": ..., "y": ...}`` and is empty when the manager did
    not report one. Unmodelled fields (``energy``, ``cursor``, ``equipment``,
    ...) are preserved in ``extra``.
    """

    name: str | None = None
    position: dict[str, float] = field(default_factory=dict)
    health: float | None = None
    direction: int | None = None
    inventory: Inventory = field(default_factory=Inventory)
    crafting_queue: list[dict[str, Any]] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Any) -> "PlayerState":
        payload = _dict(data)
        if isinstance(payload.get("player"), dict) and "name" not in payload:
            payload = dict(payload["player"], **{
                key: value for key, value in payload.items() if key != "player"
            })
        raw_position = payload.get("position")
        if isinstance(raw_position, dict):
            position = {
                "x": _number(raw_position.get("x")),
                "y": _number(raw_position.get("y")),
            }
        elif "x" in payload or "y" in payload:
            position = {"x": _number(payload.get("x")), "y": _number(payload.get("y"))}
        else:
            position = {}
        if "inventory" in payload:
            inventory = Inventory.from_dict(payload.get("inventory"))
        else:
            inventory = Inventory.from_dict(payload.get("inventories"))
        return cls(
            name=_text(payload.get("name")),
            position=position,
            health=_optional_number(payload.get("health")),
            direction=_optional_integer(payload.get("direction")),
            inventory=inventory,
            crafting_queue=_dict_slots(payload.get("crafting_queue")),
            extra=_extra(payload, _PLAYER_KNOWN),
        )

    def to_dict(self) -> dict[str, Any]:
        data = dict(self.extra)
        data.update(
            {
                "name": self.name,
                "position": dict(self.position),
                "health": self.health,
                "direction": self.direction,
                "inventory": self.inventory.to_dict(),
                "crafting_queue": [dict(item) for item in self.crafting_queue],
            }
        )
        return data


# ---------------------------------------------------------------------------
# World
# ---------------------------------------------------------------------------


@dataclass
class WorldObservation:
    """Terrain/entity window from ``/api/agent/observe/world``.

    The manager returns run-length encoded terrain rows (``terrain.rows``),
    not a flat tile list, so ``terrain`` is kept as the raw encoding and
    ``tiles`` is only populated when a payload supplies flat tiles.
    ``resources`` falls back to the resource ``patches`` shape when present.
    """

    window: dict[str, Any] = field(default_factory=dict)
    entities: list[dict[str, Any]] = field(default_factory=list)
    resources: list[dict[str, Any]] = field(default_factory=list)
    tiles: list[dict[str, Any]] = field(default_factory=list)
    terrain: dict[str, Any] = field(default_factory=dict)
    counts: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Any) -> "WorldObservation":
        payload = _dict(data)
        resources = _dict_slots(payload.get("resources"))
        if not resources:
            resources = _dict_slots(payload.get("patches"))
        return cls(
            window=_dict(payload.get("window")),
            entities=_dict_slots(payload.get("entities")),
            resources=resources,
            tiles=_dict_slots(payload.get("tiles")),
            terrain=_dict(payload.get("terrain")),
            counts=_dict(payload.get("counts")),
            extra=_extra(
                payload,
                {"window", "entities", "resources", "patches", "tiles", "terrain", "counts"},
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        data = dict(self.extra)
        data.update(
            {
                "window": dict(self.window),
                "entities": [dict(entity) for entity in self.entities],
                "resources": [dict(resource) for resource in self.resources],
                "tiles": [dict(tile) for tile in self.tiles],
                "terrain": dict(self.terrain),
                "counts": dict(self.counts),
            }
        )
        return data


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


@dataclass
class FactoryObservation:
    """Production summary from ``/api/agent/observe/factory``.

    Holds the power network flow, fuel totals, status buckets, per-entity
    counts, alerts, and the manager's active plan (when one is configured).
    """

    window: dict[str, Any] = field(default_factory=dict)
    power: dict[str, Any] = field(default_factory=dict)
    fuel: dict[str, Any] = field(default_factory=dict)
    research: dict[str, Any] = field(default_factory=dict)
    plan: Any = None
    counts: dict[str, Any] = field(default_factory=dict)
    problems: dict[str, Any] = field(default_factory=dict)
    totals: dict[str, Any] = field(default_factory=dict)
    alerts: list[Any] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Any) -> "FactoryObservation":
        payload = _dict(data)
        return cls(
            window=_dict(payload.get("window")),
            power=_dict(payload.get("power")),
            fuel=_dict(payload.get("fuel")),
            research=_dict(payload.get("research")),
            plan=payload.get("plan"),
            counts=_dict(payload.get("counts")),
            problems=_dict(payload.get("problems")),
            totals=_dict(payload.get("totals")),
            alerts=list(_list(payload.get("alerts"))),
            extra=_extra(
                payload,
                {
                    "window",
                    "power",
                    "fuel",
                    "research",
                    "plan",
                    "counts",
                    "problems",
                    "totals",
                    "alerts",
                },
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        data = dict(self.extra)
        data.update(
            {
                "window": dict(self.window),
                "power": dict(self.power),
                "fuel": dict(self.fuel),
                "research": dict(self.research),
                "plan": self.plan,
                "counts": dict(self.counts),
                "problems": dict(self.problems),
                "totals": dict(self.totals),
                "alerts": list(self.alerts),
            }
        )
        return data


# ---------------------------------------------------------------------------
# Research
# ---------------------------------------------------------------------------


@dataclass
class ResearchObservation:
    """Technology state from ``/api/agent/observe/research``."""

    current: dict[str, Any] | None = None
    queue: list[dict[str, Any]] = field(default_factory=list)
    available: list[dict[str, Any]] = field(default_factory=list)
    upgrades: list[dict[str, Any]] = field(default_factory=list)
    triggers: list[dict[str, Any]] = field(default_factory=list)
    locked: list[dict[str, Any]] = field(default_factory=list)
    completed: list[dict[str, Any]] = field(default_factory=list)
    counts: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Any) -> "ResearchObservation":
        payload = _dict(data)
        current = payload.get("current")
        return cls(
            current=dict(current) if isinstance(current, dict) else None,
            queue=_dict_slots(payload.get("queue")),
            available=_dict_slots(payload.get("available")),
            upgrades=_dict_slots(payload.get("upgrades")),
            triggers=_dict_slots(payload.get("triggers")),
            locked=_dict_slots(payload.get("locked")),
            completed=_dict_slots(payload.get("completed")),
            counts=_dict(payload.get("counts")),
            extra=_extra(
                payload,
                {
                    "current",
                    "queue",
                    "available",
                    "upgrades",
                    "triggers",
                    "locked",
                    "completed",
                    "counts",
                },
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        data = dict(self.extra)
        data.update(
            {
                "current": dict(self.current) if isinstance(self.current, dict) else None,
                "queue": [dict(item) for item in self.queue],
                "available": [dict(item) for item in self.available],
                "upgrades": [dict(item) for item in self.upgrades],
                "triggers": [dict(item) for item in self.triggers],
                "locked": [dict(item) for item in self.locked],
                "completed": [dict(item) for item in self.completed],
                "counts": dict(self.counts),
            }
        )
        return data


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------


@dataclass
class Observation:
    """Aggregate snapshot returned by ``FactorioEnv.reset``/``observe``/``step``.

    ``raw`` is the exact dictionary the typed fields were parsed from (by
    convention ``{"game": ..., "player": ..., "world": ..., "factory": ...,
    "research": ...}``) and is excluded from equality comparisons and from
    ``to_dict`` so the typed representation stays clean.
    """

    game: GameInfo = field(default_factory=GameInfo)
    player: PlayerState = field(default_factory=PlayerState)
    world: WorldObservation = field(default_factory=WorldObservation)
    factory: FactoryObservation = field(default_factory=FactoryObservation)
    research: ResearchObservation = field(default_factory=ResearchObservation)
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)
    extra: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, data: Any) -> "Observation":
        """Parse an aggregate payload; missing or malformed sections use defaults."""
        payload = _dict(data)
        return cls(
            game=_coerce(GameInfo, payload.get("game")),
            player=_coerce(PlayerState, payload.get("player")),
            world=_coerce(WorldObservation, payload.get("world")),
            factory=_coerce(FactoryObservation, payload.get("factory")),
            research=_coerce(ResearchObservation, payload.get("research")),
            raw=dict(payload),
            extra=_extra(payload, {"game", "player", "world", "factory", "research"}),
        )

    def to_dict(self) -> dict[str, Any]:
        """Return the typed observation as plain JSON-serializable data."""
        data = dict(self.extra)
        data.update(
            {
                "game": self.game.to_dict(),
                "player": self.player.to_dict(),
                "world": self.world.to_dict(),
                "factory": self.factory.to_dict(),
                "research": self.research.to_dict(),
            }
        )
        return data
