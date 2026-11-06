// Pure Lua `/sc` builders for the area-edit capability (P0-4): observe an area
// for deconstruct planning and copy entity settings between two entities.
//
// Verified against the official Factorio 2.1.24 runtime docs
// (https://lua-api.factorio.com/latest/classes/LuaEntity.html):
//   * `LuaEntity:copy_settings(entity, by_player?) → array[ItemWithQualityCount]`
//     - "Copies settings from the given entity onto this entity." It covers
//     whatever the in-game "paste settings" tool supports for the entity types:
//     assembling-machine/furnace/chemical-plant recipe, inserter filters,
//     chest/splitter filters and priorities, combinator settings, etc. There is
//     a direct engine API, so no per-field fallback is implemented.
//     `by_player` makes the copy happen "as" that player and triggers
//     `on_entity_settings_pasted`; we pass the local player so the action is
//     attributed like a real paste. The return value is "any items removed from
//     this entity as a result of copying the settings" and is surfaced as
//     `removed_items` (empty for most entity pairs).
//   * `LuaEntity:last_user` (LuaPlayer?) is "the last player that changed any
//     setting on this entity. This includes building the entity, changing its
//     color, or configuring its circuit network. nil if the last user is not
//     part of the save anymore. Can only be used if this is EntityWithOwner or
//     DeconstructibleTileProxy or TileGhost." `player_created` is therefore a
//     native-paste heuristic (last player to touch it), read inside pcall so
//     entity types that do not support `last_user` report false instead of
//     failing the whole area scan.
//   * `LuaEntity:can_reach_entity(entity)` is the native-character reach check.
//     Settings copy is refused for entities the character cannot reach (the
//     client moves with `act-move` then retries), mirroring the in-game
//     shift-click "paste settings" interaction. No walking happens in the
//     command itself.
//
// Deconstruction is intentionally client-driven: `observeAreaCommand` returns
// the entity list, and the client executes `act-mine` batches through the
// existing job queue. There is no server-side mining/deconstruct command here.
import { luaString } from "./command-builders.js";

/** How many copy targets one command accepts (payloads beyond this are cut). */
export const AREA_EDIT_COPY_LIMIT = 50;
/** Observe-area defaults/limits (radius in tiles, limit in entities). */
export const AREA_EDIT_DEFAULT_RADIUS = 64;
export const AREA_EDIT_MAX_RADIUS = 128;
export const AREA_EDIT_DEFAULT_LIMIT = 300;
export const AREA_EDIT_MAX_LIMIT = 1000;
/** Entity types never reported by the area scan (not deconstructable/resource). */
export const AREA_EDIT_EXCLUDED_TYPES = [
  "resource",
  "character",
  "cliff",
  "item-entity",
  "corpse",
  "particle",
  "projectile",
  "beam",
  "lightning",
  "stream",
  "sticker",
  "speech-bubble",
  "highlight-box",
  "explosion",
  "fire",
  "smoke",
] as const;

export type TilePoint = { x: number; y: number };
/** Raw copy request entry; coordinates are validated by the builder. */
export type CopySettingsInput = { source?: unknown; target?: unknown };
export type ObserveAreaParams = {
  x: number;
  y: number;
  radius: number;
  types?: string[];
  filters?: string[];
  limit?: number;
  playerOnly?: boolean;
  order?: "name" | "near";
};

/** Keep only array entries, capped at `limit`, so per-entry errors stay aligned. */
export function normalizeCopyTargets(value: unknown, limit = AREA_EDIT_COPY_LIMIT): CopySettingsInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit) as CopySettingsInput[];
}

/** A JSON-ish point from an unknown payload: finite-convertible x and y or null. */
export function parseTilePoint(value: unknown): TilePoint | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Prototype names/types only: keeps untrusted filter strings out of Lua source. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/;

function safeIdentifiers(values: string[] | undefined): string[] {
  return (values ?? []).filter((value) => typeof value === "string" && SAFE_IDENTIFIER.test(value));
}

