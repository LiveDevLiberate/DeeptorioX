import test from "node:test";
import assert from "node:assert/strict";
import * as builders from "../dist/command-builders.js";

const {
  agentBuildDestinationCommand,
  agentChartedResourcesCommand,
  agentClearBuildFootprintCommand,
  agentCompactWorldCommand,
  agentConnectionsCommand,
  agentCraftCommand,
  agentDescriptionCommand,
  agentEntityPrototypeCommand,
  agentExtractCommand,
  agentFactoryCommand,
  agentInsertCommand,
  agentLayoutCommand,
  agentMapCommand,
  agentMapOverviewCommand,
  agentNativeBuildCommand,
  agentObserveEntityCommand,
  agentPlayerCommand,
  agentRecipesCommand,
  agentResearchCommand,
  agentResearchStartCommand,
  agentResourcesCommand,
  agentRotateCommand,
  agentSetRecipeCommand,
  agentWorldCommand,
  luaString,
} = builders;

const BUILD = { name: "transport-belt", anchor: { x: 130, y: -42 }, direction: 4 };

test("luaString wraps values in double quotes and escapes embedded quotes and backslash pairs", () => {
  assert.equal(luaString("plain"), '"plain"');
  // The server has always escaped quotes with a doubled backslash and doubled
  // each pair of backslashes; keep that exact behavior.
  assert.equal(luaString('a"b'), '"a\\\\"b"');
  assert.equal(luaString("back\\\\slash"), '"back\\\\\\\\slash"');
  assert.equal(luaString("single\\backslash"), '"single\\backslash"');
});

test("agentNativeBuildCommand anchors the build, derives the intended center and emits the reach check", () => {
  const lua = agentNativeBuildCommand(BUILD);
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes('local name="transport-belt"'));
  assert.ok(lua.includes("local anchor_x=130"));
  assert.ok(lua.includes("local anchor_y=-42"));
  assert.ok(lua.includes("local direction=4"));
  assert.ok(lua.includes("local dry_run=false"));
  assert.ok(lua.includes("if direction==4 or direction==12 then width,height=height,width end"));
  assert.ok(lua.includes("local x=anchor_x+width/2 local y=anchor_y+height/2"));
  assert.ok(lua.includes("requested_anchor={x=anchor_x,y=anchor_y},intended_center={x=x,y=y}"));
  assert.ok(lua.includes("dx*dx+dy*dy > p.build_distance*p.build_distance"));
  assert.ok(lua.includes("error='out_of_reach'"));
  assert.ok(lua.includes("error='anchor_must_be_integer'"));
  assert.ok(lua.includes("actual_anchor="));
  assert.ok(lua.includes("offset_tiles="));
  assert.ok(lua.includes("exact=(offset"));
  assert.ok(lua.includes("helpers.table_to_json"));
  // Omitted direction defaults to north (0), and dry runs only check placement.
  const defaults = agentNativeBuildCommand({ name: "stone-furnace", anchor: { x: 0, y: 0 } });
  assert.ok(defaults.includes("local direction=0"));
  const dryRun = agentNativeBuildCommand(BUILD, true);
  assert.ok(dryRun.includes("local dry_run=true"));
  assert.ok(dryRun.includes("if dry_run then local can_place="));
});

