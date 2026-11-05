-- Commands are issued by RCON, but all movement/mining is performed by the engine.
-- Persistent requests are never restarted after loading a save. A short lease
-- also stops the character if the manager loses its connection or exits.
local reset_after_load = false
local STUCK_TICKS = 60
local AVOID_TICKS = 30
local MAX_AVOIDS = 8
local MAX_CLEARS = 16
-- A pathfinder "no path" answer is terminal for terrain (water/cliffs): one
-- sidestep attempt is enough; repeated avoidance just zig-zags in place.
local MAX_NO_PATH_AVOIDS = 1
local CLEAR_TICKS = 600
local function state()
  storage.autorio_control = storage.autorio_control or {}
  return storage.autorio_control
end
local function stop_player(p)
  if p and p.valid and p.character and p.character.valid then
    p.walking_state = {walking=false, direction=defines.direction.north}
    p.mining_state = {mining=false}
    p.clear_selected_entity()
  end
end
local function reset()
  for _,p in pairs(game.players) do stop_player(p) end
  storage.autorio_control = {}
  reset_after_load = false
end
script.on_init(reset)
script.on_configuration_changed(reset)
script.on_load(function() reset_after_load = true end)

local function distance(a,b)
  local x,y=a.x-b.x,a.y-b.y
  return math.sqrt(x*x+y*y)
end
local function result(a,ok,err)
  local p=game.get_player(a.player)
  local position=p and p.valid and p.position or a.last_position
  return {token=a.token,status='done',ok=ok,error=err,name=a.name,x=a.target_x,y=a.target_y,
    mined_count=a.mined_count or 0,items=a.items or {},avoid_count=a.avoid_count or 0,clear_count=a.clear_count or 0,
    path=a.path_out,path_count=a.path_out and #a.path_out or nil,
    entity=a.entity_info,
    movement={distance=(a.distance or 0)+distance(position,a.last_position),duration_ms=((a.walk_end or game.tick)-a.started_tick)*1000/60,
      game_ticks=(a.walk_end or game.tick)-a.started_tick,final_position={x=position.x,y=position.y}},
    game_ticks=game.tick-a.started_tick}
end
local function finish(a,ok,err)
  stop_player(game.get_player(a.player))
  local s=state()
  s.last=result(a,ok,err)
  s.active=nil
  return s.last
end
local function find_entity(p,target,minable)
  local candidates={}
  local protected=nil
  for _,e in pairs(p.surface.find_entities_filtered{area={{target.x,target.y},{target.x+1,target.y+1}}}) do
    if e.valid and e~=p.character and e.type~='character' and e.type~='item-entity' and e.type~='corpse'
      and (not minable or e.minable)
      and (not target.kind or (target.kind=='resource' and e.type=='resource') or (target.kind=='entity' and e.type~='resource'))
      and (not target.name or e.name==target.name) then
      -- Manual/resource mining must not silently dismantle the player's own
      -- buildings. Deconstruct-area/recovery explicitly opt in to that.
      if minable and not target.allow_buildings and target.kind~='resource'
        and e.force==p.force and e.type~='tree' and e.type~='simple-entity' then
        protected=protected or e
      else
        local d=distance(e.position,{x=target.x+0.5,y=target.y+0.5})
        candidates[#candidates+1]={entity=e,score=(e.type=='resource' and 0 or 100)-d*d,key=e.name..':'..e.position.x..':'..e.position.y}
      end
    end
  end
  table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end)
  return candidates[1] and candidates[1].entity, protected
end
local function reached(a,p)
  if a.entity then return a.entity.valid and p.can_reach_entity(a.entity) end
  return distance(p.position,a.goal)<=a.radius+0.08
end
local function free_position(p, direction, step)
  local candidate={x=p.position.x+direction.x*step,y=p.position.y+direction.y*step}
  local free=p.surface.find_non_colliding_position('character',candidate,0.6,0.1)
  if free and distance(free,candidate)<=0.45 then return free end
  return nil