function luaStringSet(values: string[] | undefined): string {
  const entries = safeIdentifiers(values);
  if (entries.length === 0) return "{}";
  return `{${entries.map((value) => `[${luaString(value)}]=true`).join(",")}}`;
}

/**
 * Build a `/sc` command that copies settings from each `source` entity to the
 * matching `target` entity. Every entry produces exactly one result, including
 * malformed entries (`error='invalid_target'`), so callers can zip results back
 * onto their request. `dryRun` reports reach/compatibility without mutating.
 *
 * Result shape (JSON printed by RCON):
 *   {ok, dry_run, counts:{total,ok,failed}, results:[{ok, error?, dry_run?,
 *    source:{x,y,name?,type?,position?}, target:{...}, reach:{source,target},
 *    removed_items?}]}
 */
export function copySettingsCommand(targets: unknown, options: { dryRun?: boolean } = {}): string {
  const list = normalizeCopyTargets(targets);
  const parts = [
    "/sc",
    "local p=game.players[1]",
    "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    "local s=p.surface",
    `local dry_run=${options.dryRun ? "true" : "false"}`,
    "local function find_entity(x,y)",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {}",
    "local candidates={}",
    "for _,cand in pairs(ents) do",
    "if cand and cand.valid and cand.type~='character' and cand.type~='resource' and cand.type~='item-entity' and cand.type~='corpse' then table.insert(candidates,{entity=cand,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end",
    "end",
    "table.sort(candidates,function(a,b) return a.key<b.key end)",
    "return candidates[1] and candidates[1].entity or nil",
    "end",
    "local function copy_one(sx,sy,tx,ty)",
    "local source=find_entity(sx,sy)",
    "local target=find_entity(tx,ty)",
    "local result={ok=false,source={x=sx,y=sy},target={x=tx,y=ty}}",
    "if not source then result.error='no_source_entity' return result end",
    "if not target then result.error='no_target_entity' return result end",
    "result.source.name=source.name result.source.type=source.type result.source.position={x=source.position.x,y=source.position.y}",
    "result.target.name=target.name result.target.type=target.type result.target.position={x=target.position.x,y=target.position.y}",
    "local source_reach=false local target_reach=false",
    "pcall(function() source_reach=p.can_reach_entity(source)==true end)",
    "pcall(function() target_reach=p.can_reach_entity(target)==true end)",
    "result.reach={source=source_reach,target=target_reach}",
    "if not source_reach or not target_reach then result.error='out_of_reach' return result end",
    "if source.type~=target.type then result.error='incompatible_types' return result end",
    "if dry_run then result.ok=true result.dry_run=true return result end",
    "local call_ok, removed_items=pcall(function() return target.copy_settings(source,p) end)",
    "if not call_ok then result.error='settings_copy_failed' result.detail=tostring(removed_items) return result end",
    "result.ok=true",
    "if type(removed_items)=='table' then result.removed_items=removed_items end",
    "return result",
    "end",
    "local results={}",
  ];
  list.forEach((entry, index) => {
    const source = parseTilePoint(entry?.source);
    const target = parseTilePoint(entry?.target);
    if (!source || !target) {
      // Static per-entry error so malformed payloads never touch the game.
      parts.push(`table.insert(results,{ok=false,error='invalid_target',index=${index}})`);
      return;
    }
    parts.push(`table.insert(results,copy_one(${source.x},${source.y},${target.x},${target.y}))`);
  });
  parts.push(
    "local ok_count=0 local failed=0",
    "for _,r in ipairs(results) do if r.ok then ok_count=ok_count+1 else failed=failed+1 end end",
    "done{ok=(failed==0),dry_run=dry_run,counts={total=#results,ok=ok_count,failed=failed},results=results}",
  );
  return parts.join(" ");
}

/**
 * Build a `/sc` command that lists deconstruct candidates in a square area.
 *
 * Reported fields per entity: name, type, x/y (tile), center position (exact),
 * health, player_created (LuaEntity.last_user ~= nil). Entity types listed in
 * {@link AREA_EDIT_EXCLUDED_TYPES} are always skipped. `types` matches
 * `entity.type`; `filters` matches either `entity.name` or `entity.type` (the
 * deconstruction-planner filter semantics). `playerOnly` keeps only entities
 * with a `last_user` (player-built/changed). Results are deduplicated by
 * unit_number and sorted by name/position for deterministic truncation.
 */
