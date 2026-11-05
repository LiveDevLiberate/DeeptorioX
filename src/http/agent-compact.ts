/**
 * Compact the JSON the agent sees without changing the public manager API.
 *
 * The response envelope keeps `schema_version`, `ok`/`error`, `data`, and the
 * alert envelope. Fields that only describe the manager's own bookkeeping
 * (`timing_ms`, null job timestamps, false flags, empty clearing reports) are
 * removed. This is applied only to `/api/agent/*` responses by server.ts.
 */
export function compactAgentPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => compactAgentPayload(entry));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const jobLike = "job_id" in record && "status" in record;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (raw === null) {
      // Missing timestamps/errors are not useful to the agent.
      if (["error", "started_at", "completed_at", "idempotency_key"].includes(key)) continue;
    }
    if (key === "timing_ms" || key === "wall_duration_ms") continue;
    if (key === "truncated" && raw === false) continue;
    if (key === "cancel_requested" && raw === false) continue;
    if (key === "idempotency_key" && raw === null) continue;
    if (jobLike && ["created_at", "started_at", "completed_at", "idempotency_key"].includes(key)) {
      continue;
    }
    if (key === "clearing" && raw && typeof raw === "object" && !Array.isArray(raw)) {
      const clearing = raw as Record<string, unknown>;
      const cleared = Array.isArray(clearing.cleared) ? clearing.cleared : [];
      const skipped = Array.isArray(clearing.skipped) ? clearing.skipped : [];
      if (clearing.ok === true && cleared.length === 0 && skipped.length === 0) {
        out.clearing = { ok: true };
        continue;
      }
    }
    if (key === "movement" && raw && typeof raw === "object" && !Array.isArray(raw)) {
      const movement = raw as Record<string, unknown>;
      out.movement = {
        ...(movement.final_position ? { final_position: movement.final_position } : {}),
        ...(typeof movement.distance === "number" ? { distance: movement.distance } : {}),
      };
      if (Object.keys(out.movement as Record<string, unknown>).length === 0) delete out.movement;
      continue;
    }
    out[key] = compactAgentPayload(raw);
  }
  return out;
}
