#!/usr/bin/env python3
"""Gym-style environment for the autorio Factorio manager.

The environment is duck-typed, not gymnasium-dependent: it exposes the usual
``reset``/``step``/``observe``/``render``/``close`` methods, and the
``step`` return tuple is ``(observation, reward, terminated, truncated, info)``.
Observations are typed :class:`autorio_types.Observation` instances; every reset
and step can be recorded to a SQLite file through
:class:`autorio_trajectory.TrajectoryStore`. Everything is standard library
plus the repo's own ``factorio.py`` client.

Example::

    from autorio_gym import FactorioEnv

    env = FactorioEnv(
        save="smoke.zip",
        max_steps=500,
        trajectory_path=".autorio/trajectories/demo.db",
    )
    observation = env.reset()
    terminated = truncated = False
    while not (terminated or truncated):
        action = {"type": "observe"}
        observation, reward, terminated, truncated, info = env.step(action)
    env.close()

Action schema (a plain dict with a ``type`` key)::

    {"type": "observe"}                      # fetch observation only
    {"type": "noop"}                         # no manager action
    {"type": "build", "entities": [...], "clear_obstacles": True}
    {"type": "mine", "targets": [{"x": 1, "y": 2}]}
    {"type": "move", "targets": [{"x": 1, "y": 2}]}
    {"type": "craft", "item": "iron-gear-wheel", "count": 2}
    {"type": "set_recipe", "targets": [{"x": 1, "y": 2, "recipe": "iron-gear-wheel"}]}
    {"type": "research", "technology": "automation"}
    {"type": "insert", "entity": {"x": 1, "y": 2}, "item": "coal", "count": 5}
    {"type": "extract", "entity": {"x": 1, "y": 2}, "item": "iron-plate", "count": "all"}
    {"type": "launch_rocket", "targets": [{"x": 1, "y": 2}]}
    {"type": "rotate", "targets": [{"x": 1, "y": 2}]}

Actions map directly onto ``FactorioClient`` methods (``build``, ``mine``,
``move``, ``craft``, ``set_recipe``, ``research``, ``insert``, ``extract``,
``launch_rocket``, ``rotate``). An unknown ``type`` raises ``ValueError``.
"""

from __future__ import annotations

import inspect
import math
from typing import Any, Callable

from autorio_trajectory import TrajectoryStore
from autorio_types import GameInfo, Observation

__all__ = ["ActionResult", "FactorioEnv", "RewardFn", "TaskVerifier", "TERMINAL_JOB_STATUSES"]

ActionResult = Any
RewardFn = Callable[[dict[str, Any], Any, "Observation"], float | None]
TaskVerifier = Callable[..., Any]

#: Action-job statuses that end the episode early (``truncated`` is set).
TERMINAL_JOB_STATUSES = frozenset({"failed", "cancelled"})

#: Seconds of game time per Factorio tick, used when deriving ``GameInfo``.
_TICKS_PER_SECOND = 60

#: Default observation options for an episode; ``reset(options)`` overrides them.
DEFAULT_OBSERVE_OPTIONS: dict[str, Any] = {
    "x": 0.0,
    "y": 0.0,
    "radius": 12,
    "include": ["terrain", "entities"],
    "inventory_slots": None,
    "equipment_slots": None,
    "available": None,
    "locked": None,
    "completed": None,
    "factory_radius": 120,
}


def _unwrap_data(response: Any) -> dict[str, Any]:
    """Return the ``data`` payload of a manager observation response envelope."""
    if isinstance(response, dict):
        if response.get("ok") is False:
            raise RuntimeError(str(response.get("error") or "manager reported a failed observation"))
        data = response.get("data")
        if data is not None:
            return data if isinstance(data, dict) else {}
        return response
    return {}


def _status_running(status: Any) -> bool:
    """Interpret a manager status payload (tolerating a ``{"data": ...}`` wrapper)."""
    if not isinstance(status, dict):
        return False
    payload = status
    data = status.get("data")
    if isinstance(data, dict):
        payload = data
    running = payload.get("running")
    if running is None:
        return bool(payload.get("pid"))
    return bool(running)


def _require_targets(action: dict[str, Any], action_type: str) -> list[dict[str, Any]]:
    targets = action.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ValueError(f"{action_type} action requires a non-empty 'targets' list")
    if not all(isinstance(target, dict) for target in targets):
        raise ValueError(f"{action_type} action targets must be dicts")
    return targets


def _require_entity(action: dict[str, Any], action_type: str) -> dict[str, Any]:
    entity = action.get("entity", action.get("target"))
    if not isinstance(entity, dict) or "x" not in entity or "y" not in entity:
        raise ValueError(f"{action_type} action requires an 'entity' dict with 'x' and 'y'")
    return entity


