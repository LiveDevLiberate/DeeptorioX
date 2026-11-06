import { deflateSync } from "node:zlib";

/** Build a portable blueprint wire string from observed entity positions. */
export type CaptureEntity = {
  name: string;
  position: { x: number; y: number };
  direction?: number;
  recipe?: string;
};

export type CapturedBlueprint = {
  wire: string;
  payload: {
    blueprint: {
      item: "blueprint";
      label: string;
      description: string;
      version: number;
      entities: Array<Record<string, unknown>>;
    };
  };
};

function number(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

/**
 * Serialize an already-built layout to a normal Factorio blueprint string.
 * Recipes are preserved when the observation provided them; the manager's
 * blueprint builder still requires a follow-up act-set-recipe for recipes.
 */
export function encodeCapturedBlueprint(
  entities: unknown,
  label = "Captured layout",
  description = "",
): CapturedBlueprint {
  if (!Array.isArray(entities)) throw new Error("capture entities must be an array");
  const list: Array<Record<string, unknown>> = [];
  for (const raw of entities) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entity = raw as Record<string, unknown>;
    const name = typeof entity.name === "string" ? entity.name : "";
    const position =
      entity.position && typeof entity.position === "object"
        ? (entity.position as Record<string, unknown>)
        : entity;
    const x = number(position.x ?? entity.x);
    const y = number(position.y ?? entity.y);
    if (!name || x === null || y === null) continue;
    const entry: Record<string, unknown> = {
      entity_number: list.length + 1,
      name,
      position: { x, y },
    };
    const direction = number(entity.direction);
    if (direction !== null) entry.direction = direction;
    if (typeof entity.recipe === "string" && entity.recipe) entry.recipe = entity.recipe;
    list.push(entry);
  }
  if (list.length === 0) throw new Error("capture contains no placeable entities");
  const payload = {
    blueprint: {
      item: "blueprint" as const,
      label: label.slice(0, 200),
      description: description.slice(0, 2000),
      version: 0,
      entities: list,
    },
  };
  const wire =
    "0" + deflateSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 }).toString("base64");
  return { wire, payload };
}
