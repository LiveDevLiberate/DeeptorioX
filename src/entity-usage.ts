/** Curated, behavior-level usage notes for common Factorio entity types. */

export type EntityUsage = {
  name: string;
  type: string;
  summary: string;
  flow?: { input: string; output: string };
  placement?: string;
  rules: string[];
  common_mistakes?: string[];
  examples?: string[];
  source: "curated" | "type_fallback";
};

type UsageTemplate = Omit<EntityUsage, "name" | "type" | "source">;

const BY_TYPE: Record<string, UsageTemplate> = {
  "transport-belt": {
    summary:
      "A belt has two lanes and carries items in one direction; it is not a junction that adds flows together.",
    flow: {
      input: "Items enter from the back or by side-loading; both lanes move toward the facing direction.",
      output: "Items leave at the far end. The same belt cannot emit from both ends or in both directions.",
    },
    placement:
      "Direction 0=north, 4=east, 8=south, 12=west. Adjacent belts must face the same flow; a perpendicular belt only merges when side-loaded.",
    rules: [
      "Each belt tile has two lanes (left/right). The two lanes can carry two different item types side by side; a splitter or underground trick can unmerge them.",
      "Belts only move items along themselves: they cannot insert into a chest, machine or furnace, and cannot extract from one. Put an inserter at the edge to load/unload a building.",
      "Belts do NOT automatically sum flows at an intersection or head-on meeting. Use side-loading, a splitter, or underground belts to join/cross flows.",
      "Side-loading a perpendicular belt pushes items into one lane of the target belt only. If that lane is full, the side belt backs up; it does not add a second lane automatically.",
      "A splitter has two inputs and two outputs (1:1 split); it can merge two input belts, but the output belt's throughput is still capped.",
      "Base throughput is about 15/30/45 items per second for yellow/red/blue belts; merging two saturated inputs into one output causes a bottleneck. Add parallel belts or proper balancing.",
      "To cross two independent belt flows use an underground-belt pair or a splitter; a surface crossing does not exchange items or sum flows.",
      "To change the direction of a flow, a belt corner must face the new direction; items do not turn by themselves at a tile that still faces the old direction.",
    ],
    common_mistakes: [
      "Building a + intersection and expecting the two crossing belts to exchange and sum flow.",
      "Ending a belt at a chest/machine and expecting the belt itself to transfer items; inserters are required.",
      "Assuming side-by-side parallel belts exchange items; only the tile directly in front of a belt is its output target.",
      "Treating a perpendicular side-load or a crossing as a full two-lane merge; side loads fill one lane and crossings are not automatic.",
      "Side-loading a full belt and expecting both input streams to keep their full throughput.",
      "Trying to make one belt carry two directions; use two belts or an underground pair.",
      "Feeding two full belts into one splitter output and assuming the combined throughput is preserved.",
    ],
    examples: [
      "Two item types can share one belt, one per lane; use a splitter filter to separate them.",
      "Use a splitter as a 2-input merger, or side-load a perpendicular belt to merge into one lane.",
    ],
  },

  splitter: {
    summary:
      "A splitter has two input belts and two output belts and moves items 1:1; it can merge or divide flows.",
    flow: {
      input: "Two inputs from the rear (left/right sides).",
      output: "Two forward outputs (left/right sides); lanes are preserved through the splitter.",
    },
    placement:
      "The splitter's inputs are opposite its facing direction. Keep the splitter tier at least as fast as incoming belts.",
    rules: [
      "One input is split evenly across both outputs; if one output is backed up, all input can go to the other output.",
      "Two inputs can be merged into one output; the merged belt still has the output belt's throughput limit.",
      "Filters can send one item type to a chosen output; output/input priority can favor one side.",
      "Splitters preserve left/right lanes, so they are the correct way to unmerge two different items riding one belt.",
      "A splitter is not a bidirectional junction: it has one front direction and two rear inputs; it cannot reverse a belt's flow.",
    ],
    common_mistakes: [
      "Expecting a splitter to merge two saturated input belts without loss at a single output.",
      "Rotating only one splitter in a chain; every splitter must face the intended flow.",
      "Using a splitter as a surface crossing without an underground pair; crossing flows are not exchanged for free.",
      "Expecting a splitter to act as a bidirectional junction; it has one facing direction and two rear inputs.",
    ],
  },

  "underground-belt": {
    summary: "An underground belt moves items from an input tile to its paired output tile.",
    flow: {
      input: "The input underground segment (facing the travel direction).",
      output: "The paired output segment further along the same facing direction.",
    },
    placement:
      "Place an input and a matching output, both facing the same direction; maximum distance depends on belt tier.",
    rules: [
      "Underground belts are directional and paired; they cannot emit from both ends.",
      "Use them to cross a belt, pipe or building without mixing flows.",
      "The output belongs to the matching input only; do not cross separate pairs.",
    ],
    common_mistakes: [
      "Placing two input or two output ends.",
      "Using an underground pair to merge two sources into two directions.",
    ],
  },
  inserter: {
    summary: "An inserter moves items from the tile behind it into the tile in front of it.",
    flow: { input: "Pickup side (behind the inserter).", output: "Drop side (in front of the inserter)." },
    placement: "Direction sets the drop direction; the pickup is opposite.",
    rules: [
      "One inserter is one-way; use two inserters for two directions.",
      "Inserters need power (electric) or fuel (burner) unless the prototype is free.",
      "Stack size, filters and circuit conditions change what is moved.",
    ],
    common_mistakes: [
      "Placing two machines on the same side of one inserter and expecting both to be served.",
      "Rotating an inserter 180° when only its pickup/drop should be swapped with a second inserter.",
    ],
  },
  "assembling-machine": {
    summary: "An assembler makes one selected recipe from ingredients supplied by inserters or belts.",
    rules: [
      "Set the recipe first; without a recipe it does nothing.",
      "Inputs and outputs must be inserted/extracted; belts alone do not connect to it.",
      "Crafting speed and module slots depend on the machine tier.",
    ],
    examples: ["Feed ingredients with one or more inserters and take the product from the output side."],
  },
  furnace: {
    summary: "A furnace smelts one recipe (usually ore to plate) using fuel.",
    rules: [
      "Fuel and ore are separate inputs; products exit through the output side.",
      "Stone/electric/steel furnaces have different speed and module support.",
      "A furnace cannot both smelt and act as a chest.",
    ],
  },
  "mining-drill": {
    summary: "A drill extracts resources under its drilling area and outputs them to the front/side.",
    rules: [
      "Place it on resource tiles; it only mines resources under its area.",
      "Output direction matters; belts/chests must face the output.",
      "Electric drills need power; burner drills need fuel.",
    ],
  },
  lab: {
    summary: "A lab consumes science packs to progress the current technology.",
    rules: [
      "Labs need one or more science packs inserted; the tech must be selected in the research queue.",
      "More labs research faster but consume packs faster.",
    ],
  },
  boiler: {
    summary: "A boiler heats water into steam for steam engines.",
    rules: [
      "Water input and steam output are separate fluid connections.",
      "Fuel is inserted by inserter or belt; output steam must go to a steam engine.",
    ],
  },
  generator: {
    summary: "A steam engine converts steam into electricity.",
    rules: [
      "Steam input and electric output; it does not store fuel.",
      "Connect it to the electric network with poles.",
    ],
  },
  pipe: {
    summary: "Pipes connect fluid boxes; flow is driven by machines/pumps, not by pipe direction.",
    rules: [
      "Pipes have no item direction and can merge fluid networks.",
      "Use pipe-to-ground to cross obstacles; pumps impose direction.",
    ],
  },
  "electric-pole": {
    summary:
      "Poles connect electric producers, consumers and accumulators within wire reach and supply area.",
    rules: [
      "Wire reach connects poles and entities; supply area powers nearby machines.",
      "Big poles and substations trade range/coverage; do not assume all poles are equivalent.",
    ],
  },
  container: {
    summary: "Chests store items; inserters load/unload them.",
    rules: ["Chests have no automatic input/output; use inserters or logistics."],
  },
  "logistic-container": {
    summary:
      "Logistic chests participate in the robot network; their mode controls request/provide behavior.",
    rules: [
      "Set the chest mode (passive provider, requester, buffer, etc.).",
      "Robots need a roboport and logistic coverage.",
    ],
  },
  roboport: {
    summary: "A roboport provides robot construction/logistics coverage and recharges robots.",
    rules: [
      "Coverage is split into construction and logistic ranges.",
      "Robots need power and a roboport; distance matters.",
    ],
  },
  turret: {
    summary: "A turret automatically targets enemies in range and consumes ammo (unless a laser type).",
    rules: [
      "Ammo turrets need a fed ammo inventory; laser turrets need power.",
      "Range, target priority and friendly fire behavior depend on the prototype.",
    ],
  },
  wall: {
    summary: "Walls block enemy movement; gates allow the player through.",
    rules: [
      "Walls are placed as continuous lines; gates need power or player proximity for normal operation.",
    ],
  },
};

