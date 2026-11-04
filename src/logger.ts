import fs from "node:fs";
import path from "node:path";

/**
 * Zero-dependency structured logger for the autorio manager.
 *
 * Every record is appended as one JSON object per line to the configured log
 * file (`${DATA_DIR}/manager.log` in the manager) and mirrored as a single
 * human-readable line on stderr, which cluster/launcher scripts capture in
 * `manager.err.log`. Logging must never break the manager, so filesystem and
 * console failures are swallowed.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export type LogRecord = {
  level: LogLevel;
  ts: string;
  msg: string;
  [key: string]: unknown;
};

/** A function or `{ write(chunk) }` sink for human-readable mirror lines. */
export type LogSink = ((line: string) => void) | { write(chunk: string): void };

export type LoggerOptions = {
  /** JSONL destination; parent directories are created. `null`/omitted disables the file. */
  file?: string | null;
  /** Minimum level: debug|info|warn|error; defaults to AUTORIO_LOG_LEVEL, then "info". */
  level?: string;
  /** Human mirror: `true`/omitted writes to stderr, `false` disables it, or pass a sink. */
  console?: boolean | LogSink;
  /** Injectable clock so tests can produce deterministic timestamps. */
  now?: () => Date;
};

export interface Logger {
  readonly level: LogLevel;
  readonly file: string | null;
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  /** Returns a logger that merges the given context into every record. */
  child(context: LogContext): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS = Object.keys(LEVEL_ORDER) as LogLevel[];
const REDACTED = "[redacted]";
/** Redacted keys: password, token, api_key/apiKey/api-key, secret, authorization. */
const REDACT_KEY = /password|token|api[_-]?key|secret|authorization/i;
const MAX_REDACT_DEPTH = 5;
const HUMAN_VALUE_LIMIT = 200;

/** Coerces a level name; unknown values fall back to the provided level. */
export function normalizeLevel(value: unknown, fallback: LogLevel = "info"): LogLevel {
  if (typeof value !== "string") return fallback;
  const candidate = value.trim().toLowerCase() as LogLevel;
  return LEVELS.includes(candidate) ? candidate : fallback;
}

function describeError(error: Error): LogContext {
  const context: LogContext = { name: error.name, message: error.message };
  if (error.stack) context.stack = error.stack;
  return context;
}

/**
 * Deep-copies a log context, replacing values of secret-looking keys with
 * "[redacted]". Recurses into nested objects/arrays (bounded depth) and
 * represents Errors, Dates, Buffers and cycles safely.
 */
export function redactContext(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) return redactContext(describeError(value), depth + 1, seen);
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value.toISOString() : "Invalid Date";
  }
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (Array.isArray(value)) {
    if (depth >= MAX_REDACT_DEPTH) return "[max-depth]";
    return value.map((entry) => redactContext(entry, depth + 1, seen));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_REDACT_DEPTH) return "[max-depth]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const clean: LogContext = {};
    for (const [key, entry] of Object.entries(value)) {
      clean[key] = REDACT_KEY.test(key) ? REDACTED : redactContext(entry, depth + 1, seen);
    }
    seen.delete(value);
    return clean;
  }
  return value;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  if (value === undefined) return "undefined";
  if (value instanceof Error) return value.message;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) {
      return json.length > HUMAN_VALUE_LIMIT ? `${json.slice(0, HUMAN_VALUE_LIMIT - 3)}...` : json;
    }
  } catch {
    /* cyclic or unsupported value; fall through to the placeholder */
  }
  return "[unserializable]";
}

function formatHuman(record: LogRecord): string {
  const extras: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === "ts" || key === "level" || key === "msg" || key === "component") continue;
    extras.push(`${key}=${formatValue(value)}`);
  }
  const component = typeof record.component === "string" ? ` [${record.component}]` : "";
  const message = record.msg.replace(/[\r\n]+/g, " ");
  const suffix = extras.length > 0 ? ` ${extras.join(" ")}` : "";
  return `${record.ts} ${record.level.toUpperCase().padEnd(5)}${component} ${message}${suffix}\n`;
}

function resolveFile(file: string | null | undefined): string | null {
  if (!file) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  } catch {
    return null;
  }
}

function resolveHumanSink(option: LoggerOptions["console"]): ((line: string) => void) | null {
  if (option === false) return null;
  if (typeof option === "function") return option;
  if (option && typeof option === "object" && typeof option.write === "function") {
    return (line) => option.write(line);
  }
  return (line) => {
    try {
      process.stderr.write(line);
    } catch {
      /* stderr may be closed; logging must not throw */
    }
  };
}

function appendJsonl(file: string, record: LogRecord): void {
  try {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* logging must never break the manager */
  }
}

function buildLogger(options: LoggerOptions, baseContext: LogContext): Logger {
  const file = resolveFile(options.file);
  const level = normalizeLevel(options.level ?? process.env.AUTORIO_LOG_LEVEL);
  const now = options.now ?? (() => new Date());
  const humanSink = resolveHumanSink(options.console);

  const emit = (entryLevel: LogLevel, msg: string, context?: LogContext) => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    let ts: string;
    try {
      ts = now().toISOString();
    } catch {
      ts = new Date().toISOString();
    }
    const message = typeof msg === "string" ? msg : String(msg);
    let record: LogRecord;
    try {
      const merged = { ...baseContext, ...(context ?? {}) };
      const clean = redactContext(merged) as Record<string, unknown>;
      delete clean.level;
      delete clean.ts;
      delete clean.msg;
      record = { level: entryLevel, ts, msg: message, ...clean };
    } catch {
      record = { level: entryLevel, ts, msg: message };
    }
    if (file) appendJsonl(file, record);
    if (humanSink) {
      try {
        humanSink(formatHuman(record));
      } catch {
        /* a broken sink must not affect the manager */
      }
    }
  };

  return {
    level,
    file,
    debug: (msg, context) => emit("debug", msg, context),
    info: (msg, context) => emit("info", msg, context),
    warn: (msg, context) => emit("warn", msg, context),
    error: (msg, context) => emit("error", msg, context),
    child: (context) => buildLogger(options, { ...baseContext, ...context }),
  };
}

/**
 * Creates a logger writing JSONL to `file` and human lines to `console`
 * (stderr by default). Level is chosen by AUTORIO_LOG_LEVEL when not given.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return buildLogger(options, {});
}

let current: Logger = buildLogger({ file: null, console: false }, {});

/**
 * Replaces the default `logger` sink. The manager calls this once at startup
 * with `${DATA_DIR}/manager.log`; tests use `createLogger` with a temp file.
 */
export function configureLogger(options: LoggerOptions = {}): Logger {
  current = buildLogger(options, {});
  return current;
}

/**
 * Default logger used by `import { logger } from "./logger.js"`. It is a thin
 * facade so callers observe the configuration applied by `configureLogger`
 * even when they captured the import before configuration ran.
 */
export const logger: Logger = {
  get level() {
    return current.level;
  },
  get file() {
    return current.file;
  },
  debug: (msg, context) => current.debug(msg, context),
  info: (msg, context) => current.info(msg, context),
  warn: (msg, context) => current.warn(msg, context),
  error: (msg, context) => current.error(msg, context),
  child: (context) => current.child(context),
};
