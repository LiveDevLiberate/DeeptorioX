// Pure Factorio Lua `/sc` command builders for the gameplay API.
// These functions only format command strings - no RCON, filesystem, or
// manager state - so they can be unit-tested without a running game.
// See tests/command-builders.test.mjs.
import { ROCKET_STATE_LUA } from "./rocket.js";

export function luaString(value: string) {
  return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/\"/g, '\\\\"')}"`;
}

export type BuildRequest = {
  name: string;
  anchor: { x: number; y: number };
  direction?: number;
  /**
   * Explicit underground subtype for `underground-belt` / `pipe-to-ground`.
   * The native `build_from_cursor` path cannot choose input/output, so those
   * entities take a separate Lua path that creates the entity with the subtype
   * and consumes the place item.
   */
  underground_type?: "input" | "output";
};

/**
 * Underground belt / pipe-to-ground placement. Unlike `build_from_cursor` this
 * path can choose the input/output subtype: it validates reach and placement,
 * creates the entity with the explicit `type`, then consumes the place item
 * from the player inventory (the native path consumes it as part of the build).
 */
export function agentUndergroundBuildCommand(item: BuildRequest, dryRun = false): string {
  const direction = item.direction ?? 0;
  return [
    "/sc",
    "local p=game.players[1]",
    "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    `local name=${luaString(item.name)}`,
    `local anchor_x=${Number(item.anchor.x)}`,
    `local anchor_y=${Number(item.anchor.y)}`,
    `local direction=${Number(direction)}`,
    `local underground_type=${luaString(item.underground_type ?? "")}`,
    `local dry_run=${dryRun ? "true" : "false"}`,
    "if underground_type~='input' and underground_type~='output' then done{ok=false,error='invalid_underground_type',underground_type=underground_type} return end",
    "if name~='underground-belt' and name~='pipe-to-ground' then done{ok=false,error='invalid_underground_entity',name=name} return end",
    "local proto=prototypes.entity[name]",
    "if not proto then done{ok=false,error='unknown_entity',name=name} return end",
    "local place_item=nil local place_count=1 for _,item in pairs(proto.items_to_place_this or {}) do place_item=item.name place_count=item.count or 1 break end",
    "if not place_item then done{ok=false,error='not_player_placeable',name=name} return end",
    "if direction~=0 and direction~=4 and direction~=8 and direction~=12 then done{ok=false,error='invalid_direction',direction=direction} return end",
    "local width=proto.tile_width or 1 local height=proto.tile_height or 1",
    "if direction==4 or direction==12 then width,height=height,width end",
    "local x=anchor_x+width/2 local y=anchor_y+height/2",
    "local dx=x-p.position.x local dy=y-p.position.y",
    "local reachable=dx*dx+dy*dy<=p.build_distance*p.build_distance",
    "local has_item=p.get_item_count(place_item)>=place_count",
    "local can_place=p.surface.can_place_entity{name=name,position={x,y},direction=direction,force=p.force,build_check_type=defines.build_check_type.manual}",
    "local function diagnostics() local nearby=p.surface.find_entities_filtered{area={{anchor_x-1,anchor_y-1},{anchor_x+1,anchor_y+1}}} or {} local blockers={} for _,e in pairs(nearby) do if e.valid and e~=p.character then table.insert(blockers,{name=e.name,type=e.type}) end end return {reachable=reachable,has_item=has_item,can_place=can_place,blockers=blockers} end",
    "if dry_run then done{ok=true,can_place=can_place,reachable=reachable,has_item=has_item,requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},direction=direction,underground_type=underground_type,required_item={name=place_item,count=place_count},diagnostics=diagnostics()} return end",
    "if not reachable then done{ok=false,error='out_of_reach',requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},diagnostics=diagnostics()} return end",
    "if not can_place then done{ok=false,error='cannot_build',requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},direction=direction,diagnostics=diagnostics()} return end",
    "if not has_item then done{ok=false,error='missing_item',name=name,required_item={name=place_item,count=place_count},available=p.get_item_count(place_item)} return end",
    "local e=p.surface.create_entity{name=name,position={x=x,y=y},direction=direction,force=p.force,type=underground_type,player=p,raise_built=true}",
    "if not e or not e.valid then done{ok=false,error='build_failed',name=name} return end",
    "local removed=p.remove_item{name=place_item,count=place_count}",
    "local subtype=nil pcall(function() subtype=e.belt_to_ground_type end) if subtype==nil then pcall(function() subtype=e.pipe_to_ground_type end) end",
    "done{ok=true,name=name,underground_type=underground_type,entity_subtype=subtype,placed_with_item=place_item,consumed={name=place_item,count=removed},requested_anchor={x=anchor_x,y=anchor_y},actual_center={x=e.position.x,y=e.position.y},direction=e.direction}",
  ].join(" ");
}

export function agentNativeBuildCommand(item: BuildRequest, dryRun = false): string {
  if (item.underground_type) return agentUndergroundBuildCommand(item, dryRun);
  const direction = item.direction ?? 0;
  const parts = [
    "/sc",
    "local p=game.players[1]",
    "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    `local name=${luaString(item.name)}`,
    `local anchor_x=${Number(item.anchor.x)}`,
    `local anchor_y=${Number(item.anchor.y)}`,
    `local direction=${Number(direction)}`,
    `local dry_run=${dryRun ? "true" : "false"}`,
    "local proto=prototypes.entity[name]",
    "if not proto then done{ok=false,error='unknown_entity',name=name} return end",
    "local place_item=nil local place_count=1 for _,item in pairs(proto.items_to_place_this or {}) do place_item=item.name place_count=item.count or 1 break end",
    "if not place_item then done{ok=false,error='not_player_placeable',name=name} return end",
    "if direction~=0 and direction~=4 and direction~=8 and direction~=12 then done{ok=false,error='invalid_direction',direction=direction} return end",
    "local width=proto.tile_width or math.ceil(proto.collision_box.right_bottom.x-proto.collision_box.left_top.x)",
    "local height=proto.tile_height or math.ceil(proto.collision_box.right_bottom.y-proto.collision_box.left_top.y)",
    "if direction==4 or direction==12 then width,height=height,width end",
    "local x=anchor_x+width/2 local y=anchor_y+height/2",
    "local footprint={min_x=anchor_x,min_y=anchor_y,max_x=anchor_x+width-1,max_y=anchor_y+height-1,width=width,height=height}",
    "local function diagnostics()",
    "local terrain={tile_names={}} local collision={possible_blockers={}} local d={alignment={valid=(anchor_x==math.floor(anchor_x) and anchor_y==math.floor(anchor_y)),required='integer_top_left_tile'},required_footprint=footprint,terrain=terrain,collision=collision,nearest_valid_positions={}}",
    "local dx=x-p.position.x local dy=y-p.position.y d.reachable=dx*dx+dy*dy<=p.build_distance*p.build_distance",
    "local tile_names={} for ty=anchor_y,anchor_y+height-1 do for tx=anchor_x,anchor_x+width-1 do local tile=p.surface.get_tile(tx,ty) if not tile_names[tile.name] then tile_names[tile.name]=true table.insert(terrain.tile_names,tile.name) end end end",
    "local nearby=p.surface.find_entities_filtered{area={{anchor_x,anchor_y},{anchor_x+width,anchor_y+height}}} or {}",
    "for _,e in pairs(nearby) do if e.valid and e~=p.character and e.type~='resource' then table.insert(collision.possible_blockers,{name=e.name,type=e.type,center={x=e.position.x,y=e.position.y}}) end end",
    "for radius=1,6 do for oy=-radius,radius do for ox=-radius,radius do if math.abs(ox)==radius or math.abs(oy)==radius then local ax=anchor_x+ox local ay=anchor_y+oy local cx=ax+width/2 local cy=ay+height/2 if p.surface.can_place_entity{name=name,position={cx,cy},direction=direction,force=p.force,build_check_type=defines.build_check_type.manual} then table.insert(d.nearest_valid_positions,{anchor={x=ax,y=ay},center={x=cx,y=cy}}) if #d.nearest_valid_positions>=8 then return d end end end end end end",
    "return d end",
    "if dry_run then local can_place=p.surface.can_place_entity{name=name,position={x=x,y=y},direction=direction,force=p.force,build_check_type=defines.build_check_type.manual} done{ok=true,can_place=can_place,requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},direction=direction,diagnostics=diagnostics()} return end",
    "local dx=x-p.position.x",
    "local dy=y-p.position.y",
    "if dx*dx+dy*dy > p.build_distance*p.build_distance then done{ok=false,error='out_of_reach',requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},diagnostics=diagnostics()} return end",
    "local selected=p.cursor_stack and p.cursor_stack.valid_for_read and p.cursor_stack.name==place_item",
    "if not selected then p.clear_cursor() end",
    "if not selected then local prototype=prototypes.item[place_item] if prototype then selected=p.pipette(prototype,nil,false) end end",
    "if not selected or not p.cursor_stack or not p.cursor_stack.valid_for_read or p.cursor_stack.name~=place_item then done{ok=false,error='missing_item',name=name,required_item={name=place_item,count=place_count}} return end",
    "local params={position={x=x,y=y},direction=direction,build_mode=defines.build_mode.normal,skip_fog_of_war=false}",
    "if not p.can_build_from_cursor(params) then local d=diagnostics() p.clear_cursor() done{ok=false,error='cannot_build',requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},direction=direction,diagnostics=d,cursor_cleared=true} return end",
    "p.build_from_cursor(params)",
    "p.clear_cursor()",
    "local entities=p.surface.find_entities_filtered{position={x,y},name=name} or {}",
    "local e=entities[1]",
    "if not e then done{ok=false,error='build_result_not_found',requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y},cursor_cleared=true} return end",
    "done{ok=true,name=name,placed_with_item=place_item,requested_anchor={x=anchor_x,y=anchor_y},actual_center={x=e.position.x,y=e.position.y},occupied_tiles=footprint,direction=e.direction,cursor_cleared=true}",
  ];
  return parts.join(" ");
}