const BY_NAME: Record<string, UsageTemplate> = {
  "small-electric-pole": {
    summary: "Cheap local pole: 5x5 supply area and 7.5 wire reach.",
    rules: [
      "Use rows/columns spaced about 5 tiles for local machine coverage; do not use small poles for long-distance trunks.",
      "One small pole can cover a 5x5 block; extra poles inside that block are wasted.",
    ],
    common_mistakes: ["Placing a small pole next to every machine instead of once per 5x5 supply block."],
  },
  "medium-electric-pole": {
    summary: "Local pole: 5x5 supply area and 9 wire reach.",
    rules: [
      "Same 5x5 supply footprint as small poles but longer wires; useful for slightly wider rows.",
      "Still not a long-range transmission pole.",
    ],
  },
  "big-electric-pole": {
    summary: "Long-distance transmission pole: small 4x4 supply area but 30 wire reach.",
    rules: [
      "Use only for straight power trunks between bases; it does not efficiently cover machines locally.",
      "For area coverage use small/medium poles or substations, not a dense grid of big poles.",
      "Keep big-pole trunks in one straight row/column and leave the 4x4 supply to local poles.",
    ],
    common_mistakes: [
      "Using big poles as a dense coverage grid: their supply area is tiny, so density and cost explode.",
      "Expecting a big pole to power a large machine block by itself.",
    ],
  },
  substation: {
    summary: "Area-coverage pole: 18x18 supply area and 18 wire reach.",
    rules: [
      "Use a roughly 18-tile grid for large machine areas; one substation covers 18x18.",
      "Substations are expensive but replace many small poles; keep them in aligned rows/columns.",
      "Connect substations with wires within their 18-tile reach; use big poles only for much longer gaps.",
    ],
    common_mistakes: ["Mixing substations into an irregular, manually-spaced chain and losing coverage."],
  },
  loader: {
    summary: "A loader transfers items between a belt/container and an adjacent inventory in one direction.",
    rules: [
      "Loaders are directional; input and output sides are fixed by rotation.",
      "They are not a two-way crossing; use two loaders or a proper belt layout for bidirectional transport.",
    ],
    common_mistakes: ["Treating a loader as a bidirectional belt."],
  },
};

