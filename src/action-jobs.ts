import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { asRecord, asString, errorMessage } from "./validation.js";

/**
 * Serialized action-job queue for the autorio manager.
 *
 * The manager exposes long-running gameplay actions as jobs so callers can poll
 * progress instead of holding one HTTP request open. Jobs run one at a time in
 * submission order; every job is split into per-target items and dispatched back
 * into the manager's own `/api/agent/act/*` routes over a plain `node:http`
 * request (fetch/undici would abort long native actions after 300 seconds).
 *
 * Every manager-side dependency (HTTP port, internal header key, native stop,
 * run-manager hooks) is injected, so the queue can be driven in tests against a
 * fake HTTP endpoint without a manager, RCON connection or game.
 */

export type JobAction =
  | "build"
  | "mine"
  | "move"
  | "rotate"
  | "set-recipe"
  | "launch-rocket"
  | "research"
  | "craft"
  | "insert"
  | "extract";

export type ActionJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * JSON value accepted as a job payload and echoed back in job records. The
 * queue only inspects `entities`/`targets`/`clear_obstacles`; everything else
 * is forwarded verbatim to the matching action route.
 */
export type JobPayload = unknown;

/** Result of one per-item `/api/agent/act/*` dispatch, reported to API clients. */
export type JobResult = unknown;

/** One internal dispatch as seen by the queue: HTTP status plus parsed JSON body. */
export type JobDispatchResponse = { status: number; body: unknown };

