#!/usr/bin/env python3
"""SQLite trajectory store for autorio Gym-style environment runs.

``TrajectoryStore`` records one row per episode (task attempt) and one row per
step (action, observation, reward, termination flags, info) so experiments can
be replayed, compared, or resumed later. It uses the Python standard library
only (``sqlite3``) and enables WAL so a reader can inspect a live recording.

Schema (``PRAGMA user_version = 1``)::

    episodes(
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT,
        started_at   TEXT NOT NULL,      -- UTC ISO-8601
        ended_at     TEXT,               -- UTC ISO-8601, NULL while running
        config_json  TEXT NOT NULL,      -- JSON: environment/episode config
        total_reward REAL NOT NULL,      -- accumulated reward
        step_count   INTEGER NOT NULL,
        status       TEXT NOT NULL       -- running/terminated/truncated/reset/closed
    )

    steps(
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id       INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        step_index       INTEGER NOT NULL,  -- 0-based within the episode
        action_json      TEXT NOT NULL,     -- JSON action dict
        observation_json TEXT NOT NULL,     -- JSON observation dict
        reward           REAL NOT NULL,
        terminated       INTEGER NOT NULL,  -- 0/1
        truncated        INTEGER NOT NULL,  -- 0/1
        info_json        TEXT NOT NULL,     -- JSON info dict
        created_at       TEXT NOT NULL      -- UTC ISO-8601
    )

Columns ending in ``_json`` hold JSON text on disk; the read helpers decode
them back into Python values. Readings return plain dictionaries so callers do
not need to depend on sqlite3 row objects.
"""

from __future__ import annotations

import dataclasses
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

__all__ = ["SCHEMA_VERSION", "TrajectoryStore"]

SCHEMA_VERSION = 1

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    total_reward REAL NOT NULL DEFAULT 0,
    step_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL,
    action_json TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    reward REAL NOT NULL DEFAULT 0,
    terminated INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    info_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_steps_episode ON steps(episode_id, step_index);