end
-- A blocked character tries a short perpendicular/backward sidestep, alternating
-- sides, then asks the pathfinder again from its new position. This avoids
-- repeatedly requesting the same blocked route against a wall or building.
local function begin_avoidance(a,p)
  local dx,dy=a.goal.x-p.position.x,a.goal.y-p.position.y
  local length=math.sqrt(dx*dx+dy*dy)
  if length<0.001 then dx,dy=1,0 else dx,dy=dx/length,dy/length end
  local left={x=-dy,y=dx}
  local right={x=dy,y=-dx}
  local back={x=-dx,y=-dy}
  local order=((a.avoid_count or 0)%2==0) and {left,right,back} or {right,left,back}
  for _,direction in ipairs(order) do
    for _,step in ipairs({1.0,1.6,2.4}) do
      local free=free_position(p,direction,step)
      if free then
        a.avoid_count=(a.avoid_count or 0)+1
        if a.avoid_count>MAX_AVOIDS then return false,'blocked' end
        local octant=math.floor(math.atan2(direction.x,-direction.y)/(math.pi/4)+0.5)%8
        a.phase='avoiding'
        a.avoid_until=game.tick+AVOID_TICKS
        a.avoid_direction=octant*2
        a.stuck_tick=game.tick
        stop_player(p)
        return true
      end
    end
  end
  return false,'blocked'
end
local function clearable_obstacle(entity)
  if not entity.valid or not entity.minable then return false end
  if entity.type=='tree' then return true end
  return entity.type=='simple-entity' and entity.name:find('rock',1,true)~=nil
end
local function obstacle_score(a,p,entity)
  local dx,dy=entity.position.x-p.position.x,entity.position.y-p.position.y
  local dist=math.sqrt(dx*dx+dy*dy)
  local gx,gy=a.goal.x-p.position.x,a.goal.y-p.position.y
  local glen=math.sqrt(gx*gx+gy*gy)
  local align=0
  if dist>0.001 and glen>0.001 then align=(dx*gx+dy*gy)/(dist*glen) end
  return align*2-dist*0.15
end
-- When sidestepping cannot free the character, mine the closest tree/rock in
-- front of it. Clearing one obstacle at a time keeps routes fresh and avoids
-- destroying a whole forest on a single bad path.
local function begin_clearing(a,p)
  if (a.clear_count or 0)>=MAX_CLEARS then return false,'blocked' end
  local best,best_score=nil,nil
  for _,entity in pairs(p.surface.find_entities_filtered{position=p.position,radius=3.0}) do
    if clearable_obstacle(entity) and p.can_reach_entity(entity) then
      local score=obstacle_score(a,p,entity)
      if not best_score or score>best_score then best,best_score=entity,score end
    end
  end
  if not best then return false end
  a.clear_count=(a.clear_count or 0)+1
  a.clear_entity=best
  a.phase='clearing'
  a.clear_until=game.tick+CLEAR_TICKS
  a.stuck_tick=game.tick
  stop_player(p)
  return true
end
local function request_path(a,p)
  stop_player(p)
  a.phase='pathfinding';a.path=nil;a.path_index=1;a.requested_tick=game.tick
  a.progress_distance=nil;a.progress_index=nil
  a.request=p.surface.request_path{
    bounding_box=p.character.prototype.collision_box,collision_mask=p.character.prototype.collision_mask,
    start=p.position,goal=a.goal,force=p.force,radius=a.radius,entity_to_ignore=p.character,
    can_open_gates=true,path_resolution_modifier=2,
    -- Prefer sustained diagonal/cardinal legs over a staircase of tiny turns.
    -- Fresh paths also respond to buildings placed since the previous action.
    pathfind_flags={allow_destroy_friendly_entities=false,allow_paths_through_own_entities=false,
      prefer_straight_paths=true,cache=false}
  }