test("agentNativeBuildCommand dispatches underground subtype builds through create_entity and item consumption", () => {
  const lua = agentNativeBuildCommand({
    name: "underground-belt",
    anchor: { x: 10, y: 20 },
    direction: 4,
    underground_type: "output",
  });
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes('local underground_type="output"'));
  assert.ok(lua.includes("if underground_type~='input' and underground_type~='output'"));
  assert.ok(lua.includes("error='invalid_underground_type'"));
  assert.ok(lua.includes("name~='underground-belt' and name~='pipe-to-ground'"));
  assert.ok(
    lua.includes(
      "p.surface.create_entity{name=name,position={x=x,y=y},direction=direction,force=p.force,type=underground_type,player=p,raise_built=true}",
    ),
  );
  assert.ok(lua.includes("p.remove_item{name=place_item,count=place_count}"));
  assert.ok(lua.includes("consumed={name=place_item,count=removed}"));
  assert.ok(lua.includes("error='out_of_reach'"));
  assert.ok(lua.includes("error='cannot_build'"));
  assert.ok(lua.includes("error='missing_item'"));
  // The regular build path stays untouched (no create_entity, still cursor-based).
  const normal = agentNativeBuildCommand(BUILD);
  assert.equal(normal.includes("create_entity"), false);
  assert.ok(normal.includes("p.build_from_cursor(params)"));
  // Pipes-to-ground use the same explicit subtype path.
  const pipe = agentNativeBuildCommand({
    name: "pipe-to-ground",
    anchor: { x: 0, y: 0 },
    underground_type: "input",
  });
  assert.ok(pipe.includes('local underground_type="input"'));
  assert.ok(pipe.includes("type=underground_type"));
});

test("agentClearBuildFootprintCommand sweeps the footprint area and reports cleared, pending and skipped obstacles", () => {
  const lua = agentClearBuildFootprintCommand({ name: "assembling-machine-1", anchor: { x: 130, y: -42 } });
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes('local name="assembling-machine-1"'));
  assert.ok(lua.includes("local ax=130"));
  assert.ok(lua.includes("local ay=-42"));
  assert.ok(
    lua.includes("local found=p.surface.find_entities_filtered{area={{ax,ay},{ax+width,ay+height}}}"),
  );
  assert.ok(lua.includes("if e.type=='tree' then return e.minable end"));
  // Stumps are non-minable corpses, so they are destroyed immediately.
  assert.ok(lua.includes("if e.type=='corpse' and e.name:find('stump',1,true)~=nil then return true end"));
  assert.ok(lua.includes("e.destroy()"));
  assert.ok(lua.includes("if clearable(e) then"));
  assert.ok(lua.includes("local cleared={} local pending={} local skipped={}"));
  assert.ok(lua.includes("done{ok=not blocked and #pending==0,cleared=cleared,pending=pending"));
  assert.ok(lua.includes("footprint={min_x=ax,min_y=ay,width=width,height=height}"));
});

test("agentBuildDestinationCommand returns early in reach and computes staging offsets only when forced", () => {
  const lua = agentBuildDestinationCommand(BUILD);
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes('local name="transport-belt"'));
  assert.ok(lua.includes("local ax=130"));
  assert.ok(lua.includes("local ay=-42"));
  assert.ok(lua.includes("local dir=4"));
  assert.ok(lua.includes("local force=false"));
  assert.ok(lua.includes("if dir==4 or dir==12 then w,h=h,w end"));
  assert.ok(lua.includes("local cx=ax+w/2 local cy=ay+h/2"));
  assert.ok(lua.includes("local in_reach=dx*dx+dy*dy<=p.build_distance*p.build_distance"));
  assert.ok(
    lua.includes(
      "if in_reach and not force then done{ok=true,in_reach=true,position={x=p.position.x,y=p.position.y},center={x=cx,y=cy}} return end",
    ),
  );
  assert.ok(lua.includes("local margin=1.5 local offsets="));
  assert.ok(lua.includes("p.surface.find_non_colliding_position('character'"));
  assert.ok(lua.includes("error='no_reachable_staging_position'"));
  assert.ok(lua.includes("staging=true,position=best,center={x=cx,y=cy}"));
  const forced = agentBuildDestinationCommand(BUILD, true);
  assert.ok(forced.includes("local force=true"));
  // The force walk follows the early return, so it must not be skipped.
  assert.ok(forced.includes("if in_reach and not force then"));
});

test("agentDescriptionCommand resolves entity and technology descriptions", () => {
  const entity = agentDescriptionCommand("entity", "stone-furnace");
  assert.ok(entity.startsWith("/sc "));
  assert.ok(entity.includes('prototypes.entity["stone-furnace"]'));
  assert.ok(entity.includes("localised_description"));
  assert.ok(entity.includes("rcon.print(desc)"));
  const technology = agentDescriptionCommand("technology", "automation");
  assert.ok(technology.includes('prototypes.technology["automation"]'));
});

