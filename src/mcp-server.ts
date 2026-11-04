#!/usr/bin/env node
import { createInterface } from "node:readline";

// Minimal Model Context Protocol server for the autorio manager API.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
// stdout is reserved for protocol messages; every diagnostic goes to stderr.
// The manager must already be running (npm start / npm run dev) at API_BASE.

const SERVER_NAME = "autorio";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
const DEFAULT_API_BASE = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 120_000;

const API_BASE = (process.env.AUTORIO_API_BASE || process.env.FACTORIO_API_BASE || DEFAULT_API_BASE).replace(
  /\/+$/,
  "",
);

const INSTRUCTIONS = [
  "This server exposes the autorio Factorio manager. Observation tools are read-only.",
  "Game-changing tools submit a serialized action job and return immediately with a job_id;",
  "poll job_status until status is completed, failed, or cancelled (cancel_job requests cancellation).",
  "copy_settings is the exception: it mutates synchronously after reach checks and returns per-target results.",
  "Coordinates are Factorio map tiles; build anchors are top-left tile positions.",
].join(" ");

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number | null;

type TextContent = { type: "text"; text: string };
type ToolCallResult = {
  content: TextContent[];
  structuredContent?: JsonObject;
  isError?: boolean;
};

type HttpRequestSpec = { method: "GET" | "POST"; path: string; body?: JsonObject };
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  request: (args: JsonObject) => HttpRequestSpec;
};

function log(message: string): void {
  process.stderr.write(`[autorio-mcp] ${message}\n`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Tool argument validation
// ---------------------------------------------------------------------------

class ToolArgumentError extends Error {}

function requireString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolArgumentError(`${key} must be a non-empty string`);
  }
  return value;
}

function requireObject(args: JsonObject, key: string): JsonObject {
  const value = args[key];
  if (!isJsonObject(value)) throw new ToolArgumentError(`${key} must be an object`);
  return value;
}

function requireObjectArray(args: JsonObject, key: string): JsonObject[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolArgumentError(`${key} must be a non-empty array`);
  }
  return value.map((item, index) => {
    if (!isJsonObject(item)) throw new ToolArgumentError(`${key}[${index}] must be an object`);
    return item;
  });
}

function copyOptionalNumber(source: JsonObject, key: string, target: JsonObject): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolArgumentError(`${key} must be a number`);
  }
  target[key] = value;
}

function copyOptionalInteger(
  source: JsonObject,
  key: string,
  target: JsonObject,
  min = -Infinity,
  max = Infinity,
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolArgumentError(`${key} must be an integer between ${min} and ${max}`);
  }
  target[key] = value;
}

function windowArgs(args: JsonObject, keys = ["x", "y", "radius"]): JsonObject {
  const window: JsonObject = {};
  for (const key of keys) copyOptionalNumber(args, key, window);
  return window;
}

function requirePoint(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new ToolArgumentError(`${label} must be an object with x and y`);
  for (const axis of ["x", "y"]) {
    const coordinate = value[axis];
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new ToolArgumentError(`${label}.${axis} must be a number`);
    }
  }
  return value;
}

function requirePoints(args: JsonObject, key: string): JsonObject[] {
  return requireObjectArray(args, key).map((point, index) => requirePoint(point, `${key}[${index}]`));
}

function requireBuildEntities(args: JsonObject, key: string): JsonObject[] {
  return requireObjectArray(args, key).map((entity, index) => {
    if (typeof entity.name !== "string" || entity.name.length === 0) {
      throw new ToolArgumentError(`${key}[${index}].name must be a non-empty string`);
    }
    requirePoint(entity.anchor, `${key}[${index}].anchor`);
    if (
      entity.direction !== undefined &&
      (typeof entity.direction !== "number" || !Number.isInteger(entity.direction))
    ) {
      throw new ToolArgumentError(`${key}[${index}].direction must be an integer`);
    }
    return entity;
  });
}

function copyOptionalBoolean(source: JsonObject, key: string, target: JsonObject): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "boolean") throw new ToolArgumentError(`${key} must be a boolean`);
  target[key] = value;
}

function copyOptionalStringArray(source: JsonObject, key: string, target: JsonObject): void {
  const value = source[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolArgumentError(`${key} must be an array of strings`);
  }
  target[key] = value;
}