"""


def _utc_now() -> str:
    """Current UTC time as an ISO-8601 string with a trailing ``Z``."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _jsonable(value: Any) -> Any:
    """Convert dataclasses/objects with ``to_dict`` into JSON-safe values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return _jsonable(to_dict())
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _jsonable(dataclasses.asdict(value))
    return str(value)


def _encode_json(value: Any) -> str:
    return json.dumps(_jsonable(value), separators=(",", ":"), ensure_ascii=False)


def _decode_json(text: Any, default: Any) -> Any:
    if not isinstance(text, str) or not text:
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default


class TrajectoryStore:
    """Append-only episode/step store backed by a SQLite database.

    Example::

        store = TrajectoryStore("/tmp/autorio/trajectories.db")
        episode_id = store.start_episode({"name": "smoke", "save": "test.zip"})
        store.record_step(episode_id, 0, {"type": "noop"}, observation,
                          reward=0.0, terminated=False, truncated=False,
                          info={"step": 0})
        store.end_episode(episode_id, total_reward=0.0, status="closed")
        store.close()

    ``path`` may be ``":memory:"`` for a throwaway store. Parent directories are
    created automatically. Episodes are ordered oldest first and steps by
    ``step_index``. The store only serializes its own access; a single writer at
    a time is expected (WAL allows read-only inspection of a live recording).
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = str(path)
        if not self.path:
            raise ValueError("TrajectoryStore requires a database path")
        self._lock = threading.RLock()
        self._closed = False
        if self.path != ":memory:":
            directory = os.path.dirname(os.path.abspath(self.path))
            if directory:
                os.makedirs(directory, exist_ok=True)
        self._connection = sqlite3.connect(self.path, timeout=30.0, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.executescript(SCHEMA_SQL)
            self._connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            self._connection.commit()

    # -- lifecycle ---------------------------------------------------------

    def _check_open(self) -> None:
        if self._closed:
            raise RuntimeError("TrajectoryStore is closed")

    def close(self) -> None:
        """Commit and close the database. Safe to call more than once."""
        with self._lock:
            if self._closed:
                return
            self._connection.commit()
            self._connection.close()
            self._closed = True

    def __enter__(self) -> "TrajectoryStore":
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        self.close()
        return False

    # -- writes ------------------------------------------------------------

    def start_episode(self, config: dict[str, Any] | None = None) -> int:
        """Insert a ``running`` episode and return its integer id.

        When ``config`` contains a string ``name`` it is copied to the ``name``
        column; the whole config is stored as JSON for reproducibility.
        """
        config_value = dict(config) if isinstance(config, dict) else {}
        name = config_value.get("name")
        with self._lock:
            self._check_open()
            try:
                cursor = self._connection.execute(
                    "INSERT INTO episodes (name, started_at, config_json, status) "
                    "VALUES (?, ?, ?, 'running')",
                    (name if isinstance(name, str) else None, _utc_now(), _encode_json(config_value)),
                )
                self._connection.commit()
            except sqlite3.Error:
                self._connection.rollback()
                raise
            return int(cursor.lastrowid)

    def record_step(
        self,
        episode_id: int,
        index: int,
        action: Any,
        observation: Any,
        reward: float = 0.0,
        terminated: bool = False,
        truncated: bool = False,
        info: Any = None,
    ) -> int:
        """Append one transition and update the episode's live counters.

        ``index`` is the 0-based step index within the episode. ``action``,
        ``observation`` and ``info`` may be plain JSON values or objects with a
        ``to_dict`` method (such as ``autorio_types.Observation``). The parent
        episode's ``step_count`` and ``total_reward`` are incremented in the
        same transaction.
        """
        reward_value = float(reward or 0.0)
        with self._lock:
            self._check_open()
            try:
                cursor = self._connection.execute(
                    "INSERT INTO steps (episode_id, step_index, action_json, observation_json, "
                    "reward, terminated, truncated, info_json, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        int(episode_id),
                        int(index),
                        _encode_json(action),
                        _encode_json(observation),
                        reward_value,
                        1 if terminated else 0,
                        1 if truncated else 0,
                        _encode_json(info if info is not None else {}),
                        _utc_now(),
                    ),
                )
                self._connection.execute(
                    "UPDATE episodes SET step_count = step_count + 1, "
                    "total_reward = total_reward + ? WHERE id = ?",
                    (reward_value, int(episode_id)),
                )
                self._connection.commit()
            except sqlite3.Error:
                self._connection.rollback()
                raise
            return int(cursor.lastrowid)

    def end_episode(
        self,
        episode_id: int,
        total_reward: float | None = None,
        status: str = "completed",
    ) -> None:
        """Mark an episode finished.

        ``total_reward`` overrides the reward accumulated by ``record_step``
        when provided (``None`` keeps the accumulated value). Typical statuses
        are ``completed``, ``terminated``, ``truncated``, ``reset`` and
        ``closed``. Raises ``KeyError`` for an unknown episode id.
        """
        with self._lock:
            self._check_open()
            row = self._connection.execute(
                "SELECT total_reward FROM episodes WHERE id = ?", (int(episode_id),)
            ).fetchone()
            if row is None:
                raise KeyError(f"Unknown episode id: {episode_id}")
            reward_value = float(row["total_reward"]) if total_reward is None else float(total_reward)
            try:
                self._connection.execute(
                    "UPDATE episodes SET ended_at = ?, total_reward = ?, status = ? WHERE id = ?",
                    (_utc_now(), reward_value, str(status), int(episode_id)),
                )
                self._connection.commit()
            except sqlite3.Error:
                self._connection.rollback()
                raise

    # -- reads -------------------------------------------------------------

    def list_episodes(self) -> list[dict[str, Any]]:
        """Return every episode as a dict, oldest first, with decoded config."""
        with self._lock:
            self._check_open()
            rows = self._connection.execute("SELECT * FROM episodes ORDER BY id").fetchall()
        return [self._episode_dict(row) for row in rows]

    def get_episode(self, episode_id: int) -> dict[str, Any] | None:
        """Return one episode dict (or ``None`` when the id is unknown)."""
        with self._lock:
            self._check_open()
            row = self._connection.execute(
                "SELECT * FROM episodes WHERE id = ?", (int(episode_id),)
            ).fetchone()
        return None if row is None else self._episode_dict(row)

    def get_steps(self, episode_id: int) -> list[dict[str, Any]]:
        """Return an episode's steps ordered by ``step_index`` with decoded JSON."""
        with self._lock:
            self._check_open()
            rows = self._connection.execute(
                "SELECT * FROM steps WHERE episode_id = ? ORDER BY step_index, id",
                (int(episode_id),),
            ).fetchall()
        return [self._step_dict(row) for row in rows]

    # -- row decoding ------------------------------------------------------

    @staticmethod
    def _episode_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "name": row["name"],
            "started_at": row["started_at"],
            "ended_at": row["ended_at"],
            "config": _decode_json(row["config_json"], {}),
            "total_reward": float(row["total_reward"]),
            "step_count": int(row["step_count"]),
            "status": row["status"],
        }

    @staticmethod
    def _step_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "episode_id": int(row["episode_id"]),
            "step_index": int(row["step_index"]),
            "action": _decode_json(row["action_json"], {}),
            "observation": _decode_json(row["observation_json"], {}),
            "reward": float(row["reward"]),
            "terminated": bool(row["terminated"]),
            "truncated": bool(row["truncated"]),
            "info": _decode_json(row["info_json"], {}),
            "created_at": row["created_at"],
        }
