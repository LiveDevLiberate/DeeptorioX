// Pure Factorio Lua `/sc` command builders for the telemetry / observability
// endpoints (production sampling, fluid networks, combat scan).
//
// These functions only format command strings - no RCON, filesystem, or manager
// state - so they can be unit-tested without a running game.
// See tests/telemetry.test.mjs.

import { TELEMETRY_COMMAND } from "./benchmarks.js";

/** Optional center for area scans; omitted coordinates read the player position. */
export type ObservationWindow = {
  x?: number;
  y?: number;
  radius: number;
};

function luaCoordinate(value: number | undefined): string {
  return value === undefined ? "nil" : String(value);
}

/**
 * Production/telemetry sampling command.
 *
 * Reuses `TELEMETRY_COMMAND` from `src/benchmarks.ts` as the single source of
 * truth so the independent sampler and `RunManager` telemetry read the same
 * fields: tick, speed, paused, player, character, production, consumption,
 * fluids_produced, fluids_consumed, research, current_research,
 * research_progress and rockets.
 */
export function telemetrySampleCommand(): string {
  return TELEMETRY_COMMAND;
}

/**
 * Fluid-network scan around (x, y): fluidboxes of tanks, pipes, pumps,
 * refineries/chemical plants and fluid-consuming/producing machines, with
 * contents/levels plus totals aggregated per fluid name. `entities` is capped so
 * a large refinery still returns a bounded payload; `truncated` reports the cap.
 */
export function fluidNetworkCommand(window: ObservationWindow): string {
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local p=game.players[1]",
    `local x=${luaCoordinate(window.x)} local y=${luaCoordinate(window.y)} local radius=${window.radius}`,
    "if not p then rcon.print(helpers.table_to_json{window={x=x,y=y,radius=radius},scanned=0,truncated=false,counts={},fluids={},entities={},error='no_player'}) return end",
    "if x==nil then x=p.position.x end if y==nil then y=p.position.y end",
    "local min_x=math.floor(x-radius) local min_y=math.floor(y-radius) local max_x=math.floor(x+radius) local max_y=math.floor(y+radius)",
    "local allowed={['storage-tank']=true,['pipe']=true,['pipe-to-ground']=true,['pump']=true,['offshore-pump']=true,['boiler']=true,['oil-refinery']=true,['chemical-plant']=true,['assembling-machine']=true,['furnace']=true,['pumpjack']=true,['fluid-turret']=true}",
    "local counts={} local fluids={} local entities={} local scanned=0 local truncated=false",
    "for _,e in pairs(s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}} or {}) do",
    "if e.valid and allowed[e.type] then",
    "scanned=scanned+1 counts[e.name]=(counts[e.name] or 0)+1",
    "local fluid_boxes={} local has_fluid=false local fb_count=0",
    "pcall(function() fb_count=#e.fluidbox end)",
    "for index=1,fb_count do",
    "local fluid=nil pcall(function() fluid=e.fluidbox[index] end)",
    "if fluid and fluid.name then",
    "has_fluid=true",
    "local capacity=nil pcall(function() capacity=e.fluidbox.get_capacity(index) end)",
    "local level=nil if capacity and capacity>0 then level=fluid.amount/capacity end",
    "table.insert(fluid_boxes,{index=index,fluid={name=fluid.name,amount=fluid.amount,temperature=fluid.temperature},capacity=capacity,level=level})",
    "local total=fluids[fluid.name] if not total then total={name=fluid.name,amount=0,capacity=0,fluidboxes=0} fluids[fluid.name]=total end",
    "total.amount=total.amount+(fluid.amount or 0) if capacity then total.capacity=total.capacity+capacity end total.fluidboxes=total.fluidboxes+1",
    "end end",
    "if has_fluid then if #entities<200 then table.insert(entities,{name=e.name,type=e.type,x=e.position.x,y=e.position.y,unit_number=e.unit_number,fluidboxes=fluid_boxes}) else truncated=true end end",
    "end end",
    "for _,total in pairs(fluids) do if total.capacity>0 then total.level=total.amount/total.capacity else total.level=nil end end",
    "rcon.print(helpers.table_to_json{window={x=x,y=y,radius=radius},scanned=scanned,truncated=truncated,counts=counts,fluids=fluids,entities=entities})",
  ].join(" ");
}