def _require_text(action: dict[str, Any], key: str, action_type: str) -> str:
    value = action.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{action_type} action requires a non-empty '{key}' string")
    return value


def _require_count(action: dict[str, Any], action_type: str, *, allow_all: bool = False) -> int | str:
    count = action.get("count", 1)
    if allow_all and count == "all":
        return "all"
    if isinstance(count, bool):
        raise ValueError(f"{action_type} action requires a positive integer 'count'")
    try:
        value = int(count)
    except (TypeError, ValueError):
        raise ValueError(f"{action_type} action requires a positive integer 'count'") from None
    if value < 1:
        raise ValueError(f"{action_type} action requires a positive integer 'count'")
    return value


def _accepts_two_positional(callback: Callable[..., Any]) -> bool:
    """True when a verifier hook can be called as ``verifier(result, observation)``."""
    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        return True
    positional = 0
    for parameter in signature.parameters.values():
        if parameter.kind in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        ):
            positional += 1
        elif parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            return True
    return positional >= 2


class FactorioEnv:
    """Gym-style environment wrapping :class:`factorio.FactorioClient`.

    Parameters
    ----------
    base:
        Manager URL. When the environment builds its own client it defaults to
        ``factorio.DEFAULT_BASE`` (``FACTORIO_API_BASE`` or
        ``http://localhost:3000``).
    save:
        Optional save file name (``*.zip``) used by ``reset`` when it has to
        start the manager's game. ``None`` means "never start anything".
    max_steps:
        Episode length used for truncation. ``None`` disables step truncation.
    trajectory_path:
        Optional SQLite database path; when set, an episode is opened on every
        ``reset`` and every transition is recorded via
        :class:`autorio_trajectory.TrajectoryStore`.
    client:
        Pre-built client-like object exposing the ``FactorioClient`` methods.
        Injected clients are never closed by the environment.
    autostart:
        When true, ``reset`` starts the configured save if the game is not
        running yet (it checks the manager status first). With no save
        configured the environment just attaches to the already-running game and
        never starts one. An "already running" start race is tolerated (the
        manager returns 409 if another process won).
    reward_fn:
        Optional hook ``reward_fn(action, result, observation) -> float``. The
        default reward is ``0.0``. An episode-level hook can be supplied through
        ``reset(options={"reward_fn": ...})``.
    task_verifier:
        Optional hook called after every step with ``(result, observation)`` or
        only ``(observation)`` depending on its signature. A truthy return, or a
        dict with a truthy ``terminated``/``done`` key, marks the episode
        terminated. An episode-level hook can be supplied through
        ``reset(options={"task_verifier": ...})``.
    factory_radius:
        Default factory observation radius; override per episode with
        ``reset(options={"factory_radius": ...})``.
    world_radius:
        Default world observation radius; override per episode with
        ``reset(options={"radius": ...})``.

    Notes
    -----
    * ``step`` must follow ``reset``. A finished episode raises ``RuntimeError``
      from ``step`` until ``reset`` is called again.
    * ``terminated`` comes from the optional task verifier; ``truncated`` is set
      when ``max_steps`` is reached or an action job reports a terminal status
      (``failed``/``cancelled``).
    * ``info`` contains ``step`` (0-based within the episode), ``action`` (the
      action type), ``result`` (the manager action job, if any), ``episode_id``,
      plus ``verification``/``terminal_status`` when applicable.
    * ``GameInfo`` is best effort: the manager exposes server uptime rather than
      the in-game tick, so ``time``/``tick`` are derived from ``uptimeSec``
      unless the status payload contains explicit fields.
    * Nothing here imports gymnasium. ``render`` is headless and returns the
      current :class:`autorio_types.Observation`.
    """

    def __init__(
        self,
        base: str | None = None,
        save: str | None = None,
        max_steps: int | None = 1000,
        trajectory_path: str | None = None,
        client: Any = None,
        autostart: bool = True,
        *,
        reward_fn: RewardFn | None = None,
        task_verifier: TaskVerifier | None = None,
        factory_radius: int = 120,
        world_radius: int = 12,
    ) -> None:
        if client is None:
            # Imported lazily so the module can be imported/used with an
            # injected client even if factorio.py cannot be imported.
            from factorio import DEFAULT_BASE, FactorioClient

            self.base_url: str | None = str(base or DEFAULT_BASE).rstrip("/")
            self.client = FactorioClient(self.base_url)
        else:
            self.client = client
            base_value = base if base is not None else getattr(client, "base_url", None)
            self.base_url = str(base_value).rstrip("/") if base_value else None
        self.save = save
        if max_steps is None:
            self.max_steps: int | None = None
        else:
            self.max_steps = int(max_steps)
            if self.max_steps < 0:
                raise ValueError("max_steps must be >= 0 or None")
        self.autostart = bool(autostart)
        self.reward_fn = reward_fn
        self.task_verifier = task_verifier
        default_options = dict(DEFAULT_OBSERVE_OPTIONS)
        default_options["radius"] = int(world_radius)
        default_options["factory_radius"] = int(factory_radius)
        default_options["include"] = list(DEFAULT_OBSERVE_OPTIONS["include"])
        self._default_observe_options = default_options
        self._observe_options = dict(default_options)
        self._episode_reward_fn: RewardFn | None = reward_fn
        self._episode_task_verifier: TaskVerifier | None = task_verifier
        self.trajectory_path = trajectory_path
        self.trajectory = TrajectoryStore(trajectory_path) if trajectory_path else None
        self.observation: Observation | None = None
        self._episode_id: int | None = None
        self._episode_total_reward = 0.0
        self._step_index = 0
        self._done = False
        self._closed = False
        self._last_verification: Any = None

    # -- introspection -----------------------------------------------------

    @property
    def episode_id(self) -> int | None:
        """Trajectory episode id for the current attempt, if recording."""
        return self._episode_id

    @property
    def step_index(self) -> int:
        """Number of steps executed in the current episode."""
        return self._step_index

    @property
    def total_reward(self) -> float:
        """Reward accumulated in the current episode."""
        return self._episode_total_reward

    @property
    def done(self) -> bool:
        """Whether the current episode ended (terminated or truncated)."""
        return self._done

    @property
    def closed(self) -> bool:
        """Whether :meth:`close` has been called."""
        return self._closed

    def __repr__(self) -> str:
        return (
            f"FactorioEnv(base={self.base_url!r}, save={self.save!r}, "
            f"max_steps={self.max_steps!r}, episode_id={self._episode_id!r})"
        )

    def __enter__(self) -> "FactorioEnv":
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        self.close()
        return False

    # -- Gym-style API -----------------------------------------------------

    def reset(self, options: dict[str, Any] | None = None) -> Observation:
        """Start a new episode and return the first observation.

        ``options`` may contain ``save``/``autostart``/``name`` for starting the
        game (autostart only starts when a save is configured) and naming the
        trajectory episode, observation bounds (``x``, ``y``, ``radius``,
        ``include``, ``factory_radius``, ``inventory_slots``,
        ``equipment_slots``, ``available``, ``locked``, ``completed``), and
        episode-level ``reward_fn``/``task_verifier`` hooks. Unknown options are
        ignored.
        """
        if self._closed:
            raise RuntimeError("environment is closed")
        episode_options = dict(options) if isinstance(options, dict) else {}
        if self._episode_id is not None:
            self._end_episode("reset")
        self._step_index = 0
        self._episode_total_reward = 0.0
        self._done = False
        self._last_verification = None
        self._episode_reward_fn = episode_options.get("reward_fn", self.reward_fn)
        self._episode_task_verifier = episode_options.get("task_verifier", self.task_verifier)
        self._observe_options = self._observation_options(episode_options)

        save = episode_options.get("save", self.save)
        if bool(episode_options.get("autostart", self.autostart)) and save:
            self._ensure_server(save)

        if self.trajectory is not None:
            config = {
                "base": self.base_url,
                "save": save,
                "max_steps": self.max_steps,
                "name": episode_options.get("name") or save,
                "observation": dict(self._observe_options),
            }
            self._episode_id = self.trajectory.start_episode(config)
        observation = self.observe()
        self.observation = observation
        return observation

    def step(
        self, action: dict[str, Any]
    ) -> tuple[Observation, float, bool, bool, dict[str, Any]]:
        """Apply one action, fetch the next observation, and score the transition.

        Returns ``(observation, reward, terminated, truncated, info)``. Actions
        are the dicts described in the module docstring; an unknown ``type`` or
        a malformed action raises ``ValueError`` before the manager is called,
        leaving the step counter unchanged.
        """
        if self._closed:
            raise RuntimeError("environment is closed")
        if self._done:
            raise RuntimeError("episode is finished; call reset() before step()")
        if self.observation is None:
            raise RuntimeError("call reset() before step()")
        action_value = self._validate_action(action)
        result = self._dispatch(action_value)
        index = self._step_index
        self._step_index += 1
        observation = self.observe()
        reward = self._compute_reward(action_value, result, observation)
        terminated = self._check_terminated(result, observation)
        truncated = self._check_truncated(result)

        info: dict[str, Any] = {
            "step": index,
            "action": action_value.get("type"),
            "result": result,
            "episode_id": self._episode_id,
        }
        if self._last_verification is not None:
            info["verification"] = self._last_verification
        if isinstance(result, dict) and result.get("status") in TERMINAL_JOB_STATUSES:
            info["terminal_status"] = result.get("status")

        self._episode_total_reward += reward
        if self.trajectory is not None and self._episode_id is not None:
            self.trajectory.record_step(
                self._episode_id,
                index,
                action_value,
                observation,
                reward,
                terminated,
                truncated,
                info,
            )
        self.observation = observation
        if terminated or truncated:
            self._done = True
            self._end_episode("terminated" if terminated else "truncated")
        return observation, reward, terminated, truncated, info

    def observe(self) -> Observation:
        """Fetch and parse a fresh observation from the manager.

        Combines ``observe/world``, ``observe/player``, ``observe/factory`` and
        ``observe/research`` (with episode observation bounds) and best-effort
        server status for :class:`autorio_types.GameInfo`. Endpoint truncation
        flags are kept in ``Observation.raw["truncated"]``.
        """
        if self._closed:
            raise RuntimeError("environment is closed")
        options = self._observe_options
        world_response = self.client.observe_world(
            x=options["x"],
            y=options["y"],
            radius=options["radius"],
            include=list(options["include"]),
        )
        player_response = self.client.observe_player(
            inventory_slots=options["inventory_slots"],
            equipment_slots=options["equipment_slots"],
        )
        factory_response = self.client.observe_factory(
            x=options["x"], y=options["y"], radius=options["factory_radius"]
        )
        research_response = self.client.observe_research(
            available=options["available"],
            locked=options["locked"],
            completed=options["completed"],
        )
        game = self._game_info(self._safe_server_status())
        raw: dict[str, Any] = {
            "game": game.to_dict(),
            "player": _unwrap_data(player_response),
            "world": _unwrap_data(world_response),
            "factory": _unwrap_data(factory_response),
            "research": _unwrap_data(research_response),
        }
        endpoint_truncated = {
            name: response["truncated"]
            for name, response in (
                ("player", player_response),
                ("world", world_response),
                ("factory", factory_response),
                ("research", research_response),
            )
            if isinstance(response, dict) and "truncated" in response
        }
        if endpoint_truncated:
            raw["truncated"] = endpoint_truncated
        observation = Observation.from_dict(raw)
        self.observation = observation
        return observation

    def render(self) -> Observation:
        """Headless render: fetch and return the current observation.

        There is no graphical output; use ``factorio.py observe-layout`` for an
        ASCII map. This is a convenience alias for :meth:`observe`.
        """
        return self.observe()

    def close(self) -> None:
        """Finish the active episode and close the trajectory store.

        The injected/created ``FactorioClient`` is left untouched (urllib keeps
        no persistent connection). Safe to call more than once.
        """
        if self._closed:
            return
        self._end_episode("closed")
        self._closed = True
        if self.trajectory is not None:
            self.trajectory.close()

    # -- internals ---------------------------------------------------------

    @staticmethod
    def _validate_action(action: Any) -> dict[str, Any]:
        if not isinstance(action, dict):
            raise ValueError(f"action must be a dict, got {type(action).__name__}")
        action_type = action.get("type")
        if not isinstance(action_type, str) or not action_type:
            raise ValueError("action requires a non-empty 'type' string")
        return action

    def _dispatch(self, action: dict[str, Any]) -> ActionResult:
        """Route an action dict to the matching ``FactorioClient`` method."""
        action_type = str(action["type"])
        if action_type in ("observe", "noop"):
            return None
        if action_type == "build":
            entities = action.get("entities")
            if not isinstance(entities, list) or not entities:
                raise ValueError("build action requires a non-empty 'entities' list")
            if not all(isinstance(entity, dict) for entity in entities):
                raise ValueError("build action entities must be dicts")
            clear = bool(action.get("clear_obstacles", True))
            return self.client.build(entities, clear=clear)
        if action_type == "mine":
            return self.client.mine(_require_targets(action, action_type))
        if action_type == "move":
            return self.client.move(_require_targets(action, action_type))
        if action_type == "craft":
            item = _require_text(action, "item", action_type)
            return self.client.craft(item, count=_require_count(action, action_type))
        if action_type == "set_recipe":
            return self.client.set_recipe(_require_targets(action, action_type))
        if action_type == "research":
            return self.client.research(_require_text(action, "technology", action_type))
        if action_type == "insert":
            entity = _require_entity(action, action_type)
            item = _require_text(action, "item", action_type)
            return self.client.insert(entity, item, count=_require_count(action, action_type))
        if action_type == "extract":
            entity = _require_entity(action, action_type)
            item = _require_text(action, "item", action_type)
            return self.client.extract(
                entity, item, count=_require_count(action, action_type, allow_all=True)
            )
        if action_type == "launch_rocket":
            return self.client.launch_rocket(_require_targets(action, action_type))
        if action_type == "rotate":
            return self.client.rotate(_require_targets(action, action_type))
        raise ValueError(f"Unknown action type: {action_type!r}")

    def _compute_reward(
        self, action: dict[str, Any], result: ActionResult, observation: Observation
    ) -> float:
        reward_fn = self._episode_reward_fn
        if reward_fn is None:
            reward_fn = self.reward_fn
        if reward_fn is None:
            return 0.0
        if not callable(reward_fn):
            raise TypeError("reward_fn must be callable")
        value = reward_fn(action, result, observation)
        if value is None:
            return 0.0
        try:
            reward = float(value)
        except (TypeError, ValueError):
            raise TypeError(
                f"reward_fn must return a number or None, got {type(value).__name__}"
            ) from None
        if not math.isfinite(reward):
            raise ValueError("reward_fn returned a non-finite reward")
        return reward

    def _check_terminated(self, result: ActionResult, observation: Observation) -> bool:
        self._last_verification = None
        verifier = self._episode_task_verifier
        if verifier is None:
            verifier = self.task_verifier
        if verifier is None:
            return False
        if not callable(verifier):
            raise TypeError("task_verifier must be callable")
        if _accepts_two_positional(verifier):
            value = verifier(result, observation)
        else:
            value = verifier(observation)
        self._last_verification = value
        if isinstance(value, dict):
            return bool(value.get("terminated") or value.get("done"))
        return bool(value)

    def _check_truncated(self, result: ActionResult) -> bool:
        if isinstance(result, dict) and result.get("status") in TERMINAL_JOB_STATUSES:
            return True
        return self.max_steps is not None and self._step_index >= self.max_steps

    def _ensure_server(self, save: str | None) -> None:
        """Start the configured save when the manager's game is not running yet."""
        if not save:
            return
        status = self.client.server_status()
        if _status_running(status):
            return
        try:
            self.client.server_start(str(save))
        except Exception as error:  # tolerate the start race with another client
            if "already running" in str(error).lower():
                return
            raise

    def _safe_server_status(self) -> Any:
        """Best-effort status fetch; game metadata must not fail an observation."""
        try:
            return self.client.server_status()
        except Exception:
            return None

    @staticmethod
    def _game_info(status: Any) -> GameInfo:
        """Derive :class:`GameInfo` from the manager status payload."""
        if not isinstance(status, dict):
            return GameInfo()
        payload = status.get("data") if isinstance(status.get("data"), dict) else status
        time_value = payload.get("time")
        if time_value is None:
            time_value = payload.get("uptimeSec")
        tick = payload.get("tick")
        if tick is None and time_value is not None:
            try:
                tick = int(round(float(time_value) * _TICKS_PER_SECOND))
            except (TypeError, ValueError):
                tick = None
        return GameInfo.from_dict(
            {
                "tick": tick,
                "time": time_value,
                "speed": payload.get("speed", 1.0),
                "save": payload.get("save"),
                "running": payload.get("running"),
            }
        )

    def _observation_options(self, episode_options: dict[str, Any]) -> dict[str, Any]:
        """Merge episode observation bounds over the environment defaults."""
        merged = dict(self._default_observe_options)
        for key in merged:
            if key in episode_options and episode_options[key] is not None:
                merged[key] = episode_options[key]
        if episode_options.get("world_radius") is not None:
            merged["radius"] = episode_options["world_radius"]
        include = merged.get("include")
        if isinstance(include, (list, tuple)):
            merged["include"] = [str(item) for item in include]
        else:
            merged["include"] = list(DEFAULT_OBSERVE_OPTIONS["include"])
        for key in ("radius", "factory_radius"):
            try:
                merged[key] = int(merged[key])
            except (TypeError, ValueError):
                merged[key] = self._default_observe_options[key]
        return merged

    def _end_episode(self, status: str) -> None:
        """Record the terminal status of the current trajectory episode."""
        episode_id = self._episode_id
        self._episode_id = None
        if self.trajectory is None or episode_id is None:
            return
        self.trajectory.end_episode(episode_id, self._episode_total_reward, status)