function requireCopyTargets(args: JsonObject): JsonObject[] {
  return requireObjectArray(args, "targets").map((entry, index) => {
    requirePoint(entry.source, `targets[${index}].source`);
    requirePoint(entry.target, `targets[${index}].target`);
    return entry;
  });
}

function jobRequest(action: string, payload: JsonObject, args: JsonObject): HttpRequestSpec {
  const body: JsonObject = { action, payload };
  if (args.idempotency_key !== undefined) {
    body.idempotency_key = requireString(args, "idempotency_key");
  }
  return { method: "POST", path: "/api/agent/jobs", body };
}

// ---------------------------------------------------------------------------
// HTTP execution
// ---------------------------------------------------------------------------

function successfulResult(body: unknown): ToolCallResult {
  if (isJsonObject(body)) {
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
    };
  }
  if (typeof body === "string" && body.length > 0) {
    return { content: [{ type: "text", text: body }] };
  }
  return { content: [{ type: "text", text: "{}" }] };
}

async function executeRequest(spec: HttpRequestSpec): Promise<ToolCallResult> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`${API_BASE}${spec.path}`, {
      method: spec.method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: spec.method === "GET" ? undefined : JSON.stringify(spec.body ?? {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Tool execution failures are returned as isError results so the model can
    // recover; they are not JSON-RPC protocol errors.
    return {
      content: [
        {
          type: "text",
          text: [
            `Autorio manager request failed: ${errorMessage(error)}`,
            `Is the manager running at ${API_BASE}? Start it with "npm start" or "npm run dev".`,
          ].join("\n"),
        },
      ],
      isError: true,
    };
  }

  const raw = await response.text();
  let body: unknown;
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  if (!response.ok) {
    const detail =
      isJsonObject(body) && typeof body.error === "string"
        ? body.error
        : raw.trim() || response.statusText || "request failed";
    const result: ToolCallResult = {
      content: [{ type: "text", text: `HTTP ${response.status}: ${detail}` }],
      isError: true,
    };
    if (isJsonObject(body)) result.structuredContent = body;
    return result;
  }

  return successfulResult(body);
}

// ---------------------------------------------------------------------------
// Input schema helpers
// ---------------------------------------------------------------------------

function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  const schema: JsonObject = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function pointSchema(description: string): JsonObject {
  return {
    type: "object",
    description,
    properties: {
      x: { type: "number", description: "Map x coordinate in tiles." },
      y: { type: "number", description: "Map y coordinate in tiles." },
    },
    required: ["x", "y"],
    additionalProperties: false,
  };
}

function buildEntitySchema(): JsonObject {
  return {
    type: "object",
    properties: {
      name: { type: "string", description: 'Factorio entity prototype name, e.g. "stone-furnace".' },
      anchor: pointSchema("Top-left tile anchor for the entity."),
      direction: { type: "integer", description: "Optional entity direction (0-15, entity dependent)." },
    },
    required: ["name", "anchor"],
    additionalProperties: false,
  };
}

function targetArraySchema(description: string, items: JsonObject): JsonObject {
  return { type: "array", description, items, minItems: 1 };
}

function windowSchema(radiusDescription: string, extra: JsonObject = {}): JsonObject {
  return objectSchema({
    x: {
      type: "number",
      description: "Center x in tiles (default 0, or the player position where the endpoint supports it).",
    },
    y: {
      type: "number",
      description: "Center y in tiles (default 0, or the player position where the endpoint supports it).",
    },
    radius: { type: "number", description: radiusDescription },
    ...extra,
  });
}

function jobToolSchema(required: string[], properties: JsonObject): JsonObject {
  return objectSchema(
    {
      ...properties,
      idempotency_key: {
        type: "string",
        description: "Optional idempotency key; resubmitting the same key returns the existing job.",
      },
    },
    required,
  );
}

const TARGET_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    x: { type: "number", description: "Map x coordinate in tiles." },
    y: { type: "number", description: "Map y coordinate in tiles." },
    kind: { type: "string", enum: ["entity", "resource"], description: "Optional target kind hint." },
    name: { type: "string", description: "Optional prototype/resource name hint." },
  },
  required: ["x", "y"],
  additionalProperties: false,
};