/** Canonical Factorio belt-junction rules shared by the catalog and prompts. */
export const BELT_RULES = {
  schema_version: 1,
  lanes_per_belt: 2,
  lane_capacity:
    "Two lanes can carry two different item types side by side; a lane is not a second material flow at a junction.",
  junction_rule:
    "Belts do not automatically sum or exchange flows at an intersection, head-on meeting or surface crossing. Join flows only by side-loading, a splitter, or underground belts.",
  side_loading:
    "A perpendicular belt side-loads into one lane of the target belt. A full target lane backs up instead of accepting the second flow; it does not add throughput.",
  link_rule:
    "Belts connect only through the tile directly in front of them. When the next belt is straight the full two lanes continue; a perpendicular next belt receives only a one-lane side-load; an opposite next belt is head-on (invalid); a non-belt target does not receive items. Side-by-side parallel belts do NOT exchange items. A direct cross is not a generic junction: classify each arm by next_connection (straight/side_load/head_on/non_belt) and use underground/splitters for crossings or merges.",
  building_io_rule:
    "Belts cannot load or unload chests, machines, furnaces or labs by themselves. An inserter is required at the boundary; belt endpoints only drop items on the ground/belt, not into inventories.",
  splitter_rule:
    "A splitter has two inputs and two outputs, splits 1:1, preserves lanes, supports priority/filter, and can merge inputs; its output is still limited by the output belt's throughput.",
  underground_rule:
    "An underground-belt pair crosses other belts/entities without mixing; it is directional, and the entrance half blocks side input while the belt half accepts side input.",
  throughput_items_per_second: {
    "transport-belt": 15,
    "fast-transport-belt": 30,
    "express-transport-belt": 45,
  },
  common_mistakes: [
    "Expecting a + crossing to combine both belts' throughput.",
    "Side-loading into a full lane and expecting the second flow to continue at full rate.",
    "Merging two saturated belts into one output without a balancer.",
    "Using one belt for two opposite directions.",
  ],
};

