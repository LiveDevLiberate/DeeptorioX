// Canvas viewer and patch editor for one Factorio blueprint.
//
// The page never modifies the blueprint itself. Edits accumulate as a patch
// (remove / recipe / add) exactly in the format fbp/patch.py accepts; export
// hands that patch to the Python tool, which validates, applies, renumbers and
// diffs. Rotations and moves are expressed as remove + add of a clone.
(function () {
  const inVsCode = typeof acquireVsCodeApi === "function";
  const hostApi = inVsCode ? acquireVsCodeApi() : null;
  const vscode = {
    postMessage(m) {
      if (m.type === "status") toast(m.text);
      if (hostApi) { hostApi.postMessage(m); return; }
      if (m.type === "copy" && navigator.clipboard) navigator.clipboard.writeText(m.text);
      if (m.type === "open") document.getElementById("filepick").click();
      if (m.type === "export") download("patch.json", JSON.stringify(m.patch, null, 2));
      if (m.type === "feeds") {
        // no Python behind a standalone page: keep the feeds in this browser and offer one explicit download
        try { localStorage.setItem(feedsKey(), JSON.stringify(m.feeds)); } catch (e) { /* storage may be unavailable */ }
      }
    },
  };
  // Flow progress: the host reports when it starts and finishes; if nothing comes back the most
  // likely cause is an extension host that has not been reloaded since the code changed.
  let flowTimer = null, flowTick = null, flowWaitStart = 0;
  function setFlowStatus(text, error) {
    const el = document.getElementById("flowstatus");
    el.textContent = text; el.style.color = error ? "#ff6b6b" : "";
  }
  function flowWaiting(on) {
    clearTimeout(flowTimer); clearInterval(flowTick); flowTimer = flowTick = null;
    if (!on) return;
    flowWaitStart = Date.now();
    flowTick = setInterval(() => setFlowStatus("recomputing flow… " + Math.round((Date.now() - flowWaitStart) / 1000) + "s"), 500);
    flowTimer = setTimeout(() => {
      clearInterval(flowTick);
      setFlowStatus("no answer from the extension host after 15 s. Run \"Developer: Reload Window\" so the current extension code loads, then re-tick a feed. Check the fbp output channel for errors.", true);
    }, 15000);
  }
  const $ = (id) => document.getElementById(id);
  let toastTimer = null;
  function toast(text) {
    const el = document.getElementById("toast"); if (!el) return;
    if (!text) { el.hidden = true; return; }
    el.textContent = text; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }
  function feedsKey() { return "fbp.feeds." + ((bp && bp.label) || fileName || "untitled"); }
  if (!inVsCode) { $("standalone").hidden = false; document.body.classList.add("standalone"); }
  const canvas = $("map"), ctx = canvas.getContext("2d");
  const tip = $("tip"), detail = $("detail"), coords = $("coords");

  // ---------------------------------------------------------------- data tables
  const BUILTIN = {
    "assembling-machine-1": [3, 3], "assembling-machine-2": [3, 3], "assembling-machine-3": [3, 3],
    "chemical-plant": [3, 3], "oil-refinery": [5, 5], "lab": [3, 3], "roboport": [4, 4], "radar": [3, 3],
    "stone-furnace": [2, 2], "steel-furnace": [2, 2], "electric-furnace": [3, 3], "storage-tank": [3, 3],
    "big-electric-pole": [2, 2], "substation": [2, 2], "splitter": [2, 1], "fast-splitter": [2, 1],
    "express-splitter": [2, 1], "turbo-splitter": [2, 1], "pumpjack": [3, 3], "train-stop": [2, 2],
  };
  const UNMODELLED = new Set(["legacy-straight-rail", "legacy-curved-rail", "straight-rail", "curved-rail-a",
    "curved-rail-b", "half-diagonal-rail", "cargo-wagon", "locomotive", "fluid-wagon", "artillery-wagon"]);
  const DIRS = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
  const DIRNAME = { 0: "N", 4: "E", 8: "S", 12: "W" };
  // hover highlight for an inserter's two ends: where it takes from, where it puts.
  const PICKUP_COL = "#35c8ff", DROP_COL = "#3ee06a";

  const TIER = {
    basic: { belt: "#c9a227", ug: "#7d6416", split: "#e6c352", reach: 5, label: "yellow" },
    fast: { belt: "#d24a3a", ug: "#7f2a20", split: "#e8746a", reach: 7, label: "red" },
    express: { belt: "#3b7fd6", ug: "#224b82", split: "#6ea3e6", reach: 9, label: "blue" },
    turbo: { belt: "#3fbf6b", ug: "#24703f", split: "#78d69a", reach: 11, label: "green" },
  };
  // #rrggbb scaled toward black; belts become a dark track so their bright chevrons read as motion
  // the way the game's belts do, and so the item icons on a lane have something to sit against.
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }
  function tierOf(name) {
    if (name.startsWith("fast-")) return "fast";
    if (name.startsWith("express-")) return "express";
    if (name.startsWith("turbo-")) return "turbo";
    return "basic";
  }
  const KINDS = [
    ["belt", /-transport-belt$|^transport-belt$/, "#c9a227"],
    ["underground", /underground-belt$/, "#7d6416"],
    ["splitter", /splitter$/, "#e6c352"],
    // inserters in their in-game colours: yellow basic, red long-handed, blue fast, green bulk, white stack, grey burner
    ["long inserter", /^long-handed-inserter$/, "#d9503c"],
    ["fast inserter", /^fast-inserter$/, "#3d8be6"],
    ["bulk inserter", /^bulk-inserter$/, "#3fbf6b"],
    ["stack inserter", /^stack-inserter$/, "#e8e8e8"],
    ["burner inserter", /^burner-inserter$/, "#8a8a8a"],
    ["inserter", /inserter$/, "#e0c341"],
    ["crafter", /^assembling-machine|^chemical-plant$|^oil-refinery$|^centrifuge$|^foundry$|^electromagnetic-plant$|^biochamber$|^cryogenic-plant$|^recycler$/, "#5fae6a"],
    ["furnace", /furnace$/, "#c96a3f"],
    ["lab", /^lab$/, "#d66aa8"],
    ["chest", /chest$/, "#a57fd0"],
    ["pole", /electric-pole$|^substation$/, "#ececec"],
    ["pipe", /^pipe|^pump$|^storage-tank$|^offshore-pump$/, "#3fa9a3"],
    ["lamp", /^small-lamp$/, "#f6ec9a"],
    ["combinator", /combinator$|^power-switch$|^programmable-speaker$/, "#d95050"],
    ["roboport", /^roboport$|^radar$/, "#7f8fa6"],
    ["rail", /rail|wagon|locomotive|signal|train-stop/, "#9a9a9a"],
    ["other", /.*/, "#6e6e6e"],
  ];
  function kindOf(name) {
    for (const k of KINDS) {
      if (!k[1].test(name)) continue;
      if (k[0] === "belt" || k[0] === "underground" || k[0] === "splitter") {
        const t = TIER[tierOf(name)];
        return [k[0], k[1], k[0] === "belt" ? t.belt : k[0] === "underground" ? t.ug : t.split];
      }
      return k;
    }
    return KINDS[KINDS.length - 1];
  }
  // Things one places by hand when patching a mall. Machines get a recipe from the side panel.
  const PALETTE = [
    "transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt",
    "underground-belt", "fast-underground-belt", "express-underground-belt", "turbo-underground-belt",
    "splitter", "fast-splitter", "express-splitter", "turbo-splitter",
    "inserter", "fast-inserter", "long-handed-inserter", "bulk-inserter",
    "wooden-chest", "iron-chest", "steel-chest", "passive-provider-chest", "requester-chest",
    "small-electric-pole", "medium-electric-pole", "big-electric-pole", "substation",
    "assembling-machine-1", "assembling-machine-2", "assembling-machine-3", "stone-furnace", "steel-furnace",
    "electric-furnace", "chemical-plant", "pipe", "pipe-to-ground", "pump", "storage-tank", "small-lamp",
  ];
  const DIRECTIONAL = /belt$|splitter$|inserter$|^pipe-to-ground$|^pump$|^boiler$|^steam-engine$|^offshore-pump$|^train-stop$|^rail-/;

  // ---------------------------------------------------------------- state
  let bp = null, base = [], footprints = {}, recipeList = [], fileName = "";
  let ents = [], tiles = new Map(), bbox = [0, 0, 1, 1];
  let scale = 12, ox = 0, oy = 0;
  let hover = null, pinned = null, highlight = "";
  let showWires = false, showLabels = true, showGrid = false, showTunnels = true;
  let editMode = false, nextTemp = -1;
  // flow: lane contents and machine status computed by `fbp flow` on the host; feeds are user-declared inputs
  let flowData = null, showFlow = false, feedMode = false, itemList = [], feeds = [];
  // Icon atlas state lives with the rest of the state: `let` is in the temporal dead zone until the
  // declaration runs, and the toolbar wiring below reads iconMap while the script is still starting.
  let iconMap = (typeof window !== "undefined" && window.FBP_ICONS) || null;
  let iconAtlas = null, iconUrl = null, showIcons = true;
  const ITEM_COLORS = {
    "iron-ore": "#7a8aa0", "copper-ore": "#c46a3a", "stone": "#9c9080", "coal": "#2b2b2b", "iron-plate": "#b9c4d2",
    "copper-plate": "#e0803f", "steel-plate": "#8e97a6", "stone-brick": "#b08a6a", "iron-gear-wheel": "#a9b6c6",
    "copper-cable": "#f0a45c", "electronic-circuit": "#3fbf6b", "advanced-circuit": "#e04b4b", "processing-unit": "#4f7be6",
    "iron-stick": "#c9d3df", "pipe": "#7fb3b0", "engine-unit": "#b27a4a", "electric-engine-unit": "#6aa0d6",
    "plastic-bar": "#e9e2f0", "sulfur": "#e6d63a", "battery": "#4a6ea0", "flying-robot-frame": "#c0c8d4",
    "automation-science-pack": "#e04b4b", "logistic-science-pack": "#3fbf6b", "military-science-pack": "#9a9a9a",
    "chemical-science-pack": "#4fa9e6", "production-science-pack": "#9b59d6", "utility-science-pack": "#e6c94f",
    "smelted?": "#666666",
  };
  function itemColor(name) {
    if (ITEM_COLORS[name]) return ITEM_COLORS[name];
    let hsh = 0; for (let i = 0; i < name.length; i++) hsh = (hsh * 31 + name.charCodeAt(i)) >>> 0;
    return "hsl(" + (hsh % 360) + ",55%,55%)";
  }
  // edits: base entity number -> action. remove: true; recipe: string; replace: clone entity (rotation/move).
  const edits = { remove: new Set(), recipe: new Map(), replace: new Map(), add: [], history: [] };

  // ---------------------------------------------------------------- geometry
  function cellsOf(e) {
    if (UNMODELLED.has(e.name)) return [[Math.floor(e.position.x), Math.floor(e.position.y)]];
    let [w, h] = footprints[e.name] || BUILTIN[e.name] || [1, 1];
    const d = (e.direction || 0) & 12;
    if (d === 4 || d === 12) [w, h] = [h, w];
    const x0 = Math.floor(e.position.x - w / 2), y0 = Math.floor(e.position.y - h / 2);
    const out = [];
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) out.push([x0 + dx, y0 + dy]);
    return out;
  }
  function sizeOf(name, dir) {
    let [w, h] = footprints[name] || BUILTIN[name] || [1, 1];
    if ((dir & 12) === 4 || (dir & 12) === 12) [w, h] = [h, w];
    return [w, h];
  }
  // Centre position for an entity whose top-left tile is (tx, ty).
  function centreFor(name, dir, tx, ty) {
    const [w, h] = sizeOf(name, dir);
    return { x: tx + w / 2, y: ty + h / 2 };
  }
  function ugPair(r) {
    const e = r.e, d = (e.direction || 0) & 12, v = DIRS[d] || [0, -1];
    const want = e.type === "input" ? "output" : "input", step = e.type === "input" ? 1 : -1;
    const [x, y] = r.cells[0], reach = TIER[tierOf(e.name)].reach;
    for (let k = 1; k <= reach; k++) {
      const list = tiles.get((x + v[0] * k * step) + "," + (y + v[1] * k * step)) || [];
      for (const q of list) if (!q.removed && q.e.name === e.name && q.e.type === want && ((q.e.direction || 0) & 12) === d) return { pair: q, gap: k - 1 };
    }
    return null;
  }

  // ---------------------------------------------------------------- build view from base + edits
  function rebuild(keepView) {
    ents = [];
    for (const e of base) {
      const id = e.entity_number;
      if (edits.replace.has(id)) {
        ents.push({ e: edits.replace.get(id), cells: cellsOf(edits.replace.get(id)), kind: kindOf(e.name), changed: true, baseId: id });
        continue;
      }
      let shown = e;
      if (edits.recipe.has(id)) shown = Object.assign({}, e, { recipe: edits.recipe.get(id) });
      ents.push({ e: shown, cells: cellsOf(shown), kind: kindOf(e.name), removed: edits.remove.has(id),
        changed: edits.recipe.has(id), baseId: id });
    }
    for (const a of edits.add) ents.push({ e: a, cells: cellsOf(a), kind: kindOf(a.name), added: true, baseId: null });
    let temp = -1;
    for (const r of ents) r.flowId = r.baseId !== null ? r.baseId : temp--;
    tiles = new Map();
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const r of ents) for (const [x, y] of r.cells) {
      const k = x + "," + y;
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k).push(r);
      if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
    }
    bbox = ents.length ? [minx, miny, maxx, maxy] : [0, 0, 1, 1];
    const n = edits.remove.size + edits.recipe.size + edits.replace.size + edits.add.length;
    $("patchcount").textContent = n ? n + " edit" + (n === 1 ? "" : "s") : "";
    $("file").textContent = (bp.label || fileName || "") + "  ·  " + base.length + " entities";
    renderChanges();
    if (!keepView) fit();
    draw();
  }

  // The change list: one row per edit with its own revert button, so a single mistake can be
  // taken back without unwinding everything after it.
  function renderChanges() {
    const el = $("changes"); el.innerHTML = "";
    const byId = new Map(base.map((e) => [e.entity_number, e]));
    const row = (text, revert, focus) => {
      const div = document.createElement("div"); div.className = "change";
      const b = document.createElement("button"); b.textContent = "×"; b.title = "revert this edit"; b.onclick = revert;
      const span = document.createElement("span"); span.textContent = text; span.title = "click to select";
      span.onclick = focus;
      div.appendChild(b); div.appendChild(span); el.appendChild(div);
    };
    const pin = (pred) => () => { pinned = ents.find(pred) || null; showDetail(pinned); draw(); };
    for (const id of [...edits.remove].sort((a, b) => a - b)) {
      const e = byId.get(id);
      row("remove " + (e ? e.name : "#" + id) + " #" + id, () => act({ kind: "revert", what: "remove", id }), pin((r) => r.baseId === id));
    }
    for (const [id, rec] of edits.recipe) {
      const e = byId.get(id);
      row("recipe #" + id + " " + (e && e.recipe ? e.recipe + " → " : "") + rec, () => act({ kind: "revert", what: "recipe", id }), pin((r) => r.baseId === id));
    }
    for (const [id, rep] of edits.replace) {
      row((rep.type && byId.get(id) && rep.type !== byId.get(id).type ? "flip " : "rotate ") + rep.name + " #" + id + " → " + (DIRNAME[(rep.direction || 0) & 12] || rep.direction) + (rep.recipe && byId.get(id) && rep.recipe !== byId.get(id).recipe ? ", " + rep.recipe : ""),
          () => act({ kind: "revert", what: "replace", id }), pin((r) => r.baseId === id));
    }
    edits.add.forEach((a, index) => {
      row("add " + a.name + (a.recipe ? " [" + a.recipe + "]" : "") + " @ (" + a.position.x + ", " + a.position.y + ")" + (a.direction !== undefined ? " " + DIRNAME[a.direction & 12] : ""),
          () => act({ kind: "revert", what: "add", index }), pin((r) => r.e === a));
    });
    $("changeshead").hidden = !el.childElementCount;
  }

  function load(msg) {
    const GD = (typeof window !== "undefined" && window.FBP_GAMEDATA) || null;   // shipped with the page for standalone use
    bp = msg.bp; fileName = msg.file || "";
    footprints = msg.footprints && Object.keys(msg.footprints).length ? msg.footprints : (GD ? GD.footprints : {});
    recipeList = msg.recipes && msg.recipes.length ? msg.recipes : (GD ? Object.keys(GD.recipes).sort() : []);
    if (msg.items && msg.items.length) itemList = msg.items;
    else if (GD) { const st = new Set(); for (const r of Object.values(GD.recipes)) { Object.keys(r.ingredients || {}).forEach((k) => st.add(k)); Object.keys(r.results || {}).forEach((k) => st.add(k)); } itemList = [...st].sort(); }
    gamedataForFlow = GD || { recipes: {} };
    // A recipe with no category is "crafting" in Factorio; a machine lists the categories it accepts.
    recipeCategory = {}; craftCategories = (GD && GD.crafting_categories) || {};
    if (GD) for (const [name, r] of Object.entries(GD.recipes)) recipeCategory[name] = r.category || "crafting";
    flowData = null; feeds = [];
    base = bp.entities || [];
    edits.remove.clear(); edits.recipe.clear(); edits.replace.clear(); edits.add.length = 0; edits.history.length = 0;
    nextTemp = -1; pinned = null; hover = null;
    fillItemOptions();
    if (!inVsCode) {
      try { feeds = JSON.parse(localStorage.getItem(feedsKey()) || "[]"); } catch (e) { feeds = []; }
    }
    legend();
    rebuild(false);          // builds `ents`, which the flow reads
    computeFlowLocally();
    if (inVsCode) flowWaiting(true);   // the host also saves feeds and re-runs the Python; its answer replaces ours
    showDetail(null);
  }

  function fit() {
    const [x0, y0, x1, y1] = bbox;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    scale = Math.max(1, Math.min(canvas.width / (w + 2), canvas.height / (h + 2)));
    ox = (canvas.width - w * scale) / 2 - x0 * scale;
    oy = (canvas.height - h * scale) / 2 - y0 * scale;
  }
  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(r.width)); canvas.height = Math.max(1, Math.floor(r.height));
    draw();
  }
  const px = (x) => ox + x * scale, py = (y) => oy + y * scale;
  function matches(r) {
    if (!highlight) return false;
    return r.e.name.includes(highlight) || (r.e.recipe || "").includes(highlight);
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    ctx.fillStyle = "#1b1b1d"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!bp) return;
    const vx0 = Math.floor(-ox / scale) - 1, vy0 = Math.floor(-oy / scale) - 1;
    const vx1 = Math.ceil((canvas.width - ox) / scale) + 1, vy1 = Math.ceil((canvas.height - oy) / scale) + 1;
    const gap = scale >= 6 ? 1 : 0;
    const deferredLabels = [];   // recipe labels are drawn last so tunnel lines and wires never cover them
    const visible = (r) => r.cells.some(([x, y]) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1);

    if (showGrid && scale >= 8) {
      ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = vx0; x <= vx1; x++) { ctx.moveTo(px(x) + 0.5, 0); ctx.lineTo(px(x) + 0.5, canvas.height); }
      for (let y = vy0; y <= vy1; y++) { ctx.moveTo(0, py(y) + 0.5); ctx.lineTo(canvas.width, py(y) + 0.5); }
      ctx.stroke();
    }

    for (const r of ents) {
      if (!visible(r)) continue;
      const dim = (highlight && !matches(r)) || r.removed;
      ctx.globalAlpha = r.removed ? 0.3 : dim ? 0.25 : 1;
      const beltish = r.kind[0] === "belt" || r.kind[0] === "underground" || r.kind[0] === "splitter";
      // Zoomed out, belts stay bright: they are how you read the shape of a base at a glance.
      // Zoomed in, they become a dark track under bright chevrons, which is how the game draws them
      // and what gives the item icons on each lane something to sit against.
      const track = beltish && scale >= 8;
      ctx.fillStyle = track ? shade(r.kind[2], r.kind[0] === "splitter" ? 0.5 : r.kind[0] === "underground" ? 0.7 : 0.42) : r.kind[2];
      const xs = r.cells.map((c) => c[0]), ys = r.cells.map((c) => c[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 + 1, h = Math.max(...ys) - y0 + 1;
      const bx = px(x0) + gap, by = py(y0) + gap, bw = w * scale - gap * 2, bh = h * scale - gap * 2;
      ctx.fillRect(bx, by, bw, bh);
      if (!beltish && r.cells.length > 1 && scale >= 8 && !r.removed) {
        // a lit top-left edge and a shaded bottom-right one: enough for a machine to read as a body
        // with the icon sitting on it, rather than as a flat patch of colour
        ctx.lineWidth = Math.max(1, scale / 14);
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.beginPath(); ctx.moveTo(bx, by + bh); ctx.lineTo(bx, by); ctx.lineTo(bx + bw, by); ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath(); ctx.moveTo(bx + bw, by); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx, by + bh); ctx.stroke();
      }
      // A crafter shows its recipe; anything else multi-tile shows its own icon, so a radar, a
      // roboport or a tank is recognisable and not just a coloured square. Only the machines fall
      // back to text, which is what they did before there were icons.
      const named = r.e.recipe || r.kind[0] === "furnace" || r.kind[0] === "crafter";
      const art = showIcons ? (recipeIcon(r.e.recipe) || (iconCell(r.e.name) ? r.e.name : null)) : null;
      // Belts, undergrounds, splitters and inserters read better as arrows than as icons, and so do
      // the two directional pipe pieces; everything else — chests, poles, lamps, pipes, combinators
      // — gets its icon once the tiles are big enough to see it. A splitter shows its filter item
      // instead of a generic splitter icon, which is the part its shape does not tell you.
      const arrowed = r.kind[0] === "belt" || r.kind[0] === "underground" || r.kind[0] === "splitter" ||
        r.kind[0].endsWith("inserter") || r.e.name === "pipe-to-ground" || r.e.name === "pump";
      const smallIcon = !!art && !arrowed && r.cells.length === 1 && showLabels && scale >= 12;
      if (smallIcon) {
        const alpha = ctx.globalAlpha;
        deferredLabels.push(() => {
          ctx.globalAlpha = alpha;
          const side = scale * 0.74;
          drawIcon(art, px(x0) + (scale - side) / 2, py(y0) + (scale - side) / 2, side);
          ctx.globalAlpha = 1;
        });
      }
      if (r.cells.length > 1 && showLabels && scale >= 8 && !arrowed && (named || art)) {
        const alpha = ctx.globalAlpha;
        deferredLabels.push(() => {
          ctx.globalAlpha = alpha;
          const cx = px(x0) + w * scale / 2, cy = py(y0) + h * scale / 2;
          if (art) {
            const side = Math.min(w, h) * scale * 0.62;
            drawIcon(art, cx - side / 2, cy - side / 2, side);
          } else if (named) {
            ctx.fillStyle = "rgba(0,0,0,0.8)";
            const fs = Math.max(8, Math.min(12, scale * 0.9));
            ctx.font = fs + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            wrapText((r.e.recipe || r.e.name).replace(/-/g, " "), cx, cy, w * scale - 4, fs);
          }
          ctx.globalAlpha = 1;
        });
      }
      if (scale >= 5 && !r.removed && !smallIcon) decorate(r);
      ctx.globalAlpha = 1;
      if (r.removed) {   // red X
        ctx.strokeStyle = "#ff3b3b"; ctx.lineWidth = Math.max(1, scale / 8); ctx.beginPath();
        ctx.moveTo(px(x0) + 2, py(y0) + 2); ctx.lineTo(px(x0) + w * scale - 2, py(y0) + h * scale - 2);
        ctx.moveTo(px(x0) + w * scale - 2, py(y0) + 2); ctx.lineTo(px(x0) + 2, py(y0) + h * scale - 2); ctx.stroke();
      } else if (r.added) { ctx.strokeStyle = "#39d353"; ctx.lineWidth = 2; outline(r); }
      else if (r.changed) { ctx.strokeStyle = "#ff9f1c"; ctx.lineWidth = 2; outline(r); }
      if (matches(r)) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; outline(r); }
    }

    if (showFlow && flowData && scale >= 5) {
      // Each lane is a stripe on its side of the belt (left of travel = left lane). Several items on a
      // lane are shown as bands along the stripe. Unknown furnace output is grey.
      for (const r of ents) {
        if (r.kind[0] !== "belt" && r.kind[0] !== "underground" && r.kind[0] !== "splitter") continue;
        if (r.removed || !visible(r)) continue;
        const L = flowData.lanes[String(r.flowId)]; if (!L) continue;
        const d = (r.e.direction || 0) & 12, v = DIRS[d] || [0, -1], lv = [v[1], -v[0]];
        for (const [x, y] of r.cells) {
          for (const [lane, sign] of [["left", 1], ["right", -1]]) {
            const items = L[lane]; if (!items || !items.length) continue;
            const cx = px(x) + scale / 2 + lv[0] * sign * scale * 0.25, cy = py(y) + scale / 2 + lv[1] * sign * scale * 0.25;
            const along = scale * 0.8, across = Math.max(2, scale * 0.3);
            const n = Math.min(items.length, 4), seg = along / n;
            if (showIcons && iconAtlas && scale >= 11 && n <= 2) {
              // one small icon per item on the lane, drawn on its side of the belt
              const side = Math.min(scale * 0.42, along / n - 1);
              for (let i = 0; i < n; i++) {
                if (flowHighlight && items[i] !== flowHighlight) continue;
                const off = -along / 2 + seg * i + seg / 2;
                const ix = v[0] === 0 ? cx : cx + off, iy = v[0] === 0 ? cy + off : cy;
                if (!drawIcon(items[i], ix - side / 2, iy - side / 2, side)) {
                  ctx.fillStyle = itemColor(items[i]);
                  ctx.fillRect(ix - across / 2, iy - across / 2, across, across);
                }
              }
              continue;
            }
            for (let i = 0; i < n; i++) {
              ctx.fillStyle = itemColor(items[i]);
              if (flowHighlight && items[i] !== flowHighlight) ctx.fillStyle = "rgba(0,0,0,0.35)";
              const off = -along / 2 + seg * i;
              if (v[0] === 0) ctx.fillRect(cx - across / 2, cy + off, across, seg - (n > 1 ? 1 : 0));
              else ctx.fillRect(cx + off, cy - across / 2, seg - (n > 1 ? 1 : 0), across);
            }
          }
        }
      }
      for (const r of ents) {
        if ((r.kind[0] !== "crafter" && r.kind[0] !== "furnace") || r.removed || !visible(r)) continue;
        const m = flowData.machines[String(r.flowId)]; if (!m) continue;
        ctx.lineWidth = Math.max(2, scale / 5);
        if (m.status === "ok") ctx.strokeStyle = "#39d353";
        else if (m.status === "missing") ctx.strokeStyle = "#ff3b3b";
        else if (m.status === "unknown") { ctx.strokeStyle = "#9a9a9a"; ctx.setLineDash([4, 4]); }
        else continue;
        outline(r); ctx.setLineDash([]);
        if (m.status === "missing" && scale >= 7 && m.missing.length) {
          // what is missing, written on the machine so the map alone answers the question
          const xs = r.cells.map((c) => c[0]), ys = r.cells.map((c) => c[1]);
          const x0 = Math.min(...xs), y1 = Math.max(...ys) + 1, w = Math.max(...xs) - x0 + 1;
          const fs = Math.max(8, Math.min(11, scale * 0.6));
          ctx.font = "bold " + fs + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          const text = "needs " + m.missing.map((i) => i.replace(/-/g, " ")).join(", ");
          const tw = Math.min(ctx.measureText(text).width + 8, Math.max(w * scale, 60));
          const cx = px(x0) + w * scale / 2, cy = py(y1) - fs * 0.8;
          ctx.fillStyle = "rgba(160,20,20,0.92)"; ctx.fillRect(cx - tw / 2, cy - fs * 0.7, tw, fs * 1.4);
          ctx.fillStyle = "#fff";
          const label = ctx.measureText(text).width + 8 > tw ? text.slice(0, Math.floor(tw / (fs * 0.55))) + "…" : text;
          ctx.fillText(label, cx, cy);
        }
      }
    }
    if (feedMode || (showFlow && feeds.length)) {   // feed markers: a diamond in the item colour
      for (const f of feeds) {
        const cx = px(f.x) + scale / 2, cy = py(f.y) + scale / 2, s = Math.max(4, scale * 0.45);
        ctx.fillStyle = itemColor((f.items || [])[0] || "?"); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    if (showWires && bp.wires) {
      const byId = new Map(ents.filter((r) => r.baseId !== null).map((r) => [r.baseId, r]));
      ctx.lineWidth = Math.max(1, scale / 12);
      for (const [a, ca, b] of bp.wires) {
        const ra = byId.get(a), rb = byId.get(b); if (!ra || !rb) continue;
        ctx.strokeStyle = ca === 5 ? "rgba(255,140,60,0.8)" : ca === 1 ? "rgba(255,70,70,0.8)" : "rgba(70,220,90,0.8)";
        ctx.beginPath(); ctx.moveTo(px(ra.e.position.x), py(ra.e.position.y)); ctx.lineTo(px(rb.e.position.x), py(rb.e.position.y)); ctx.stroke();
      }
    }

    if (showTunnels && scale >= 4) {
      // The tunnel line runs down the middle, tile by tile, and each tile decides its own strength:
      // solid over belts and open ground, faint where it crosses a machine, chest or pole so the
      // icon and the text underneath stay readable. The dash is the tier's light colour over a dark
      // casing — a tunnel usually runs over belts of its own tier, and a yellow dash on a yellow
      // belt cannot be seen at all. Hovering either end draws the whole run solid.
      const lit = pinned || hover;
      for (const r of ents) {
        if (r.kind[0] !== "underground" || r.removed || !visible(r)) continue;
        if (r.e.type === "input") {
          const p = ugPair(r);
          if (p) {
            const [x, y] = r.cells[0], [x2, y2] = p.pair.cells[0];
            const on = lit === r || lit === p.pair;
            const d = (r.e.direction || 0) & 12, v = DIRS[d] || [0, -1];
            const t = TIER[tierOf(r.e.name)];
            const core = Math.max(1.5, scale / (on ? 6 : 9)), dash = Math.max(3, scale * 0.45);
            // a tile the line should tread lightly on: anything that is not belt and not bare ground
            const covers = (tx, ty) => (tiles.get(tx + "," + ty) || []).some((q) => !q.removed && q !== r && q !== p.pair &&
              q.kind[0] !== "belt" && q.kind[0] !== "underground" && q.kind[0] !== "splitter");
            const n = Math.max(Math.abs(x2 - x), Math.abs(y2 - y));
            ctx.setLineDash([dash, dash * 0.75]); ctx.lineCap = "butt";
            for (let k = 0; k <= n; k++) {
              const tx = x + v[0] * k, ty = y + v[1] * k;
              const s0 = k === 0 ? 0 : -0.5, s1 = k === n ? 0 : 0.5;
              if (s0 === s1) continue;
              const cx = px(tx) + scale / 2, cy = py(ty) + scale / 2;
              const ax = cx + v[0] * s0 * scale, ay = cy + v[1] * s0 * scale;
              const bx = cx + v[0] * s1 * scale, by = cy + v[1] * s1 * scale;
              ctx.globalAlpha = on || !covers(tx, ty) ? 0.95 : 0.22;
              ctx.lineDashOffset = (k + s0) * scale;      // keep one dash pattern across the segments
              ctx.strokeStyle = "rgba(12,12,14,0.9)"; ctx.lineWidth = core + Math.max(2, scale * 0.14);
              ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
              ctx.strokeStyle = t.split; ctx.lineWidth = core;
              ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
            }
            ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.globalAlpha = 1;
          }
        }
        if (!ugPair(r)) { ctx.strokeStyle = "#ff3b3b"; ctx.lineWidth = 2; outline(r); }
      }
    }

    for (const f of deferredLabels) f();   // after belts, flow stripes, wires and tunnels

    // placement ghost
    if (editMode && ghost && hoverTile) {
      const occupied = ghost.cells.some(([x, y]) => (tiles.get(x + "," + y) || []).some((q) => !q.removed));
      ctx.globalAlpha = 0.6; ctx.fillStyle = occupied ? "#ff3b3b" : kindOf(ghost.e.name)[2];
      for (const [x, y] of ghost.cells) ctx.fillRect(px(x) + 1, py(y) + 1, scale - 2, scale - 2);
      ctx.globalAlpha = 1;
      if (scale >= 5) decorate(ghost);
    }

    if (showItemLegend) { if (showFlow && flowData) drawItemLegend(); else drawEntityLegend(); }

    const sel = pinned || hover;
    if (sel) {
      ctx.strokeStyle = pinned ? "#ffd166" : "#ffffff"; ctx.lineWidth = 2; outline(sel);
      if (sel.kind[0] === "underground") {
        const e = sel.e, d = (e.direction || 0) & 12, v = DIRS[d] || [0, -1], step = e.type === "input" ? 1 : -1;
        const [x, y] = sel.cells[0], reach = TIER[tierOf(e.name)].reach;
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        for (let k = 1; k <= reach; k++) ctx.fillRect(px(x + v[0] * k * step), py(y + v[1] * k * step), scale, scale);
        const p = ugPair(sel);
        if (p) { ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 2; outline(p.pair); }
      } else if (sel.kind[0].endsWith("inserter")) {
        // `direction` points at the pickup tile; the drop is the same distance the other way. A
        // long-handed inserter reaches two tiles and skips the one between, drawn dashed so the
        // gap it hands over is obvious.
        const d = (sel.e.direction || 0) & 12, v = DIRS[d] || [0, -1];
        const reach = sel.kind[0] === "long inserter" ? 2 : 1;
        const [x, y] = sel.cells[0];
        if (reach === 2) {
          ctx.setLineDash([Math.max(2, scale / 4), Math.max(2, scale / 4)]); ctx.lineWidth = 1.5;
          for (const [s, col] of [[1, PICKUP_COL], [-1, DROP_COL]]) {
            ctx.strokeStyle = col;
            ctx.strokeRect(px(x + v[0] * s) + 2.5, py(y + v[1] * s) + 2.5, scale - 5, scale - 5);
          }
          ctx.setLineDash([]);
        }
        for (const [s, col] of [[1, PICKUP_COL], [-1, DROP_COL]])
          inserterEnd(x + v[0] * reach * s, y + v[1] * reach * s, col, s < 0 ? sel : null);
      }
    }
  }

  // Which lane an inserter lands items on. The rule lives in flow.js so the highlight and the lane
  // stripes can never disagree; +1 is the left lane, -1 the right, as in the stripe drawing above.
  function dropLaneSign(ins, belt, cell) {
    if (typeof FBPFlow === "undefined") return -1;
    return FBPFlow.dropLane(ins.e, belt.e, cell) === "left" ? 1 : -1;
  }
  // One end of a hovered inserter: tint what it reaches and outline whatever stands there, so a
  // 3x3 machine or a chest reads as the target rather than only the tile under the hand. Given
  // `ins` (the drop end), a belt target is tinted on the landing lane only, half a tile wide.
  function inserterEnd(x, y, col, ins) {
    const belt = ins && (tiles.get(x + "," + y) || [])
      .find((q) => !q.removed && (q.kind[0] === "belt" || q.kind[0] === "underground" || q.kind[0] === "splitter"));
    let rx = px(x) + 1, ry = py(y) + 1, rw = scale - 2, rh = scale - 2;
    if (belt) {
      const d = (belt.e.direction || 0) & 12, v = DIRS[d] || [0, -1], lv = [v[1], -v[0]];
      const sgn = dropLaneSign(ins, belt, [x, y]);
      rw = lv[0] ? scale / 2 - 1.5 : scale - 2; rh = lv[1] ? scale / 2 - 1.5 : scale - 2;
      rx = px(x) + scale / 2 + lv[0] * sgn * scale / 4 - rw / 2;
      ry = py(y) + scale / 2 + lv[1] * sgn * scale / 4 - rh / 2;
    }
    ctx.globalAlpha = belt ? 0.42 : 0.3; ctx.fillStyle = col;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, scale / 7);
    ctx.strokeRect(rx, ry, rw, rh);
    const t = (tiles.get(x + "," + y) || []).filter((q) => !q.removed).sort((a, b) => a.cells.length - b.cells.length)[0];
    if (t && t.cells.length > 1) { ctx.lineWidth = 2; outline(t); }
  }

  // On-map legend for item colours: bottom-left, most common items first, one or two columns.
  // Also outlines the machine status colours. Click the legend header (ctrl+L) to hide it.
  let showItemLegend = true;
  function drawItemLegend() {
    const counts = {};
    for (const L of Object.values(flowData.lanes)) for (const i of L.left.concat(L.right)) counts[i] = (counts[i] || 0) + 1;
    const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    if (!names.length) return;
    const rowH = 16, pad = 8, colW = 190, maxRows = 18;
    const cols = names.length > maxRows ? 2 : 1, rows = Math.min(maxRows, Math.ceil(names.length / cols));
    const statusRows = 3, w = pad * 2 + colW * cols, h = pad * 2 + rowH * (rows + statusRows + 1);
    const x0 = 10, y0 = canvas.height - h - 10;
    ctx.fillStyle = "rgba(20,20,22,0.88)"; ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    ctx.font = "12px sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = "#ddd"; ctx.fillText("items on belts  (lane stripe colours)", x0 + pad, y0 + pad + rowH / 2);
    names.slice(0, rows * cols).forEach((n, i) => {
      const c = Math.floor(i / rows), r = i % rows;
      const x = x0 + pad + c * colW, y = y0 + pad + rowH * (r + 1) + rowH / 2;
      ctx.fillStyle = flowHighlight && flowHighlight !== n ? "rgba(120,120,120,0.5)" : itemColor(n);
      ctx.fillRect(x, y - 6, 12, 12);
      ctx.fillStyle = flowHighlight && flowHighlight !== n ? "#888" : "#eee";
      const label = n.replace(/-/g, " ") + (n === "smelted?" ? "  (furnace, ore not declared)" : "");
      ctx.fillText(label.length > 28 ? label.slice(0, 27) + "…" : label, x + 18, y);
    });
    const sy = y0 + pad + rowH * (rows + 1) + rowH / 2;
    const status = [["#39d353", "machine: all inputs arrive"], ["#ff3b3b", "machine: an input is missing"], ["#9a9a9a", "machine: depends on undeclared furnace"]];
    status.forEach(([col, txt], i) => {
      const y = sy + rowH * i;
      ctx.strokeStyle = col; ctx.lineWidth = 2; if (i === 2) ctx.setLineDash([3, 3]);
      ctx.strokeRect(x0 + pad + 1, y - 5, 10, 10); ctx.setLineDash([]);
      ctx.fillStyle = "#eee"; ctx.fillText(txt, x0 + pad + 18, y);
    });
    legendBox = { x0, y0, w, h };
  }
  let legendBox = null;

  // On-map legend when flow is off: what the entity colours mean. Same box, same hide behaviour.
  function drawEntityLegend() {
    const rows = [];
    for (const [name, t] of Object.entries(TIER)) rows.push([t.belt, name + " belt / underground / splitter (" + t.label + "), gap " + (t.reach - 1)]);
    for (const k of KINDS) if (!["other", "belt", "underground", "splitter"].includes(k[0])) rows.push([k[2], k[0]]);
    rows.push(["#39d353", "added by this patch"], ["#ff9f1c", "changed by this patch"], ["#ff3b3b", "removed / unpaired underground"]);
    const rowH = 16, pad = 8, colW = 230, maxRows = 14;
    const cols = rows.length > maxRows ? 2 : 1, nrows = Math.min(maxRows, Math.ceil(rows.length / cols));
    const w = pad * 2 + colW * cols, h = pad * 2 + rowH * (nrows + 4);
    const x0 = 10, y0 = canvas.height - h - 10;
    ctx.fillStyle = "rgba(20,20,22,0.88)"; ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    ctx.font = "12px sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = "#ddd"; ctx.fillText("legend  (turn on flow for item colours)", x0 + pad, y0 + pad + rowH / 2);
    rows.forEach(([col, txt], i) => {
      const c = Math.floor(i / nrows), r = i % nrows;
      const x = x0 + pad + c * colW, y = y0 + pad + rowH * (r + 1) + rowH / 2;
      ctx.fillStyle = col; ctx.fillRect(x, y - 6, 12, 12);
      ctx.fillStyle = "#eee"; ctx.fillText(txt.length > 36 ? txt.slice(0, 35) + "…" : txt, x + 18, y);
    });
    ctx.fillStyle = "#888";
    ctx.fillText("arrows: belt travel · inserter arrow points where the item goes", x0 + pad, y0 + pad + rowH * (nrows + 1) + rowH / 2);
    ctx.fillText("hover an inserter: blue = pickup, green = drop (the lane it lands on)", x0 + pad, y0 + pad + rowH * (nrows + 2) + rowH / 2);
    ctx.fillText("splitter: bar on the priority output, in the filtered item · click header to hide", x0 + pad, y0 + pad + rowH * (nrows + 3) + rowH / 2);
    legendBox = { x0, y0, w, h, entity: true };
  }

  function wrapText(text, cx, cy, maxW, lh) {
    const words = text.split(" "), lines = []; let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    const y0 = cy - (lines.length - 1) * lh / 2;
    lines.forEach((l, i) => ctx.fillText(l, cx, y0 + i * lh));
  }
  function outline(r) {
    const xs = r.cells.map((c) => c[0]), ys = r.cells.map((c) => c[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 + 1, h = Math.max(...ys) - y0 + 1;
    ctx.strokeRect(px(x0) + 1, py(y0) + 1, w * scale - 2, h * scale - 2);
  }
  // A splitter can sort as well as balance, and its shape says none of it: a filter sends one item
  // to one side, a priority makes one side preferred. "left" is left of the way the splitter faces,
  // and the cells are sorted the same way the flow sorts them so the two always name the same side.
  function splitterInfo(r) {
    const e = r.e, prio = e.output_priority, inPrio = e.input_priority;
    const sided = (p) => p === "left" || p === "right";
    if (!sided(prio) && !sided(inPrio)) return null;
    const filter = sided(prio) ? (e.filter && (e.filter.name || e.filter)) || null : null;
    const d = (e.direction || 0) & 12, v = DIRS[d] || [0, -1], lv = [v[1], -v[0]];
    const cells = r.cells.slice().sort((a, b) => (b[0] * lv[0] + b[1] * lv[1]) - (a[0] * lv[0] + a[1] * lv[1]));
    const pick = (side) => (side === "left" ? cells[0] : cells[1]) || cells[0];
    return { v, filter, prio, inPrio, outCell: pick(prio), inCell: pick(inPrio) };
  }
  // A bar across the preferred output edge, in the filtered item's colour when there is a filter, a
  // dimmer one on the preferred input edge, and the filter's own icon on the side it leaves by.
  function splitterMarks(r, sp, icon) {
    const [vx, vy] = sp.v, along = Math.max(2, scale * 0.16), across = scale * 0.78;
    const bar = (cell, sign, colour, alpha) => {
      const cx = px(cell[0]) + scale / 2 + vx * sign * scale * 0.42;
      const cy = py(cell[1]) + scale / 2 + vy * sign * scale * 0.42;
      const w = vx ? along : across, h = vx ? across : along;
      ctx.globalAlpha = alpha; ctx.fillStyle = colour;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.globalAlpha = 1;
    };
    if (sp.prio === "left" || sp.prio === "right") bar(sp.outCell, 1, sp.filter ? itemColor(sp.filter) : "#f2f2f2", 0.95);
    if (sp.inPrio === "left" || sp.inPrio === "right") bar(sp.inCell, -1, "#f2f2f2", 0.55);
    if (!icon) return;
    const side = scale * 0.62, ix = px(sp.outCell[0]) + (scale - side) / 2, iy = py(sp.outCell[1]) + (scale - side) / 2;
    if (!drawIcon(sp.filter, ix, iy, side)) {
      ctx.fillStyle = itemColor(sp.filter);
      ctx.fillRect(ix + side * 0.15, iy + side * 0.15, side * 0.7, side * 0.7);
    }
  }
  // A pair of ">" strokes along the direction of travel, centred on a tile.
  function chevrons(cx, cy, v, colour) {
    const wing = scale * 0.26, nose = scale * 0.16, gap = scale * 0.3;
    ctx.strokeStyle = colour; ctx.lineWidth = Math.max(1.5, scale * 0.085);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const s of [-1, 1]) {
      const ox2 = cx + v[0] * s * gap * 0.5, oy2 = cy + v[1] * s * gap * 0.5;
      ctx.beginPath();
      ctx.moveTo(ox2 - v[0] * nose + v[1] * wing, oy2 - v[1] * nose - v[0] * wing);
      ctx.lineTo(ox2 + v[0] * nose, oy2 + v[1] * nose);
      ctx.lineTo(ox2 - v[0] * nose - v[1] * wing, oy2 - v[1] * nose + v[0] * wing);
      ctx.stroke();
    }
    ctx.lineCap = "butt"; ctx.lineJoin = "miter";
  }
  function decorate(r) {
    const e = r.e, k = r.kind[0];
    const d = (e.direction || 0) & 12, v = DIRS[d] || [0, -1];
    const [tx, ty] = r.cells[0];
    const cx = px(tx) + scale / 2, cy = py(ty) + scale / 2;
    const tri = (x, y) => {
      const s = scale * 0.28;
      ctx.beginPath(); ctx.moveTo(x + v[0] * s, y + v[1] * s);
      ctx.lineTo(x - v[0] * s + v[1] * s, y - v[1] * s - v[0] * s);
      ctx.lineTo(x - v[0] * s - v[1] * s, y - v[1] * s + v[0] * s); ctx.closePath(); ctx.fill();
    };
    if (k === "belt" || k === "underground" || k === "splitter") {
      ctx.fillStyle = k === "underground" ? (e.type === "input" ? "#3a2e08" : "#f5d76e") : "rgba(0,0,0,0.6)";
      const sp = k === "splitter" ? splitterInfo(r) : null;
      const icon = !!(sp && sp.filter && scale >= 10);
      // Two chevrons a tile, pointing the way the belt runs, bright against the dark track: a run of
      // belt reads as one moving line the way it does in the game. An underground keeps its single
      // hood triangle, because light or dark is what tells an entrance from an exit.
      const tier = TIER[tierOf(e.name)];
      const arrows = scale >= 8 && k !== "underground";
      for (const c of (k === "splitter" ? r.cells : [r.cells[0]])) {
        if (icon && c[0] === sp.outCell[0] && c[1] === sp.outCell[1]) continue;   // the filter icon sits here
        const ax = px(c[0]) + scale / 2, ay = py(c[1]) + scale / 2;
        if (arrows) chevrons(ax, ay, v, k === "splitter" ? tier.split : tier.belt);
        else tri(ax, ay);
      }
      if (sp) splitterMarks(r, sp, icon);
    } else if (k.endsWith("inserter")) {
      // arrow in the direction the item travels: from the pickup side (where `direction` points) to the drop side
      // One arrow, tail at the pickup side, head at the drop side. Long-handed: longer shaft, a bar at the tail.
      const long = k === "long inserter";
      const tail = long ? 0.42 : 0.32, headLen = Math.max(2, scale * 0.22), halfW = headLen * 0.42;
      const sx = cx + v[0] * scale * tail, sy = cy + v[1] * scale * tail;                 // pickup end
      const ex = cx - v[0] * scale * (long ? 0.42 : 0.34), ey = cy - v[1] * scale * (long ? 0.42 : 0.34);   // drop tip
      const bx = ex + v[0] * headLen, by = ey + v[1] * headLen;                          // head base
      const ink = "rgba(0,0,0,0.85)";
      ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = Math.max(1.2, scale / 12); ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(bx, by); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex, ey);
      ctx.lineTo(bx + v[1] * halfW, by - v[0] * halfW);
      ctx.lineTo(bx - v[1] * halfW, by + v[0] * halfW); ctx.closePath(); ctx.fill();
      if (long && scale >= 8) {   // tail bar: "reaches over the next tile"
        ctx.beginPath(); ctx.moveTo(sx + v[1] * halfW, sy - v[0] * halfW); ctx.lineTo(sx - v[1] * halfW, sy + v[0] * halfW); ctx.stroke();
      }
      ctx.lineCap = "butt";
    } else if (k === "pole") {
      ctx.fillStyle = "#333"; ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, scale * 0.18), 0, Math.PI * 2); ctx.fill();
    } else if (e.name === "pipe-to-ground" || e.name === "pump") {
      ctx.fillStyle = "rgba(0,0,0,0.6)"; tri(cx, cy);
    }
  }

  function legend() {
    const el = $("legend"); el.innerHTML = "";
    const row = (color, text) => {
      const sw = document.createElement("i"); sw.style.background = color;
      const lab = document.createElement("span"); lab.textContent = text; el.appendChild(sw); el.appendChild(lab);
    };
    for (const [name, t] of Object.entries(TIER)) row(t.belt, name + " belt (" + t.label + "), underground gap " + (t.reach - 1));
    for (const k of KINDS) if (!["other", "belt", "underground", "splitter"].includes(k[0])) row(k[2], k[0]);
    row("#39d353", "added (edit)"); row("#ff9f1c", "recipe or rotation changed (edit)"); row("#ff3b3b", "removed (edit) / unpaired underground");
  }

  // ---------------------------------------------------------------- picking and describing
  function tileAt(mx, my) { return [Math.floor((mx - ox) / scale), Math.floor((my - oy) / scale)]; }
  function entityAt(mx, my) {
    const [x, y] = tileAt(mx, my);
    const list = tiles.get(x + "," + y);
    if (!list) return null;
    return list.slice().sort((a, b) => (a.removed ? 1 : 0) - (b.removed ? 1 : 0) || a.cells.length - b.cells.length)[0];
  }
  function describe(r) {
    const e = r.e, p = e.position, d = e.direction || 0;
    let s = e.name + (r.baseId !== null ? " #" + r.baseId : " (new)") + "  @ (" + p.x + ", " + p.y + ")";
    if (r.removed) s += "\nMARKED FOR REMOVAL";
    if (r.added) s += "\nADDED by this patch";
    if (r.changed && !r.added) s += "\nCHANGED by this patch";
    if (e.recipe) s += "\nrecipe: " + e.recipe;
    if (e.direction !== undefined) s += "\ndirection: " + d + (DIRNAME[d & 12] ? " (" + DIRNAME[d & 12] + ")" : "");
    if (e.type) s += "\ntype: " + e.type + (e.type === "input" ? " (entrance)" : " (exit)");
    if (["belt", "underground", "splitter"].includes(r.kind[0])) s += "\ntier: " + tierOf(e.name) + " (" + TIER[tierOf(e.name)].label + ")";
    if (r.kind[0] === "splitter") {
      const flt = e.filter && (e.filter.name || e.filter);
      if (flt) s += "\nfilter: " + flt + (e.output_priority ? " -> " + e.output_priority + " output" : " (no output priority, so the filter does nothing)");
      if (e.output_priority && !flt) s += "\noutput priority: " + e.output_priority;
      if (e.input_priority) s += "\ninput priority: " + e.input_priority;
    }
    if (r.kind[0] === "underground") {
      const q = ugPair(r);
      s += q ? "\npair: " + (q.pair.baseId !== null ? "#" + q.pair.baseId : "(new)") + " @ (" + q.pair.e.position.x + ", " + q.pair.e.position.y + "), gap " + q.gap + " of max " + (TIER[tierOf(e.name)].reach - 1)
             : "\npair: NONE within reach " + (TIER[tierOf(e.name)].reach - 1);
    }
    if (flowData) {
      const L = flowData.lanes[String(r.flowId)];
      if (L) s += "\nleft lane: " + (L.left.join(", ") || "-") + "\nright lane: " + (L.right.join(", ") || "-");
      const m = flowData.machines[String(r.flowId)];
      if (m) {
        s += "\nflow: " + m.status.toUpperCase() + (m.missing.length ? " missing " + m.missing.join(", ") : "");
        s += "\nreceives: " + (m.in.join(", ") || "-") + "\nmakes: " + (m.out.join(", ") || "-");
      }
      const c = flowData.chests[String(r.flowId)];
      if (c) s += "\nholds: " + c.join(", ");
    }
    if (e.bar !== undefined) s += "\nbar: " + e.bar;
    if (e.request_filters) s += "\nrequests: " + (e.request_filters.sections || []).flatMap((sec) => (sec.filters || []).map((f) => f.name + (f.count ? " " + f.count : ""))).join(", ");
    if (e.control_behavior && e.control_behavior.circuit_condition) {
      const c = e.control_behavior.circuit_condition;
      s += "\ncircuit: " + ((c.first_signal || {}).name || "?") + " " + (c.comparator || "") + " " + (c.second_signal ? c.second_signal.name : c.constant);
    }
    return s;
  }

  function button(label, fn, title) {
    const b = document.createElement("button"); b.textContent = label; b.onclick = fn; if (title) b.title = title; return b;
  }
  // The side panel leads with the thing most often changed: the machine's recipe, with its flow
  // verdict right beneath it. Identity, raw fields and the edit buttons follow.
  function recipePicker(r) {
    const e = r.e, allowed = recipesFor(e.name);
    const box = document.createElement("div"); box.className = "recipebox";

    const row = document.createElement("div"); row.className = "recipepick";
    const lab = document.createElement("span"); lab.className = "muted"; lab.textContent = "recipe";
    const cur = document.createElement("b"); cur.className = "current"; cur.textContent = e.recipe || "none set";
    row.appendChild(lab); row.appendChild(cur); box.appendChild(row);

    if (flowData) {
      const m = flowData.machines[String(r.flowId)];
      if (m && m.status !== "none") {
        const v = document.createElement("div"); v.className = "verdict " + m.status;
        v.textContent = m.status === "ok" ? "all inputs arrive"
          : m.status === "missing" ? "missing " + m.missing.join(", ")
          : "depends on a furnace whose input is not declared";
        box.appendChild(v);
      }
    }

    const inp = document.createElement("input");
    inp.placeholder = "change recipe: type to search " + allowed.length + " this machine can make…";
    inp.value = ""; inp.spellcheck = false; inp.autocomplete = "off";
    const list = document.createElement("div"); list.className = "recipe-options"; list.hidden = true;
    const apply = (v) => {
      v = (v || "").trim(); if (!v || v === e.recipe) return;
      if (recipeList.length && !recipeList.includes(v)) { toast("not a recipe: " + v); return; }
      if (allowed.length && !allowed.includes(v)) { toast(e.name + " cannot make " + v); return; }
      if (!editMode) { $("editmode").checked = true; $("editmode").onchange({ target: $("editmode") }); }
      act({ kind: "recipe", r, recipe: v });
    };
    let matches = [];
    const refresh = () => {
      const q = inp.value.trim().toLowerCase();
      matches = (q ? allowed.filter((n) => n.includes(q)) : allowed.slice())
        .sort((x, y) => (x.startsWith(q) ? 0 : 1) - (y.startsWith(q) ? 0 : 1) || x.localeCompare(y)).slice(0, 14);
      list.innerHTML = ""; list.hidden = !matches.length;
      for (const name of matches) {
        const o = document.createElement("div"); o.className = "recipe-option";
        const art = recipeIcon(name);
        if (art) { const sw = swatch(art, null, 16); sw.className = "opt-icon"; o.appendChild(sw); }
        o.appendChild(document.createTextNode(name)); if (name === e.recipe) o.classList.add("is-current");
        o.onmousedown = (ev) => { ev.preventDefault(); apply(name); };
        list.appendChild(o);
      }
    };
    inp.oninput = refresh;
    inp.onkeydown = (ev) => { if (ev.key === "Enter") apply(matches[0] || inp.value); if (ev.key === "Escape") { inp.value = ""; refresh(); } ev.stopPropagation(); };
    inp.onfocus = refresh;
    inp.onblur = () => setTimeout(() => { list.hidden = true; }, 150);
    box.appendChild(inp); box.appendChild(list);
    return box;
  }

  function showDetail(r) {
    detail.innerHTML = "";
    if (!r) {
      const d = document.createElement("div"); d.className = "muted";
      d.textContent = editMode
        ? "Edit mode. Right-click removes (or restores). Click an entity, then R rotates, T flips an underground, Delete removes. Pick a palette item and click a tile to place; shift+drag paints a run. Ctrl+Z undoes one step; × in the change list reverts one edit."
        : "Hover for details, click to pin. Drag to pan, wheel to zoom, F to fit.";
      detail.appendChild(d); return;
    }
    const e = r.e;
    const h = document.createElement("h3"); h.textContent = e.name + (r.baseId !== null ? " #" + r.baseId : " (new)");
    detail.appendChild(h);

    if (r.kind[0] === "crafter" && !r.removed) detail.appendChild(recipePicker(r));

    const pre = document.createElement("pre"); pre.textContent = describe(r); detail.appendChild(pre);
    if (editMode) {
      detail.appendChild(button(r.removed ? "restore" : "remove", () => act({ kind: "toggleRemove", r }), "Delete"));
      if (DIRECTIONAL.test(e.name) || r.cells.length > 1) detail.appendChild(button("rotate", () => act({ kind: "rotate", r }), "R"));
      if (r.kind[0] === "underground") detail.appendChild(button("flip in/out", () => act({ kind: "flip", r }), "T"));
      detail.appendChild(document.createElement("br"));
    }
    detail.appendChild(button("copy id", () => vscode.postMessage({ type: "copy", text: String(r.baseId) })));
    detail.appendChild(button("copy position", () => vscode.postMessage({ type: "copy", text: e.position.x + " " + e.position.y })));
    detail.appendChild(button("copy JSON", () => vscode.postMessage({ type: "copy", text: JSON.stringify(e) })));
    const pre2 = document.createElement("pre"); pre2.textContent = JSON.stringify(e, null, 1); detail.appendChild(pre2);
  }

  // ---------------------------------------------------------------- editing
  function clone(e) { return JSON.parse(JSON.stringify(e)); }
  function currentOf(r) { return r.baseId !== null && edits.replace.has(r.baseId) ? edits.replace.get(r.baseId) : r.e; }

  // Every action snapshots the edit state first (deep copies, so later in-place changes cannot leak
  // into history), applies one change, then rebuilds the view. Added entities are replaced by fresh
  // objects rather than mutated, so an undo snapshot never shares an object with live state.
  function snapshotEdits() {
    return { remove: new Set(edits.remove), recipe: new Map(edits.recipe),
             replace: new Map([...edits.replace].map(([k, v]) => [k, clone(v)])), add: edits.add.map(clone) };
  }
  function swapAdded(oldE, newE) { const i = edits.add.indexOf(oldE); if (i >= 0) edits.add[i] = newE; return newE; }
  function act(a) {
    edits.history.push(snapshotEdits());
    let follow = null;   // entity object to keep pinned after rebuild
    if (a.kind === "toggleRemove") {
      if (a.r.added) edits.add.splice(edits.add.indexOf(a.r.e), 1);
      else if (edits.remove.has(a.r.baseId)) { edits.remove.delete(a.r.baseId); follow = a.r.baseId; }
      else { edits.remove.add(a.r.baseId); edits.recipe.delete(a.r.baseId); edits.replace.delete(a.r.baseId); follow = a.r.baseId; }
    } else if (a.kind === "rotate" || a.kind === "flip") {
      const target = clone(currentOf(a.r));
      if (a.kind === "rotate") target.direction = ((target.direction || 0) + 4) % 16;
      else target.type = target.type === "input" ? "output" : "input";
      if (a.r.added) follow = swapAdded(a.r.e, target);
      else { edits.replace.set(a.r.baseId, target); edits.remove.delete(a.r.baseId); follow = a.r.baseId; }
    } else if (a.kind === "recipe") {
      if (a.r.added) { const t = clone(a.r.e); t.recipe = a.recipe; t.recipe_quality = "normal"; follow = swapAdded(a.r.e, t); }
      else if (edits.replace.has(a.r.baseId)) { edits.replace.get(a.r.baseId).recipe = a.recipe; follow = a.r.baseId; }
      else { edits.recipe.set(a.r.baseId, a.recipe); follow = a.r.baseId; }
    } else if (a.kind === "place") {
      if (a.replacing) edits.add.splice(edits.add.indexOf(a.replacing.e), 1);
      edits.add.push(a.entity); follow = a.entity;
    } else if (a.kind === "revert") {          // undo one specific edit from the change list
      if (a.what === "remove") edits.remove.delete(a.id);
      if (a.what === "recipe") edits.recipe.delete(a.id);
      if (a.what === "replace") edits.replace.delete(a.id);
      if (a.what === "add") edits.add.splice(a.index, 1);
    }
    rebuild(true);
    pinned = follow === null ? null : ents.find((r) => (typeof follow === "number" ? r.baseId === follow : r.e === follow)) || null;
    if (a.kind === "recipe" && !showFlow) { showFlow = true; $("flow").checked = true; }   // a recipe change is a question for the flow
    if (flowData || showFlow) computeFlowLocally();
    showDetail(pinned);
  }
  function undo() {
    const s = edits.history.pop(); if (!s) return;
    edits.remove.clear(); for (const x of s.remove) edits.remove.add(x);
    edits.recipe.clear(); for (const [k, v] of s.recipe) edits.recipe.set(k, v);
    edits.replace.clear(); for (const [k, v] of s.replace) edits.replace.set(k, v);
    edits.add.length = 0; edits.add.push(...s.add);
    pinned = null; rebuild(true); if (flowData) computeFlowLocally(); showDetail(null);
  }
  function buildPatch() {
    const remove = new Set(edits.remove);
    const add = edits.add.map((a) => { const c = clone(a); delete c.entity_number; return c; });
    for (const [id, rep] of edits.replace) { remove.add(id); const c = clone(rep); delete c.entity_number; add.push(c); }
    const recipe = {}; for (const [id, rec] of edits.recipe) if (!remove.has(id)) recipe[String(id)] = rec;
    const patch = { _comment: "Made in the fbp viewer for '" + (bp.label || fileName) + "'. Rotations are remove+add of a clone." };
    if (remove.size) patch.remove = [...remove].sort((a, b) => a - b);
    if (Object.keys(recipe).length) patch.recipe = recipe;
    if (add.length) patch.add = add;
    return patch;
  }
  function download(name, text) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click();
  }

  // palette ghost
  let ghost = null, hoverTile = null;
  function paletteEntity(tx, ty) {
    const name = $("palette").value; if (!name) return null;
    const dir = parseInt($("pdir").value, 10);
    const e = { name, position: centreFor(name, dir, tx, ty) };
    // The palette direction is "the way items move". Belts store exactly that; inserters store the
    // pickup side, i.e. the opposite, so flip it here and the arrow points where the user chose.
    const stored = name.endsWith("inserter") ? (dir + 8) % 16 : dir;
    if (DIRECTIONAL.test(name) || sizeOf(name, 0)[0] !== sizeOf(name, 0)[1]) e.direction = stored;
    if (name.endsWith("underground-belt")) e.type = $("ptype").value;
    if (/^assembling-machine|^chemical-plant$|furnace$/.test(name)) e.recipe_quality = "normal";
    if (/chest$/.test(name) && !/requester|provider/.test(name)) e.bar = 1;
    return e;
  }
  function refreshGhost() {
    ghost = null;
    if (!editMode || !hoverTile) return;
    const e = paletteEntity(hoverTile[0], hoverTile[1]);
    if (e) ghost = { e, cells: cellsOf(e), kind: kindOf(e.name) };
  }

  // ---------------------------------------------------------------- interaction
  let dragging = false, lastX = 0, lastY = 0, moved = false;
  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button === 2) return;
    if (editMode && ev.shiftKey && ghost && ghost.cells.length === 1) {   // start painting a run
      painting = true; const t = tileAt(ev.offsetX, ev.offsetY); lastPaint = t.join(",");
      tryPlaceAt(t[0], t[1], false); refreshGhost(); draw(); return;
    }
    dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY; canvas.classList.add("dragging");
  });
  // Mouse semantics in edit mode (right-click removes, as in the game):
  //   right-click         delete what is under the cursor (added: gone; original: marked removed / restored)
  //   palette + empty     place the ghost
  //   palette + added     replace that added entity with the ghost (re-place a wrong inserter in one click)
  //   palette + original  select it (never place on top of the print)
  //   shift + drag        paint the 1x1 palette item along the drag (belts, inserters, poles)
  //   no palette          select
  // Placing a multi-tile entity clears the palette; 1x1 items stay selected for repeated placement.
  let painting = false, lastPaint = null;
  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (feedMode) {
      const [tx, ty] = tileAt(ev.offsetX, ev.offsetY);
      const before = feeds.length; feeds = feeds.filter((f) => !(f.x === tx && f.y === ty));
      if (feeds.length !== before) pushFeeds();
      return;
    }
    if (!editMode) return;
    const under = entityAt(ev.offsetX, ev.offsetY);
    if (under) act({ kind: "toggleRemove", r: under });
  });
  function tryPlaceAt(tx, ty, replaceAdded) {
    const e = paletteEntity(tx, ty); if (!e) return false;
    const g = { e, cells: cellsOf(e), kind: kindOf(e.name) };
    const blockers = g.cells.flatMap(([x, y]) => (tiles.get(x + "," + y) || []).filter((q) => !q.removed));
    if (!blockers.length) { act({ kind: "place", entity: e }); return true; }
    const onlyOneAdded = blockers.every((q) => q === blockers[0]) && blockers[0].added;
    if (replaceAdded && onlyOneAdded) { act({ kind: "place", entity: e, replacing: blockers[0] }); return true; }
    return false;
  }
  window.addEventListener("mouseup", (ev) => {
    if (ev.button === 2) { dragging = false; painting = false; canvas.classList.remove("dragging"); return; }
    if (painting) { painting = false; lastPaint = null; dragging = false; canvas.classList.remove("dragging"); return; }
    if (dragging && !moved && ev.target === canvas) {
      // click on the on-map legend: an item row toggles highlight, the header hides the legend
      const inLegend = showItemLegend && legendBox &&
          ev.offsetX >= legendBox.x0 && ev.offsetX <= legendBox.x0 + legendBox.w && ev.offsetY >= legendBox.y0 && ev.offsetY <= legendBox.y0 + legendBox.h;
      if (inLegend && legendBox.entity) {
        if (ev.offsetY - legendBox.y0 < 24) { showItemLegend = false; $("itemlegend").checked = false; draw(); }
        dragging = false; canvas.classList.remove("dragging"); return;
      }
      if (inLegend && showFlow && flowData) {
        const counts = {};
        for (const L of Object.values(flowData.lanes)) for (const i of L.left.concat(L.right)) counts[i] = (counts[i] || 0) + 1;
        const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        const rowH = 16, pad = 8, colW = 190, maxRows = 18, cols = names.length > maxRows ? 2 : 1, rows = Math.min(maxRows, Math.ceil(names.length / cols));
        const r = Math.floor((ev.offsetY - legendBox.y0 - pad) / rowH) - 1, c = Math.floor((ev.offsetX - legendBox.x0 - pad) / colW);
        if (r < 0) { showItemLegend = false; $("itemlegend").checked = false; }
        else if (r < rows && names[c * rows + r]) flowHighlight = flowHighlight === names[c * rows + r] ? "" : names[c * rows + r];
        draw(); dragging = false; canvas.classList.remove("dragging"); return;
      }
      const under = entityAt(ev.offsetX, ev.offsetY);
      if (feedMode && !(editMode && ghost)) {
        const [tx, ty] = tileAt(ev.offsetX, ev.offsetY);
        const item = $("feeditem").value;
        if (!item) vscode.postMessage({ type: "status", text: "pick an item first" });
        else if (!under || !["belt", "underground", "splitter"].includes(under.kind[0])) vscode.postMessage({ type: "status", text: "click a belt tile" });
        else {
          const existing = feeds.find((f) => f.x === tx && f.y === ty && f.lane === $("feedlane").value);
          if (existing) { if (!existing.items.includes(item)) existing.items.push(item); }
          else feeds.push({ x: tx, y: ty, items: [item], lane: $("feedlane").value });
          pushFeeds();
        }
      } else if (editMode && (ev.ctrlKey || ev.metaKey)) {          // ctrl+click: delete, for hosts that intercept right-click
        if (under) act({ kind: "toggleRemove", r: under });
      } else if (editMode && ghost) {
        const blockers = ghost.cells.flatMap(([x, y]) => (tiles.get(x + "," + y) || []).filter((q) => !q.removed));
        const onlyOneAdded = blockers.length > 0 && blockers.every((q) => q === blockers[0]) && blockers[0].added;
        if (!blockers.length) { act({ kind: "place", entity: ghost.e }); afterPlace(); }
        else if (onlyOneAdded) { act({ kind: "place", entity: ghost.e, replacing: blockers[0] }); afterPlace(); }
        else if (under && !under.added) { pinned = under; showDetail(pinned); draw(); }
        else vscode.postMessage({ type: "status", text: "tile occupied: shift+click to remove what is there" });
      } else {
        pinned = under; showDetail(pinned); draw();
      }
    }
    dragging = false; canvas.classList.remove("dragging");
  });
  function afterPlace() {
    if (ghost && ghost.cells.length > 1) { $("palette").value = ""; $("ptype").hidden = true; }
    refreshGhost(); draw();
  }
  canvas.addEventListener("mousemove", (ev) => {
    const r = canvas.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    if (painting) {
      const t = tileAt(mx, my); hoverTile = t;
      if (t.join(",") !== lastPaint) { lastPaint = t.join(","); tryPlaceAt(t[0], t[1], false); }
      refreshGhost(); draw(); return;
    }
    if (dragging) {
      const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      ox += dx; oy += dy; lastX = ev.clientX; lastY = ev.clientY; draw(); return;
    }
    const t = tileAt(mx, my); hoverTile = t;
    coords.textContent = "tile " + t[0] + ", " + t[1] + "   " + scale.toFixed(1) + " px/tile";
    const h = entityAt(mx, my);
    if (h !== hover) { hover = h; if (!pinned) showDetail(h); }
    refreshGhost(); draw();
    if (h) { tip.hidden = false; tip.textContent = describe(h).split("\n").slice(0, 2).join("  "); tip.style.left = (ev.clientX + 14) + "px"; tip.style.top = (ev.clientY + 14) + "px"; }
    else tip.hidden = true;
  });
  canvas.addEventListener("mouseleave", () => { tip.hidden = true; hover = null; hoverTile = null; ghost = null; draw(); });
  function zoomAt(mx, my, factor) {
    const ns = Math.max(0.5, Math.min(80, scale * factor));
    ox = mx - (mx - ox) * (ns / scale); oy = my - (my - oy) * (ns / scale); scale = ns; draw();
    coords.textContent = scale.toFixed(1) + " px/tile";
  }
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(ev.clientX - r.left, ev.clientY - r.top, ev.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  canvas.addEventListener("dblclick", (ev) => { if (editMode) return; const r = canvas.getBoundingClientRect(); zoomAt(ev.clientX - r.left, ev.clientY - r.top, 2); });
  window.addEventListener("keydown", (ev) => {
    // A palette dropdown that still has focus must not swallow the edit keys.
    if (ev.target && ev.target.tagName === "SELECT" && ev.target.closest("#edittools, #feedtools") && !["ArrowUp", "ArrowDown", "Enter", " ", "Tab"].includes(ev.key)) {
      ev.preventDefault(); ev.target.blur(); canvas.focus();
    } else if (ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT")) return;
    if (ev.key === "f" || ev.key === "F") { fit(); draw(); }
    if (ev.key === "Escape") { pinned = null; $("palette").value = ""; refreshGhost(); showDetail(hover); draw(); }
    if ((ev.key === "l" || ev.key === "L") && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); showItemLegend = !showItemLegend; draw(); }
    if (ev.key === "+" || ev.key === "=") zoomAt(canvas.width / 2, canvas.height / 2, 1.25);
    if (ev.key === "-" || ev.key === "_") zoomAt(canvas.width / 2, canvas.height / 2, 1 / 1.25);
    if (!editMode) return;
    if ((ev.key === "z" || ev.key === "Z") && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); undo(); }
    // Delete / X: the pinned entity, or whatever is under the cursor. Works even if the host eats right-click.
    if (ev.key === "Delete" || ev.key === "Backspace" || ev.key === "x" || ev.key === "X") {
      const target = pinned || hover;
      if (target) { ev.preventDefault(); act({ kind: "toggleRemove", r: target }); }
    }
    if (ev.key === "r" || ev.key === "R") {
      if (pinned) act({ kind: "rotate", r: pinned });
      else { const d = $("pdir"); d.value = String((parseInt(d.value, 10) + 4) % 16); refreshGhost(); draw(); }
    }
    if ((ev.key === "t" || ev.key === "T") && pinned && pinned.kind[0] === "underground") act({ kind: "flip", r: pinned });
  });

  // toolbar
  $("fit").onclick = () => { fit(); draw(); };
  $("wires").onchange = (ev) => { showWires = ev.target.checked; draw(); };
  $("labels").onchange = (ev) => { showLabels = ev.target.checked; draw(); };
  $("gridlines").onchange = (ev) => { showGrid = ev.target.checked; draw(); };
  $("tunnels").onchange = (ev) => { showTunnels = ev.target.checked; draw(); };
  $("flow").onchange = (ev) => {
    showFlow = ev.target.checked;
    if (showFlow) { showItemLegend = true; $("itemlegend").checked = true; if (!flowData) computeFlowLocally(); }
    draw();
  };
  $("itemlegend").onchange = (ev) => { showItemLegend = ev.target.checked; draw(); };
  $("icons").onchange = (ev) => { showIcons = ev.target.checked; draw(); };
  if (!iconMap) { $("icons").checked = false; $("icons").disabled = true; $("icons").parentElement.title = "run `fbp icons` to build the atlas from your Factorio installation"; }
  $("feedmode").onchange = (ev) => {
    feedMode = ev.target.checked; document.body.classList.toggle("feeding", feedMode);
    if (feedMode && editMode) { editMode = false; $("editmode").checked = false; document.body.classList.remove("editing"); ghost = null; }
    if (feedMode && !showFlow) { showFlow = true; $("flow").checked = true; }
    resize();
  };
  let gamedataForFlow = null, recipeCategory = {}, craftCategories = {};

  // ---------------------------------------------------------------- icons
  // `fbp icons` builds icons.png + icons.js from a local Factorio install. They are optional and
  // never committed, so everything below degrades to the coloured tiles when they are absent.
  function loadIcons(url) {
    if (!iconMap) return;
    iconUrl = url || iconMap.file || "icons.png";
    const img = new Image();
    img.onload = () => { iconAtlas = img; renderItems(); if (pinned || hover) showDetail(pinned || hover); draw(); };
    img.onerror = () => { iconAtlas = null; iconMap = null; };
    img.src = iconUrl;
  }
  // Factorio's artwork is not ours to serve, so the hosted page ships no atlas. Instead you point
  // it at the icons.png and icons.js that `fbp icons` built from your own installation, and the
  // browser keeps them in IndexedDB (a couple of megabytes, too big for localStorage) so the next
  // visit already has them. Nothing is uploaded: the image stays a blob URL in the page.
  function applyAtlas(map, url) {
    if (!map || !map.names) return false;
    iconMap = map;
    const box = $("icons");
    box.disabled = false; box.checked = true; showIcons = true;
    box.parentElement.title = "real item icons";
    loadIcons(url);
    return true;
  }
  function atlasStore(mode) {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("no storage"));
      const open = indexedDB.open("fbp-viewer", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("icons");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result.transaction("icons", mode).objectStore("icons"));
    });
  }
  const atlasRequest = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  function rememberedAtlas() { return atlasStore("readonly").then((st) => atlasRequest(st.get("atlas"))); }
  function rememberAtlas(map, blob) { return atlasStore("readwrite").then((st) => atlasRequest(st.put({ map, blob }, "atlas"))); }
  // `fbp icons` writes `window.FBP_ICONS = {...}`; take the object out of it without eval, which the
  // page's content security policy forbids anyway. A plain .json manifest works too.
  function parseAtlasManifest(text) {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
  }
  function iconCell(name) { return iconMap && iconAtlas && name ? iconMap.names[name] : null; }
  // The icon for a recipe is the icon of what it makes; oil processing and the like have none.
  function recipeIcon(recipe) {
    if (!recipe) return null;
    if (iconCell(recipe)) return recipe;
    const r = gamedataForFlow && gamedataForFlow.recipes && gamedataForFlow.recipes[recipe];
    if (!r) return null;
    const fluids = new Set(r.fluid_results || []);
    for (const k of Object.keys(r.results || {})) if (!fluids.has(k) && iconCell(k)) return k;
    for (const k of Object.keys(r.results || {})) if (iconCell(k)) return k;   // oil processing: the fluid is the product
    return null;
  }
  function drawIcon(name, x, y, w) {
    const c = iconCell(name); if (!c) return false;
    const s = iconMap.size;
    ctx.drawImage(iconAtlas, c[0] * s, c[1] * s, s, s, x, y, w, w);
    return true;
  }
  // Panel swatch: the real icon where there is one, else the colour the map uses.
  function swatch(name, colour, px) {
    const i = document.createElement("i");
    const c = iconCell(name);
    if (c && iconUrl) {
      const side = px || 14;
      i.style.width = i.style.height = side + "px";
      i.style.backgroundImage = 'url("' + iconUrl + '")';
      i.style.backgroundSize = (iconMap.cols * side) + "px " + (iconMap.rows * side) + "px";
      i.style.backgroundPosition = "-" + (c[0] * side) + "px -" + (c[1] * side) + "px";
      i.style.borderRadius = "0";
    } else {
      i.style.background = colour || "#6e6e6e";
    }
    return i;
  }
  // Recipes this machine can actually be set to. Falls back to every recipe when the game data
  // does not describe the machine, so an unknown or modded building is not left with an empty list.
  function recipesFor(name) {
    const cats = craftCategories[name];
    if (!cats || !cats.length || !recipeList.length) return recipeList;
    const ok = new Set(cats);
    const out = recipeList.filter((n) => ok.has(recipeCategory[n] || "crafting"));
    return out.length ? out : recipeList;
  }
  // The flow is computed right here (flow.js, a port of fbp/flow.py) so it works in any browser.
  // Inside VS Code the host additionally saves the feeds file and answers with the Python result.
  function computeFlowLocally() {
    if (!bp || typeof FBPFlow === "undefined") { setFlowStatus("flow.js not loaded", true); return; }
    const t0 = performance.now();
    try {
      // run on the edited view: removed entities gone, recipe changes and additions in, keyed by flowId
      const view = { entities: ents.filter((r) => !r.removed).map((r) => Object.assign({}, r.e, { entity_number: r.flowId })) };
      flowData = FBPFlow.compute(view, footprints, gamedataForFlow || { recipes: {} }, feeds);
    } catch (e) { setFlowStatus("flow failed: " + (e.message || e), true); return; }
    const st = { ok: 0, missing: 0, unknown: 0 };
    for (const m of Object.values(flowData.machines)) if (st[m.status] !== undefined) st[m.status]++;
    setFlowStatus(Object.keys(flowData.lanes).length + " belts resolved · machines " + st.ok + " ok / " + st.missing + " missing / " + st.unknown + " unknown · " + Math.round(performance.now() - t0) + " ms" + (inVsCode ? "" : " (computed in page)"));
    if (!gamedataForFlow || !Object.keys(gamedataForFlow.recipes).length) setFlowStatus("flow computed without game data (gamedata.js missing): machine products unknown", true);
    renderItems(); if (!showFlow && feeds.length) { showFlow = true; $("flow").checked = true; } draw();
  }
  function pushFeeds() {
    computeFlowLocally();
    if (inVsCode) flowWaiting(true);
    vscode.postMessage({ type: "feeds", feeds });
    renderItems(); draw();
  }
  function fillItemOptions() {
    const sel = $("feeditem"); const keep = sel.value; sel.innerHTML = "";
    const o0 = document.createElement("option"); o0.value = ""; o0.textContent = "(item)"; sel.appendChild(o0);
    const common = ["iron-ore", "copper-ore", "stone", "coal", "iron-plate", "copper-plate", "steel-plate", "stone-brick", "electronic-circuit", "advanced-circuit", "iron-gear-wheel", "copper-cable", "plastic-bar", "sulfur"];
    for (const name of common.concat(itemList.filter((n) => !common.includes(n)))) {
      const o = document.createElement("option"); o.value = name; o.textContent = name; sel.appendChild(o);
    }
    sel.value = keep;
  }
  // side panel: items seen on belts with their colours, and the declared feeds with a remove button each
  function renderItems() {
    const el = $("items"); el.innerHTML = "";
    if (!flowData && !feeds.length) return;
    const head = (t) => { const h4 = document.createElement("h4"); h4.textContent = t; el.appendChild(h4); };
    if (feeds.length) {
      head("edge feeds");
      feeds.forEach((f, i) => {
        const div = document.createElement("div"); div.className = "feed";
        const b = document.createElement("button"); b.textContent = "×"; b.title = "remove this feed"; b.onclick = () => { feeds.splice(i, 1); pushFeeds(); };
        const sw = swatch(f.items[0], itemColor(f.items[0] || "?"));
        const span = document.createElement("span"); span.textContent = f.items.join("+") + " @ (" + f.x + "," + f.y + ") " + f.lane;
        span.style.cursor = "pointer"; span.onclick = () => { ox = canvas.width / 2 - (f.x + 0.5) * scale; oy = canvas.height / 2 - (f.y + 0.5) * scale; draw(); };
        div.appendChild(b); div.appendChild(sw); div.appendChild(span); el.appendChild(div);
      });
    }
    if (flowData) {
      const counts = {};
      for (const L of Object.values(flowData.lanes)) for (const i of L.left.concat(L.right)) counts[i] = (counts[i] || 0) + 1;
      const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      head("item colours (" + names.length + " on belts) · click one to highlight");
      for (const n of names) {
        const sw = swatch(n, itemColor(n));
        const lab = document.createElement("span"); lab.textContent = n.replace(/-/g, " ") + "  ·  " + counts[n] + " belts";
        lab.style.cursor = "pointer"; lab.onclick = () => { $("search").value = ""; highlight = ""; flowHighlight = flowHighlight === n ? "" : n; draw(); };
        el.appendChild(sw); el.appendChild(lab);
      }
      const st = { ok: 0, missing: 0, unknown: 0 };
      for (const m of Object.values(flowData.machines)) if (st[m.status] !== undefined) st[m.status]++;
      const sum = document.createElement("span"); sum.className = "muted"; sum.style.gridColumn = "1 / -1";
      sum.textContent = "machines: " + st.ok + " ok, " + st.missing + " missing inputs, " + st.unknown + " unknown (declare feeds)";
      el.appendChild(sum);
      const missing = Object.entries(flowData.machines).filter(([id, m]) => m.status === "missing");
      if (missing.length) {
        head("missing inputs (" + missing.length + ") · click to go there");
        const byRow = new Map(ents.map((r) => [String(r.flowId), r]));
        missing.sort((a, b) => (a[1].missing.join() + a[0]).localeCompare(b[1].missing.join() + b[0]));
        for (const [id, m] of missing) {
          const r = byRow.get(id); if (!r) continue;
          const div = document.createElement("div"); div.className = "feed";
          const sw = swatch(recipeIcon(r.e.recipe), "#ff3b3b");
          const span = document.createElement("span");
          span.textContent = (r.e.recipe || r.e.name) + " @ (" + r.e.position.x + "," + r.e.position.y + ")  needs " + m.missing.join(", ");
          span.style.cursor = "pointer";
          span.onclick = () => { if (scale < 12) scale = 16; ox = canvas.width / 2 - r.e.position.x * scale; oy = canvas.height / 2 - r.e.position.y * scale; pinned = r; showDetail(r); draw(); };
          div.appendChild(sw); div.appendChild(span); el.appendChild(div);
        }
      }
    }
  }
  let flowHighlight = "";
  $("editmode").onchange = (ev) => {
    editMode = ev.target.checked; document.body.classList.toggle("editing", editMode);
    if (editMode && feedMode) { feedMode = false; $("feedmode").checked = false; document.body.classList.remove("feeding"); }
    refreshGhost(); showDetail(pinned); resize();
  };
  $("search").oninput = (ev) => {
    highlight = ev.target.value.trim();
    const n = highlight ? ents.filter(matches).length : 0;
    vscode.postMessage({ type: "status", text: highlight ? n + " entities match '" + highlight + "'" : "" });
    draw();
  };
  // After any palette choice, hand keyboard focus back to the map so R / T / Delete / Esc work at once.
  const refocus = () => { document.activeElement && document.activeElement.blur(); canvas.focus(); };
  $("palette").onchange = () => { $("ptype").hidden = !$("palette").value.endsWith("underground-belt"); refreshGhost(); draw(); refocus(); };
  $("pdir").onchange = () => { refreshGhost(); draw(); refocus(); };
  $("ptype").onchange = () => { refreshGhost(); draw(); refocus(); };
  $("feeditem").onchange = refocus; $("feedlane").onchange = refocus;
  canvas.addEventListener("mousedown", refocus);
  $("undo").onclick = undo;
  $("clear").onclick = () => {
    const n = edits.remove.size + edits.recipe.size + edits.replace.size + edits.add.length;
    if (!n) return;
    edits.history.push(snapshotEdits());   // clear all is itself undoable
    edits.remove.clear(); edits.recipe.clear(); edits.replace.clear(); edits.add.length = 0;
    pinned = null; rebuild(true); showDetail(null);
  };
  $("nopalette").onclick = () => { $("palette").value = ""; $("ptype").hidden = true; refreshGhost(); draw(); };
  $("copypatch").onclick = () => vscode.postMessage({ type: "copy", text: JSON.stringify(buildPatch(), null, 2) });
  $("export").onclick = () => {
    const p = buildPatch();
    if (!p.remove && !p.recipe && !p.add) { vscode.postMessage({ type: "status", text: "nothing to export" }); return; }
    vscode.postMessage({ type: "export", patch: p });
  };
  for (const name of PALETTE) { const o = document.createElement("option"); o.value = name; o.textContent = name; $("palette").appendChild(o); }

  // ---------------------------------------------------------------- loading without the extension host
  const drop = $("drop");
  $("mode").textContent = inVsCode
    ? "Running inside VS Code. The active editor's blueprint loads automatically; open… picks another file. Export runs fbp patch and fbp diff."
    : "Running standalone in a browser: decoding, flow and editing all happen in the page. Exporting an edited blueprint needs the VS Code panel.";
  drop.hidden = false;
  async function decodeStandalone(text) {
    const t = text.trim();
    if (t.startsWith("{")) return JSON.parse(t);
    if (!t.startsWith("0")) throw new Error("not a blueprint string (expected leading '0')");
    const bin = Uint8Array.from(atob(t.slice(1)), (c) => c.charCodeAt(0));
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate"));
    return JSON.parse(await new Response(stream).text());
  }
  function firstBlueprint(obj) {
    if (obj.blueprint) return obj.blueprint;
    for (const e of (obj.blueprint_book || {}).blueprints || []) { const b = firstBlueprint(e); if (b) return b; }
    return null;
  }
  async function loadText(text, name) {
    try {
      const obj = await decodeStandalone(text);
      const b = firstBlueprint(obj);
      if (!b) throw new Error("no blueprint in this data");
      drop.hidden = true; resize(); load({ bp: b, footprints, recipes: recipeList, file: name || "pasted string" });
    } catch (e) { $("file").textContent = "error: " + (e.message || e); drop.hidden = false; }
  }
  // The web build ships sample.txt beside the page so a first visit has something to look at.
  // Inside VS Code there is always a blueprint to open, so the button stays hidden there.
  if (!inVsCode) {
    const sample = $("sample");
    sample.hidden = false;
    sample.onclick = async () => {
      sample.disabled = true;
      try {
        const res = await fetch("sample.txt");
        if (!res.ok) throw new Error("no example on this host (" + res.status + ")");
        await loadText(await res.text(), "example blueprint");
      } catch (e) { $("file").textContent = "error: " + (e.message || e); }
      sample.disabled = false;
    };
  }
  $("dismiss").onclick = () => { $("standalone").hidden = true; resize(); };
  $("open").onclick = () => vscode.postMessage({ type: "open" });
  $("filepick").onchange = (ev) => { const f = ev.target.files[0]; if (f) f.text().then((t) => loadText(t, f.name)); ev.target.value = ""; };
  document.addEventListener("paste", (ev) => {
    if (ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA")) return;
    const t = (ev.clipboardData || {}).getData ? ev.clipboardData.getData("text") : "";
    if (t && t.trim().length > 20 && (t.trim().startsWith("0") || t.trim().startsWith("{"))) { ev.preventDefault(); loadText(t); }
  });
  for (const el of [document.body, drop]) {
    el.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.hidden = false; drop.classList.add("over"); });
    el.addEventListener("dragleave", () => drop.classList.remove("over"));
    el.addEventListener("drop", (ev) => {
      ev.preventDefault(); drop.classList.remove("over");
      const f = ev.dataTransfer.files[0];
      if (f) f.text().then((t) => loadText(t, f.name));
      else { const t = ev.dataTransfer.getData("text"); if (t) loadText(t); else drop.hidden = !bp; }
    });
  }

  $("pickicons").onclick = () => $("iconpick").click();
  $("iconpick").onchange = async (ev) => {
    const files = [...ev.target.files]; ev.target.value = "";
    const png = files.find((f) => /\.png$/i.test(f.name));
    const manifest = files.find((f) => /\.(js|json)$/i.test(f.name));
    const say = (msg) => { $("file").textContent = msg; };
    if (!png || !manifest) return say("pick both files: icons.png and icons.js (from `fbp icons`)");
    const map = parseAtlasManifest(await manifest.text());
    if (!map) return say("could not read " + manifest.name + "; expected the icons.js that `fbp icons` wrote");
    if (!applyAtlas(map, URL.createObjectURL(png))) return say(manifest.name + " has no icon names in it");
    const loaded = Object.keys(map.names).length + " icons loaded from " + png.name;
    say(loaded);
    rememberAtlas(map, png).catch(() => say(loaded + " (this browser will not keep them for next time)"));
  };
  if (!inVsCode) {
    loadIcons(null);
    if (!iconMap) rememberedAtlas().then((saved) => { if (saved) applyAtlas(saved.map, URL.createObjectURL(saved.blob)); }).catch(() => {});
  }
  window.addEventListener("resize", resize);
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type === "blueprint") { drop.hidden = true; resize(); load(m); if (!iconAtlas) loadIcons(m.iconsUrl); }
    if (m.type === "error") { $("file").textContent = "error: " + m.message; }
    if (m.type === "exported") { vscode.postMessage({ type: "status", text: "exported " + m.file }); }
    if (m.type === "flowstatus") { setFlowStatus(m.text); }
    if (m.type === "flow") {
      flowWaiting(false);
      if (m.error) { setFlowStatus("host flow failed: " + m.error + " (showing in-page result)", true); return; }
      flowData = m.data; feeds = (m.data.feeds || []).map((f) => Object.assign({}, f));
      if (m.feedsFile) $("feedsfile").textContent = "saved as " + m.feedsFile;
      const st = { ok: 0, missing: 0, unknown: 0 };
      for (const mm of Object.values(flowData.machines)) if (st[mm.status] !== undefined) st[mm.status]++;
      setFlowStatus(Object.keys(flowData.lanes).length + " belts resolved · machines " + st.ok + " ok / " + st.missing + " missing / " + st.unknown + " unknown" + (m.ms ? " · " + m.ms + " ms" : ""));
      renderItems(); if (!showFlow && feeds.length) { showFlow = true; $("flow").checked = true; } draw();
    }
  });
  resize();
})();
