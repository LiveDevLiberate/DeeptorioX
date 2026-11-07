// Lane-level item flow, JavaScript port of fbp/flow.py. Same rules, same worklist, same
// output shape, so the page can compute it without the extension host. Runs in the browser
// (window.FBPFlow) and in Node (module.exports) so tests can compare it with the Python.
(function (root) {
  const DIRS = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
  const UNKNOWN = "smelted?";
  const REACH = { "underground-belt": 5, "fast-underground-belt": 7, "express-underground-belt": 9, "turbo-underground-belt": 11 };
  const INSERTERS = new Set(["inserter", "fast-inserter", "long-handed-inserter", "bulk-inserter", "stack-inserter", "burner-inserter"]);
  const CRAFTERS = new Set(["assembling-machine-1", "assembling-machine-2", "assembling-machine-3", "chemical-plant", "oil-refinery",
    "centrifuge", "electromagnetic-plant", "foundry", "biochamber", "cryogenic-plant", "recycler"]);
  const FURNACES = new Set(["stone-furnace", "steel-furnace", "electric-furnace"]);
  const CHESTS = new Set(["wooden-chest", "iron-chest", "steel-chest", "passive-provider-chest", "active-provider-chest",
    "storage-chest", "buffer-chest", "requester-chest"]);
  const BUILTIN = {
    "assembling-machine-1": [3, 3], "assembling-machine-2": [3, 3], "assembling-machine-3": [3, 3], "chemical-plant": [3, 3],
    "oil-refinery": [5, 5], "centrifuge": [3, 3], "lab": [3, 3], "beacon": [3, 3], "roboport": [4, 4], "radar": [3, 3],
    "stone-furnace": [2, 2], "steel-furnace": [2, 2], "electric-furnace": [3, 3], "storage-tank": [3, 3], "pumpjack": [3, 3],
    "electric-mining-drill": [3, 3], "big-electric-pole": [2, 2], "substation": [2, 2], "accumulator": [2, 2], "solar-panel": [3, 3],
    "splitter": [2, 1], "fast-splitter": [2, 1], "express-splitter": [2, 1], "turbo-splitter": [2, 1], "train-stop": [2, 2],
  };
  const UNMODELLED = new Set(["legacy-straight-rail", "legacy-curved-rail", "straight-rail", "curved-rail-a", "curved-rail-b",
    "half-diagonal-rail", "cargo-wagon", "locomotive", "fluid-wagon", "artillery-wagon"]);

  const isBelt = (n) => /transport-belt$|underground-belt$|splitter$/.test(n);
  const isUnderground = (n) => n.endsWith("underground-belt");
  const isSplitter = (n) => n.endsWith("splitter");
  function kind(e) {
    const n = e.name;
    if (isBelt(n)) return "belt";
    if (INSERTERS.has(n)) return "inserter";
    if (CRAFTERS.has(n)) return "crafter";
    if (FURNACES.has(n)) return "furnace";
    if (CHESTS.has(n)) return "chest";
    return "other";
  }
  const leftOf = (d) => { const [dx, dy] = DIRS[d & 12] || [0, -1]; return [dy, -dx]; };
  const key = (x, y) => x + "," + y;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];

  function cellsOf(e, footprints) {
    if (UNMODELLED.has(e.name)) return [[Math.floor(e.position.x), Math.floor(e.position.y)]];
    let [w, h] = (footprints && footprints[e.name]) || BUILTIN[e.name] || [1, 1];
    const d = (e.direction || 0) & 12;
    if (d === 4 || d === 12) [w, h] = [h, w];
    const x0 = Math.floor(e.position.x - w / 2), y0 = Math.floor(e.position.y - h / 2);
    const out = [];
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) out.push([x0 + dx, y0 + dy]);
    return out;
  }
  const tileOf = (e) => [Math.floor(e.position.x), Math.floor(e.position.y)];
  function inserterEnds(e) {
    const [dx, dy] = DIRS[(e.direction || 0) & 12];
    const r = e.name === "long-handed-inserter" ? 2 : 1;
    const [x, y] = tileOf(e);
    return [[x + dx * r, y + dy * r], [x - dx * r, y - dy * r]];
  }

  // ---------------------------------------------------------------- game data
  function makeData(gd) {
    const recipes = (gd && gd.recipes) || {};
    const smelt = {};
    for (const r of Object.values(recipes)) {
      if (r.category !== "smelting") continue;
      for (const ing of Object.keys(r.ingredients || {})) { smelt[ing] = smelt[ing] || new Set(); for (const p of Object.keys(r.results || {})) smelt[ing].add(p); }
    }
    const plates = new Set(); for (const s of Object.values(smelt)) for (const p of s) plates.add(p);
    return {
      recipes, smelt, plates,
      products(name) {
        const r = recipes[name]; if (!r) return new Set([name]);
        const fl = new Set(r.fluid_results || []);
        const out = new Set(Object.keys(r.results || {}).filter((k) => !fl.has(k)));
        return out.size || fl.size ? out : new Set([name]);
      },
      ingredients(name) {
        const r = recipes[name]; if (!r) return null;
        const fl = new Set(r.fluid_ingredients || []);
        return Object.keys(r.ingredients || {}).filter((k) => !fl.has(k));
      },
    };
  }

  // ---------------------------------------------------------------- grid + belt graph
  function buildGrid(entities, footprints) {
    const byid = new Map(), tiles = new Map(), cells = new Map();
    for (const e of entities) {
      byid.set(e.entity_number, e);
      const cs = cellsOf(e, footprints); cells.set(e.entity_number, cs);
      for (const c of cs) { const k = key(c[0], c[1]); if (!tiles.has(k)) tiles.set(k, []); tiles.get(k).push(e); }
    }
    const at = (x, y, noInserters) => (tiles.get(key(x, y)) || []).filter((e) => !noInserters || !INSERTERS.has(e.name));
    const beltAt = (x, y) => (tiles.get(key(x, y)) || []).find((e) => isBelt(e.name)) || null;
    return { entities, byid, tiles, cells, at, beltAt, cellsOf: (e) => cells.get(e.entity_number) };
  }

  function ugPair(g, b) {
    const d = (b.direction || 0) & 12, [dx, dy] = DIRS[d];
    const want = b.type === "input" ? "output" : "input", step = b.type === "input" ? 1 : -1;
    const [x, y] = tileOf(b), reach = REACH[b.name] || 5;
    for (let k = 1; k <= reach; k++) {
      for (const f of g.at(x + dx * k * step, y + dy * k * step)) {
        if (f.name === b.name && f.type === want && ((f.direction || 0) & 12) === d) return f;
      }
    }
    return null;
  }
  function outputs(g, b) {
    const d = (b.direction || 0) & 12, [dx, dy] = DIRS[d];
    if (isSplitter(b.name)) return g.cellsOf(b).map((c) => [c[0] + dx, c[1] + dy]);
    const [x, y] = tileOf(b);
    if (isUnderground(b.name) && b.type === "input") { const p = ugPair(g, b); return p ? [tileOf(p)] : []; }
    return [[x + dx, y + dy]];
  }
  // An inserter drops on the FAR lane: the side of the belt away from where it stands. An inserter
  // in line with the belt has no far side; the game puts those on the right. The viewer draws its
  // hover highlight from this, so the picture and the flow can never disagree.
  function dropLane(ins, belt, dropCell) {
    const [ix, iy] = tileOf(ins), lv = leftOf(belt.direction || 0);
    const rel = [Math.sign(ix - dropCell[0]), Math.sign(iy - dropCell[1])];   // long-handed inserters stand 2 tiles away
    if (same(rel, lv)) return "right";
    if (same(rel, [-lv[0], -lv[1]])) return "left";
    return "right";
  }
  const sameAxis = (a, b) => (((a.direction || 0) & 12) % 8) === (((b.direction || 0) & 12) % 8);
  const opposed = (a, b) => ((((a.direction || 0) & 12) + 8) % 16) === ((b.direction || 0) & 12);
  function upstream(g, b) {
    // an underground exit receives through its tunnel and from belts running into its SIDE; the
    // flow's underground filter then keeps only the lane aligned with the open half. Two belts
    // facing each other never connect: head-on into the hood of an entrance, or into the front
    // of any belt, the items just pile up at the end.
    const found = new Map();
    const exit = isUnderground(b.name) && b.type === "output";
    if (exit) { const p = ugPair(g, b); if (p) found.set(p.entity_number, p); }
    for (const [x, y] of g.cellsOf(b)) {
      for (const [dx, dy] of Object.values(DIRS)) {
        const f = g.beltAt(x + dx, y + dy);
        if (!f || f === b) continue;
        if (exit && sameAxis(f, b)) continue;
        if (opposed(f, b)) continue;
        if (outputs(g, f).some((o) => same(o, [x, y]))) found.set(f.entity_number, f);
      }
    }
    return [...found.values()];
  }

  // ---------------------------------------------------------------- flow
  function compute(bp, footprints, gamedata, feeds) {
    const gd = makeData(gamedata);
    const g = buildGrid(bp.entities || [], footprints);
    feeds = feeds || [];

    // static graph
    const beltIn = new Map(), beltOut = new Map(), insPick = new Map(), insDrop = new Map(), pickedBy = new Map(), machineIns = new Map();
    const push2 = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const b of g.entities) {
      if (!isBelt(b.name)) continue;
      for (const cell of g.cellsOf(b)) {
        for (const f of upstream(g, b)) {
          if (outputs(g, f).some((o) => same(o, cell))) {
            push2(beltIn, b.entity_number, [f, cell]);
            if (!beltOut.has(f.entity_number)) beltOut.set(f.entity_number, new Set());
            beltOut.get(f.entity_number).add(b.entity_number);
          }
        }
      }
    }
    for (const ins of g.entities) {
      if (!INSERTERS.has(ins.name)) continue;
      const [pick, drop] = inserterEnds(ins);
      const srcs = g.at(pick[0], pick[1], true), tgts = g.at(drop[0], drop[1], true);
      insPick.set(ins.entity_number, srcs); insDrop.set(ins.entity_number, tgts.map((t) => [t, drop]));
      for (const s of srcs) push2(pickedBy, s.entity_number, ins);
      for (const t of tgts) { const k = kind(t); if (k === "crafter" || k === "furnace") push2(machineIns, t.entity_number, ins); }
    }

    const lanes = new Map(), machineIn = new Map(), machineOut = new Map(), chest = new Map();
    const lanesOf = (b) => { if (!lanes.has(b.entity_number)) lanes.set(b.entity_number, { left: new Set(), right: new Set() }); return lanes.get(b.entity_number); };
    const union = (a, b) => { let changed = false; for (const x of b) if (!a.has(x)) { a.add(x); changed = true; } return changed; };

    function feederSide(f, bDir, cell) {
      const fd = (f.direction || 0) & 12;
      if (fd === (bDir & 12)) return "behind";
      let fx, fy;
      if (isSplitter(f.name)) {
        const [dx, dy] = DIRS[fd];
        const c = g.cellsOf(f).find((c) => same([c[0] + dx, c[1] + dy], cell)) || g.cellsOf(f)[0];
        [fx, fy] = c;
      } else [fx, fy] = tileOf(f);
      const lv = leftOf(bDir);
      return (fx - cell[0] === lv[0] && fy - cell[1] === lv[1]) ? "left" : "right";
    }
    function splitterSides(s) {
      const lv = leftOf(s.direction || 0);
      return g.cellsOf(s).slice().sort((a, b) => (b[0] * lv[0] + b[1] * lv[1]) - (a[0] * lv[0] + a[1] * lv[1]));
    }
    function outLanes(f, cell) {
      const FL = lanesOf(f);
      if (!isSplitter(f.name)) return FL;
      const flt = f.filter && f.filter.name, prio = f.output_priority;
      if (!flt || (prio !== "left" && prio !== "right")) return FL;
      const [leftCell] = splitterSides(f), [dx, dy] = DIRS[(f.direction || 0) & 12];
      const outSide = same([leftCell[0] + dx, leftCell[1] + dy], cell) ? "left" : "right";
      const keep = outSide === prio ? (s) => new Set([...s].filter((i) => i === flt)) : (s) => new Set([...s].filter((i) => i !== flt));
      return { left: keep(FL.left), right: keep(FL.right) };
    }
    function undergroundFilter(f, u, FL) {
      const fwd = DIRS[(u.direction || 0) & 12], back = [-fwd[0], -fwd[1]];
      const open = u.type === "input" ? back : fwd;
      return same(leftOf(f.direction || 0), open) ? FL.left : FL.right;
    }
    function sourceItems(sources) {
      const items = new Set();
      for (const s of sources) {
        const k = kind(s);
        if (k === "belt") { const L = lanesOf(s); for (const i of L.left) items.add(i); for (const i of L.right) items.add(i); }
        else if (k === "crafter" || k === "furnace") for (const i of machineOut.get(s.entity_number) || []) items.add(i);
        else if (k === "chest") {
          for (const i of chest.get(s.entity_number) || []) items.add(i);
          for (const sec of (s.request_filters || {}).sections || []) for (const f of sec.filters || []) if (f.name) items.add(f.name);
        }
      }
      return items;
    }

    let resolved = new Set();
    function runOnce() {
      lanes.clear(); machineIn.clear(); machineOut.clear(); chest.clear();
      const work = [], queued = new Set();
      const push = (id) => { if (!queued.has(id)) { queued.add(id); work.push(id); } };
      const addLane = (b, lane, items) => {
        if (union(lanesOf(b)[lane], items)) {
          for (const d of beltOut.get(b.entity_number) || []) push(d);
          for (const ins of pickedBy.get(b.entity_number) || []) push(ins.entity_number);
        }
      };
      for (const f of feeds) {
        const b = g.beltAt(Math.floor(f.x), Math.floor(f.y)); if (!b) continue;
        for (const lane of (f.lane || "both") === "both" ? ["left", "right"] : [f.lane]) addLane(b, lane, new Set(f.items || []));
      }
      for (const m of g.entities) { const k = kind(m); if (k === "crafter" || k === "furnace") push(m.entity_number); }
      let head = 0;
      while (head < work.length) {
        const eid = work[head++]; queued.delete(eid);
        const e = g.byid.get(eid); if (!e) continue;
        const k = kind(e);
        if (k === "belt") {
          const d = e.direction || 0;
          for (const cell of g.cellsOf(e)) {
            const feeders = (beltIn.get(eid) || []).filter(([f, c]) => same(c, cell)).map(([f]) => f);
            if (!feeders.length) continue;
            const behind = feeders.filter((f) => feederSide(f, d, cell) === "behind");
            const sides = feeders.filter((f) => !behind.includes(f));
            const curve = !behind.length && sides.length === 1 && !isUnderground(e.name) && !isSplitter(e.name);
            for (const f of behind) { const FL = outLanes(f, cell); addLane(e, "left", FL.left); addLane(e, "right", FL.right); }
            for (const f of sides) {
              const FL = outLanes(f, cell);
              if (curve) { addLane(e, "left", FL.left); addLane(e, "right", FL.right); }
              else {
                const incoming = isUnderground(e.name) ? undergroundFilter(f, e, FL) : new Set([...FL.left, ...FL.right]);
                addLane(e, feederSide(f, d, cell), incoming);
              }
            }
          }
        } else if (k === "inserter") {
          const items = sourceItems(insPick.get(eid) || []); if (!items.size) continue;
          for (const [t, drop] of insDrop.get(eid) || []) {
            const tk = kind(t);
            if (tk === "belt") addLane(t, dropLane(e, t, drop), items);
            else if (tk === "chest") {
              if (!chest.has(t.entity_number)) chest.set(t.entity_number, new Set());
              if (union(chest.get(t.entity_number), items)) for (const ins of pickedBy.get(t.entity_number) || []) push(ins.entity_number);
            } else if (tk === "crafter" || tk === "furnace") push(t.entity_number);
          }
        } else if (k === "crafter" || k === "furnace") {
          if (!machineIn.has(eid)) machineIn.set(eid, new Set());
          const mi = machineIn.get(eid);
          for (const ins of machineIns.get(eid) || []) union(mi, sourceItems(insPick.get(ins.entity_number) || []));
          let out;
          if (k === "crafter") out = e.recipe ? gd.products(e.recipe) : new Set();
          else {
            out = new Set();
            for (const i of mi) for (const p of gd.smelt[i] || []) out.add(p);
            if (!out.size && !resolved.has(eid)) out = new Set([UNKNOWN]);
          }
          if (!machineOut.has(eid)) machineOut.set(eid, new Set());
          if (union(machineOut.get(eid), out)) for (const ins of pickedBy.get(eid) || []) push(ins.entity_number);
        }
      }
    }
    for (let pass = 0; pass < 6; pass++) {
      runOnce();
      const now = new Set();
      for (const [eid, mi] of machineIn) { const e = g.byid.get(eid); if (kind(e) === "furnace" && [...mi].some((i) => gd.smelt[i])) now.add(eid); }
      if ([...now].every((x) => resolved.has(x))) break;
      for (const x of now) resolved.add(x);
    }

    function status(m) {
      const k = kind(m), mi = machineIn.get(m.entity_number) || new Set();
      if (k === "furnace") {
        const known = [...mi].filter((i) => i !== UNKNOWN);
        if (known.length) return known.some((i) => gd.smelt[i]) ? ["ok", []] : ["missing", known.sort()];
        return ["unknown", []];
      }
      if (!m.recipe) return ["none", []];
      const needs = gd.ingredients(m.recipe); if (needs === null) return ["unknown", []];
      const missing = needs.filter((i) => !mi.has(i));
      if (!missing.length) return ["ok", []];
      if (mi.has(UNKNOWN) && missing.every((i) => gd.plates.has(i))) return ["unknown", missing];
      return ["missing", missing];
    }

    const out = { lanes: {}, machines: {}, chests: {}, feeds, items: [] };
    const seen = new Set();
    for (const [id, L] of lanes) {
      if (!L.left.size && !L.right.size) continue;
      out.lanes[id] = { left: [...L.left].sort(), right: [...L.right].sort() };
      for (const i of L.left) seen.add(i); for (const i of L.right) seen.add(i);
    }
    for (const m of g.entities) {
      const k = kind(m); if (k !== "crafter" && k !== "furnace") continue;
      const [st, missing] = status(m);
      out.machines[m.entity_number] = { in: [...(machineIn.get(m.entity_number) || [])].sort(), out: [...(machineOut.get(m.entity_number) || [])].sort(), status: st, missing };
    }
    for (const [id, c] of chest) out.chests[id] = [...c].sort();
    out.items = [...seen].sort();
    return out;
  }

  const api = { compute, cellsOf, kind, dropLane, UNKNOWN };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FBPFlow = api;
})(typeof window !== "undefined" ? window : globalThis);