export function entityUsage(prototype: { name?: unknown; type?: unknown }): EntityUsage {
  const name = typeof prototype.name === "string" ? prototype.name : "unknown";
  const type = typeof prototype.type === "string" ? prototype.type : "unknown";
  const template = BY_NAME[name] || BY_TYPE[type] || BY_TYPE[name];
  if (template) return { name, type, source: "curated", ...template };
  return {
    name,
    type,
    source: "type_fallback",
    summary: `No curated usage note for this ${type}.`,
    rules: [
      "Use observe-entity-prototype for dimensions/energy/fluid fields, and observe-layout/observe-connections to see how neighbours are connected.",
      "Do not assume a bidirectional behavior from a building's name; check its type and prototype description.",
    ],
  };
}

// Additional base-game building types. Type-level rules apply to every tier/name
// of that type, so `entity-usage --name electric-furnace` inherits furnace rules.
Object.assign(BY_TYPE, {
  "chemical-plant": {
    summary: "A 3x3 chemical plant runs one fluid/solid recipe.",
    rules: [
      "Ingredients and products can be fluids and items; use pipes for fluids and inserters for items.",
      "Set the recipe first; modules and beacon effects apply while running.",
    ],
  },
  "oil-refinery": {
    summary: "A multi-output refinery runs refining recipes using crude oil and water.",
    rules: [
      "Pipe crude oil/water in and route each fluid product out; products are not interchangeable.",
      "Set the refinery recipe first; recipes have different input/output layouts.",
    ],
  },
  centrifuge: {
    summary: "A centrifuge processes uranium/nuclear-related recipes.",
    rules: [
      "Set the recipe; uranium processing produces multiple outputs and consumes acid in some recipes.",
    ],
  },
  recycler: {
    summary: "A recycler breaks items back into a fraction of their ingredients.",
    rules: ["Set a recyclable recipe; output is probabilistic and the machine is not a storage chest."],
  },
  "solar-panel": {
    summary: "A solar panel produces electricity only during daylight.",
    rules: [
      "No fuel/fluid input; connect it to the electric network with poles.",
      "Pair with accumulators for night-time demand.",
    ],
  },
  accumulator: {
    summary: "An accumulator stores electric energy and discharges during shortages.",
    rules: [
      "Connect to a network; it charges only when production exceeds demand.",
      "It is not a generator and cannot bootstrap a blacked-out network.",
    ],
  },
  reactor: {
    summary: "A nuclear reactor produces heat from fuel cells; heat must be converted to steam/electricity.",
    rules: [
      "Needs a fuel-cell inserter and heat pipes/exchangers; it does not directly output electricity.",
      "Neighbouring reactors receive a neighbour bonus; heat and fluid connections are directional.",
    ],
  },
  "heat-exchanger": {
    summary: "A heat exchanger converts reactor heat and water into steam.",
    rules: ["Heat pipe input, water input, steam output; steam turbines convert the steam to electricity."],
  },
  "steam-turbine": {
    summary: "A steam turbine converts high-temperature steam into electricity.",
    rules: ["Steam input and electric output; it does not store fuel or water."],
  },
  pump: {
    summary: "A pump moves fluid in one direction and can extend pipeline flow.",
    rules: [
      "Pumps are directional; rotate to face the flow direction.",
      "They can be powered by electricity or burn fuel depending on tier.",
    ],
  },
  "offshore-pump": {
    summary: "An offshore pump extracts water from a lake/ocean edge.",
    rules: [
      "Must be placed on the shoreline with water adjacent; output is a fluid pipe connection.",
      "Water flows from the pump to connected pipes/machines.",
    ],
  },
  "pipe-to-ground": {
    summary: "A pipe-to-ground pair crosses obstacles while keeping fluid flow on one axis.",
    rules: [
      "Paired input/output segments must face/connect correctly; use for crossings, not item flow.",
      "Fluid networks merge only through valid pipe connections.",
    ],
  },
  "storage-tank": {
    summary: "A storage tank buffers one fluid network.",
    rules: [
      "Pipes connect to its fluid boxes; it stores a single fluid.",
      "It does not generate or consume fluid.",
    ],
  },
  radar: {
    summary: "A radar reveals surrounding chunks and can transmit circuit signals.",
    rules: [
      "Needs power; continuous scanning reveals nearby chunks over time.",
      "It does not automatically build or mine.",
    ],
  },
  beacon: {
    summary: "A beacon broadcasts module effects to nearby machines.",
    rules: [
      "Needs power and modules; only machines in range receive effects.",
      "Beacon effects do not stack from multiple beacons for the same stat beyond the game's rules.",
    ],
  },
  "rocket-silo": {
    summary: "A rocket silo builds and launches rockets from supplied parts.",
    rules: [
      "Insert rocket parts and satellite/payload items; it needs power and a launch trigger.",
      "Rockets are launched at the silo; output is not a normal item inventory.",
    ],
  },
  locomotive: {
    summary: "A locomotive powers a train on rails.",
    rules: [
      "Needs fuel and a rail network; it pulls wagons and uses rail signals for safe blocks.",
      "It cannot drive off rails or through unconnected rail.",
    ],
  },
  "cargo-wagon": {
    summary: "A cargo wagon stores solid items for train transport.",
    rules: [
      "Must be coupled to a locomotive and loaded/unloaded with inserters at a stop.",
      "It has no engine and no automatic item transfer.",
    ],
  },
  "fluid-wagon": {
    summary: "A fluid wagon transports one fluid by train.",
    rules: ["Must be coupled and connected via pumps to load/unload; it cannot carry solids."],
  },
  "train-stop": {
    summary: "A train stop names a station for automatic train schedules.",
    rules: [
      "Trains path to stops by schedule; signals determine safe blocks.",
      "The stop itself does not load cargo; use inserters/pumps.",
    ],
  },
  "rail-signal": {
    summary: "A rail signal divides rail into blocks and permits one train per block.",
    rules: [
      "Place on the right side of the direction of travel; red blocks block entry.",
      "Chain signals preview the next block; do not rely on them to stop a train physically.",
    ],
  },
  "rail-chain-signal": {
    summary: "A chain signal checks the next signal/block before allowing entry.",
    rules: ["Use before junctions and crossings; it does not reserve the following block by itself."],
  },
  "gun-turret": {
    summary: "A gun turret shoots enemies using inserted ammunition.",
    rules: [
      "Needs an ammo inventory; insert magazines with an inserter.",
      "It is not a laser turret and does not use electricity.",
    ],
  },
  "laser-turret": {
    summary: "A laser turret shoots enemies using electricity.",
    rules: [
      "Needs a connected electric network and a large power reserve; it has no ammo inventory.",
      "Power shortages reduce its fire rate.",
    ],
  },
  "flamethrower-turret": {
    summary: "A flamethrower turret sprays burning fluid at enemies.",
    rules: [
      "Needs crude oil/heavy oil plus power; pipe the fluid to its fluid box.",
      "It has a limited arc and can set fires.",
    ],
  },
  "artillery-turret": {
    summary: "An artillery turret fires shells at distant enemy structures.",
    rules: [
      "Needs artillery shells and power; it cannot hit nearby fast units reliably.",
      "It reveals/clears hostile nests at long range.",
    ],
  },
  gate: {
    summary: "A gate opens for the player/vehicles while blocking enemies.",
    rules: [
      "Must be placed in a wall line aligned with walls; it opens toward a player nearby.",
      "It needs power for normal automatic operation; it is not a wall segment when open.",
    ],
  },
  "land-mine": {
    summary: "A land mine detonates when enemies enter its tile.",
    rules: [
      "It is consumed on detonation; it does not distinguish friendly units from enemies unless configured by the game.",
      "Place with spacing; do not put it where your own pathing must cross.",
    ],
  },
  lamp: {
    summary: "A lamp emits light and can be controlled by circuit signals.",
    rules: ["Needs power; color/brightness can be set by circuit conditions."],
  },
  "arithmetic-combinator": {
    summary: "A circuit combinator performs arithmetic on signals.",
    rules: [
      "Needs no power; connect red/green wires and set input/output signals.",
      "Circuit signals are separate from the electric network.",
    ],
  },
  "decider-combinator": {
    summary: "A circuit combinator outputs signals when conditions are true.",
    rules: ["Needs no power; configure conditions and output signals via wires."],
  },
  "constant-combinator": {
    summary: "A constant combinator emits configured signals.",
    rules: [
      "It has no inputs; set its signal values in the GUI.",
      "It needs no power and does not control machines directly.",
    ],
  },
  "power-switch": {
    summary: "A power switch connects/disconnects two electric networks.",
    rules: [
      "It is controlled manually or by circuit conditions; an open switch splits the network.",
      "It is not a generator and cannot create power.",
    ],
  },
  "display-panel": {
    summary: "A display panel shows text/icons; it does not produce items.",
    rules: ["Configure text or circuit signals; it needs power."],
  },
  "programmable-speaker": {
    summary: "A speaker plays sounds based on circuit conditions.",
    rules: ["It needs power and circuit inputs; it has no gameplay effect on production."],
  },
  "straight-rail": {
    summary: "Straight rail is the track for trains.",
    rules: [
      "Rails must connect continuously; signals determine blocks.",
      "Trains cannot leave rails and rail direction matters.",
    ],
  },
  "curved-rail": {
    summary: "Curved rail connects track at an angle.",
    rules: [
      "Curves must align with straight rail endpoints; signals need clear placement.",
      "Use rail planner or mirror placement for consistent networks.",
    ],
  },
});

/** Full curated catalog for agents and offline inspection. */
export function entityUsageCatalog() {
  const serialize = (template: UsageTemplate) => ({
    summary: template.summary,
    flow: template.flow,
    placement: template.placement,
    rules: template.rules,
    common_mistakes: template.common_mistakes,
    examples: template.examples,
  });
  return {
    schema_version: 1,
    types: Object.entries(BY_TYPE)
      .map(([type, template]) => ({ type, ...serialize(template) }))
      .sort((a, b) => a.type.localeCompare(b.type)),
    names: Object.entries(BY_NAME)
      .map(([name, template]) => ({ name, ...serialize(template) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    belt_rules: BELT_RULES,
    fallback: {
      summary: "Unknown/modded entity: use prototype metadata plus observation.",
      rules: [
        "Call observe-entity-prototype for type, tile size, rotatable, energy, fluids and placement item.",
        "Call observe-layout/observe-connections and inspect its status/inventories before assuming behavior.",
      ],
    },
  };
}