/**
 * Read-only combat scan around (x, y): enemy nests/units/worms counted by force
 * and type, player turrets with ammo counts and health, and player health.
 * Recent damage is not derivable from one RCON reply - the route exposes
 * `recent_damage: null` and callers compare repeated `player.health` values.
 */
export function combatScanCommand(window: ObservationWindow): string {
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local p=game.players[1]",
    `local x=${luaCoordinate(window.x)} local y=${luaCoordinate(window.y)} local radius=${window.radius}`,
    "if not p then rcon.print(helpers.table_to_json{window={x=x,y=y,radius=radius},scanned=0,counts={by_force={},by_type={},enemy_total=0,turrets=0},nests={},turrets={},player=nil,error='no_player'}) return end",
    "if x==nil then x=p.position.x end if y==nil then y=p.position.y end",
    "local min_x=math.floor(x-radius) local min_y=math.floor(y-radius) local max_x=math.floor(x+radius) local max_y=math.floor(y+radius)",
    "local counts={by_force={},by_type={},enemy_total=0,turrets=0} local nests={} local turrets={} local scanned=0",
    "local function is_enemy(e) return e.force and e.force~=p.force and e.force~=game.forces.neutral end",
    "local function bump(e) counts.by_force[e.force.name]=(counts.by_force[e.force.name] or 0)+1 counts.by_type[e.type]=(counts.by_type[e.type] or 0)+1 counts.enemy_total=counts.enemy_total+1 end",
    "local function health_of(e) local health=nil local max_health=nil pcall(function() health=e.health end) pcall(function() max_health=e.prototype.max_health end) return health,max_health end",
    "for _,e in pairs(s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}} or {}) do",
    "if e.valid then",
    "if e.type=='unit-spawner' and is_enemy(e) then",
    "scanned=scanned+1 bump(e)",
    "if #nests<100 then local health,max_health=health_of(e) table.insert(nests,{name=e.name,force=e.force.name,x=e.position.x,y=e.position.y,health=health,max_health=max_health,unit_number=e.unit_number}) end",
    "elseif (e.type=='unit' or e.type=='spider-unit' or e.type=='turret') and is_enemy(e) then",
    "scanned=scanned+1 bump(e)",
    "elseif e.force==p.force and (e.type=='ammo-turret' or e.type=='electric-turret' or e.type=='fluid-turret') then",
    "scanned=scanned+1 counts.turrets=counts.turrets+1",
    "if #turrets<100 then",
    "local health,max_health=health_of(e)",
    "local ammo={} local inventory=nil pcall(function() inventory=e.get_inventory(defines.inventory.turret_ammo) end)",
    "if inventory then for i=1,#inventory do local stack=inventory[i] if stack and stack.valid_for_read then ammo[stack.name]=(ammo[stack.name] or 0)+stack.count end end end",
    "local fluid=nil pcall(function() fluid=e.fluidbox and e.fluidbox[1] end)",
    "table.insert(turrets,{name=e.name,type=e.type,x=e.position.x,y=e.position.y,health=health,max_health=max_health,ammo=ammo,fluid=fluid and {name=fluid.name,amount=fluid.amount} or nil})",
    "end end end end",
    "local player=nil if p.character and p.character.valid then local health=nil local max_health=nil pcall(function() health=p.character.health end) pcall(function() max_health=p.character.max_health end) local deficit=nil if health and max_health then deficit=max_health-health end player={name=p.name,health=health,max_health=max_health,health_deficit=deficit,position={x=p.position.x,y=p.position.y}} end",
    "rcon.print(helpers.table_to_json{window={x=x,y=y,radius=radius},scanned=scanned,counts=counts,nests=nests,turrets=turrets,player=player})",
  ].join(" ");
}