/** Mine trees and rocks that overlap a build footprint before placement. */
export function agentClearBuildFootprintCommand(item: BuildRequest): string {
  const direction = item.direction ?? 0;
  return [
    "/sc",
    "local p=game.players[1]",
    "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    `local name=${luaString(item.name)}`,
    `local ax=${Number(item.anchor.x)}`,
    `local ay=${Number(item.anchor.y)}`,
    `local direction=${Number(direction)}`,
    "local proto=prototypes.entity[name]",
    "if not proto then done{ok=false,error='unknown_entity',name=name} return end",
    "local width=proto.tile_width or 1 local height=proto.tile_height or 1",
    "if direction==4 or direction==12 then width,height=height,width end",
    "local function clearable(e)",
    "if not e.valid then return false end",
    "if e.type=='tree' then return e.minable end",
    // Tree stumps are non-minable corpses; destroy them right away.
    "if e.type=='corpse' and e.name:find('stump',1,true)~=nil then return true end",
    "return e.type=='simple-entity' and e.minable and (e.name:find('rock',1,true)~=nil or e.name:find('stone',1,true)~=nil)",
    "end",
    "local found=p.surface.find_entities_filtered{area={{ax,ay},{ax+width,ay+height}}} or {}",
    "local cleared={} local pending={} local skipped={} local blocked=false",
    "for _,e in pairs(found) do",
    "if e.valid and e~=p.character and e.type~='resource' then",
    "if clearable(e) then",
    "local ename=e.name local etype=e.type",
    "if etype=='corpse' then",
    "e.destroy()",
    "table.insert(cleared,{name=ename,type=etype,removed='corpse'})",
    "elseif p.can_reach_entity(e) then",
    "local mined=p.mine_entity(e,true)",
    "if mined then table.insert(cleared,{name=ename,type=etype}) else table.insert(skipped,{name=ename,type=etype,reason='mine_failed'}) blocked=true end",
    "else table.insert(pending,{name=ename,type=etype,x=math.floor(e.position.x),y=math.floor(e.position.y)}) end",
    "else table.insert(skipped,{name=e.name,type=e.type,reason='not_clearable'}) blocked=true end",
    "end",
    "end",
    "done{ok=not blocked and #pending==0,cleared=cleared,pending=pending,skipped=skipped,footprint={min_x=ax,min_y=ay,width=width,height=height}}",
  ].join(" ");
}

export function agentBuildDestinationCommand(item: BuildRequest, forceStaging = false): string {
  const direction = item.direction ?? 0;
  return [
    "/sc",
    "local p=game.players[1]",
    "local function done(v) rcon.print(helpers.table_to_json(v)) end",
    "if not p or not p.character then done{ok=false,error='no_character'} return end",
    `local name=${luaString(item.name)}`,
    `local ax=${item.anchor.x}`,
    `local ay=${item.anchor.y}`,
    `local dir=${direction}`,
    `local force=${forceStaging ? "true" : "false"}`,
    "local proto=prototypes.entity[name] if not proto then done{ok=false,error='unknown_entity'} return end",
    "local w=proto.tile_width local h=proto.tile_height if dir==4 or dir==12 then w,h=h,w end local cx=ax+w/2 local cy=ay+h/2",
    "local dx=cx-p.position.x local dy=cy-p.position.y local in_reach=dx*dx+dy*dy<=p.build_distance*p.build_distance",
    // Standing still is usually enough: obstacles are mined before placement,
    // so only walk when the intended center is out of build range.
    "if in_reach and not force then done{ok=true,in_reach=true,position={x=p.position.x,y=p.position.y},center={x=cx,y=cy}} return end",
    "local margin=1.5 local offsets={{-(w/2+margin),0},{w/2+margin,0},{0,-(h/2+margin)},{0,h/2+margin},{-(w/2+margin),-(h/2+margin)},{w/2+margin,-(h/2+margin)},{-(w/2+margin),h/2+margin},{w/2+margin,h/2+margin}}",
    "local best=nil local best_d=nil for _,o in pairs(offsets) do local tx=cx+o[1] local ty=cy+o[2] local pos=p.surface.find_non_colliding_position('character',{tx,ty},1.5,0.1) if pos then local reach_dx=pos.x-cx local reach_dy=pos.y-cy if reach_dx*reach_dx+reach_dy*reach_dy<=p.build_distance*p.build_distance then local dx=pos.x-p.position.x local dy=pos.y-p.position.y local d=dx*dx+dy*dy if not best_d or d<best_d then best=pos best_d=d end end end end",
    "if not best then done{ok=false,error='no_reachable_staging_position'} return end done{ok=true,in_reach=in_reach,staging=true,position=best,center={x=cx,y=cy}}",
  ].join(" ");
}

export function agentMapCommand(params: { x: number; y: number; radius: number }): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local force=game.forces.player or game.forces[1]",
    "local function esc(v) if v==nil then return 'null' end if type(v)=='string' then return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"' end return tostring(v) end",
    `local min_x=${minX}`,
    `local max_x=${maxX}`,
    `local min_y=${minY}`,
    `local max_y=${maxY}`,
    "local chunks={} local symbols={}",
    "local cminx=math.floor(min_x/32) local cmaxx=math.floor(max_x/32) local cminy=math.floor(min_y/32) local cmaxy=math.floor(max_y/32)",
    "for cy=cminy,cmaxy do for cx=cminx,cmaxx do",
    "local charted=force.is_chunk_charted(s,{x=cx,y=cy})",
    "table.insert(chunks,'{\"x\":'..cx..',\"y\":'..cy..',\"charted\":'..tostring(charted)..'}')",
    "if charted then local ents=s.find_entities_filtered{area={{cx*32,cy*32},{cx*32+32,cy*32+32}}} or {} for i=1,#ents do local e=ents[i] if e.valid and (e.type=='resource' or e.force==force) then table.insert(symbols,'{\"name\":'..esc(e.name)..',\"type\":'..esc(e.type)..',\"x\":'..math.floor(e.position.x)..',\"y\":'..math.floor(e.position.y)..'}') end end end",
    "end end",
    "rcon.print('{\"window\":{\"min_x\":'..min_x..',\"min_y\":'..min_y..',\"max_x\":'..max_x..',\"max_y\":'..max_y..'},\"chunks\":['..table.concat(chunks,',')..'],\"symbols\":['..table.concat(symbols,',')..']}')",
  ].join(" ");
}

export function agentChartedResourcesCommand(params: { x: number; y: number; radius: number }): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local force=game.forces.player or game.forces[1]",
    `local center_x=${params.x}`,
    `local center_y=${params.y}`,
    `local min_x=${minX}`,
    `local max_x=${maxX}`,
    `local min_y=${minY}`,
    `local max_y=${maxY}`,
    "local found=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}},type='resource'} or {} local cells={} local total=0",
    "for _,e in pairs(found) do local x=math.floor(e.position.x) local y=math.floor(e.position.y) if force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)}) then local key=e.name..':'..x..':'..y cells[key]={name=e.name,x=x,y=y,amount=e.amount or 0} total=total+1 end end",
    "local visited={} local patches={} local neighbours={{-1,-1},{0,-1},{1,-1},{-1,0},{1,0},{-1,1},{0,1},{1,1}}",
    "for key,start in pairs(cells) do if not visited[key] then local queue={start} visited[key]=true local head=1 local count=0 local amount=0 local sum_x=0 local sum_y=0 local minpx=start.x local maxpx=start.x local minpy=start.y local maxpy=start.y while head<=#queue do local cell=queue[head] head=head+1 count=count+1 amount=amount+cell.amount sum_x=sum_x+cell.x sum_y=sum_y+cell.y minpx=math.min(minpx,cell.x) maxpx=math.max(maxpx,cell.x) minpy=math.min(minpy,cell.y) maxpy=math.max(maxpy,cell.y) for _,o in pairs(neighbours) do local nk=cell.name..':'..(cell.x+o[1])..':'..(cell.y+o[2]) local next_cell=cells[nk] if next_cell and not visited[nk] then visited[nk]=true table.insert(queue,next_cell) end end end local cx=sum_x/count local cy=sum_y/count table.insert(patches,{resource=start.name,tile_count=count,amount=amount,center={x=cx,y=cy},bounds={min_x=minpx,min_y=minpy,max_x=maxpx,max_y=maxpy},distance=math.sqrt((cx-center_x)^2+(cy-center_y)^2)}) end end",
    "table.sort(patches,function(a,b) if a.distance==b.distance then return a.resource<b.resource end return a.distance<b.distance end) local patch_count=#patches local nearest={} for _,patch in ipairs(patches) do if not nearest[patch.resource] then nearest[patch.resource]=patch end end while #patches>200 do table.remove(patches) end",
    "local shoreline={} local shoreline_radius=math.min(128,math.max(math.abs(max_x-center_x),math.abs(max_y-center_y))) local shore_min_x=center_x-shoreline_radius local shore_max_x=center_x+shoreline_radius local shore_min_y=center_y-shoreline_radius local shore_max_y=center_y+shoreline_radius local dirs={{0,-1,0,'north'},{1,0,4,'east'},{0,1,8,'south'},{-1,0,12,'west'}} for y=shore_min_y,shore_max_y do for x=shore_min_x,shore_max_x do if force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)}) then local land=s.get_tile(x,y) if not string.find(land.name,'water',1,true) then for _,d in pairs(dirs) do local water=s.get_tile(x+d[1],y+d[2]) if string.find(water.name,'water',1,true) then table.insert(shoreline,{land_tile={x=x,y=y,name=land.name},water_tile={x=x+d[1],y=y+d[2],name=water.name},facing=d[4],direction=d[3],distance=math.sqrt((x-center_x)^2+(y-center_y)^2)}) end end end end end end table.sort(shoreline,function(a,b) return a.distance<b.distance end) while #shoreline>64 do table.remove(shoreline) end",
    "rcon.print(helpers.table_to_json{patches=patches,patch_count=patch_count,patches_truncated=patch_count>#patches,nearest_by_resource=nearest,shoreline_candidates=shoreline,shoreline_scan_radius=shoreline_radius,total_resource_tiles=total,charted_only=true})",
  ].join(" ");
}