export function observeAreaCommand(params: ObserveAreaParams): string {
  const x = Number(params.x);
  const y = Number(params.y);
  const radius = Number(params.radius);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius)) {
    throw new Error("observeAreaCommand requires finite x, y and radius");
  }
  const requestedLimit = Number(params.limit ?? AREA_EDIT_DEFAULT_LIMIT);
  const limit = Math.max(
    1,
    Math.min(AREA_EDIT_MAX_LIMIT, Number.isFinite(requestedLimit) ? requestedLimit : AREA_EDIT_DEFAULT_LIMIT),
  );
  const types = luaStringSet(params.types);
  const filters = luaStringSet(params.filters);
  const order = params.order === "near" ? "near" : "name";
  const excluded = `{${AREA_EDIT_EXCLUDED_TYPES.map((type) => `[${luaString(type)}]=true`).join(",")}}`;
  return [
    "/sc",
    "local p=game.players[1]",
    "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    "local s=p.surface",
    `local cx=${x} local cy=${y} local radius=${radius} local limit=${limit}`,
    `local player_only=${params.playerOnly ? "true" : "false"}`,
    `local excluded=${excluded}`,
    `local type_filter=${types}`,
    `local name_filter=${filters}`,
    "local min_x=math.floor(cx-radius) local min_y=math.floor(cy-radius) local max_x=math.floor(cx+radius) local max_y=math.floor(cy+radius)",
    "local found=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}} or {}",
    "local seen={} local candidates={} local total=#found local matched=0",
    "for _,e in pairs(found) do",
    // Explicitly requested types win over the default exclusion list.
    "if e.valid and (type_filter[e.type]==true or not excluded[e.type]) then",
    "local ok_unit, unit_number=pcall(function() return e.unit_number end)",
    "local key=tostring((ok_unit and unit_number) or (e.name..':'..e.position.x..':'..e.position.y))",
    "if not seen[key] then",
    "seen[key]=true",
    "local type_ok=(next(type_filter)==nil) or (type_filter[e.type]==true)",
    "local name_ok=(next(name_filter)==nil) or (name_filter[e.name]==true) or (name_filter[e.type]==true)",
    "if type_ok and name_ok then",
    "local player_created=false pcall(function() player_created=e.last_user~=nil end)",
    "if (not player_only) or player_created then",
    "matched=matched+1",
    "table.insert(candidates,{entity=e,key=e.name..':'..e.position.x..':'..e.position.y})",
    "end",
    "end",
    "end",
    "end",
    "end",
    `local order=${luaString(order)}`,
    "table.sort(candidates,function(a,b) if order=='near' then local ax=a.entity.position.x-cx local ay=a.entity.position.y-cy local bx=b.entity.position.x-cx local by=b.entity.position.y-cy local da=ax*ax+ay*ay local db=bx*bx+by*by if da~=db then return da<db end end return a.key<b.key end)",
    "local entities={}",
    "for i=1,math.min(#candidates,limit) do",
    "local e=candidates[i].entity",
    "local player_created=false pcall(function() player_created=e.last_user~=nil end)",
    "local health=nil pcall(function() health=e.health end)",
    "local direction=nil pcall(function() direction=e.direction end) local recipe=nil pcall(function() local r=e.get_recipe() recipe=r and r.name or nil end)",
    "table.insert(entities,{name=e.name,type=e.type,x=math.floor(e.position.x),y=math.floor(e.position.y),position={x=e.position.x,y=e.position.y},direction=direction,recipe=recipe,health=health,player_created=player_created})",
    "end",
    "done{ok=true,area={x=cx,y=cy,radius=radius,min_x=min_x,min_y=min_y,max_x=max_x,max_y=max_y},counts={total=total,matched=matched,included=#entities},entities=entities,truncated=matched>#entities,player_only=player_only}",
  ].join(" ");
}