test("agentMapOverviewCommand downsamples a charted window into ASCII rows", () => {
  const lua = agentMapOverviewCommand({ x: 0, y: 0, radius: 128, size: 96 });
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes("local min_x=-128"));
  assert.ok(lua.includes("local step=3"));
  assert.ok(lua.includes("local width=86"));
  assert.ok(lua.includes("is_chunk_charted"));
  assert.ok(lua.includes("table.concat(rows"));
  assert.ok(lua.includes('"@":"player"'));
});

test("agentMapCommand builds a bounded chart window with chunk and symbol JSON arrays", () => {
  const lua = agentMapCommand({ x: 130, y: -42, radius: 12 });
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes("local min_x=118"));
  assert.ok(lua.includes("local max_x=142"));
  assert.ok(lua.includes("local min_y=-54"));
  assert.ok(lua.includes("local max_y=-30"));
  assert.ok(lua.includes("local chunks={} local symbols={}"));
  assert.ok(lua.includes("force.is_chunk_charted(s,{x=cx,y=cy})"));
  assert.ok(
    lua.includes(
      `rcon.print('{"window":{"min_x":'..min_x..',"min_y":'..min_y..',"max_x":'..max_x..',"max_y":'..max_y..'},"chunks":['..table.concat(chunks,',')..'],"symbols":['..table.concat(symbols,',')..']}')`,
    ),
  );
});

test("agentWorldCommand and agentCompactWorldCommand serialise the window with the requested include flags", () => {
  const world = agentWorldCommand({ x: 0, y: 0, radius: 5, includeTiles: true, includeEntities: false });
  assert.ok(world.startsWith("/sc "));
  assert.ok(world.includes("local include_tiles=true"));
  assert.ok(world.includes("local include_entities=false"));
  assert.ok(world.includes("local min_x=-5"));
  assert.ok(world.includes(`table.insert(out,'"window":{"min_x":'`));
  assert.ok(world.includes(`'"counts":{"tiles_total":'`));
  const compact = agentCompactWorldCommand({
    x: 10,
    y: 20,
    radius: 3,
    includeTiles: false,
    includeEntities: true,
  });
  assert.ok(compact.startsWith("/sc "));
  assert.ok(compact.includes("local include_tiles=false"));
  assert.ok(compact.includes("local include_entities=true"));
  assert.ok(compact.includes("local min_x=7"));
  assert.ok(compact.includes("terrain={encoding='rle_rows',rows=rows}"));
  assert.ok(compact.includes("helpers.table_to_json{window={min_x=min_x"));
});

test("agentObserveEntityCommand reports footprint and anchor for multi-tile buildings", () => {
  const lua = agentObserveEntityCommand([{ x: 1, y: 2 }]);
  assert.ok(lua.includes("e.bounding_box"));
  assert.ok(lua.includes("footprint={left="));
  assert.ok(lua.includes("anchor={x=footprint.left,y=footprint.top}"));
  assert.ok(lua.includes("collision_bounds="));
  assert.ok(lua.includes("interfaces={}"));
  assert.ok(lua.includes("port('pickup'"));
  assert.ok(lua.includes("kind='fluid'"));
});

test("agentObserveEntityCommand emits one observe() call per target with optional kind and name filters", () => {
  const lua = agentObserveEntityCommand([
    { x: 10, y: 20 },
    { x: 30, y: 40, kind: "resource", name: "iron-ore" },
  ]);
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes("table.insert(results,observe(10,20,nil,nil))"));
  assert.ok(lua.includes('table.insert(results,observe(30,40,"resource","iron-ore"))'));
  // Rocket silo observations reuse the shared rocket-state Lua block.
  assert.ok(lua.includes("local function rocket_state(e)"));
  assert.ok(lua.includes("rocket=rocket_state(e)"));
  assert.ok(lua.includes("rcon.print(helpers.table_to_json{results=results})"));
  const empty = agentObserveEntityCommand([]);
  assert.ok(empty.includes("local results={}"));
  assert.ok(!empty.includes("table.insert(results,observe("));
});

