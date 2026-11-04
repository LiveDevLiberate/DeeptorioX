/**
 * `GET /api/health` payload builder.
 *
 * The manager is alive whenever it can answer this request, so `status` is
 * "ok" when every injected probe succeeds (even if no game is running: an idle
 * manager is healthy) and "degraded" when a probe throws or returns an
 * unusable value. Probe failures are collected in `problems` instead of
 * propagating, so a broken probe can never fail the HTTP request.
 */

export const HEALTH_SCHEMA_VERSION = 1;

export type HealthStatus = "ok" | "degraded";

export type HealthGame = {
  running: boolean;
  rcon_connected: boolean;
};

export type HealthActiveRun = {
  id: string;
  state: string;
  agent: string;
} | null;

export type HealthPayload = {
  ok: boolean;
  status: HealthStatus;
  /** ISO timestamp of the response, from the `timestamp` probe. */
  timestamp: string;
  uptime_seconds: number;
  game: HealthGame;
  active_run: HealthActiveRun;
  versions: Record<string, unknown>;
  /** Names of probes that threw or returned an unusable value. */
  problems: string[];
  schema_version: number;
};

export type HealthDeps = {
  /** Clock used for `timestamp` and uptime; defaults to `new Date()`. */
  timestamp?: () => Date | number | string;
  /** Manager start as epoch milliseconds (or a probe returning one). */
  startedAt?: number | null | (() => number | null);
  /** Current game state. `rcon` maps to `game.rcon_connected`. */
  game?: () => { running: boolean; rcon: boolean };
  /** Currently active run, if any. */
  activeRun?: () => { id: string; state: string; agent: string } | null;
  /** Build/version information reported to operators. */
  versions?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Payload schema version; the manager passes API_SCHEMA_VERSION. */
  schemaVersion?: number;
};

type HealthStatusCodeInput = {
  ok: boolean;
  status: HealthStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function probe<T>(name: string, call: (() => T) | undefined, fallback: T, problems: string[]): T {
  if (!call) return fallback;
  try {
    return call();
  } catch {
    problems.push(name);
    return fallback;
  }
}

function toMillis(value: unknown, problems: string[]): number {
  try {
    if (value instanceof Date) {
      const ms = value.getTime();
      if (Number.isFinite(ms)) return ms;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    } else if (typeof value === "string") {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    /* fall through to the fallback clock */
  }
  problems.push("timestamp");
  return Date.now();
}

function gameFrom(value: unknown, hasProbe: boolean, problems: string[]): HealthGame {
  if (isRecord(value)) {
    return { running: value.running === true, rcon_connected: value.rcon === true };
  }
  if (hasProbe) problems.push("game");
  return { running: false, rcon_connected: false };
}

function activeRunFrom(value: unknown, hasProbe: boolean, problems: string[]): HealthActiveRun {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    if (hasProbe) problems.push("active_run");
    return null;
  }
  const text = (entry: unknown): string => {
    if (typeof entry === "string") return entry;
    if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
    return "";
  };
  return { id: text(value.id), state: text(value.state), agent: text(value.agent) };
}

function versionsFrom(value: unknown, hasProbe: boolean, problems: string[]): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (hasProbe) problems.push("versions");
  return {};
}

/**
 * Builds the health payload from injected probes. Every probe is isolated: a
 * throwing or malformed probe degrades the payload instead of rejecting it.
 */
export function healthPayload(deps: HealthDeps = {}): HealthPayload {
  const problems: string[] = [];

  const timestampValue = probe("timestamp", deps.timestamp, new Date(), problems);
  const nowMs = toMillis(timestampValue, problems);

  let startedProbe: (() => number | null) | undefined;
  if (typeof deps.startedAt === "function") {
    startedProbe = deps.startedAt;
  } else if (typeof deps.startedAt === "number" && Number.isFinite(deps.startedAt)) {
    const fixed = deps.startedAt;
    startedProbe = () => fixed;
  }
  const startedRaw = probe("started_at", startedProbe, nowMs, problems);
  let startedMs = nowMs;
  if (typeof startedRaw === "number" && Number.isFinite(startedRaw)) {
    startedMs = startedRaw;
  } else {
    problems.push("started_at");
  }

  const game = gameFrom(
    probe("game", deps.game, { running: false, rcon: false }, problems),
    Boolean(deps.game),
    problems,
  );

  const activeRun = activeRunFrom(
    probe("active_run", deps.activeRun, null, problems),
    Boolean(deps.activeRun),
    problems,
  );

  let versionsValue: unknown;
  if (typeof deps.versions === "function") {
    versionsValue = probe("versions", deps.versions, {}, problems);
  } else {
    versionsValue = deps.versions ?? {};
  }
  const versions = versionsFrom(versionsValue, typeof deps.versions === "function", problems);

  const schemaVersion =
    typeof deps.schemaVersion === "number" && Number.isFinite(deps.schemaVersion)
      ? Math.trunc(deps.schemaVersion)
      : HEALTH_SCHEMA_VERSION;

  const ok = problems.length === 0;
  return {
    ok,
    status: ok ? "ok" : "degraded",
    timestamp: new Date(nowMs).toISOString(),
    uptime_seconds: Math.max(0, Math.floor((nowMs - startedMs) / 1000)),
    game,
    active_run: activeRun,
    versions,
    problems,
    schema_version: schemaVersion,
  };
}

/** 200 for a healthy payload, 503 for a degraded one. */
export function healthStatusCode(payload: HealthStatusCodeInput): number {
  return payload.ok && payload.status === "ok" ? 200 : 503;
}