const COPY_TARGETS_SCHEMA: JsonObject = {
  type: "array",
  description: "Source/target entity pairs to copy settings between (at most 50 per call).",
  items: {
    type: "object",
    properties: {
      source: pointSchema("Source entity tile (its settings are copied from)."),
      target: pointSchema("Target entity tile (its settings are overwritten)."),
    },
    required: ["source", "target"],
    additionalProperties: false,
  },
  minItems: 1,
  maxItems: 50,
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: ToolDefinition[] = [
  {
    name: "observe_world",
    description:
      "Observe charted terrain and entities around a map position. Returns {ok, data, truncated}; data.tiles is run-length encoded terrain and data.entities is a compact entity list.",
    inputSchema: windowSchema("View radius in tiles (default 12, max 200).", {
      include: {
        type: "array",
        description: 'What to include: "terrain" for tiles and/or "entities". Defaults to both.',
        items: { type: "string", enum: ["terrain", "entities"] },
        uniqueItems: true,
      },
    }),
    request: (args) => {
      const body: JsonObject = { window: windowArgs(args) };
      const include = args.include;
      if (include !== undefined) {
        if (!Array.isArray(include) || include.some((item) => typeof item !== "string")) {
          throw new ToolArgumentError("include must be an array of strings");
        }
        body.include = include;
      }
      return { method: "POST", path: "/api/agent/observe/world", body };
    },
  },
  {
    name: "observe_map",
    description: "Observe only the map chunks charted by the player's force, with terrain classes per chunk.",
    inputSchema: windowSchema("View radius in tiles (default 48, max 96)."),
    request: (args) => ({
      method: "POST",
      path: "/api/agent/observe/map",
      body: { window: windowArgs(args) },
    }),
  },
  {
    name: "observe_player",
    description: "Observe the player character: position, inventories, equipment, and status.",
    inputSchema: objectSchema({
      inventory_slots: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Inventory slots to include (default 200).",
      },
      equipment_slots: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Equipment slots to include (default 50).",
      },
    }),
    request: (args) => {
      const limits: JsonObject = {};
      copyOptionalInteger(args, "inventory_slots", limits, 1, 200);
      copyOptionalInteger(args, "equipment_slots", limits, 1, 50);
      return { method: "POST", path: "/api/agent/observe/player", body: { limits } };
    },
  },
  {
    name: "observe_research",
    description:
      "Observe research state: available, locked, queued, current, and completed technologies with science pack requirements.",
    inputSchema: objectSchema({
      available: {
        type: "integer",
        minimum: 0,
        maximum: 200,
        description: "Available technologies to include (default 50).",
      },
      locked: {
        type: "integer",
        minimum: 0,
        maximum: 200,
        description: "Locked technologies to include (default 50).",
      },
      completed: {
        type: "integer",
        minimum: 0,
        maximum: 200,
        description: "Completed technologies to include (default 50).",
      },
    }),
    request: (args) => {
      const limits: JsonObject = {};
      copyOptionalInteger(args, "available", limits, 0, 200);
      copyOptionalInteger(args, "locked", limits, 0, 200);
      copyOptionalInteger(args, "completed", limits, 0, 200);
      return { method: "POST", path: "/api/agent/observe/research", body: { limits } };
    },
  },
  {
    name: "observe_recipes",
    description: "Observe crafting recipes available to the player, optionally limited to unlocked recipes.",
    inputSchema: objectSchema({
      recipes: {
        type: "integer",
        minimum: 1,
        maximum: 300,
        description: "Maximum recipes to return (default 300).",
      },
      unlocked_only: { type: "boolean", description: "Only return unlocked recipes." },
    }),
    request: (args) => {
      const body: JsonObject = {};
      const limits: JsonObject = {};
      copyOptionalInteger(args, "recipes", limits, 1, 300);
      if (Object.keys(limits).length > 0) body.limits = limits;
      if (args.unlocked_only !== undefined) {
        if (typeof args.unlocked_only !== "boolean") {
          throw new ToolArgumentError("unlocked_only must be a boolean");
        }
        if (args.unlocked_only) body.filters = { unlocked: true };
      }
      return { method: "POST", path: "/api/agent/observe/recipes", body };
    },
  },
  {
    name: "observe_factory",
    description:
      "Observe a compact factory power/fuel/status summary: entity counts by status, blocked or unfueled buildings, coal in fuel slots, electric network satisfaction, and alerts.",
    inputSchema: windowSchema("Audit radius in tiles (default 120, max 256)."),
    request: (args) => ({
      method: "POST",
      path: "/api/agent/observe/factory",
      body: { window: windowArgs(args) },
    }),
  },
  {
    name: "observe_layout",
    description:
      "Observe a coarse terrain/layout summary (terrain classes, water, cliffs, and structure density) for planning.",
    inputSchema: windowSchema("Layout radius in tiles (default 35, max 80).", {
      step: { type: "integer", minimum: 1, maximum: 8, description: "Sampling step in tiles (default 1)." },
    }),
    request: (args) => {
      const window = windowArgs(args);
      copyOptionalInteger(args, "step", window, 1, 8);
      return { method: "POST", path: "/api/agent/observe/layout", body: { window } };
    },
  },
  {
    name: "observe_connections",
    description:
      "Audit machine, inserter, belt, pipe, and power connections in an area and report missing or mismatched connections.",
    inputSchema: windowSchema("Audit radius in tiles (default 120, max 256)."),
    request: (args) => ({
      method: "POST",
      path: "/api/agent/observe/connections",
      body: { window: windowArgs(args) },
    }),
  },
  {
    name: "observe_placement",
    description:
      "Dry-run placement analysis for one or more entities without building them: footprint, reach, terrain, blockers, and nearby valid anchors.",
    inputSchema: objectSchema(
      {
        placements: targetArraySchema("Entities to analyze.", buildEntitySchema()),
      },
      ["placements"],
    ),
    request: (args) => ({
      method: "POST",
      path: "/api/agent/observe/placement",
      body: { placements: requireBuildEntities(args, "placements") },
    }),
  },
  {
    name: "observe_resources",
    description:
      "Observe charted resource patches (connected components with totals and nearest patches) and shoreline candidates around a position.",
    inputSchema: windowSchema("Search radius in tiles (default 50, max 500)."),
    request: (args) => ({
      method: "POST",
      path: "/api/agent/observe/resources",
      body: { window: windowArgs(args) },
    }),
  },
  {
    name: "observe_production",
    description:
      "Read-only. Observe manager-collected production telemetry from the independent sampler (default 5 s): production_per_minute, deltas, research, rockets, and the sample window. Use it to verify that automation actually produces a target item; returns 409 until a live sample exists.",
    inputSchema: objectSchema({}),
    request: () => ({ method: "POST", path: "/api/agent/observe/production", body: {} }),
  },
  {
    name: "observe_fluids",
    description:
      "Read-only. Observe fluid networks and levels around a map position: fluid types, amounts, capacities, networks, and connected entities.",
    inputSchema: windowSchema("Fluid scan radius in tiles (default 32, max 128)."),
    request: (args) => ({
      method: "POST",
      path: "/api/agent/observe/fluids",
      body: { window: windowArgs(args) },
    }),
  },
  {
    name: "observe_combat",
    description:
      "Read-only. Observe enemy nests and units, turrets and their ammo, and player health in an area. Recent damage is not derivable from one reply: compare player.health across calls.",
    inputSchema: windowSchema("Combat scan radius in tiles (default 64, max 256)."),
    request: (args) => ({
      method: "POST",
      path: "/api/agent/observe/combat",
      body: { window: windowArgs(args) },
    }),
  },
  {
    name: "observe_area",
    description:
      "Read-only. List deconstruct-planning candidates in an area with name, type, tile, health, and player_created, filterable by entity type or name. Deconstruction is client-driven: mine the returned entities with mine jobs. Use before acting on an area.",
    inputSchema: windowSchema("Scan radius in tiles (default 64, max 128).", {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Maximum entities to return (default 300).",
      },
      types: {
        type: "array",
        items: { type: "string" },
        maxItems: 100,
        description: 'Keep only these entity types, e.g. ["assembling-machine"].',
      },
      filters: {
        type: "array",
        items: { type: "string" },
        maxItems: 100,
        description:
          "Keep entities whose prototype name or type matches one of these (deconstruction-planner filters).",
      },
      player_only: {
        type: "boolean",
        description: "Only entities last built or changed by a player.",
      },
    }),
    request: (args) => {
      const body: JsonObject = { window: windowArgs(args) };
      copyOptionalInteger(args, "limit", body, 1, 1000);
      copyOptionalStringArray(args, "types", body);
      copyOptionalStringArray(args, "filters", body);
      copyOptionalBoolean(args, "player_only", body);
      return { method: "POST", path: "/api/agent/observe/area", body };
    },
  },
  {
    name: "copy_settings_check",
    description:
      "Read-only dry-run. Check reach and compatibility for copying settings (recipe, filters, splitter priority, combinator) between source/target entity pairs without mutating anything. Use before copy_settings; both entities must be within the character's reach, so move first.",
    inputSchema: objectSchema({ targets: COPY_TARGETS_SCHEMA }, ["targets"]),
    request: (args) => ({
      method: "POST",
      path: "/api/agent/observe/copy-settings",
      body: { targets: requireCopyTargets(args) },
    }),
  },
  {
    name: "copy_settings",
    description:
      "Action (mutates entity settings). Synchronously copy settings (recipe, filters, splitter priority, combinator) from each source entity onto its target. NOT a queued action job: per-target results return immediately. Both entities must be within reach (move first); unreachable or incompatible pairs are reported and never mutated. Use copy_settings_check first to preview.",
    inputSchema: objectSchema(
      {
        targets: COPY_TARGETS_SCHEMA,
        dry_run: {
          type: "boolean",
          description:
            "Preview only: report reach/compatibility without mutating (same as copy_settings_check).",
        },
      },
      ["targets"],
    ),
    request: (args) => {
      const body: JsonObject = { targets: requireCopyTargets(args) };
      copyOptionalBoolean(args, "dry_run", body);
      return { method: "POST", path: "/api/agent/act/copy-settings", body };
    },
  },
  {
    name: "build",
    description:
      "Queue a build job that places entities one at a time, walking into reach and clearing trees/rocks from footprints first. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["entities"], {
      entities: targetArraySchema("Entities to place.", buildEntitySchema()),
      clear_obstacles: {
        type: "boolean",
        description: "Mine trees/rocks from each footprint before placing (default true).",
      },
    }),
    request: (args) => {
      const payload: JsonObject = { entities: requireBuildEntities(args, "entities") };
      if (args.clear_obstacles !== undefined) {
        if (typeof args.clear_obstacles !== "boolean") {
          throw new ToolArgumentError("clear_obstacles must be a boolean");
        }
        payload.clear_obstacles = args.clear_obstacles;
      }
      return jobRequest("build", payload, args);
    },
  },
  {
    name: "mine",
    description:
      "Queue a mine job for resource or entity targets. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["targets"], {
      targets: targetArraySchema("Targets to mine.", TARGET_SCHEMA),
    }),
    request: (args) => {
      const targets = requirePoints(args, "targets");
      for (const target of targets) {
        if (target.kind !== undefined && target.kind !== "entity" && target.kind !== "resource") {
          throw new ToolArgumentError('target kind must be "entity" or "resource"');
        }
        if (target.name !== undefined && typeof target.name !== "string") {
          throw new ToolArgumentError("target name must be a string");
        }
      }
      return jobRequest("mine", { targets }, args);
    },
  },
  {
    name: "move",
    description:
      "Queue a move job that walks the character to tile targets. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["targets"], {
      targets: targetArraySchema("Tiles to walk to.", pointSchema("Destination tile.")),
    }),
    request: (args) => jobRequest("move", { targets: requirePoints(args, "targets") }, args),
  },
  {
    name: "rotate",
    description:
      "Queue a rotate job that rotates entities under the given tile targets. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["targets"], {
      targets: targetArraySchema("Entities to rotate.", pointSchema("Entity tile.")),
    }),
    request: (args) => jobRequest("rotate", { targets: requirePoints(args, "targets") }, args),
  },
  {
    name: "set_recipe",
    description:
      "Queue a set-recipe job that assigns a crafting recipe to assembling machines at the given tile targets. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["targets"], {
      targets: targetArraySchema("Machines to configure.", {
        type: "object",
        properties: {
          x: { type: "number", description: "Map x coordinate in tiles." },
          y: { type: "number", description: "Map y coordinate in tiles." },
          recipe: { type: "string", description: 'Recipe name to set, e.g. "iron-gear-wheel".' },
        },
        required: ["x", "y", "recipe"],
        additionalProperties: false,
      }),
    }),
    request: (args) => {
      const targets = requirePoints(args, "targets");
      for (const target of targets) {
        if (typeof target.recipe !== "string" || target.recipe.length === 0) {
          throw new ToolArgumentError("every target needs a recipe");
        }
      }
      return jobRequest("set-recipe", { targets }, args);
    },
  },
  {
    name: "craft",
    description:
      "Queue a hand-crafting job. Returns the job immediately; poll job_status for results (crafting may take a while after the job completes).",
    inputSchema: jobToolSchema(["item"], {
      item: { type: "string", description: 'Recipe/item name to craft, e.g. "iron-gear-wheel".' },
      count: { type: "integer", minimum: 1, maximum: 10000, description: "How many to craft (default 1)." },
    }),
    request: (args) => {
      const payload: JsonObject = { item: requireString(args, "item") };
      copyOptionalInteger(args, "count", payload, 1, 10000);
      return jobRequest("craft", payload, args);
    },
  },
  {
    name: "insert",
    description:
      "Queue a job that inserts items from the player inventory into a machine or container. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["entity", "item"], {
      entity: pointSchema("Target entity tile."),
      item: { type: "string", description: "Item name to insert." },
      count: { type: "integer", minimum: 1, maximum: 100000, description: "How many to insert (default 1)." },
    }),
    request: (args) => {
      const payload: JsonObject = {
        entity: requirePoint(requireObject(args, "entity"), "entity"),
        item: requireString(args, "item"),
      };
      copyOptionalInteger(args, "count", payload, 1, 100000);
      return jobRequest("insert", payload, args);
    },
  },
  {
    name: "extract",
    description:
      "Queue a job that extracts items from a machine or container into the player inventory. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["entity", "item"], {
      entity: pointSchema("Source entity tile."),
      item: { type: "string", description: "Item name to extract." },
      count: {
        type: "integer",
        minimum: -1,
        maximum: 100000,
        description: 'How many to extract (default 1); use "all" or -1 to extract everything.',
      },
    }),
    request: (args) => {
      const payload: JsonObject = {
        entity: requirePoint(requireObject(args, "entity"), "entity"),
        item: requireString(args, "item"),
      };
      const count = args.count;
      if (count !== undefined) {
        if (count === "all") {
          payload.count = "all";
        } else {
          copyOptionalInteger(args, "count", payload, -1, 100000);
        }
      }
      return jobRequest("extract", payload, args);
    },
  },
  {
    name: "research",
    description:
      "Queue a job that starts researching a technology. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["technology"], {
      technology: { type: "string", description: 'Technology name, e.g. "automation".' },
    }),
    request: (args) => jobRequest("research", { technology: requireString(args, "technology") }, args),
  },
  {
    name: "launch_rocket",
    description:
      "Queue a job that launches ready rocket silos; success means the launch was initiated, not that the rocket finished flying. Returns the job immediately; poll job_status for results.",
    inputSchema: jobToolSchema(["targets"], {
      targets: targetArraySchema("Rocket silo tiles to launch.", pointSchema("Silo tile.")),
    }),
    request: (args) => jobRequest("launch-rocket", { targets: requirePoints(args, "targets") }, args),
  },
  {
    name: "server_status",
    description:
      "Read the autorio manager and Factorio server status, including whether the game is running and the current save.",
    inputSchema: objectSchema({}),
    request: () => ({ method: "GET", path: "/api/server/status" }),
  },
  {
    name: "list_runs",
    description: "List benchmark runs known to the manager (state, benchmark, agent, model, elapsed time).",
    inputSchema: objectSchema({}),
    request: () => ({ method: "GET", path: "/api/runs" }),
  },
  {
    name: "list_benchmarks",
    description: "List the benchmark definitions available to the manager.",
    inputSchema: objectSchema({}),
    request: () => ({ method: "GET", path: "/api/benchmarks" }),
  },
  {
    name: "job_status",
    description:
      "Poll an action job by id. Reports status (queued/running/completed/failed/cancelled), progress, per-item results, and error.",
    inputSchema: objectSchema(
      {
        job_id: { type: "string", description: "Job id returned by an action tool." },
      },
      ["job_id"],
    ),
    request: (args) => ({
      method: "GET",
      path: `/api/agent/jobs/${encodeURIComponent(requireString(args, "job_id"))}`,
    }),
  },
  {
    name: "cancel_job",
    description:
      "Request cancellation of a queued or running action job. An action already executing in Factorio is not rolled back.",
    inputSchema: objectSchema(
      {
        job_id: { type: "string", description: "Job id to cancel." },
      },
      ["job_id"],
    ),
    request: (args) => ({
      method: "POST",
      path: `/api/agent/jobs/${encodeURIComponent(requireString(args, "job_id"))}/cancel`,
      body: {},
    }),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function publicTools(): JsonObject[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function initializeResult(params: unknown): JsonObject {
  const incoming = isJsonObject(params) ? params : {};
  const requested = typeof incoming.protocolVersion === "string" ? incoming.protocolVersion : undefined;
  const protocolVersion =
    requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  };
}

async function callTool(params: unknown): Promise<ToolCallResult> {
  const incoming = isJsonObject(params) ? params : {};
  const name = incoming.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ToolArgumentError("tools/call requires a tool name");
  }
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new ToolArgumentError(`Unknown tool: ${name}`);
  const rawArguments = incoming.arguments;
  const args = rawArguments === undefined || rawArguments === null ? {} : rawArguments;
  if (!isJsonObject(args)) throw new ToolArgumentError("tool arguments must be an object");
  log(`tools/call ${name}`);
  return executeRequest(tool.request(args));
}

