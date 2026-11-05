// Lightweight blueprint payload preview used by the run and recording pages.
// No dependencies: draw one rectangle per entity, colored by rough category.
(function () {
  const COLORS = {
    belt: "#d59b4b",
    inserter: "#c9772e",
    machine: "#4f83a8",
    power: "#5c9b62",
    chest: "#9a744e",
    other: "#6f7d86",
  };
  const SIZES = [
    [/assembling-machine|chemical-plant|oil-refinery|lab|rocket-silo/, 3],
    [/stone-furnace|steel-furnace|electric-furnace|boiler|steam-engine/, 2],
    [/splitter|loader/, 2],
    [/radar|roboport|substation|big-electric-pole/, 2],
  ];
  const NAMES = [
    [/transport-belt|underground-belt|splitter|loader/, "belt"],
    [/inserter/, "inserter"],
    [/assembling|furnace|chemical|refinery|lab|rocket-silo|boiler|steam-engine/, "machine"],
    [/solar|accumulator|electric-pole|substation|power-switch|generator/, "power"],
    [/chest|container|storage-tank/, "chest"],
  ];
  function sizeFor(name) {
    for (const [pattern, size] of SIZES) if (pattern.test(name)) return size;
    return 1;
  }
  function colorFor(name) {
    for (const [pattern, color] of NAMES) if (pattern.test(name)) return COLORS[color];
    return COLORS.other;
  }
  function payloadBlueprint(payload) {
    const root = payload && typeof payload === "object" ? payload : {};
    if (root.blueprint) return root.blueprint;
    const book = root.blueprint_book;
    const first = book && Array.isArray(book.blueprints) ? book.blueprints[0] : undefined;
    return first && first.blueprint ? first.blueprint : null;
  }
  function blueprintPreview(payload, options) {
    const blueprint = payloadBlueprint(payload);
    const entities = blueprint && Array.isArray(blueprint.entities) ? blueprint.entities : [];
    if (!entities.length) return null;
    const limit = Number(options && options.limit) || 4000;
    const shown = entities.slice(0, limit);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const boxes = [];
    for (const entity of shown) {
      const position = entity && entity.position;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      const name = String(entity.name || "entity");
      const size = sizeFor(name);
      const left = position.x - size / 2;
      const top = position.y - size / 2;
      boxes.push({ left, top, size, name, color: colorFor(name) });
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, left + size);
      maxY = Math.max(maxY, top + size);
    }
    if (!boxes.length) return null;
    const padding = 1;
    const width = Math.max(1, maxX - minX + padding * 2);
    const height = Math.max(1, maxY - minY + padding * 2);
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `${minX - padding} ${minY - padding} ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Blueprint preview");
    for (const box of boxes) {
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", String(box.left));
      rect.setAttribute("y", String(box.top));
      rect.setAttribute("width", String(box.size));
      rect.setAttribute("height", String(box.size));
      rect.setAttribute("fill", box.color);
      rect.setAttribute("fill-opacity", "0.72");
      rect.setAttribute("stroke", "#101b20");
      rect.setAttribute("stroke-width", "0.04");
      const title = document.createElementNS(svgNS, "title");
      title.textContent = box.name;
      rect.append(title);
      svg.append(rect);
    }
    const figure = document.createElement("figure");
    figure.className = "blueprint-preview";
    const caption = document.createElement("figcaption");
    caption.textContent = `${boxes.length}${entities.length > shown.length ? ` / ${entities.length}` : ""} entities · ${blueprint.label || "blueprint"}`;
    figure.append(svg, caption);
    return figure;
  }
  globalThis.blueprintPreview = blueprintPreview;
})();