test("agentCraftCommand handcrafts a recipe count and reports the queued result", () => {
  const lua = agentCraftCommand("iron-gear-wheel", 5);
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes('local recipe="iron-gear-wheel"'));
  assert.ok(lua.includes("local count=5"));
  assert.ok(lua.includes("local recipe_obj=player.force.recipes[recipe]"));
  assert.ok(lua.includes("if not handcraft then"));
  assert.ok(lua.includes("player.begin_crafting{recipe=recipe,count=count}"));
  assert.ok(lua.includes("ok=true,completed=false"));
  assert.ok(lua.includes("player.crafting_queue"));
});

test("builders inject the configured observation limits", () => {
  const player = agentPlayerCommand({ inventoryLimit: 200, equipmentLimit: 50 });
  assert.ok(player.includes("local inv_limit=200"));
  assert.ok(player.includes("local equip_limit=50"));
  assert.ok(player.includes("character_main"));
  assert.ok(player.includes("character_trash"));
  const research = agentResearchCommand({ availableLimit: 50, lockedLimit: 40, completedLimit: 30 });
  assert.ok(research.includes("local available_limit=50"));
  assert.ok(research.includes("local locked_limit=40"));
  assert.ok(research.includes("local completed_limit=30"));
  assert.ok(research.includes("helpers.table_to_json{current=current"));
  const recipes = agentRecipesCommand({ limit: 300, unlockedOnly: true });
  assert.ok(recipes.includes("local limit=300"));
  assert.ok(recipes.includes("local unlocked_only=true"));
});

test("agentInsertCommand and agentExtractCommand emit item transfers with explicit or all counts", () => {
  const insert = agentInsertCommand({ x: 3, y: 4, item: "coal", count: 50 });
  assert.ok(insert.startsWith("/sc "));
  assert.ok(insert.includes("local x=3"));
  assert.ok(insert.includes("local y=4"));
  assert.ok(insert.includes('local item="coal"'));
  assert.ok(insert.includes("local count=50"));
  assert.ok(insert.includes("e.insert{name=item,count=removed}"));
  const extractAll = agentExtractCommand({ x: 3, y: 4, item: "coal", count: "all" });
  assert.ok(extractAll.includes("local count=-1"));
  assert.ok(extractAll.includes("if count == -1 then count=available end"));
  assert.ok(extractAll.includes("player.insert{name=item,count=removed}"));
  const extractSome = agentExtractCommand({ x: 3, y: 4, item: "coal", count: 7 });
  assert.ok(extractSome.includes("local count=7"));
});

test("agentRotateCommand and agentSetRecipeCommand emit one action call per target", () => {
  const rotate = agentRotateCommand([
    { x: 3, y: 4 },
    { x: 5, y: 6, direction: 4 },
  ]);
  assert.ok(rotate.startsWith("/sc "));
  assert.ok(rotate.includes("table.insert(results,rotate(3,4,nil))"));
  assert.ok(rotate.includes("table.insert(results,rotate(5,6,4))"));
  assert.ok(rotate.includes("r.steps"));
  assert.ok(rotate.includes(`rcon.print('{"results":'..results_json..'}')`));
  const setRecipe = agentSetRecipeCommand([{ x: 3, y: 4, recipe: "iron-gear-wheel" }]);
  assert.ok(setRecipe.includes("table.insert(results,set_recipe(3,4," + luaString("iron-gear-wheel") + "))"));
  assert.ok(setRecipe.includes("recipe_locked_or_unknown"));
  assert.ok(agentRotateCommand([]).includes("local results={}"));
});

test("agentResearchStartCommand escapes the technology name and starts force research", () => {
  const lua = agentResearchStartCommand("logistics");
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes('local tech_name="logistics"'));
  assert.ok(lua.includes("force.add_research(tech)"));
  assert.ok(lua.includes("esc('Technology not found: '..tech_name)"));
  const quoted = agentResearchStartCommand('weird"tech');
  assert.ok(quoted.includes(`local tech_name=${luaString('weird"tech')}`));
});

