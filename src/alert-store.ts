/**
 * Agent alert cache and gate.
 *
 * `observe-factory` already reports per-entity problems. This store deduplicates
 * them into stable alert ids, keeps first-seen timestamps, and lets the HTTP
 * layer (a) attach a compact alert envelope to every agent response and (b) block
 * mutating actions until a critical alert has been acknowledged. Long-unresolved
 * critical alerts accrue a permanent automation-score penalty instead of
 * restarting the agent.
 */

export type AlertSeverity = "critical" | "warning";

export type AgentAlert = {
  id: string;
  severity: AlertSeverity;
  kind: string;
  message: string;
  count: number;
  first_seen_ms: number;
  updated_at_ms: number;
  sample?: Record<string, unknown>;
};

export type AlertEnvelope = {
  revision: number;
  counts: { critical: number; warning: number };
  items: AgentAlert[];
  acked_revision: number | null;
  requires_ack: boolean;
  penalty: number;
  generated_at: string;
};

export type AlertGate = {
  blocked: boolean;
  message: string;
  alerts: AlertEnvelope;
  nudge?: { reason: "alerts_pending"; first_step: "observe-factory"; message: string };
};

type FactoryAlertData = {
  problems?: unknown;
  totals?: unknown;
  alerts?: unknown;
  power?: unknown;
};

const CRITICAL_PROBLEMS: Record<string, { message: string; kind: string }> = {
  no_power: { message: "entities have no power", kind: "no_power" },
  no_fuel: { message: "entities have no fuel", kind: "no_fuel" },
  no_input_fluid: { message: "entities have no input fluid", kind: "no_input_fluid" },
  no_minable_resources: { message: "drills have no minable resources", kind: "no_minable_resources" },
};

const WARNING_PROBLEMS: Record<string, { message: string; kind: string }> = {
  waiting_for_space_in_destination: {
    message: "entities are waiting for output space",
    kind: "output_blocked",
  },
  no_ingredients: { message: "furnaces have no ingredients", kind: "no_ingredients" },
  missing_science_packs: { message: "labs are missing science packs", kind: "missing_science" },
};

function positiveCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function firstSample(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Deduplicated, time-aware alert cache. One instance is shared by the manager
 * process; `ingest()` is safe to call repeatedly with the same factory snapshot.
 */
export class AlertStore {
  private alerts = new Map<string, AgentAlert>();
  private revision = 0;
  private ackedRevision: number | null = null;
  private ackedAt = 0;
  /** Cumulative points awarded for critical alerts that stayed unresolved too long. */
  private retiredPenalty = 0;
  private penaltyState = new Map<string, { awarded: number; nextAt: number }>();

  constructor(
    private readonly gateGraceSeconds = Number(process.env.AUTORIO_ALERT_GATE_GRACE_SECONDS || 0) || 30,
    private readonly penaltyGraceSeconds = Number(process.env.AUTORIO_ALERT_PENALTY_GRACE_SECONDS || 0) ||
      300,
    private readonly penaltyIntervalSeconds = Number(
      process.env.AUTORIO_ALERT_PENALTY_INTERVAL_SECONDS || 0,
    ) || 300,
    private readonly penaltyPoints = Number(process.env.AUTORIO_ALERT_PENALTY_POINTS || 0) || 25,
  ) {}

  /** Merge an observe-factory snapshot into the alert set. */
  ingest(data: unknown, now = Date.now()): AlertEnvelope {
    const record = asRecord(data) as FactoryAlertData | undefined;
    if (!record) return this.envelope(now);
    const problems = asRecord(record.problems) ?? {};
    const totals = asRecord(record.totals) ?? {};
    const next = new Map<string, AgentAlert>();

    const addProblem = (key: string, meta: { message: string; kind: string }, severity: AlertSeverity) => {
      const entries = problems[key];
      const count = Math.max(positiveCount(totals[key]), Array.isArray(entries) ? entries.length : 0);
      if (count <= 0) return;
      const id = `problem:${key}`;
      const previous = this.alerts.get(id);
      const sample = firstSample(entries) ?? previous?.sample;
      next.set(id, {
        id,
        severity,
        kind: meta.kind,
        message: meta.message,
        count,
        first_seen_ms: previous?.first_seen_ms ?? now,
        updated_at_ms: now,
        ...(sample ? { sample } : {}),
      });
    };

    for (const [key, meta] of Object.entries(CRITICAL_PROBLEMS)) addProblem(key, meta, "critical");
    for (const [key, meta] of Object.entries(WARNING_PROBLEMS)) addProblem(key, meta, "warning");

    const power = asRecord(record.power);
    const satisfaction = Number(power?.satisfaction);
    if (Number.isFinite(satisfaction) && satisfaction < 0.95) {
      const id = "power:satisfaction";
      const previous = this.alerts.get(id);
      next.set(id, {
        id,
        severity: satisfaction < 0.5 ? "critical" : "warning",
        kind: "low_power",
        message: `power satisfaction ${Math.round(satisfaction * 100)}%`,
        count: 1,
        first_seen_ms: previous?.first_seen_ms ?? now,
        updated_at_ms: now,
      });
    }

    const messages = Array.isArray(record.alerts) ? record.alerts : [];
    for (const message of messages) {
      if (typeof message !== "string" || !message.trim()) continue;
      const id = `factory:${message.trim().slice(0, 120)}`;
      if (next.has(id)) continue;
      const previous = this.alerts.get(id);
      next.set(id, {
        id,
        severity: "warning",
        kind: "factory_alert",
        message,
        count: 1,
        first_seen_ms: previous?.first_seen_ms ?? now,
        updated_at_ms: now,
      });
    }

    const signature = [...next.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      // Count fluctuations are common in a running factory; only an alert
      // appearing/disappearing or changing severity re-arms an acknowledgement.
      .map((alert) => `${alert.id}:${alert.severity}`)
      .join("|");
    const oldSignature = [...this.alerts.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((alert) => `${alert.id}:${alert.severity}`)
      .join("|");
    if (signature !== oldSignature) {
      this.revision++;
      if (next.size === 0) this.ackedRevision = null;
    }
    this.alerts = next;
    this.accrue(now);
    return this.envelope(now);
  }

  /** Award interval penalties for critical alerts that have remained too long. */
  accrue(now = Date.now()): number {
    for (const alert of this.alerts.values()) {
      if (alert.severity !== "critical") continue;
      let state = this.penaltyState.get(alert.id);
      if (!state) {
        state = {
          awarded: 0,
          nextAt: alert.first_seen_ms + this.penaltyGraceSeconds * 1000,
        };
      }
      while (now >= state.nextAt) {
        state.awarded += this.penaltyPoints;
        state.nextAt += this.penaltyIntervalSeconds * 1000;
      }
      this.penaltyState.set(alert.id, state);
    }
    return this.penalty();
  }

  /** Permanently retire penalties for alerts that no longer exist. */
  private retireResolved(now: number): void {
    const current = new Set(this.alerts.keys());
    for (const [id, state] of this.penaltyState) {
      if (!current.has(id)) {
        this.retiredPenalty += state.awarded;
        this.penaltyState.delete(id);
      }
    }
    void now;
  }

  penalty(): number {
    this.retireResolved(Date.now());
    let total = this.retiredPenalty;
    for (const alert of this.alerts.values()) {
      if (alert.severity !== "critical") continue;
      total += this.penaltyState.get(alert.id)?.awarded ?? 0;
    }
    return Math.min(1000, total);
  }

  /** Clear all cached alerts/penalty state (used when switching runs). */
  reset(): void {
    this.alerts.clear();
    this.revision = 0;
    this.ackedRevision = null;
    this.ackedAt = 0;
    this.retiredPenalty = 0;
    this.penaltyState.clear();
  }

  ack(now = Date.now()): AlertEnvelope {
    this.ackedRevision = this.revision;
    this.ackedAt = now;
    return this.envelope(now);
  }

  /** Whether a critical alert has existed longer than the gate grace and is unacked. */
  gate(now = Date.now()): AlertGate {
    const critical = [...this.alerts.values()].filter((alert) => alert.severity === "critical");
    const aged = critical.filter((alert) => now - alert.first_seen_ms >= this.gateGraceSeconds * 1000);
    const envelope = this.envelope(now);
    const blocked = aged.length > 0 && this.ackedRevision !== this.revision;
    const names = aged
      .slice(0, 3)
      .map((alert) => alert.message)
      .join("; ");
    return {
      blocked,
      message: blocked ? `Critical alerts require attention before mutating actions: ${names}` : "",
      alerts: envelope,
      ...(blocked
        ? {
            nudge: {
              reason: "alerts_pending" as const,
              first_step: "observe-factory" as const,
              message:
                "Inspect the alert samples, fix power/fuel/fluid/resource causes, then ack with POST /api/agent/alerts/ack.",
            },
          }
        : {}),
    };
  }

  envelope(now = Date.now()): AlertEnvelope {
    const items = [...this.alerts.values()].sort((a, b) => a.id.localeCompare(b.id));
    const counts = { critical: 0, warning: 0 };
    for (const alert of items) counts[alert.severity]++;
    return {
      revision: this.revision,
      counts,
      items,
      acked_revision: this.ackedRevision,
      requires_ack: items.length > 0 && this.ackedRevision !== this.revision,
      penalty: this.penalty(),
      generated_at: new Date(now).toISOString(),
    };
  }

  /** Attach a compact alert envelope to an arbitrary agent JSON payload. */
  attach(data: unknown): unknown {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    return { ...(data as Record<string, unknown>), alerts: this.envelope() };
  }

  get lastAckAt(): number {
    return this.ackedAt;
  }
}