export function agentWorldCommand(params: {
  x: number;
  y: number;
  radius: number;
  includeTiles: boolean;
  includeEntities: boolean;
}): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local force=game.forces.player or game.forces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local min_x=${minX}`,
    `local max_x=${maxX}`,
    `local min_y=${minY}`,
    `local max_y=${maxY}`,
    "local tiles_out={}",
    "local tiles_total=0",
    "local tiles_included=0",
    "if true then",
    `local include_tiles=${params.includeTiles ? "true" : "false"}`,
    "if include_tiles then",
    "for y=min_y,max_y do",
    "for x=min_x,max_x do",
    "tiles_total=tiles_total+1",
    "local charted=force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)})",
    "if charted then local t=s.get_tile(x,y) table.insert(tiles_out,'{\"x\":'..x..',\"y\":'..y..',\"name\":'..esc(t.name)..'}') tiles_included=tiles_included+1 end",
    "end",
    "end",
    "end",
    "end",
    "local entities_out={}",
    "local entities_total=0",
    "local entities_included=0",
    `local include_entities=${params.includeEntities ? "true" : "false"}`,
    "if include_entities then",
    "local entities=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}} or {}",
    "entities_total=#entities",
    "for i=1,#entities do",
    "local e=entities[i]",
    "local charted=force.is_chunk_charted(s,{x=math.floor(e.position.x/32),y=math.floor(e.position.y/32)})",
    "if charted then",
    "local force_name=e.force and e.force.name or nil",
    "local health=e.health",
    "local box=nil",
    "local ok_box,proto=pcall(function() return e.prototype end)",
    "if ok_box and proto and proto.collision_box then box=proto.collision_box end",
    "local box_left=nil",
    "local box_top=nil",
    "local box_right=nil",
    "local box_bottom=nil",
    "if box and box.left_top and box.right_bottom then",
    "box_left=e.position.x + box.left_top.x",
    "box_top=e.position.y + box.left_top.y",
    "box_right=e.position.x + box.right_bottom.x",
    "box_bottom=e.position.y + box.right_bottom.y",
    "end",
    "local tile_x=math.floor(e.position.x)",
    "local tile_y=math.floor(e.position.y)",
    "local entry='{\"name\":'..esc(e.name)..',\"type\":'..esc(e.type)..',\"x\":'..esc(tile_x)",
    "entry=entry..',\"y\":'..esc(tile_y)..',\"center_x\":'..esc(e.position.x)..',\"center_y\":'..esc(e.position.y)",
    "entry=entry..',\"box_left\":'..esc(box_left)..',\"box_top\":'..esc(box_top)..',\"box_right\":'..esc(box_right)..',\"box_bottom\":'..esc(box_bottom)",
    "entry=entry..',\"direction\":'..esc(e.direction)",
    "entry=entry..',\"force\":'..esc(force_name)..',\"health\":'..esc(health)..'}'",
    "table.insert(entities_out,entry)",
    "entities_included=entities_included+1",
    "end",
    "end",
    "end",
    "local out={}",
    "table.insert(out,'\"window\":{\"min_x\":'..min_x..',\"min_y\":'..min_y..',\"max_x\":'..max_x..',\"max_y\":'..max_y..'}')",
    "table.insert(out,'\"tiles\":['..table.concat(tiles_out,',')..']')",
    "table.insert(out,'\"entities\":['..table.concat(entities_out,',')..']')",
    "table.insert(out,'\"counts\":{\"tiles_total\":'..tiles_total..',\"tiles_included\":'..tiles_included..',\"entities_total\":'..entities_total..',\"entities_included\":'..entities_included..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

export function agentCompactWorldCommand(params: {
  x: number;
  y: number;
  radius: number;
  includeTiles: boolean;
  includeEntities: boolean;
}): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local force=game.forces.player or game.forces[1]",
    `local min_x=${minX}`,
    `local max_x=${maxX}`,
    `local min_y=${minY}`,
    `local max_y=${maxY}`,
    `local include_tiles=${params.includeTiles ? "true" : "false"}`,
    `local include_entities=${params.includeEntities ? "true" : "false"}`,
    "local rows={} local tile_total=0 local tile_included=0 if include_tiles then for y=min_y,max_y do local runs={} local current=nil for x=min_x,max_x do tile_total=tile_total+1 local charted=force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)}) local name=charted and s.get_tile(x,y).name or 'uncharted' if charted then tile_included=tile_included+1 end if current and current.name==name then current.length=current.length+1 else current={x=x,length=1,name=name} table.insert(runs,current) end end table.insert(rows,{y=y,runs=runs}) end end",
    "local entities={} local entity_total=0 if include_entities then local found=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}} or {} for _,e in pairs(found) do if force.is_chunk_charted(s,{x=math.floor(e.position.x/32),y=math.floor(e.position.y/32)}) then entity_total=entity_total+1 local health=nil pcall(function() health=e.health end) local cb=e.prototype.collision_box table.insert(entities,{name=e.name,type=e.type,center={x=e.position.x,y=e.position.y},occupied_tile={x=math.floor(e.position.x),y=math.floor(e.position.y)},collision_bounds={left=e.position.x+cb.left_top.x,top=e.position.y+cb.left_top.y,right=e.position.x+cb.right_bottom.x,bottom=e.position.y+cb.right_bottom.y},direction=e.direction,force=e.force and e.force.name or nil,health=health}) end end end",
    "rcon.print(helpers.table_to_json{window={min_x=min_x,min_y=min_y,max_x=max_x,max_y=max_y},terrain={encoding='rle_rows',rows=rows},entities=entities,counts={tiles_total=tile_total,tiles_included=tile_included,entities_included=entity_total},charted_only=true})",
  ].join(" ");
}

export function agentPlayerCommand(params: { inventoryLimit: number; equipmentLimit: number }): string {
  const parts = [
    "/sc",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local inv_limit=${params.inventoryLimit}`,
    `local equip_limit=${params.equipmentLimit}`,
    "local inventories={}",
    "local inv_total=0",
    "local inv_included=0",
    "local function add_inventory(name,inv)",
    "if not inv or not inv.valid then return end",
    "local out={}",
    "for i=1,#inv do",
    "local stack=inv[i]",
    "if stack and stack.valid_for_read then",
    "inv_total=inv_total+1",
    "if inv_included < inv_limit then",
    "local durability=nil",
    "local ammo=nil",
    "local ok_dur, dur=pcall(function() return stack.durability end)",
    "if ok_dur then durability=dur end",
    "local ok_ammo, am=pcall(function() return stack.ammo end)",
    "if ok_ammo then ammo=am end",
    "local entry='{\"slot\":'..i..',\"name\":'..esc(stack.name)..',\"count\":'..stack.count",
    "entry=entry..',\"durability\":'..esc(durability)",
    "entry=entry..',\"ammo\":'..esc(ammo)..'}'",
    "table.insert(out,entry)",
    "inv_included=inv_included+1",
    "end",
    "end",
    "if inv_included >= inv_limit then break end",
    "end",
    "table.insert(inventories,'{\"name\":'..esc(name)..',\"slots\":['..table.concat(out,',')..']}')",
    "end",
    "add_inventory('main',player.get_inventory(defines.inventory.character_main))",
    "add_inventory('guns',player.get_inventory(defines.inventory.character_guns))",
    "add_inventory('ammo',player.get_inventory(defines.inventory.character_ammo))",
    "add_inventory('armor',player.get_inventory(defines.inventory.character_armor))",
    "add_inventory('trash',player.get_inventory(defines.inventory.character_trash))",
    "local equipment_out={}",
    "local equip_total=0",
    "local equip_included=0",
    "local armor=player.get_inventory(defines.inventory.character_armor)",
    "if armor and armor.valid and #armor > 0 then",
    "local stack=armor[1]",
    "if stack and stack.valid_for_read then",
    "local grid=stack.grid",
    "if grid then",
    "for _,eq in pairs(grid.equipment) do",
    "equip_total=equip_total+1",
    "if equip_included < equip_limit then",
    "local entry='{\"name\":'..esc(eq.name)..',\"pos_x\":'..eq.position.x..',\"pos_y\":'..eq.position.y",
    "entry=entry..',\"energy\":'..esc(eq.energy)..'}'",
    "table.insert(equipment_out,entry)",
    "equip_included=equip_included+1",
    "end",
    "end",
    "end",
    "end",
    "end",
    "local craft_out={}",
    "local cq=player.crafting_queue",
    "if cq then",
    "for i=1,#cq do",
    "local c=cq[i]",
    "local entry='{\"recipe\":'..esc(c.recipe)..',\"count\":'..esc(c.count)..',\"prerequisite\":'..esc(c.prerequisite)..'}'",
    "table.insert(craft_out,entry)",
    "end",
    "end",
    "local pf={}",
    "table.insert(pf,'\"name\":'..esc(player.name))",
    "table.insert(pf,'\"x\":'..esc(player.position.x))",
    "table.insert(pf,'\"y\":'..esc(player.position.y))",
    "local direction=nil",
    "if player.character then direction=player.character.direction end",
    "table.insert(pf,'\"direction\":'..esc(direction))",
    "table.insert(pf,'\"health\":'..esc(player.character and player.character.health))",
    "table.insert(pf,'\"energy\":'..esc(player.character and player.character.energy))",
    "local cursor='null'",
    "if player.cursor_stack and player.cursor_stack.valid_for_read then cursor='{\"name\":'..esc(player.cursor_stack.name)..',\"count\":'..player.cursor_stack.count..'}' end",
    "table.insert(pf,'\"cursor\":'..cursor)",
    "table.insert(pf,'\"inventories\":['..table.concat(inventories,',')..']')",
    "table.insert(pf,'\"equipment\":['..table.concat(equipment_out,',')..']')",
    "table.insert(pf,'\"crafting_queue\":['..table.concat(craft_out,',')..']')",
    "local out={}",
    "table.insert(out,'\"player\":{'..table.concat(pf,',')..'}')",
    "table.insert(out,'\"counts\":{\"inventory_total\":'..inv_total..',\"inventory_included\":'..inv_included..',\"equipment_total\":'..equip_total..',\"equipment_included\":'..equip_included..'}')",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