end
local function begin_mining(a,p)
  a.walk_end=game.tick
  if not a.entity.valid then return finish(a,false,'target_disappeared') end
  local properties=a.entity.prototype.mineable_properties
  local products=properties.products or {}
  if properties.required_fluid or (#products>0 and products[1].type=='fluid') then return finish(a,false,'not_hand_minable') end
  local can_insert=false
  for _,item in pairs(products) do
    if item.type=='item' and p.can_insert{name=item.name,count=item.amount or item.amount_max or 1} then can_insert=true end
  end
  if #products>0 and not can_insert then return finish(a,false,'inventory_full') end
  a.phase='mining'
  local mining_time=a.entity.prototype.mineable_properties.mining_time or 1
  local speed=(p.character.prototype.mining_speed or 0.5)*math.max(0.01,1+p.character_mining_speed_modifier+p.force.manual_mining_speed_modifier)
  a.mining_deadline=game.tick+math.max(600,math.ceil(mining_time/speed*60*3)+120)
end
local function update(a,p)
  if not p or not p.valid or not p.connected or not p.character or not p.character.valid then return finish(a,false,'no_character') end
  if p.driving then return finish(a,false,'driving_not_supported') end
  if game.tick>a.lease then return finish(a,false,'controller_lease_expired') end
  if game.tick-a.started_tick>36000 then return finish(a,false,'action_timeout') end
  a.distance=a.distance+distance(p.position,a.last_position)
  a.last_position={x=p.position.x,y=p.position.y}
  if a.mined then return finish(a,true) end
  if a.entity and not a.entity.valid then return finish(a,false,'target_disappeared') end
  if a.phase=='mining' then
    if not p.can_reach_entity(a.entity) then return finish(a,false,'out_of_reach') end
    if game.tick>a.mining_deadline then return finish(a,false,'mining_stalled') end
    p.walking_state={walking=false,direction=defines.direction.north}
    p.selected=a.entity
    if p.selected~=a.entity then return finish(a,false,'target_not_selectable') end
    p.mining_state={mining=true,position=a.entity.position}
    return
  end
  if reached(a,p) then
    if a.kind=='mine' then begin_mining(a,p) else finish(a,true) end
    return
  end
  if a.phase=='clearing_done' then
    a.phase='walking';a.stuck_tick=game.tick
    return request_path(a,p)
  end
  if a.phase=='clearing' then
    local entity=a.clear_entity
    if not entity or not entity.valid then
      a.clear_entity=nil;a.phase='clearing_done';return
    end
    if game.tick>a.clear_until then
      a.clear_entity=nil;a.phase='clearing_done';return
    end
    if not p.can_reach_entity(entity) then
      a.clear_entity=nil
      local ok,err=begin_avoidance(a,p)
      if ok then return end
      return finish(a,false,err or 'blocked')
    end
    p.walking_state={walking=false,direction=defines.direction.north}
    p.selected=entity
    if p.selected~=entity then
      a.clear_entity=nil;a.phase='clearing_done';return
    end
    p.mining_state={mining=true,position=entity.position}
    return
  end
  if a.retry_tick then
    if game.tick>=a.retry_tick then a.retry_tick=nil;request_path(a,p) end
    return
  end
  if a.phase=='avoiding' then
    if game.tick<a.avoid_until then
      p.mining_state={mining=false}
      p.walking_state={walking=true,direction=a.avoid_direction}
      return
    end
    a.phase='walking';a.stuck_tick=game.tick
    return request_path(a,p)
  end
  if a.phase=='pathfinding' then
    if game.tick-a.requested_tick>600 then return finish(a,false,'pathfinding_timeout') end
    return
  end
  local point=a.path and a.path[a.path_index]
  while point and distance(p.position,point.position)<0.30 do
    if a.kind=='move' and a.path_index==#a.path then break end
    a.path_index=a.path_index+1;point=a.path[a.path_index]
  end
  -- The pathfinder can end near the requested position. Walk to the actual
  -- move target instead of dropping the final waypoint just outside tolerance.
  if point and a.kind=='move' and a.path_index==#a.path then point={position=a.goal} end
  if not point then
    -- Reach is entity-specific: rocks/trees can have a smaller interaction
    -- range than containers. Tighten a pathfinder radius that stopped too far
    -- away instead of repeating the same zero-length route.
    a.range_adjustments=(a.range_adjustments or 0)+1
    if a.range_adjustments>6 or a.radius<=0.2 then
      local cleared=begin_clearing(a,p)
      if cleared then return end
      local ok,err=begin_avoidance(a,p)
      if ok then return end
      return finish(a,false,err or 'blocked')
    end
    a.radius=math.max(0.2,a.radius/2)
    return request_path(a,p)
  end
  -- Judge progress against the current waypoint, not raw position: a character
  -- sliding along a tree still jitters a few centimetres every tick, which used
  -- to mask a fully blocked route forever.
  if a.progress_index~=a.path_index then
    a.progress_index=a.path_index;a.progress_distance=nil
  end
  local point_distance=distance(p.position,point.position)
  if not a.progress_distance or point_distance<a.progress_distance-0.15 then
    a.progress_distance=point_distance;a.progress_tick=game.tick
  elseif game.tick-(a.progress_tick or game.tick)>STUCK_TICKS then
    a.progress_distance=nil
    -- A coarse path node can sit just outside the character's collision box on
    -- open ground. Skip one intermediate node before the more disruptive
    -- sidestep dance, which is what caused visible zig-zagging.
    if a.path and a.path_index<#a.path then
      a.path_index=a.path_index+1
      a.progress_tick=game.tick
      return
    end
    if (a.avoid_count or 0)>=1 then
      local cleared=begin_clearing(a,p)
      if cleared then return end
    end
    local ok,err=begin_avoidance(a,p)
    if ok then return end
    return finish(a,false,err or 'blocked')
  end
  local dx,dy=point.position.x-p.position.x,point.position.y-p.position.y
  local octant=math.floor(math.atan2(dx,-dy)/(math.pi/4)+0.5)%8
  p.mining_state={mining=false}
  p.walking_state={walking=true,direction=octant*2}
end
script.on_event(defines.events.on_tick,function()
  if reset_after_load then reset() end
  local a=state().active
  if not a then return end
  local ok,err=pcall(update,a,game.get_player(a.player))
  if not ok then finish(a,false,'controller_error: '..tostring(err)) end
end)
script.on_event(defines.events.on_script_path_request_finished,function(event)
  local a=state().active
  if not a or a.request~=event.id then return end
  if event.try_again_later then
    a.retries=a.retries+1
    if a.retries>5 then return finish(a,false,'pathfinder_busy') end
    a.retry_tick=game.tick+30
  elseif not event.path then
    if a.kind=='path' then finish(a,false,'no_path') return end
    -- Terrain (water/cliffs) cannot be cleared: retry at most once from a
    -- sidestep and then report no_path instead of oscillating.
    if (a.no_path_attempts or 0)>=MAX_NO_PATH_AVOIDS then finish(a,false,'no_path') return end
    a.no_path_attempts=(a.no_path_attempts or 0)+1
    local p=game.get_player(a.player)
    if p and p.valid and p.character then
      local cleared=begin_clearing(a,p)
      if cleared then return end
      local ok=begin_avoidance(a,p)
      if ok then return end
    end
    finish(a,false,'no_path')
  elseif a.kind=='path' then
    a.path_out={}
    for _,waypoint in ipairs(event.path) do
      table.insert(a.path_out,{x=waypoint.position.x,y=waypoint.position.y})
    end
    finish(a,true)
  else
    a.path=event.path;a.path_index=1;a.phase='walking'
    a.stuck_tick=game.tick
  end
end)
script.on_event(defines.events.on_pre_player_mined_item,function(event)
  local a=state().active
  if a and a.phase=='clearing' and event.player_index==a.player and event.entity==a.clear_entity then
    a.clear_entity=nil
    local p=game.get_player(a.player)
    if p then p.mining_state={mining=false} end
    a.phase='clearing_done';a.stuck_tick=game.tick;a.avoid_count=0
    return
  end
  if a and a.kind=='mine' and a.phase=='mining' and event.player_index==a.player and event.entity==a.entity then
    a.mined=true
    -- Stop immediately, so a resource action mines exactly one cycle.
    local p=game.get_player(a.player);p.mining_state={mining=false}
  end
end)
script.on_event(defines.events.on_player_mined_item,function(event)
  local a=state().active
  if a and a.mined and event.player_index==a.player then
    local item=event.item_stack
    a.items[item.name]=(a.items[item.name] or 0)+item.count
    a.mined_count=a.mined_count+item.count
  end
end)
remote.add_interface('autorio-control',{
  reset=function() reset();return {ok=true} end,
  stop=function(token)
    local a=state().active
    if a and (not token or token==a.token) then return finish(a,false,'cancelled') end
    return {ok=true,status='done'}
  end,
  start=function(args)
    if reset_after_load then reset() end
    local s=state()
    if s.active then return {ok=false,status='done',error='controller_busy'} end
    local p=game.get_player(1)
    if not p or not p.character or not p.connected then return {ok=false,status='done',error='no_character'} end
    if game.tick_paused then return {ok=false,status='done',error='game_paused'} end
    if p.driving then return {ok=false,status='done',error='driving_not_supported'} end
    local pos=(args.kind=='move' or args.kind=='path') and args or args.target
    if not pos or type(pos.x)~='number' or type(pos.y)~='number' or math.abs(pos.x)==math.huge or math.abs(pos.y)==math.huge then return {ok=false,status='done',error='invalid_target'} end
    local a={token=args.token,kind=args.kind,player=p.index,started_tick=game.tick,lease=game.tick+300,
      last_position={x=p.position.x,y=p.position.y},stuck_position={x=p.position.x,y=p.position.y},
      stuck_tick=game.tick,distance=0,avoid_count=0,clear_count=0,retries=0,mined_count=0,items={}}
    if args.kind=='move' or args.kind=='path' then
      a.goal={x=args.x,y=args.y};a.radius=0.18
    elseif args.kind=='mine' or args.kind=='approach' then
      local protected
      a.entity,protected=find_entity(p,args.target,args.kind=='mine')
      if not a.entity then
        if protected then
          return {ok=false,status='done',error='protected_building',entity={name=protected.name,type=protected.type,center={x=protected.position.x,y=protected.position.y}},hint='Use --allow-buildings with act-mine or deconstruct-area for an intentional removal.'}
        end
        return {ok=false,status='done',error=args.target.kind=='resource' and 'no_resource' or 'no_entity'}
      end
      a.name=a.entity.name;a.target_x=args.target.x;a.target_y=args.target.y
      a.goal={x=a.entity.position.x,y=a.entity.position.y}
      a.entity_info={name=a.name,center=a.goal}
      a.radius=math.max(0.25,(a.entity.type=='resource' and p.resource_reach_distance or p.reach_distance)-0.75)
    else return {ok=false,status='done',error='invalid_action'} end
    s.active=a;s.last=nil
    local ok,err=pcall(function()
      if reached(a,p) then
        if a.kind=='mine' then begin_mining(a,p) else finish(a,true) end
      else request_path(a,p) end
    end)
    if not ok then return finish(a,false,'controller_error: '..tostring(err)) end
    return s.last or {ok=true,status='running',token=a.token,phase=a.phase}
  end,
  poll=function(token)
    local s=state();local a=s.active
    if a and a.token==token then
      if game.tick_paused then return finish(a,false,'game_paused') end
      a.lease=game.tick+300
      return {ok=true,status='running',token=token,phase=a.phase,avoid_count=a.avoid_count or 0,clear_count=a.clear_count or 0,game_ticks=game.tick-a.started_tick}
    end
    if s.last and s.last.token==token then return s.last end
    return {ok=false,status='done',error='action_not_found'}
  end
})
