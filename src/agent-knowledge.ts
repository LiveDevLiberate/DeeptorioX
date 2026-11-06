/** Concise, behavior-level engineering knowledge for the benchmark agent. */

export type KnowledgeTopic = {
  id: string;
  title: string;
  aliases: string[];
  summary: string;
  rules: string[];
  mistakes?: string[];
  references?: string[];
};

export const AGENT_KNOWLEDGE: KnowledgeTopic[] = [
  {
    id: "inserters",
    title: "Inserters",
    aliases: ["inserter", "arms", "mechanical-arm"],
    summary:
      "An inserter moves items from the tile behind it to the tile in front; it is one-way and needs power or fuel.",
    rules: [
      "Direction sets the drop side; pickup is the opposite tile. Use two inserters for two directions.",
      "Electric inserters need a connected powered network; burner inserters need fuel. A no_power/no_fuel inserter does nothing.",
      "Base capacity is about 0.83 items/s; stack size and inserter-capacity research raise it. Long-handed inserters reach 2 tiles, normal 1.",
      "Filter inserters/stack filter inserters restrict item types; useful for mixed belts and byproducts.",
      "One inserter cannot serve two source or two destination tiles; give each machine its own inserter pair.",
      "Belts cannot insert into or extract from chests/machines; an inserter is required at every building boundary.",
    ],
    mistakes: [
      "Expecting one inserter to feed two machines.",
      "Forgetting to connect the pole network or fuel a burner inserter.",
      "Overloading one inserter beyond its throughput instead of adding another.",
    ],
    references: ["https://wiki.factorio.com/Inserters"],
  },
  {
    id: "pipes",
    title: "Pipes and fluids",
    aliases: ["pipe", "fluid", "plumbing"],
    summary:
      "A connected pipe network shares one fluid; pumps add direction, underground pairs cross obstacles, and fluid never mixes across different networks.",
    rules: [
      "Pipes connect adjacent fluid boxes; the whole connected segment is one fluid network. Never connect different fluids into one network.",
      "Pumps are directional and can move fluid between networks; offshore pumps extract water at a shoreline.",
      "Underground pipe pairs cross belts/buildings without mixing; both endpoints must face the same travel direction and stay within max distance.",
      "Storage tanks buffer one fluid; a full tank backs up its network just like a full belt.",
      "Long runs and high-consumption machines need pumps; a pipe network has finite throughput and equalizes levels rather than creating infinite flow.",
      "Prefer underground pipe pairs for long runs and walkways: surface only at endpoints/corners/connections. build-line --kind pipe defaults to mostly underground pipe-to-ground; use --surface-pipes only when deliberate.",
      "When byproducts/fluids must not mix, use separate networks and pumps, not a junction.",
    ],
    mistakes: [
      "Connecting two different fluids and expecting them to remain separate.",
      "Forgetting that pumps need power/fuel.",
      "Assuming a pipe junction can merge different fluids or create pressure.",
    ],
    references: ["https://wiki.factorio.com/Fluid_system", "https://wiki.factorio.com/Pipe"],
  },
  {
    id: "trains",
    title: "Trains and rail signals",
    aliases: ["train", "rail", "railway", "signal"],
    summary:
      "Trains run on rail blocks controlled by signals; chain signals protect junctions, and locomotives need fuel.",
    rules: [
      "A rail signal divides track into blocks and permits one train per block. Place signals on the right side of the direction of travel.",
      "Put a chain signal before a junction/crossing and a normal signal after it; chain signals prevent a train from blocking the junction.",
      "Every locomotive needs fuel; cargo/fluid wagons need inserters/pumps at a train stop.",
      "Stops must be in a train schedule; signals alone do not create a route. Set station names and conditions.",
      "Avoid long bidirectional single-track lines; if used, place signals for both directions and ensure no deadlock.",
      "Use train limits/stackers to prevent trains queueing into junctions; leave space between blocks.",
    ],
    mistakes: [
      "Missing or wrong-side signal: the train reports no path.",
      "No chain signal at a junction, causing a deadlock.",
      "Building a station but not adding it to the schedule.",
    ],
    references: ["https://wiki.factorio.com/Railway", "https://wiki.factorio.com/Rail_signal"],
  },
  {
    id: "power",
    title: "Power grid",
    aliases: ["electricity", "power-grid", "poles", "electric"],
    summary:
      "Poles connect producers and consumers; supply area powers machines, wire reach joins poles, and satisfaction must stay at 1.0.",
    rules: [
      "A pole has a supply area (powers nearby machines) and a wire reach (connects poles). Both must cover the layout.",
      "Small/medium poles supply 5x5; substations supply 18x18 with 18 wire reach; big poles have tiny 4x4 supply but 30 wire reach (transmission only).",
      "Generators, accumulators and consumers must be on the same connected network; an isolated pole powers nothing.",
      "Steam needs water + fuel; check boiler/engine fluid boxes and pump power. Solar only works in daylight; accumulators cover night.",
      "A blackout can stop fuel/water inserters and pumps; keep critical inserters/pumps powered or on a separate priority network.",
      "Use `observe-factory.power.satisfaction`; if below ~1.0 find disconnected poles, missing fuel/water, or insufficient generation.",
    ],
    mistakes: [
      "Using big poles as a dense coverage grid.",
      "Poles placed within wire reach but not connected to the network.",
      "Forgetting water/fuel to boilers or power to offshore pumps/inserters.",
    ],
    references: ["https://wiki.factorio.com/Electric_system", "https://wiki.factorio.com/Electric_pole"],
  },
  {
    id: "chemistry",
    title: "Oil and chemistry",
    aliases: ["oil", "chemical", "refinery", "fluid-processing"],
    summary:
      "Refineries/chemical plants need a selected recipe and correct fluid/item inputs; byproducts and fluid mixing are the main failure modes.",
    rules: [
      "Set the refinery/chemical-plant recipe first; the machine does nothing until a valid recipe is selected.",
      "Basic oil processing produces petroleum gas; advanced processing adds heavy/light oil. Route each output separately and handle byproduct backup.",
      "Plastic = petroleum gas + coal. Sulfur = petroleum gas + water. Sulfuric acid = sulfur + water + iron plates. Batteries need acid + plates.",
      "Heavy oil can be cracked to light oil, light oil to petroleum gas; cracking consumes water and needs chemical plants.",
      "Never connect different fluids in one pipe network. Use separate networks/pumps and check output tanks for fullness.",
      "Chemical plants/refineries need power; a full output or missing input makes the machine stop with a status.",
    ],
    mistakes: [
      "No recipe selected.",
      "Allowing a byproduct output to back up and stop the refinery.",
      "Mixing heavy/light/petroleum fluids in one network.",
    ],
    references: ["https://wiki.factorio.com/Oil_processing", "https://wiki.factorio.com/Chemical_plant"],
  },
  {
    id: "defense",
    title: "Weapons and defense",
    aliases: ["weapons", "turret", "military", "walls", "combat"],
    summary:
      "Turrets need ammo or power, walls channel enemies, and gaps/unfed turrets are the main defense failures.",
    rules: [
      "Gun turrets need inserted magazines; laser turrets need power and a large reserve; flamethrower turrets need crude/heavy oil and power.",
      "Walls block movement; gates let the player/vehicles through. Keep wall lines continuous and place turrets behind walls with overlapping fields of fire.",
      "Artillery hits distant nests/structures and needs shells; it is not a close-defense weapon.",
      "Keep ammo/fluid/power supplied continuously; a single unloaded turret creates a breach.",
      "Repair damaged walls/turrets with repair packs or construction robots; replace destroyed sections promptly.",
      "Do not build defenses across your own logistics paths or leave gaps that biters can path through.",
    ],
    mistakes: [
      "Empty ammo turrets.",
      "Laser turrets without enough generation/accumulators.",
      "A wall with an unguarded gate or gap.",
    ],
    references: ["https://wiki.factorio.com/Turret", "https://wiki.factorio.com/Wall"],
  },
  {
    id: "production",
    title: "Production optimization",
    aliases: ["optimization", "throughput", "ratios", "bottleneck"],
    summary:
      "Measure first, then fix the bottleneck: inputs, power, inserter/belt throughput, or an undersized machine chain.",
    rules: [
      "Use production/consumption stats and factory status to find the bottleneck; do not add machines blindly.",
      "Respect belt throughput: about 15/30/45 items/s for yellow/red/blue; two full belts into one output is a bottleneck.",
      "Respect inserter throughput; fast/stack inserters and more parallel inserters are needed for high-volume recipes.",
      "Use correct ratios (for example 1 offshore pump : 20 boilers : 40 steam engines) and compare recipe times/ingredients.",
      "Balance lanes and use splitters/balancers; buffers only cover short spikes, they do not fix sustained undercapacity.",
      "Modules/beacons multiply speed/productivity but increase power; ensure power and inputs scale with them.",
      "Prefer parallel independent lines over one overloaded line when inputs and outputs are both saturated.",
    ],
    mistakes: [
      "Adding assemblers without feeding inputs or power.",
      "Merging saturated belts and expecting sum throughput.",
      "Ignoring inserter limits or byproduct backpressure.",
    ],
    references: ["https://wiki.factorio.com/Production", "https://wiki.factorio.com/Balancer_mechanics"],
  },
  {
    id: "containers",
    title: "Containers and crash debris",
    aliases: ["chests", "inventory", "debris", "salvage"],
    summary:
      "Containers expose slot inventories; crash-site spaceship wreckage is a lootable, mineable salvage source.",
    rules: [
      "observe-container --target x,y (or observe-entity) shows slot/name/count stacks; chests do not move items by themselves.",
      "container-transfer --from x,y --to x,y moves every stack through the player inventory; add --item/--count to filter. A full target leaves leftovers in the player inventory.",
      "Chests need inserters (or a logistic network) to load/unload in normal production; the transfer command is for manual organization.",
      "Crash-site spaceship names start with crash-site-spaceship; they are mineable and some are containers with loot.",
      "recover-debris scans that wreckage, extracts loot into the player inventory, then mines each piece; collect the loot before destroying it.",
    ],
    mistakes: [
      "Mining a loot container before extracting its contents.",
      "Expecting a chest to feed a machine without an inserter.",
      "Transferring into a full chest and losing track of leftovers in the player inventory.",
    ],
    references: ["https://wiki.factorio.com/Container"],
  },
  {
    id: "blueprints",
    title: "Blueprints",
    aliases: ["blueprint", "copy-paste", "design"],
    summary:
      "Blueprints copy an existing layout as a string; use the registry, dry-run the anchor, then build and apply recipes/settings separately.",
    rules: [
      "Create a blueprint from a known-good layout (copy tool/string) and save it with blueprint-save; list them with blueprint-list.",
      "act-build-blueprint places entities relative to an anchor; use --dry-run first and pass the blueprint's top-left anchor explicitly.",
      "The manager's blueprint builder expands entities/directions/subtypes but does not apply recipes, filters or modules; set those after building.",
      "Do not stamp a blueprint over existing entities; observe the area and clear/choose a free anchor first.",
      "Build large blueprints in sections, then verify connections, power and fluid inputs; a copied layout can still lack local power/inputs.",
      "Rotate/mirror the design on paper/manually; do not assume a blueprint auto-adapts its inserters or fluid connections.",
    ],
    mistakes: [
      "Wrong anchor or no dry-run, causing collisions.",
      "Expecting the blueprint builder to set recipes/filters automatically.",
      "Copying a layout without checking local power/fluid availability.",
    ],
    references: ["https://wiki.factorio.com/Blueprint"],
  },
];

const ALIASES = new Map<string, KnowledgeTopic>();
for (const topic of AGENT_KNOWLEDGE) {
  ALIASES.set(topic.id, topic);
  for (const alias of topic.aliases) ALIASES.set(alias, topic);
}

export function knowledgeTopic(topic: string): KnowledgeTopic | undefined {
  return ALIASES.get(topic.trim().toLowerCase());
}

export function knowledgeCatalog() {
  return {
    schema_version: 1,
    topics: AGENT_KNOWLEDGE,
    count: AGENT_KNOWLEDGE.length,
    usage: "knowledge --topic inserters|pipes|trains|power|chemistry|defense|production|blueprints",
  };
}