test("region builders embed their window arguments and JSON output plumbing", () => {
  const resources = agentResourcesCommand({ x: 1, y: 2, radius: 30 });
  assert.ok(resources.includes("local min_x=-29"));
  assert.ok(resources.includes("local max_x=31"));
  assert.ok(resources.includes(`"patches":[`));
  const charted = agentChartedResourcesCommand({ x: 100, y: 200, radius: 50 });
  assert.ok(charted.includes("local center_x=100"));
  assert.ok(charted.includes("local center_y=200"));
  assert.ok(charted.includes("local min_x=50"));
  assert.ok(charted.includes("helpers.table_to_json{patches=patches"));
  const factory = agentFactoryCommand({ radius: 60 });
  assert.ok(factory.includes("local x=nil local y=nil local radius=60"));
  assert.ok(factory.includes("helpers.table_to_json{window={x=x,y=y,radius=radius}"));
  assert.ok(agentFactoryCommand({ x: 5, y: 6, radius: 60 }).includes("local x=5 local y=6 local radius=60"));
  const layout = agentLayoutCommand({ radius: 35, step: 2 });
  assert.ok(layout.includes("local x=nil local y=nil local radius=35 local step=2"));
  assert.ok(layout.includes("overlaps_truncated=overlaps_truncated"));
  const connections = agentConnectionsCommand({ radius: 120 });
  assert.ok(connections.includes("local radius=120"));
  assert.ok(connections.includes("helpers.table_to_json{window={x=min_x,y=min_y,radius=radius}"));
  const prototype = agentEntityPrototypeCommand("assembling-machine-1");
  assert.ok(prototype.includes('local name="assembling-machine-1"'));
  assert.ok(prototype.includes("proto.fluidbox_prototypes"));
});

test("every exported command builder returns a /sc command without leaking undefined or NaN", () => {
  const cases = {
    agentBuildDestinationCommand: [BUILD],
    agentChartedResourcesCommand: [{ x: 0, y: 0, radius: 1 }],
    agentClearBuildFootprintCommand: [BUILD],
    agentCompactWorldCommand: [{ x: 0, y: 0, radius: 1, includeTiles: true, includeEntities: true }],
    agentConnectionsCommand: [{ radius: 1 }],
    agentCraftCommand: ["iron-gear-wheel", 1],
    agentEntityPrototypeCommand: ["stone-furnace"],
    agentExtractCommand: [{ x: 0, y: 0, item: "coal", count: "all" }],
    agentFactoryCommand: [{ radius: 1 }],
    agentInsertCommand: [{ x: 0, y: 0, item: "coal", count: 1 }],
    agentLayoutCommand: [{ radius: 1, step: 1 }],
    agentMapCommand: [{ x: 0, y: 0, radius: 1 }],
    agentNativeBuildCommand: [BUILD],
    agentObserveEntityCommand: [[]],
    agentPlayerCommand: [{ inventoryLimit: 1, equipmentLimit: 1 }],
    agentRecipesCommand: [{ limit: 1, unlockedOnly: false }],
    agentResearchCommand: [{ availableLimit: 1, lockedLimit: 1, completedLimit: 1 }],
    agentResearchStartCommand: ["logistics"],
    agentResourcesCommand: [{ x: 0, y: 0, radius: 1 }],
    agentRotateCommand: [[]],
    agentSetRecipeCommand: [[]],
    agentWorldCommand: [{ x: 0, y: 0, radius: 1, includeTiles: true, includeEntities: true }],
  };
  for (const [name, args] of Object.entries(cases)) {
    const command = builders[name](...args);
    assert.equal(typeof command, "string", `${name} should return a string`);
    assert.ok(command.startsWith("/sc "), `${name} should return a /sc command`);
    assert.ok(!command.includes("undefined"), `${name} should not leak undefined into Lua`);
    assert.ok(!command.includes("NaN"), `${name} should not leak NaN into Lua`);
  }
});
