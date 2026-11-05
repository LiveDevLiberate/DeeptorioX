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
    summary: "A belt carries items in one direction only.",
    flow: {
      input: "Items enter from the side/back and move toward the facing direction.",
      output: "Items leave at the far end; the same belt cannot emit from both ends.",
    },
    placement: "Direction 0=north, 4=east, 8=south, 12=west. Adjacent belts must face the same flow.",
    rules: [
      "One belt segment has one direction; it cannot output products in two opposite directions.",
      "To cross two belts, use an underground-belt pair or a splitter; a surface crossing does not create a bidirectional junction.",
      "Side-loading a belt merges items from one perpendicular belt; both lanes still share the belt's single flow direction.",
      "To split flow use a splitter; to merge two inputs use side-loading or a splitter's two inputs.",
    ],
    common_mistakes: [
      "Building a cross and expecting the two belts to exchange output in both directions.",
      "Reversing one tile in a belt run: the reversed tile blocks the flow instead of making a reverse lane.",
    ],
    examples: ["Place a splitter upstream when one input must feed two downstream belts."],
  },
  splitter: {
    summary: "A splitter takes one input side and distributes it to its two forward outputs.",
    flow: {
      input: "The rear/input side.",
      output:
        "The two front/left-right output sides; output direction follows the splitter's facing direction.",
    },
    placement:
      "The splitter's input is opposite its facing direction. Filter/priority settings are per output.",
    rules: [
      "A splitter is not a bidirectional crossing: it has one input direction and two output directions.",
      "Use filters to send one item type to a specific output, or priority to favor one output.",
      "For a belt crossing, underground belts are usually simpler than chaining splitters.",
    ],
    common_mistakes: [
      "Expecting the two inputs to act as independent inputs in both directions.",
      "Rotating only one splitter in a chain; every splitter must face the intended flow.",
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
  loader: {
    summary: "A loader transfers items between a belt/container and an adjacent inventory in one direction.",
    rules: [
      "Loaders are directional; input and output sides are fixed by rotation.",
      "They are not a two-way crossing; use two loaders or a proper belt layout for bidirectional transport.",
    ],
    common_mistakes: ["Treating a loader as a bidirectional belt."],
  },
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