async function handleMessage(message: JsonObject): Promise<void> {
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const rawId = message.id;
  if (hasId && !(typeof rawId === "string" || typeof rawId === "number" || rawId === null)) {
    sendError(null, -32600, "Invalid Request: id must be a string, number, or null");
    return;
  }
  const id: JsonRpcId = hasId ? (rawId as JsonRpcId) : null;
  const method = message.method;
  if (typeof method !== "string") {
    if (hasId) sendError(id, -32600, "Invalid Request: method must be a string");
    return;
  }

  try {
    if (method === "initialize") {
      if (hasId) sendResult(id, initializeResult(message.params));
      return;
    }
    if (method === "notifications/initialized") {
      // Notification: never answered.
      return;
    }
    if (method === "ping") {
      if (hasId) sendResult(id, {});
      return;
    }
    if (method === "tools/list") {
      if (hasId) sendResult(id, { tools: publicTools() });
      return;
    }
    if (method === "tools/call") {
      if (!hasId) return;
      sendResult(id, await callTool(message.params));
      return;
    }
    if (!hasId) {
      log(`ignoring unsupported notification: ${method}`);
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    if (error instanceof ToolArgumentError) {
      if (hasId) sendError(id, -32602, error.message);
      return;
    }
    const detail = errorMessage(error);
    log(`internal error handling ${method}: ${detail}`);
    if (hasId) sendError(id, -32603, `Internal error: ${detail}`);
  }
}

async function handleLine(line: string): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    log("received a line that is not valid JSON");
    sendError(null, -32700, "Parse error");
    return;
  }
  if (!isJsonObject(message)) {
    sendError(null, -32600, "Invalid Request");
    return;
  }
  await handleMessage(message);
}

// Requests are handled in order so tools/call side effects cannot race each
// other inside this process; the manager serializes action jobs separately.
let workQueue: Promise<void> = Promise.resolve();
function enqueue(line: string): void {
  workQueue = workQueue
    .then(() => handleLine(line))
    .catch((error) => log(`message handling failed: ${errorMessage(error)}`));
}

function main(): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length > 0) enqueue(trimmed);
  });
  input.on("close", () => log("stdin closed; shutting down"));
  log(`MCP stdio server ready (manager API base ${API_BASE})`);
}

process.stdout.on("error", (error) => log(`stdout error: ${errorMessage(error)}`));
process.on("uncaughtException", (error) => log(`uncaught exception: ${errorMessage(error)}`));
process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${errorMessage(reason)}`));

main();