export function agentResearchCommand(params: {
  availableLimit: number;
  lockedLimit: number;
  completedLimit: number;
}): string {
  return [
    "/sc",
    "local force=game.forces.player or game.forces[1]",
    `local available_limit=${params.availableLimit}`,
    `local locked_limit=${params.lockedLimit}`,
    `local completed_limit=${params.completedLimit}`,
    "local function descriptor(tech,status)",
    "local ingredients={} for _,ingredient in pairs(tech.research_unit_ingredients or {}) do table.insert(ingredients,{name=ingredient.name,type=ingredient.type,amount=ingredient.amount}) end table.sort(ingredients,function(a,b) return a.name<b.name end)",
    "local prerequisites={} local missing={} for name,p in pairs(tech.prerequisites or {}) do table.insert(prerequisites,name) if p.name~=tech.name and not p.researched then table.insert(missing,name) end end table.sort(prerequisites) table.sort(missing)",
    "local max_level=nil pcall(function() max_level=tech.prototype.max_level end) if type(max_level)~='number' then max_level=nil end",
    "local upgrade=false pcall(function() upgrade=tech.upgrade end)",
    "local trigger=nil pcall(function() trigger=tech.prototype.research_trigger end)",
    "return {name=tech.name,level=tech.level,max_level=max_level,upgrade=upgrade,status=status,enabled=tech.enabled,researched=tech.researched,unit_count=tech.research_unit_count,unit_time_seconds=tech.research_unit_energy/60,unit_energy_ticks=tech.research_unit_energy,ingredients=ingredients,prerequisites=prerequisites,missing_prerequisites=missing,saved_progress=tech.saved_progress,trigger=trigger and trigger.type or nil}",
    "end",
    "local available={} local upgrades={} local triggers={} local locked={} local completed={} local counts={available=0,upgrade=0,trigger=0,locked=0,completed=0}",
    "local names={} for name,_ in pairs(force.technologies) do table.insert(names,name) end table.sort(names)",
    "for _,name in ipairs(names) do local tech=force.technologies[name] local has_units=#(tech.research_unit_ingredients or {})>0 local missing=false for _,p in pairs(tech.prerequisites or {}) do if p.name~=tech.name and not p.researched then missing=true break end end",
    "local max_level=nil pcall(function() max_level=tech.prototype.max_level end) local maxed=((type(max_level)=='number' and tech.level>=max_level) or (max_level==nil and tech.researched))",
    "local trigger=nil pcall(function() trigger=tech.prototype.research_trigger end)",
    "if tech.researched then",
    "if not maxed and not missing then counts.upgrade=counts.upgrade+1 if #upgrades<available_limit then table.insert(upgrades,descriptor(tech,'upgrade')) end",
    "elseif maxed then counts.completed=counts.completed+1 if #completed<completed_limit then table.insert(completed,descriptor(tech,'completed')) end",
    "else counts.locked=counts.locked+1 if #locked<locked_limit then table.insert(locked,descriptor(tech,'locked')) end end",
    "elseif trigger and not has_units then counts.trigger=counts.trigger+1 if #triggers<available_limit then table.insert(triggers,descriptor(tech,'trigger')) end",
    "elseif tech.enabled and has_units and not missing then counts.available=counts.available+1 if #available<available_limit then table.insert(available,descriptor(tech,'available')) end",
    "else counts.locked=counts.locked+1 if #locked<locked_limit then table.insert(locked,descriptor(tech,'locked')) end end end",
    "local queue={} if force.research_queue then for _,tech in ipairs(force.research_queue) do table.insert(queue,descriptor(tech,'queued')) end end",
    "local current=nil if force.current_research then current=descriptor(force.current_research,'researching') current.progress=force.research_progress end",
    "rcon.print(helpers.table_to_json{current=current,queue=queue,available=available,upgrades=upgrades,triggers=triggers,locked=locked,completed=completed,counts={available_total=counts.available,available_included=#available,upgrade_total=counts.upgrade,upgrade_included=#upgrades,trigger_total=counts.trigger,trigger_included=#triggers,locked_total=counts.locked,locked_included=#locked,completed_total=counts.completed,completed_included=#completed}})",
  ].join(" ");
}

export function agentRecipesCommand(params: { limit: number; unlockedOnly: boolean }): string {
  const parts = [
    "/sc",
    "local force=game.forces.player or game.forces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local limit=${params.limit}`,
    `local unlocked_only=${params.unlockedOnly ? "true" : "false"}`,
    "local out={}",
    "local total=0",
    "local included=0",
    "for name,recipe in pairs(force.recipes) do",
    "if (not unlocked_only) or recipe.enabled then",
    "total=total+1",
    "if included < limit then",
    "local ingredients_out={}",
    "for _,ing in pairs(recipe.ingredients) do",
    "table.insert(ingredients_out,'{\"name\":'..esc(ing.name)..',\"type\":'..esc(ing.type)..',\"amount\":'..esc(ing.amount)..'}')",
    "end",
    "local products_out={}",
    "for _,prod in pairs(recipe.products) do",
    "table.insert(products_out,'{\"name\":'..esc(prod.name)..',\"type\":'..esc(prod.type)..',\"amount\":'..esc(prod.amount)..'}')",
    "end",
    "local entry='{\"name\":'..esc(name)..',\"enabled\":'..esc(recipe.enabled)",
    "entry=entry..',\"energy\":'..esc(recipe.energy)",
    "local categories=recipe.categories",
    "if not categories or #categories==0 then local ok,cat=pcall(function() return recipe.category end) if ok and cat then categories={cat} else categories={} end end",
    "local category_list={} for _,category in ipairs(categories) do table.insert(category_list,esc(category)) end",
    "entry=entry..',\"categories\":['..table.concat(category_list,',')..']'",
    "if categories[1] then entry=entry..',\"category\":'..esc(categories[1]) end",
    "entry=entry..',\"ingredients\":['..table.concat(ingredients_out,',')..']'",
    "entry=entry..',\"products\":['..table.concat(products_out,',')..']}'",
    "table.insert(out,entry)",
    "included=included+1",
    "end",
    "end",
    "end",
    "local res={}",
    "table.insert(res,'\"recipes\":['..table.concat(out,',')..']')",
    "table.insert(res,'\"counts\":{\"total\":'..total..',\"included\":'..included..'}')",
    "rcon.print('{'..table.concat(res,',')..'}')",
  ];
  return parts.join(" ");
}

export function agentRotateCommand(targets: Array<{ x: number; y: number; direction?: number }>): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t=="string" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\"')..'\"'",
    'elseif t=="number" or t=="boolean" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\"')..'\"'",
    "end",
    "end",
    "local function ensure_reach(entity)",
    "if not player or not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local results={}",
    "local function rotate(x,y,want)",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='character' and cand.type~='resource' and cand.type~='item-entity' and cand.type~='corpse' then table.insert(candidates,{entity=cand,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) return a.key<b.key end) local e=candidates[1] and candidates[1].entity or nil",
    "if not e then return {x=x,y=y,ok=false,error='no_entity'} end",
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then return {x=x,y=y,name=e.name,ok=false,error=reach_err or 'out_of_reach'} end",
    "if want ~= nil then",
    "local steps=0",
    "for _=1,4 do",
    "if e.direction==want then break end",
    "local called,rotated=pcall(function() return e.rotate() end)",
    "if not called or rotated~=true then return {x=x,y=y,name=e.name,ok=false,error='rotation_rejected',direction=e.direction,steps=steps} end",
    "steps=steps+1",
    "end",
    "if e.direction~=want then return {x=x,y=y,name=e.name,ok=false,error='direction_not_reached',direction=e.direction,steps=steps} end",
    "return {x=x,y=y,name=e.name,ok=true,direction=e.direction,steps=steps}",
    "end",
    "local called,rotated=pcall(function() return e.rotate() end) local ok=called and rotated==true local err=not called and rotated or (not ok and 'rotation_rejected' or nil)",
    "if ok then return {x=x,y=y,name=e.name,ok=true,direction=e.direction} end",
    "return {x=x,y=y,name=e.name,ok=false,error=tostring(err)}",
    "end",
  ];
  for (const target of targets) {
    const direction = Number.isInteger(target.direction) ? target.direction : "nil";
    parts.push(`table.insert(results,rotate(${target.x},${target.y},${direction}))`);
  }
  parts.push(
    "local out={}",
    "for i=1,#results do",
    "local r=results[i]",
    "local entry='{\"x\":'..r.x..',\"y\":'..r.y..',\"ok\":'..tostring(r.ok)",
    "if r.name then entry=entry..',\"name\":'..esc(r.name) end",
    "if r.direction then entry=entry..',\"direction\":'..esc(r.direction) end",
    "if r.steps then entry=entry..',\"steps\":'..r.steps end",
    "if r.error then entry=entry..',\"error\":'..esc(r.error) end",
    "entry=entry..'}'",
    "table.insert(out,entry)",
    "end",
    "local results_json='['..table.concat(out,',')..']'",
    "rcon.print('{\"results\":'..results_json..'}')",
  );
  return parts.join(" ");
}

export function agentSetRecipeCommand(targets: Array<{ x: number; y: number; recipe: string }>): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    "local function ensure_reach(entity)",
    "if not player or not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local results={}",
    "local function set_recipe(x,y,recipe)",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='character' and cand.type~='resource' and cand.type~='item-entity' and cand.type~='corpse' then table.insert(candidates,{entity=cand,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) return a.key<b.key end) local e=candidates[1] and candidates[1].entity or nil",
    "if not e then return {x=x,y=y,ok=false,error='no_entity'} end",
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then return {x=x,y=y,name=e.name,ok=false,error=reach_err or 'out_of_reach'} end",
    "local def=player.force.recipes[recipe] if not def or not def.enabled then return {x=x,y=y,name=e.name,ok=false,error='recipe_locked_or_unknown'} end",
    "local ok,err=pcall(function() e.set_recipe(recipe) end)",
    "if ok then return {x=x,y=y,name=e.name,ok=true,recipe=recipe} end",
    "return {x=x,y=y,name=e.name,ok=false,error=tostring(err)}",
    "end",
  ];
  for (const target of targets) {
    parts.push(`table.insert(results,set_recipe(${target.x},${target.y},${luaString(target.recipe)}))`);
  }
  parts.push(
    "local out={}",
    "for i=1,#results do",
    "local r=results[i]",
    "local entry='{\"x\":'..r.x..',\"y\":'..r.y..',\"ok\":'..tostring(r.ok)",
    "if r.name then entry=entry..',\"name\":'..esc(r.name) end",
    "if r.recipe then entry=entry..',\"recipe\":'..esc(r.recipe) end",
    "if r.error then entry=entry..',\"error\":'..esc(r.error) end",
    "entry=entry..'}'",
    "table.insert(out,entry)",
    "end",
    "local results_json='['..table.concat(out,',')..']'",
    "rcon.print('{\"results\":'..results_json..'}')",
  );
  return parts.join(" ");
}