/** Envelope returned by the manager action routes: `{ok, data:{results}, error}`. */
export type JobEnvelope = {
  ok?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ActionJob = {
  id: string;
  action: JobAction;
  idempotency_key: string | null;
  status: ActionJobStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  total: number;
  completed: number;
  results: JobResult[];
  error: string | null;
  cancel_requested: boolean;
  payload: JobPayload;
};

/** Public (HTTP/JSON) projection of an action job. Field order is part of the API. */
export type PublicActionJob = {
  job_id: string;
  action: JobAction;
  idempotency_key: string | null;
  status: ActionJobStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  progress: { completed: number; total: number };
  results: JobResult[];
  error: string | null;
  cancel_requested: boolean;
};

/** Record persisted by the injected onRecord hook (run.json/actions accounting). */
export type ActionJobRecord = PublicActionJob & { payload: JobPayload };

export type ActionJobQueueOptions = {
  /** Manager HTTP port that receives the internal `/api/agent/act/*` dispatches. */
  port: number;
  /** Header value authorizing internal dispatches (`X-Autorio-Internal`). */
  internalKey: string;
  /** Stops the native controller when the running job is cancelled. */
  nativeStop?: () => Promise<void> | void;
  /**
   * External cancellation condition OR'd with a job's own `cancel_requested`
   * flag, e.g. "the run manager is busy but no longer accepting actions".
   */
  isCancelled?: () => boolean;
  /** Persists submitted/finished job records in submission order. */
  onRecord?: (event: "submitted" | "finished", record: ActionJobRecord) => void;
  /** Socket safety timeout for one internal dispatch; defaults to 30 minutes. */
  timeoutMs?: number;
  /** How long finished jobs stay queryable; defaults to one hour. */
  retentionMs?: number;
  /** Retention clock, injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Retention sweep interval; defaults to one minute. */
  cleanupIntervalMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export const actionPaths: Record<JobAction, string> = {
  build: "/api/agent/act/build",
  mine: "/api/agent/act/mine",
  move: "/api/agent/act/move",
  rotate: "/api/agent/act/rotate",
  "set-recipe": "/api/agent/act/set-recipe",
  "launch-rocket": "/api/agent/act/launch-rocket",
  research: "/api/agent/act/research",
  craft: "/api/agent/act/craft",
  insert: "/api/agent/act/insert",
  extract: "/api/agent/act/extract",
};

/** Splits a job payload into the ordered per-item payloads dispatched to the API. */
export function splitJobPayload(action: JobAction, payload: JobPayload): unknown[] {
  if (action === "build") {
    const record = asRecord(payload);
    const clear = record?.clear_obstacles !== false;
    return (Array.isArray(record?.entities) ? record.entities : []).map((entity) => ({
      entities: [entity],
      clear_obstacles: clear,
    }));
  }
  if (["mine", "move", "rotate", "set-recipe", "launch-rocket"].includes(action)) {
    const record = asRecord(payload);
    return (Array.isArray(record?.targets) ? record.targets : []).map((target) => ({
      targets: [target],
    }));
  }
  return [payload ?? {}];
}

/**
 * Reports the per-item result for one internal dispatch. Keeps the historical
 * `data.results[0] ?? data ?? envelope` precedence and wraps non-2xx replies as
 * `{ok:false, error, detail}` so job consumers keep the same JSON shapes.
 */
export function jobResultFromDispatch(response: JobDispatchResponse): JobResult {
  const envelope: JobEnvelope | undefined = asRecord(response.body);
  const data = envelope ? envelope.data : undefined;
  const dataRecord = asRecord(data);
  const firstResult = dataRecord && Array.isArray(dataRecord.results) ? dataRecord.results[0] : undefined;
  let result: JobResult = firstResult ?? data ?? response.body;
  if (response.status < 200 || response.status >= 300) {
    const error = asString(envelope?.error) || `HTTP ${response.status}`;
    result = { ok: false, error, detail: result };
  }
  return result;
}

function toPublicJob(job: ActionJob): PublicActionJob {
  return {
    job_id: job.id,
    action: job.action,
    idempotency_key: job.idempotency_key,
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    progress: { completed: job.completed, total: job.total },
    results: job.results,
    error: job.error,
    cancel_requested: job.cancel_requested,
  };
}

export class ActionJobQueue {
  private readonly port: number;
  private readonly internalKey: string;
  private readonly nativeStop?: () => Promise<void> | void;
  private readonly isCancelledHook?: () => boolean;
  private readonly onRecord?: (event: "submitted" | "finished", record: ActionJobRecord) => void;
  private readonly timeoutMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly jobs = new Map<string, ActionJob>();
  private readonly jobKeys = new Map<string, string>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private actionQueue: Promise<void> = Promise.resolve();
  private currentJobValue: ActionJob | undefined;

  constructor(options: ActionJobQueueOptions) {
    this.port = options.port;
    this.internalKey = options.internalKey;
    this.nativeStop = options.nativeStop;
    this.isCancelledHook = options.isCancelled;
    this.onRecord = options.onRecord;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
    );
    // The sweep must never be the only reason a manager/test process stays alive.
    this.cleanupTimer.unref();
  }

  /** The job currently executing, if any (captured by native-action cancellation checks). */
  get currentJob(): ActionJob | undefined {
    return this.currentJobValue;
  }

  /** Number of tracked jobs (queued, running or retained). */
  size(): number {
    return this.jobs.size;
  }

  get(id: string): ActionJob | undefined {
    return this.jobs.get(id);
  }

  /** Public projection of a tracked job, or `undefined` when it is unknown/pruned. */
  publicJob(id: string): PublicActionJob | undefined {
    const job = this.jobs.get(id);
    return job ? toPublicJob(job) : undefined;
  }

  /**
   * Legacy cancellation guard: the evaluated job was asked to stop, or the
   * injected external condition reports cancellation. Passing a job evaluates
   * that job (native actions capture the job they were dispatched for); omitting
   * it evaluates the live current job.
   */
  isCancelled(job: ActionJob | undefined = this.currentJobValue): boolean {
    return Boolean(job?.cancel_requested) || Boolean(this.isCancelledHook?.());
  }

  submit(action: JobAction, payload: JobPayload, idempotencyKey: string | null): ActionJob {
    const scopedKey = idempotencyKey ? `${action}:${idempotencyKey}` : null;
    if (idempotencyKey) {
      const existingId = this.jobKeys.get(scopedKey!);
      const existing = existingId ? this.jobs.get(existingId) : null;
      if (existing) return existing;
    }
    const items = splitJobPayload(action, payload);
    const job: ActionJob = {
      id: randomUUID(),
      action,
      idempotency_key: idempotencyKey,
      status: "queued",
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      total: items.length,
      completed: 0,
      results: [],
      error: null,
      cancel_requested: false,
      payload,
    };
    this.jobs.set(job.id, job);
    this.record("submitted", job);
    if (scopedKey) this.jobKeys.set(scopedKey, job.id);
    this.actionQueue = this.actionQueue.then(
      () => this.runActionJob(job),
      () => this.runActionJob(job),
    );
    return job;
  }

  /**
   * Requests cancellation and stops the native controller when the job is the
   * one currently executing. Returns the job, or `undefined` for unknown ids.
   */
  async cancel(id: string): Promise<ActionJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "queued" || job.status === "running") job.cancel_requested = true;
    if (job === this.currentJobValue && this.nativeStop) {
      try {
        await this.nativeStop();
      } catch {
        /* The native stop is best-effort; the cancelled job is reported either way. */
      }
    }
    return job;
  }

  /** Flags every queued/running job for cancellation (run-manager shutdown hooks). */
  cancelAll(): void {
    for (const job of this.jobs.values())
      if (["queued", "running"].includes(job.status)) job.cancel_requested = true;
  }

  /** Resolves when every job submitted so far has finished. */
  drain(): Promise<void> {
    return this.actionQueue;
  }

  /** Drops all tracked jobs and idempotency keys. */
  clear(): void {
    this.jobs.clear();
    this.jobKeys.clear();
  }

  /** Deletes finished jobs older than the retention window; returns the removed count. */
  cleanup(nowMs: number = this.now()): number {
    const cutoff = nowMs - this.retentionMs;
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.completed_at && Date.parse(job.completed_at) < cutoff) {
        this.jobs.delete(id);
        if (job.idempotency_key) this.jobKeys.delete(`${job.action}:${job.idempotency_key}`);
        removed++;
      }
    }
    return removed;
  }

  /** Stops the background retention sweep (tests / process teardown). */
  close(): void {
    clearInterval(this.cleanupTimer);
  }

  private record(event: "submitted" | "finished", job: ActionJob) {
    this.onRecord?.(event, { ...toPublicJob(job), payload: job.payload });
  }

  // The queue owns timeouts and cancellation, so dispatch long actions over a
  // plain HTTP request with no client-side deadline (fetch/undici aborts at 300s).
  private internalPost(pathname: string, payload: JobPayload): Promise<JobDispatchResponse> {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: this.port,
          path: pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            "X-Autorio-Internal": this.internalKey,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch (err) {
              // prefer-promise-reject-errors: JSON.parse only throws Errors, but
              // keep the rejection reason an Error for the type-aware lint rule.
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },
      );
      // Safety net only: settle the socket after half an hour without any
      // response instead of hanging the job queue forever.
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("internal action timed out")));
      req.on("error", reject);
      req.end(body);
    });
  }

  private async runActionJob(job: ActionJob) {
    if (job.cancel_requested) {
      job.status = "cancelled";
      job.completed_at = new Date().toISOString();
      this.record("finished", job);
      return;
    }
    job.status = "running";
    this.currentJobValue = job;
    job.started_at = new Date().toISOString();
    const items = splitJobPayload(job.action, job.payload);
    try {
      for (const payload of items) {
        if (job.cancel_requested) {
          job.status = "cancelled";
          break;
        }
        const response = await this.internalPost(actionPaths[job.action], payload);
        job.results.push(jobResultFromDispatch(response));
        job.completed++;
      }
      job.status = job.cancel_requested ? "cancelled" : "completed";
    } catch (error) {
      job.status = job.cancel_requested ? "cancelled" : "failed";
      job.error = errorMessage(error) || "Action job failed";
    } finally {
      job.completed_at = new Date().toISOString();
      this.record("finished", job);
      this.currentJobValue = undefined;
    }
  }
}