export function agentResearchStartCommand(technology: string): string {
  const parts = [
    "/sc",
    "local force=game.forces.player or game.forces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local tech_name=${luaString(technology)}`,
    "local tech=force.technologies[tech_name]",
    "if not tech then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Technology not found: '..tech_name)..'}')",
    "return",
    "end",
    "local max_level=nil pcall(function() max_level=tech.prototype.max_level end)",
    "local maxed=((type(max_level)=='number' and tech.level>=max_level) or (max_level==nil and tech.researched))",
    "if tech.researched and maxed then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Already researched at max level: '..tech_name)..'}')",
    "return",
    "end",
    "if not tech.enabled then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Technology not available: '..tech_name)..'}')",
    "return",
    "end",
    "local trigger=nil pcall(function() trigger=tech.prototype.research_trigger end)",
    "if #tech.research_unit_ingredients == 0 and trigger then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Trigger technology (completed by in-game action, not research): '..tech_name)..'}')",
    "return",
    "end",
    "for _,p in pairs(tech.prerequisites) do",
    "if p.name~=tech.name and not p.researched then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Missing prerequisite: '..p.name)..'}')",
    "return",
    "end",
    "end",
    "local added=force.add_research(tech)",
    "if not added then",
    "rcon.print('{\"ok\":false,\"error\":'..esc('Failed to add research: '..tech_name)..'}')",
    "return",
    "end",
    "local out={}",
    "table.insert(out,'\"ok\":true')",
    "table.insert(out,'\"technology\":'..esc(tech.name))",
    "table.insert(out,'\"level\":'..esc(tech.level))",
    "if max_level then table.insert(out,'\"max_level\":'..esc(max_level)) end",
    "if force.current_research then",
    "local cr=force.current_research",
    "table.insert(out,'\"current_research\":{\"name\":'..esc(cr.name)..',\"level\":'..esc(cr.level)..',\"progress\":'..esc(force.research_progress)..'}')",
    "end",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

export function agentCraftCommand(recipe: string, count: number): string {
  return [
    "/sc",
    "local player=game.players[1]",
    "if not player or not player.character or not player.character.valid then rcon.print(helpers.table_to_json{ok=false,error='no_character'}) return end",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local recipe=${luaString(recipe)}`,
    `local count=${count}`,
    "local recipe_obj=player.force.recipes[recipe]",
    "if not recipe_obj then rcon.print(helpers.table_to_json{recipe=recipe,count=count,ok=false,error='unknown_recipe'}) return end",
    "if not recipe_obj.enabled then rcon.print(helpers.table_to_json{recipe=recipe,count=count,ok=false,error='recipe_locked'}) return end",
    "local handcraft=false local cats=recipe_obj.categories if cats then for _,c in pairs(cats) do if c=='crafting' then handcraft=true break end end else local ok_cat,cat=pcall(function() return recipe_obj.category end) if ok_cat and cat=='crafting' then handcraft=true end end",
    "if not handcraft then rcon.print(helpers.table_to_json{recipe=recipe,count=count,ok=false,error='not_handcraftable'}) return end",
    "local products={} for _,prod in pairs(recipe_obj.products or {}) do local amount=prod.amount or prod.amount_min or 1 local ptype=prod.type or 'item' if ptype=='fluid' then rcon.print(helpers.table_to_json{recipe=recipe,count=count,ok=false,error='not_handcraftable'}) return end table.insert(products,{name=prod.name,type=ptype,amount=amount}) if not player.can_insert{name=prod.name,count=amount} then rcon.print(helpers.table_to_json{recipe=recipe,count=count,ok=false,error='output_full',product=prod.name}) return end end",
    "if #products==0 then rcon.print(helpers.table_to_json{recipe=recipe,count=count,ok=false,error='not_handcraftable'}) return end",
    "local craftable=player.get_craftable_count(recipe)",
    "if craftable < count then rcon.print(helpers.table_to_json{recipe=recipe,count=count,craftable=craftable,ok=false,error='Insufficient ingredients'}) return end",
    "local called,queued=pcall(function() return player.begin_crafting{recipe=recipe,count=count} end) local ok=called and queued==count",
    "if not ok then rcon.print(helpers.table_to_json{recipe=recipe,count=count,queued=queued,ok=false,error=called and 'crafting_rejected' or tostring(queued)}) return end",
    "rcon.print(helpers.table_to_json{recipe=recipe,count=count,queued=queued,ok=true,completed=false,products=products,crafting_queue=(player.crafting_queue and #player.crafting_queue or 0),energy=recipe_obj.energy})",
  ].join(" ");
}

export function agentInsertCommand(params: { x: number; y: number; item: string; count: number }): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"ok":false,"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local x=${params.x}`,
    `local y=${params.y}`,
    `local item=${luaString(params.item)}`,
    `local count=${params.count}`,
    "local function ensure_reach(entity)",
    "if not player or not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='resource' and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) table.insert(candidates,{entity=cand,score=-(dx*dx+dy*dy),key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end)",
    "local e=candidates[1] and candidates[1].entity or nil",
    'if not e then rcon.print(\'{"ok":false,"error":"no_entity"}\') return end',
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then rcon.print('{\"ok\":false,\"error\":'..esc(reach_err or 'out_of_reach')..'}') return end",
    "local available=player.get_item_count(item) or 0",
    "if available < count then rcon.print(helpers.table_to_json{ok=false,error='count too high: requested '..count..' but only '..available..' available',available=available,requested=count,entity=e.name}) return end",
    "local removed=player.remove_item{name=item,count=count}",
    "local inserted=e.insert{name=item,count=removed}",
    "if inserted < removed then player.insert{name=item,count=removed-inserted} end",
    "if inserted>0 then player.create_local_flying_text{text={'','-',inserted,' ',prototypes.item[item].localised_name},position=e.position} end",
    "local out={}",
    "table.insert(out,'\"ok\":'..tostring(inserted==count))",
    "table.insert(out,'\"entity\":'..esc(e.name))",
    "table.insert(out,'\"removed\":'..esc(removed))",
    "table.insert(out,'\"inserted\":'..esc(inserted))",
    "if inserted<count then table.insert(out,'\"error\":'..esc('entity capacity too low: requested '..count..' but inserted '..inserted)) end",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

export function agentExtractCommand(params: {
  x: number;
  y: number;
  item: string;
  count: number | "all";
}): string {
  const luaCount = params.count === "all" ? -1 : params.count;
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"ok":false,"error":"No player"}\') return end',
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local x=${params.x}`,
    `local y=${params.y}`,
    `local item=${luaString(params.item)}`,
    `local count=${luaCount}`,
    "local function ensure_reach(entity)",
    "if not player or not player.character then return false,'no_character' end",
    "if player.can_reach_entity and player.can_reach_entity(entity) then return true end",
    "return false,'out_of_reach'",
    "end",
    "local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='resource' and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) table.insert(candidates,{entity=cand,score=-(dx*dx+dy*dy),key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end)",
    "local e=candidates[1] and candidates[1].entity or nil",
    'if not e then rcon.print(\'{"ok":false,"error":"no_entity"}\') return end',
    "local can_reach,reach_err=ensure_reach(e)",
    "if not can_reach then rcon.print('{\"ok\":false,\"error\":'..esc(reach_err or 'out_of_reach')..'}') return end",
    "local available=e.get_item_count(item) or 0",
    "if count == -1 then count=available end",
    "if available < count then",
    "local out={}",
    "table.insert(out,'\"ok\":false')",
    "table.insert(out,'\"error\":'..esc('count too high: requested '..count..' but only '..available..' available'))",
    "table.insert(out,'\"available\":'..esc(available))",
    "table.insert(out,'\"requested\":'..esc(count))",
    "rcon.print('{'..table.concat(out,',')..'}')",
    "return",
    "end",
    "if count == 0 then",
    "rcon.print(helpers.table_to_json{ok=true,entity=e.name,removed=0,inserted=0})",
    "return",
    "end",
    "local removed=e.remove_item{name=item,count=count}",
    "local inserted=player.insert{name=item,count=removed}",
    "if inserted < removed then e.insert{name=item,count=removed-inserted} end",
    "if inserted>0 then player.create_local_flying_text{text={'','+',inserted,' ',prototypes.item[item].localised_name},position=e.position} end",
    "local out={}",
    "table.insert(out,'\"ok\":'..tostring(inserted==count))",
    "table.insert(out,'\"entity\":'..esc(e.name))",
    "table.insert(out,'\"removed\":'..esc(removed))",
    "table.insert(out,'\"inserted\":'..esc(inserted))",
    "if inserted<count then table.insert(out,'\"error\":'..esc('player inventory capacity too low: requested '..count..' but inserted '..inserted)) end",
    "rcon.print('{'..table.concat(out,',')..'}')",
  ];
  return parts.join(" ");
}

export function agentObserveEntityCommand(
  targets: Array<{ x: number; y: number; kind?: string; name?: string }>,
): string {
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local force=game.forces.player or game.forces[1]",
    "local results={}",
    ROCKET_STATE_LUA,
    "local function find_entity(x,y,kind,wanted_name) local ents=s.find_entities_filtered{area={{x,y},{x+1,y+1}}} or {} local candidates={} for _,cand in pairs(ents) do if cand and cand.valid and cand.type~='character' and cand.type~='item-entity' and cand.type~='corpse' and (not kind or (kind=='resource' and cand.type=='resource') or (kind=='entity' and cand.type~='resource')) and (not wanted_name or cand.name==wanted_name) then local dx=cand.position.x-(x+0.5) local dy=cand.position.y-(y+0.5) local score=(cand.type=='resource' and 0 or 100)+(wanted_name and 1000 or 0)-dx*dx-dy*dy table.insert(candidates,{entity=cand,score=score,key=cand.name..':'..cand.position.x..':'..cand.position.y}) end end table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end) return candidates[1] and candidates[1].entity or nil end",
    "local function items(inv) local out={} if inv and inv.valid then for i=1,#inv do local stack=inv[i] if stack and stack.valid_for_read then table.insert(out,{slot=i,name=stack.name,count=stack.count}) end end end return out end",
    "local function observe(x,y,kind,wanted_name)",
    "if not force.is_chunk_charted(s,{x=math.floor(x/32),y=math.floor(y/32)}) then return {requested_tile={x=x,y=y},ok=false,error='uncharted'} end",
    "local e=find_entity(x,y,kind,wanted_name) if not e then return {requested_tile={x=x,y=y},ok=false,error=kind=='resource' and 'no_resource' or 'no_entity'} end",
    "local status=nil local ok_status,value=pcall(function() return e.status end) if ok_status and value then local names={} for k,v in pairs(defines.entity_status) do names[v]=k end status=names[value] or tostring(value) end",
    "local health=nil pcall(function() health=e.health end) local max_health=nil pcall(function() max_health=e.prototype.max_health end) local energy=nil pcall(function() energy=e.energy end)",
    "local inventories={} local seen={} local function add_inventory(purpose,inv,index) if not inv or not inv.valid then return end local resolved_index=index pcall(function() resolved_index=resolved_index or inv.index end) local existing=resolved_index and seen[resolved_index] or nil if existing then local already=false for _,known in pairs(existing.purposes) do if known==purpose then already=true break end end if not already then table.insert(existing.purposes,purpose) end return end local factorio_name=nil pcall(function() factorio_name=inv.name end) local entry={purposes={purpose},factorio_name=factorio_name,index=resolved_index,items=items(inv)} if resolved_index then seen[resolved_index]=entry end table.insert(inventories,entry) end",
    "local ok,inv=pcall(function() return e.get_fuel_inventory() end) if ok then add_inventory('fuel',inv) end ok,inv=pcall(function() return e.get_burnt_result_inventory() end) if ok then add_inventory('burnt_result',inv) end if e.type=='furnace' or e.type=='assembling-machine' or e.type=='rocket-silo' then ok,inv=pcall(function() return e.get_output_inventory() end) if ok then add_inventory('output',inv) end end ok,inv=pcall(function() return e.get_module_inventory() end) if ok then add_inventory('modules',inv) end",
    "local max_index=0 pcall(function() local value=e.get_max_inventory_index() if type(value)=='number' then max_index=value end end) for index=1,max_index do local got=nil pcall(function() got=e.get_inventory(index) end) if got and got.valid then local n=nil pcall(function() n=e.get_inventory_name(index) end) add_inventory(n or 'inventory',got,index) end end",
    "local fluid_boxes={} local fb_count=0 pcall(function() fb_count=#e.fluidbox end) for index=1,fb_count do local fluid=nil pcall(function() fluid=e.fluidbox[index] end) local capacity=nil pcall(function() capacity=e.fluidbox.get_capacity(index) end) local filter=nil pcall(function() local f=e.fluidbox.get_filter(index) filter=f and f.name or nil end) local production_type=nil pcall(function() local fp=e.fluidbox.get_prototype(index) if fp and fp.production_type then production_type=fp.production_type end end) local connections={} pcall(function() for _,c in pairs(e.fluidbox.get_pipe_connections(index) or {}) do local owner=c.target and c.target.owner or nil table.insert(connections,{connection_type=c.connection_type,flow_direction=c.flow_direction,position={x=c.position.x,y=c.position.y},target_position={x=c.target_position.x,y=c.target_position.y},target=owner and {name=owner.name,center={x=owner.position.x,y=owner.position.y}} or nil,target_fluidbox_index=c.target_fluidbox_index,target_pipe_connection_index=c.target_pipe_connection_index}) end end) table.insert(fluid_boxes,{index=index,production_type=production_type,filter=filter,capacity=capacity,fluid=fluid and {name=fluid.name,amount=fluid.amount,temperature=fluid.temperature} or nil,connections=connections}) end",
    "local recipe=nil pcall(function() local r=e.get_recipe() recipe=r and r.name or nil end) local drop_position=nil pcall(function() drop_position=e.drop_position end) local drop_target=nil pcall(function() local t=e.drop_target drop_target=t and {name=t.name,center={x=t.position.x,y=t.position.y}} or nil end)",
    "local bounding_box=nil pcall(function() bounding_box=e.bounding_box end)",
    "local footprint=nil local anchor=nil if bounding_box then footprint={left=math.floor(bounding_box.left_top.x+0.001),top=math.floor(bounding_box.left_top.y+0.001),right=math.floor(bounding_box.right_bottom.x-0.001),bottom=math.floor(bounding_box.right_bottom.y-0.001)} footprint.width=footprint.right-footprint.left+1 footprint.height=footprint.bottom-footprint.top+1 anchor={x=footprint.left,y=footprint.top} end",
    "local tile_size=nil pcall(function() tile_size={width=e.prototype.tile_width,height=e.prototype.tile_height} end)",
    "return {requested_tile={x=x,y=y},ok=true,name=e.name,type=e.type,center={x=e.position.x,y=e.position.y},anchor=anchor,footprint=footprint,tile_size=tile_size,occupied_tile={x=math.floor(e.position.x),y=math.floor(e.position.y)},collision_bounds=bounding_box and {left=bounding_box.left_top.x,top=bounding_box.left_top.y,right=bounding_box.right_bottom.x,bottom=bounding_box.right_bottom.y} or nil,direction=e.direction,status=status,rocket=rocket_state(e),health=health,max_health=max_health,energy=energy,recipe=recipe,inventories=inventories,fluid_boxes=fluid_boxes,drop_position=drop_position and {x=drop_position.x,y=drop_position.y} or nil,drop_target=drop_target} end",
  ];
  for (const target of targets) {
    parts.push(
      `table.insert(results,observe(${target.x},${target.y},${target.kind ? luaString(target.kind) : "nil"},${target.name ? luaString(target.name) : "nil"}))`,
    );
  }
  parts.push("rcon.print(helpers.table_to_json{results=results})");
  return parts.join(" ");
}

export function agentFactoryCommand(params: { x?: number; y?: number; radius: number }): string {
  const x = params.x === undefined ? "nil" : String(params.x);
  const y = params.y === undefined ? "nil" : String(params.y);
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    `local x=${x} local y=${y} local radius=${params.radius}`,
    "if not player then rcon.print(helpers.table_to_json{ok=false,error='no_player'}) return end",
    "if x==nil then x=player.position.x end if y==nil then y=player.position.y end",
    "local area={{x-radius,y-radius},{x+radius,y+radius}}",
    "local function status_name(e) if e.status==nil then return 'none' end for k,v in pairs(defines.entity_status) do if v==e.status then return k end end return tostring(e.status) end",
    "local function fuel(e) local items={} local ok,inv=pcall(function() return e.get_fuel_inventory() end) if ok and inv and inv.valid then for i=1,#inv do local stack=inv[i] if stack and stack.valid_for_read then table.insert(items,{name=stack.name,count=stack.count}) end end end local burning=nil pcall(function() if e.burner and e.burner.currently_burning then burning=e.burner.currently_burning.name end end) return items,burning end",
    "local counts={}",
    "local statuses={'no_fuel','no_power','no_input_fluid','no_minable_resources','waiting_for_space_in_destination','no_ingredients','missing_science_packs'}",
    "local problems={} local totals={} for _,key in ipairs(statuses) do problems[key]={} totals[key]=0 end",
    "local coal=0 local without_fuel=0 local low_fuel=0",
    "local types={'burner-mining-drill','furnace','boiler','generator','assembling-machine','lab','inserter','electric-pole'}",
    "for _,e in pairs(s.find_entities_filtered{area=area,type=types}) do",
    "local status=status_name(e) local name=e.name",
    "counts[name]=counts[name] or {total=0,statuses={}}",
    "counts[name].total=counts[name].total+1",
    "counts[name].statuses[status]=(counts[name].statuses[status] or 0)+1",
    "local items,burning=fuel(e) local coal_count=0 for _,item in ipairs(items) do if item.name=='coal' then coal_count=coal_count+item.count end end coal=coal+coal_count",
    "if status=='no_fuel' then without_fuel=without_fuel+1 elseif coal_count>0 and coal_count<5 then low_fuel=low_fuel+1 end",
    "for _,key in ipairs(statuses) do if status==key then totals[key]=totals[key]+1 if #problems[key]<20 then table.insert(problems[key],{name=name,x=e.position.x,y=e.position.y,status=status}) end end end",
    "end",
    "local power=nil local poles=s.find_entities_filtered{area=area,type='electric-pole'} if #poles>0 then local seen={} local production,consumption,transfer,networks=0,0,0,0 for _,pole in ipairs(poles) do local ok,sub=pcall(function() return pole.electric_network end) if ok and sub then local ok2,parent=pcall(function() return sub.parent_network end) if ok2 and parent then local key=tostring(parent) if not seen[key] then seen[key]=true networks=networks+1 local ok3,flow=pcall(function() return parent.flow_last_tick end) if ok3 and flow then production=production+(flow.maximum_production or 0) consumption=consumption+(flow.maximum_consumption or 0) transfer=transfer+(flow.total_transfer or 0) end end end end end power={networks=networks,maximum_production=production,maximum_consumption=consumption,total_transfer=transfer} if consumption>0 then power.satisfaction=math.min(1,transfer/consumption) end end",
    "local alerts={} local function alert(n,text) if n and n>0 then table.insert(alerts,n..' '..text) end end",
    "alert(totals.no_fuel,'entities have no fuel')",
    "alert(totals.no_power,'entities have no power')",
    "alert(totals.no_input_fluid,'entities have no input fluid')",
    "alert(totals.no_minable_resources,'drills have no minable resources')",
    "alert(totals.waiting_for_space_in_destination,'entities are waiting for output space')",
    "alert(totals.no_ingredients,'furnaces have no ingredients')",
    "alert(totals.missing_science_packs,'labs are missing science packs')",
    "if type(power)=='table' and type(power.satisfaction)=='number' and power.satisfaction<0.95 then table.insert(alerts,string.format('power satisfaction %.0f%%',power.satisfaction*100)) end",
    "if coal==0 then table.insert(alerts,'no coal in fuel slots in this area') end",
    "rcon.print(helpers.table_to_json{window={x=x,y=y,radius=radius},counts=counts,problems=problems,totals=totals,fuel={coal_in_fuel_slots=coal,entities_without_fuel=without_fuel,entities_low_fuel=low_fuel},power=power,alerts=alerts})",
  ].join(" ");
}

export function agentLayoutCommand(params: { x?: number; y?: number; radius: number; step: number }): string {
  const x = params.x === undefined ? "nil" : String(params.x);
  const y = params.y === undefined ? "nil" : String(params.y);
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    `local x=${x} local y=${y} local radius=${params.radius} local step=${params.step}`,
    "if not player then rcon.print(helpers.table_to_json{rows={},built_rows={},resource_rows={},legend={},entities={},overlaps={},error='no_player'}) return end",
    "if x==nil then x=player.position.x end if y==nil then y=player.position.y end",
    "local min_x=math.floor(x-radius) local min_y=math.floor(y-radius) local max_x=math.floor(x+radius) local max_y=math.floor(y+radius)",
    "local width=math.floor((max_x-min_x)/step)+1 local height=math.floor((max_y-min_y)/step)+1",
    "local function new_grid() local g={} for row=1,height do g[row]={} for col=1,width do g[row][col]=' ' end end return g end",
    "local terrain=new_grid() local resource=new_grid() local natural=new_grid() local built=new_grid() local actors=new_grid()",
    "local function cell(px,py) local col=math.floor((math.floor(px)-min_x)/step)+1 local row=math.floor((math.floor(py)-min_y)/step)+1 if col<1 or col>width or row<1 or row>height then return nil end return row,col end",
    "local function fill(grid,e,ch) local bb=e.bounding_box if not bb or not bb.left_top or not bb.right_bottom then local row,col=cell(e.position.x,e.position.y) if row then grid[row][col]=ch end return end local left=math.floor(bb.left_top.x+0.001) local top=math.floor(bb.left_top.y+0.001) local right=math.floor(bb.right_bottom.x-0.001) local bottom=math.floor(bb.right_bottom.y-0.001) for ty=top,bottom do for tx=left,right do local row,col=cell(tx+0.5,ty+0.5) if row then grid[row][col]=ch end end end end",
    "for row=1,height do local ty=min_y+(row-1)*step for col=1,width do local tx=min_x+(col-1)*step local tile=s.get_tile(tx,ty) local name=tile and tile.valid and tile.name or '' local ch='.' if name:find('water',1,true) then ch='~' elseif name:find('cliff',1,true) then ch='#' elseif name:find('path',1,true) or name:find('concrete',1,true) then ch='=' end terrain[row][col]=ch end end",
    "local function resource_symbol(n) if n=='iron-ore' then return 'o' elseif n=='copper-ore' then return 'c' elseif n=='coal' then return 'k' elseif n=='stone' then return 's' elseif n=='uranium-ore' then return 'u' elseif n=='crude-oil' then return 'p' end return '*' end",
    "for _,e in pairs(s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}},type='resource'}) do fill(resource,e,resource_symbol(e.name)) end",
    "local entities={}",
    "local function status_name(e) local ok,v=pcall(function() return e.status end) if not ok or not v then return nil end for k,n in pairs(defines.entity_status) do if n==v then return k end end return tostring(v) end",
    "local function symbol(e) local n=e.name if n:find('inserter',1,true) then local d=e.direction if d==0 then return 'n' elseif d==4 then return 'e' elseif d==8 then return 's' elseif d==12 then return 'w' end return 'i' end if n=='transport-belt' then local d=e.direction if d==0 then return '^' elseif d==4 then return '>' elseif d==8 then return 'v' elseif d==12 then return '<' end return 'b' end if n:find('underground-belt',1,true) then return 'U' end if n:find('splitter',1,true) then return 'S' end if n:find('mining-drill',1,true) then return 'D' end if n:find('furnace',1,true) then return 'F' end if n:find('assembling-machine',1,true) then return 'A' end if n=='lab' then return 'L' end if n=='boiler' then return 'B' end if n=='steam-engine' or n=='generator' then return 'E' end if n:find('pump',1,true) then return 'W' end if n:find('electric-pole',1,true) then return 'P' end if n:find('chest',1,true) then return 'C' end if n=='radar' then return 'R' end if n=='rocket-silo' then return 'Z' end if e.type=='tree' then return 'T' end if e.type=='simple-entity' and n:find('rock',1,true) then return 'O' end if e.type=='fish' then return 'f' end if e.type=='character' then return '@' end return '?' end",
    "for _,e in pairs(s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}}) do if e.valid and e.type~='resource' and e.type~='item-entity' and e.type~='corpse' then local ch=symbol(e) if e.type=='tree' or e.type=='simple-entity' or e.type=='fish' then fill(natural,e,ch) elseif e.type=='character' then fill(actors,e,ch) else fill(built,e,ch) if #entities<250 then table.insert(entities,{name=e.name,x=e.position.x,y=e.position.y,direction=e.direction,status=status_name(e)}) end end end end",
    "local row,col=cell(player.position.x,player.position.y) if row then actors[row][col]='@' end",
    "local rows={} local built_rows={} local resource_rows={} local overlaps={} local overlaps_truncated=false",
    "for row=1,height do local chars={} local br={} local rr={} for col=1,width do local a=actors[row][col] local b=built[row][col] local n=natural[row][col] local r=resource[row][col] local t=terrain[row][col] chars[col]=a~=' ' and a or (b~=' ' and b or (n~=' ' and n or (r~=' ' and r or t))) br[col]=b~=' ' and b or ' ' rr[col]=r~=' ' and r or ' ' local layers={} if a~=' ' then table.insert(layers,'actor:'..a) end if b~=' ' then table.insert(layers,'built:'..b) end if n~=' ' then table.insert(layers,'natural:'..n) end if r~=' ' then table.insert(layers,'resource:'..r) end if t~=' ' and t~='.' then table.insert(layers,'terrain:'..t) end if #layers>1 then if #overlaps<200 then table.insert(overlaps,{x=min_x+(col-1)*step,y=min_y+(row-1)*step,layers=layers}) else overlaps_truncated=true end end end table.insert(rows,table.concat(chars)) table.insert(built_rows,table.concat(br)) table.insert(resource_rows,table.concat(rr)) end",
    "local legend={['.']='ground',['~']='water',['#']='cliff',['=']='path',['o']='iron ore',['c']='copper ore',['k']='coal',['t']='stone',['u']='uranium',['p']='oil',['*']='other resource',['T']='tree',['O']='rock',['f']='fish',['@']='player',['e']='inserter east',['w']='inserter west',['n']='inserter north',['s']='inserter south',['>']='belt east',['<']='belt west',['^']='belt north',['v']='belt south',['U']='underground belt',['S']='splitter',['D']='mining drill',['F']='furnace',['A']='assembling machine',['L']='lab',['B']='boiler',['E']='steam engine',['W']='pump',['P']='electric pole',['C']='chest',['R']='radar',['Z']='rocket silo'}",
    "rcon.print(helpers.table_to_json{origin={x=min_x,y=min_y},step=step,width=width,height=height,rows=rows,built_rows=built_rows,resource_rows=resource_rows,legend=legend,entities=entities,overlaps=overlaps,overlaps_truncated=overlaps_truncated})",
  ].join(" ");
}

export function agentConnectionsCommand(params: { x?: number; y?: number; radius: number }): string {
  const x = params.x === undefined ? "nil" : String(params.x);
  const y = params.y === undefined ? "nil" : String(params.y);
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local player=game.players[1]",
    `local x=${x} local y=${y} local radius=${params.radius}`,
    "if not player then rcon.print(helpers.table_to_json{counts={},inserters={},belts={},machines={},issues={},error='no_player'}) return end",
    "if x==nil then x=player.position.x end if y==nil then y=player.position.y end",
    "local min_x=math.floor(x-radius) local min_y=math.floor(y-radius) local max_x=math.floor(x+radius) local max_y=math.floor(y+radius)",
    "local function dir_vec(d) if d==0 then return 0,-1 elseif d==4 then return 1,0 elseif d==8 then return 0,1 elseif d==12 then return -1,0 end return 0,0 end",
    "local function entity_at(tx,ty) local list=s.find_entities_filtered{area={{tx,ty},{tx+1,ty+1}}} for _,e in pairs(list) do if e.valid and e.type~='character' and e.type~='item-entity' and e.type~='corpse' then return e end end return nil end",
    "local function summary(e) if not e then return nil end return {name=e.name,type=e.type,x=e.position.x,y=e.position.y,direction=e.direction} end",
    "local inserters={} local belts={} local machines={} local issues={} local counts={inserters=0,belts=0,machines=0,issues=0}",
    "local function issue(kind,e,extra) counts.issues=counts.issues+1 if #issues<200 then local item={kind=kind,name=e.name,x=e.position.x,y=e.position.y,direction=e.direction} if extra then for k,v in pairs(extra) do item[k]=v end end table.insert(issues,item) end end",
    "local invalid_types={['electric-pole']=true,['lamp']=true,['radar']=true,['steam-engine']=true,['generator']=true,['pump']=true,['offshore-pump']=true,['pipe']=true,['pipe-to-ground']=true,['wall']=true,['gate']=true,['resource']=true,['tree']=true,['simple-entity']=true,['fish']=true,['character']=true,['inserter']=true}",
    "for _,e in pairs(s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}}) do",
    "if e.valid then",
    "if e.type=='inserter' then",
    "counts.inserters=counts.inserters+1 local dx,dy=dir_vec(e.direction) local tx,ty=math.floor(e.position.x),math.floor(e.position.y) local source=summary(entity_at(tx-dx,ty-dy)) local target=summary(entity_at(tx+dx,ty+dy)) if #inserters<200 then table.insert(inserters,{name=e.name,x=e.position.x,y=e.position.y,direction=e.direction,source=source,target=target}) end if not source then issue('inserter_no_source',e) elseif invalid_types[source.type] then issue('inserter_invalid_source',e,{endpoint=source.name}) end if not target then issue('inserter_no_target',e) elseif invalid_types[target.type] then issue('inserter_invalid_target',e,{endpoint=target.name}) end",
    "elseif e.type=='transport-belt' or e.type=='underground-belt' or e.type=='splitter' then",
    "counts.belts=counts.belts+1 local dx,dy=dir_vec(e.direction) local tx,ty=math.floor(e.position.x),math.floor(e.position.y) local next_entity=entity_at(tx+dx,ty+dy) local next_summary=summary(next_entity) if #belts<200 then table.insert(belts,{name=e.name,x=e.position.x,y=e.position.y,direction=e.direction,next=next_summary}) end if not next_summary then issue('belt_dead_end',e) elseif e.type=='transport-belt' and next_summary.type~='transport-belt' and next_summary.type~='underground-belt' and next_summary.type~='splitter' then issue('belt_points_to_non_belt',e,{next=next_summary.name}) elseif next_summary.type=='transport-belt' and next_summary.direction==((e.direction+8)%16) then issue('belt_opposite',e,{next=next_summary.name}) end",
    "elseif e.type=='furnace' or e.type=='assembling-machine' or e.type=='lab' or e.type=='boiler' then",
    "counts.machines=counts.machines+1 local bb=e.bounding_box local list=nil pcall(function() list=s.find_entities_filtered{area={{bb.left_top.x-1,bb.left_top.y-1},{bb.right_bottom.x+1,bb.right_bottom.y+1}},type='inserter'} end) local near=0 if list then for _ in pairs(list) do near=near+1 end end if #machines<100 then table.insert(machines,{name=e.name,x=e.position.x,y=e.position.y,inserters=near}) end if near==0 and e.type~='furnace' then issue('machine_no_inserters',e) end local status=nil pcall(function() status=e.status end) if status==defines.entity_status.waiting_for_space_in_destination then issue('machine_output_blocked',e) end",
    "end end end",
    "rcon.print(helpers.table_to_json{window={x=min_x,y=min_y,radius=radius},counts=counts,inserters=inserters,belts=belts,machines=machines,issues=issues})",
  ].join(" ");
}

export function agentResourcesCommand(params: { x: number; y: number; radius: number }): string {
  const minX = params.x - params.radius;
  const maxX = params.x + params.radius;
  const minY = params.y - params.radius;
  const maxY = params.y + params.radius;
  const parts = [
    "/sc",
    "local s=game.surfaces[1]",
    "local function esc(v)",
    "if v==nil then return 'null' end",
    "local t=type(v)",
    'if t==\"string\" then',
    "return '\"'..v:gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    'elseif t==\"number\" or t==\"boolean\" then',
    "return tostring(v)",
    "else",
    "return '\"'..tostring(v):gsub('\\\\','\\\\\\\\'):gsub('\"','\\\\\"')..'\"'",
    "end",
    "end",
    `local min_x=${minX}`,
    `local max_x=${maxX}`,
    `local min_y=${minY}`,
    `local max_y=${maxY}`,
    "local resources=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}},type='resource'} or {}",
    "local groups={}",
    "for i=1,#resources do",
    "local e=resources[i]",
    "local n=e.name",
    "if not groups[n] then groups[n]={count=0,amount=0,min_x=e.position.x,min_y=e.position.y,max_x=e.position.x,max_y=e.position.y,sum_x=0,sum_y=0} end",
    "local g=groups[n]",
    "g.count=g.count+1",
    "g.amount=g.amount+(e.amount or 0)",
    "g.sum_x=g.sum_x+e.position.x",
    "g.sum_y=g.sum_y+e.position.y",
    "if e.position.x < g.min_x then g.min_x=e.position.x end",
    "if e.position.y < g.min_y then g.min_y=e.position.y end",
    "if e.position.x > g.max_x then g.max_x=e.position.x end",
    "if e.position.y > g.max_y then g.max_y=e.position.y end",
    "end",
    "local out={}",
    "for name,g in pairs(groups) do",
    "local cx=math.floor(g.sum_x/g.count)",
    "local cy=math.floor(g.sum_y/g.count)",
    'table.insert(out,\'{"name":\'..esc(name)..\',"tile_count":\'..g.count..\',"amount":\'..g.amount..\',"center":{"x":\'..cx..\',"y":\'..cy..\'},"bounds":{"min_x":\'..math.floor(g.min_x)..\',"min_y":\'..math.floor(g.min_y)..\',"max_x":\'..math.floor(g.max_x)..\',"max_y":\'..math.floor(g.max_y)..\'}}\')',
    "end",
    "rcon.print('{\"patches\":['..table.concat(out,',')..'],\"total_entities\":'..#resources..'}')",
  ];
  return parts.join(" ");
}

/** Resolve a prototype's localised description in the game's current locale. */
export function agentDescriptionCommand(kind: "entity" | "technology", name: string): string {
  const prototype = kind === "entity" ? "prototypes.entity" : "prototypes.technology";
  return [
    "/sc",
    `local p=${prototype}[${luaString(name)}]`,
    "if not p then rcon.print('__AUTORIO_UNKNOWN__') return end",
    "local ok,desc=pcall(function() return p.localised_description end)",
    "if not ok or desc==nil then rcon.print(helpers.table_to_json{name=p.name,raw=nil}) return end",
    "rcon.print(helpers.table_to_json{name=p.name,raw=desc})",
    "rcon.print(desc)",
  ].join(" ");
}

export function agentEntityPrototypeCommand(name: string): string {
  return [
    "/sc",
    `local name=${luaString(name)}`,
    "local proto=prototypes.entity[name]",
    "if not proto then rcon.print(helpers.table_to_json{ok=false,error='unknown_entity',name=name}) return end",
    "local function box(value) if not value then return nil end return {left_top={x=value.left_top.x,y=value.left_top.y},right_bottom={x=value.right_bottom.x,y=value.right_bottom.y}} end",
    "local fluid_boxes={} local direction_names={[0]='north',[4]='east',[8]='south',[12]='west'} local direction_vectors={[0]={x=0,y=-1},[4]={x=1,y=0},[8]={x=0,y=1},[12]={x=-1,y=0}} for index,fb in pairs(proto.fluidbox_prototypes or {}) do local connections={} for _,pc in pairs(fb.pipe_connections or {}) do local positions={} for orientation,pos in pairs(pc.positions or {}) do local actual_direction=((pc.direction or 0)+(orientation-1)*4)%16 local vector=direction_vectors[actual_direction] table.insert(positions,{orientation_index=orientation,orientation_name=({'north','east','south','west'})[orientation],connection_position={x=pos.x,y=pos.y},connection_direction=direction_names[actual_direction],compatible_neighbor_position=vector and {x=pos.x+vector.x,y=pos.y+vector.y} or nil}) end table.insert(connections,{connection_type=pc.connection_type,flow_direction=pc.flow_direction,connection_category=pc.connection_category,positions=positions,max_underground_distance=pc.max_underground_distance}) end table.insert(fluid_boxes,{index=index,production_type=fb.production_type,filter=fb.filter and fb.filter.name or nil,minimum_temperature=fb.minimum_temperature,maximum_temperature=fb.maximum_temperature,pipe_connections=connections}) end",
    "table.sort(fluid_boxes,function(a,b) return a.index<b.index end)",
    "local function safe(read) local ok,value=pcall(read) if ok then return value end return nil end local electric=safe(function() return proto.electric_energy_source_prototype end) local burner=safe(function() return proto.burner_prototype end) local fluid=safe(function() return proto.fluid_energy_source_prototype end) local heat=safe(function() return proto.heat_energy_source_prototype end)",
    "local energy_type='none' if electric then energy_type='electric' elseif burner then energy_type='burner' elseif fluid then energy_type='fluid' elseif heat then energy_type='heat' end",
    "local fuel_categories={} if burner then for category,_ in pairs(burner.fuel_categories or {}) do table.insert(fuel_categories,category) end table.sort(fuel_categories) end",
    "local placeable_by={} for _,item in pairs(proto.items_to_place_this or {}) do table.insert(placeable_by,{name=item.name,count=item.count}) end",
    "local max_health=safe(function() return proto.max_health end) local flags=safe(function() return proto.flags end) or {}",
    "local out={ok=true,name=name,type=proto.type,tile_size={width=proto.tile_width,height=proto.tile_height},center_alignment={x=(proto.tile_width%2==0) and 'integer' or 'half_tile',y=(proto.tile_height%2==0) and 'integer' or 'half_tile'},collision_box=box(proto.collision_box),selection_box=box(proto.selection_box),rotatable=not flags['not-rotatable'],placeable_by=placeable_by,fluid_boxes=fluid_boxes,energy_source=energy_type,fuel_categories=fuel_categories,max_health=max_health}",
    "rcon.print(helpers.table_to_json(out))",
  ].join(" ");
}
/**
 * Compact, downsampled map thumbnail for agent planning.
 *
 * The grid is rendered in Lua so the response stays small: each cell samples one
 * tile at `step`-tile intervals, labels charted/uncharted/terrain and overlays
 * player-force entities, resources and the player. The API clamps radius/size.
 */
export function agentMapOverviewCommand(params: {
  x: number;
  y: number;
  radius: number;
  size: number;
}): string {
  const minX = Math.floor(params.x - params.radius);
  const minY = Math.floor(params.y - params.radius);
  const span = params.radius * 2 + 1;
  const step = Math.max(1, Math.ceil(span / params.size));
  const width = Math.ceil(span / step);
  const height = width;
  const maxX = minX + width * step;
  const maxY = minY + height * step;
  const output = String.raw`rcon.print('{"min_x":'..min_x..',"min_y":'..min_y..',"max_x":'..max_x..',"max_y":'..max_y..',"step":'..step..',"width":'..width..',"height":'..height..',"samples":'..samples..',"charted_samples":'..charted_samples..',"rows":["'..table.concat(rows,'","')..'"],"legend":{"?":"uncharted","~":"water",".":"land","#":"player-force entity","*":"resource","@":"player"}}')`;
  return [
    "/sc",
    "local s=game.surfaces[1]",
    "local force=game.forces.player or game.forces[1]",
    `local min_x=${minX} local min_y=${minY} local step=${step} local width=${width} local height=${height}`,
    `local max_x=${maxX} local max_y=${maxY}`,
    "local built={} local resources={}",
    "local function mark(target,pos)",
    "local gx=math.floor((pos.x-min_x)/step) local gy=math.floor((pos.y-min_y)/step)",
    "if gx>=0 and gx<width and gy>=0 and gy<height then target[gy*width+gx]=true end",
    "end",
    "for _,e in pairs(s.find_entities_filtered{area={{min_x,min_y},{max_x,max_y}},force=force} or {}) do if e.valid then mark(built,e.position) end end",
    "for _,e in pairs(s.find_entities_filtered{area={{min_x,min_y},{max_x,max_y}},type='resource'} or {}) do if e.valid then mark(resources,e.position) end end",
    "local p=game.players[1]",
    "local px=math.floor(((p and p.valid and p.position.x or -1e9)-min_x)/step)",
    "local py=math.floor(((p and p.valid and p.position.y or -1e9)-min_y)/step)",
    "local rows={} local samples=0 local charted_samples=0",
    "for gy=0,height-1 do local chars={} local sy=min_y+gy*step for gx=0,width-1 do local sx=min_x+gx*step samples=samples+1 local is_charted=force.is_chunk_charted(s,{x=math.floor(sx/32),y=math.floor(sy/32)}) local ch='?' if is_charted then charted_samples=charted_samples+1 local key=gy*width+gx if gx==px and gy==py then ch='@' elseif built[key] then ch='#' elseif resources[key] then ch='*' else local name=s.get_tile(math.floor(sx),math.floor(sy)).name if name:find('water',1,true) then ch='~' else ch='.' end end end chars[#chars+1]=ch end rows[#rows+1]=table.concat(chars) end",
    output,
  ].join(" ");
}
