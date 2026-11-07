// Loads the viewer's scripts against a minimal DOM and feeds them a real blueprint.
//
// The point is to catch the errors that kill the page at load: a `let` read before its
// declaration, a handler bound to an element that does not exist, a typo in a branch that
// only runs at startup. Any of those leaves every control below the failure unbound, which
// looks to a user like "the open button does nothing".
//
//   node tests/viewer_smoke.js [dir]
//
// With a directory it runs against that copy of the page instead of vscode/media, which is how the
// static web build gets tested: the deployed bundle is what visitors load, not the source folder.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const MEDIA = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "vscode", "media");
const read = (f) => fs.readFileSync(path.join(MEDIA, f), "utf8");

const html = read(fs.existsSync(path.join(MEDIA, "viewer.html")) ? "viewer.html" : "index.html");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const calls = {};
const count = (name) => { calls[name] = (calls[name] || 0) + 1; };
// Rectangles the page drew, with the colour in force at the time, so a test can ask "was that
// tile tinted, and in which colour" rather than only "did anything draw".
const ops = [];
const paint = { fillStyle: "", strokeStyle: "", globalAlpha: 1 };

function element(id) {
  const node = {
    id, style: {}, dataset: {}, children: [], hidden: false, checked: false, disabled: false,
    value: "", textContent: "", innerHTML: "", title: "", className: "", tagName: "DIV", files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, setAttribute() {}, getAttribute: () => null, click() { count("click"); },
    focus() {}, blur() {}, closest: () => null, querySelector: () => null,
    on: {},
    addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    insertBefore(c) { this.children.push(c); return c; },
  };
  node.parentElement = { title: "", classList: node.classList, appendChild() {} };
  if (id === "map") {
    node.tagName = "CANVAS";
    node.width = 1200; node.height = 800;
    node.getContext = () => new Proxy({}, {
      get(_, prop) {
        if (prop === "measureText") return () => ({ width: 10 });
        if (prop === "canvas") return node;
        if (prop in paint) return paint[prop];
        if (prop === "moveTo" || prop === "lineTo") {
          return (...args) => { count(prop); ops.push({ op: prop, args, stroke: paint.strokeStyle, alpha: paint.globalAlpha }); };
        }
        if (prop === "fillRect" || prop === "strokeRect" || prop === "drawImage") {
          return (...args) => { count(prop); ops.push({ op: prop, args, fill: paint.fillStyle, stroke: paint.strokeStyle }); };
        }
        return typeof prop === "string" && /^[a-z]/.test(prop) ? (() => count(prop)) : undefined;
      },
      set(_, prop, value) { if (prop in paint) paint[prop] = value; return true; },
    });
  }
  return node;
}

const nodes = new Map([...ids].map((id) => [id, element(id)]));
const windowListeners = {}, documentListeners = {};
const listen = (bag) => (type, fn) => { (bag[type] = bag[type] || []).push(fn); };

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  // the page waits for the atlas image before drawing icons; pretend it arrives at once
  Image: class { set src(v) { this._src = v; if (this.onload) this.onload(); } },
  performance: { now: () => 0 },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { clipboard: { writeText() {} } },
  atob: (b) => Buffer.from(b, "base64").toString("binary"),
  URL: { createObjectURL: () => "blob:" }, Blob: class {},
  document: {
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => { const n = element("new-" + tag); n.tagName = tag.toUpperCase(); return n; },
    body: element("body"),
    activeElement: null,
    addEventListener: listen(documentListeners),
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.addEventListener = listen(windowListeners);

vm.createContext(sandbox);

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }

for (const file of ["gamedata.js", "icons.js", "flow.js", "viewer.js"]) {
  const full = path.join(MEDIA, file);
  if (!fs.existsSync(full)) continue;          // gamedata.js and icons.js are generated
  try {
    vm.runInContext(read(file), sandbox, { filename: file });
  } catch (e) {
    fail(file + " threw while loading: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
  }
}

// The page is only useful if it listens for a blueprint and for user input.
if (!windowListeners.message) fail("viewer.js never registered a message listener");
if (!documentListeners.paste) fail("viewer.js never registered a paste listener");
if (!nodes.get("open").onclick) fail("the open button has no click handler");
if (!nodes.get("editmode").onchange) fail("the edit toggle has no change handler");

// Feed it a real blueprint the way the extension host does.
const text = fs.readFileSync(path.join(ROOT, "tests", "fixtures", "mall.txt"), "utf8").trim();
const bp = JSON.parse(zlib.inflateSync(Buffer.from(text.slice(1), "base64")).toString("utf8")).blueprint;
try {
  for (const fn of windowListeners.message) fn({ data: { type: "blueprint", bp, file: "mall.txt" } });
} catch (e) {
  fail("handling a blueprint threw: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
}

if (!calls.fillRect) fail("nothing was drawn after loading a blueprint");

// Hovering an inserter marks the tile it takes from and the tile it puts into. The view transform
// lives inside the page, so recover it from the readout the page writes on every mousemove: the
// scale is printed there, and a binary search for the pixel where the reported tile changes gives
// the origin. Then the tinted rectangles can be checked against tiles, not pixels.
const map = nodes.get("map");
const move = (x, y) => { for (const fn of map.on.mousemove || []) fn({ clientX: x, clientY: y }); };
const readTile = () => (nodes.get("coords").textContent.match(/tile (-?\d+), (-?\d+)\s+([\d.]+)/) || []).slice(1).map(Number);
if (!map.on.mousemove) fail("the map has no mousemove handler");
move(600, 400);
if (readTile().length !== 3) fail("the coords readout did not parse: " + JSON.stringify(nodes.get("coords").textContent));
let scale = 0, ox = 0, oy = 0;
// smallest pixel whose reported tile is `tile`, i.e. the tile's left/top edge
function edge(axis, tile) {
  let lo = 0, hi = axis === 0 ? map.width : map.height;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    axis === 0 ? move(mid, 400) : move(600, mid);
    (readTile()[axis] >= tile ? (hi = mid) : (lo = mid));
  }
  return hi;
}
// the view transform changes with every zoom, so recover it whenever the test zooms
function calibrate() {
  move(600, 400);
  const t = readTile();                      // a tile that is certainly on screen to search around
  const left = edge(0, t[0]);
  scale = edge(0, t[0] + 1) - left;          // the readout rounds the scale, two tile edges do not
  ox = left - t[0] * scale;
  oy = edge(1, t[1]) - t[1] * scale;
}
calibrate();
const px = (x) => ox + x * scale, py = (y) => oy + y * scale;
const ins = bp.entities.find((e) => e.name === "long-handed-inserter");
if (!ins) fail("the fixture has no long-handed inserter to hover");
const ix = Math.floor(ins.position.x), iy = Math.floor(ins.position.y);
ops.length = 0;
move(px(ix) + scale / 2, py(iy) + scale / 2);
const tinted = (col) => ops.filter((o) => o.op === "fillRect" && o.fill === col);
const PICKUP = "#35c8ff", DROP = "#3ee06a";
for (const [col, what] of [[PICKUP, "pickup"], [DROP, "drop"]]) {
  if (tinted(col).length !== 1) fail("hovering an inserter tinted " + tinted(col).length + " tiles for " + what + ", expected 1");
}
// direction points at the pickup; a long-handed inserter reaches two tiles, skipping the one between
const d = ins.direction & 12, v = ({ 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] })[d] || [0, -1];
for (const [col, sign, what] of [[PICKUP, 1, "pickup"], [DROP, -1, "drop"]]) {
  const want = [ix + v[0] * 2 * sign, iy + v[1] * 2 * sign];
  const [rx, ry, rw, rh] = tinted(col)[0].args;
  const got = [Math.floor((rx + rw / 2 - ox) / scale), Math.floor((ry + rh / 2 - oy) / scale)];
  if (got[0] !== want[0] || got[1] !== want[1]) {
    fail("long-handed inserter at " + [ix, iy] + " facing " + d + ": " + what + " highlight on tile " + got + ", expected " + want);
  }
}

const status = nodes.get("flowstatus").textContent;
if (!/belts resolved/.test(status)) fail("the flow did not run in the page; status was: " + JSON.stringify(status));

// An inserter drops on the far lane, so a belt target is tinted on that lane only: half a tile.
// mall.txt has one such inserter, at (103,68) facing west onto an eastbound belt at (104,68).
const ins2 = bp.entities.find((e) => e.name === "inserter" && Math.floor(e.position.x) === 103 && Math.floor(e.position.y) === 68);
if (!ins2) fail("the fixture no longer has the inserter at (103,68) this test hovers");
ops.length = 0;
move(px(103) + scale / 2, py(68) + scale / 2);
const drop = tinted(DROP);
if (drop.length !== 1) fail("expected one drop tint, got " + drop.length);
{
  const [rx, ry, rw, rh] = drop[0].args;
  if (Math.abs(rh - scale / 2) > 2) fail("a drop onto an eastbound belt should tint half a tile high, got " + rh + " of " + scale);
  if (Math.abs(rw - scale) > 3) fail("it should still span the tile along the belt, got " + rw + " of " + scale);
  const half = (ry + rh / 2 - oy) / scale - 68;    // 0.25 = north half (left lane), 0.75 = south (right)
  if (half < 0.5) fail("the inserter stands west of the belt, so items land on the right lane (south half); got y offset " + half.toFixed(2));
}

// Icons: a radar is not a crafter and has no recipe, but it is a building the atlas knows, so it
// draws its own icon rather than a bare coloured square. Skipped when `fbp icons` has not been run.
if (fs.existsSync(path.join(MEDIA, "icons.js")) && fs.existsSync(path.join(MEDIA, "icons.png"))) {
  const cell = sandbox.window.FBP_ICONS.names["radar"];
  if (!cell) fail("the icon atlas has no radar icon");
  const radar = bp.entities.find((e) => e.name === "radar");
  if (!radar) fail("the fixture no longer has a radar");
  for (const fn of windowListeners.keydown || []) fn({ key: "+", preventDefault() {} });   // zoom in past the icon threshold
  calibrate();
  ops.length = 0;
  move(px(Math.floor(radar.position.x)) + scale / 2, py(Math.floor(radar.position.y)) + scale / 2);
  const size = sandbox.window.FBP_ICONS.size;
  const drawn = ops.filter((o) => o.op === "drawImage" && o.args[1] === cell[0] * size && o.args[2] === cell[1] * size);
  if (!drawn.length) fail("the radar drew no icon (" + ops.filter((o) => o.op === "drawImage").length + " icons drawn in all)");
}

// The tunnel line runs down the middle of the tiles, drawn a segment at a time, and goes faint only
// where it crosses something that is not a belt. mall.txt has a westbound pair from (101,79) to
// (97,79) whose run covers a small electric pole at (100,79) and bare ground at (99,79).
// Each segment is a moveTo/lineTo pair; the alpha in force when it was drawn says how it reads.
function tunnelSegment(tile) {
  const wantX = px(tile[0]) + scale / 2, wantY = py(tile[1]) + scale / 2;
  for (let i = 1; i < ops.length; i++) {
    const a = ops[i - 1], b = ops[i];
    if (a.op !== "moveTo" || b.op !== "lineTo") continue;
    const midX = (a.args[0] + b.args[0]) / 2, midY = (a.args[1] + b.args[1]) / 2;
    if (Math.abs(midX - wantX) > scale * 0.1 || Math.abs(midY - wantY) > scale * 0.1) continue;
    if (Math.abs(a.args[1] - wantY) > 0.5 || Math.abs(b.args[1] - wantY) > 0.5) continue;   // horizontal, on the centre line
    return a;
  }
  return null;
}
ops.length = 0;
move(px(150) + scale / 2, py(150) + scale / 2);      // nothing there, so no underground is lit
{
  const overPole = tunnelSegment([100, 79]), overGround = tunnelSegment([99, 79]);
  if (!overGround) fail("no tunnel segment was drawn down the middle of (99,79)");
  if (!overPole) fail("no tunnel segment was drawn down the middle of (100,79)");
  if (overGround.alpha < 0.9) fail("over open ground the tunnel should be solid; alpha " + overGround.alpha);
  if (overPole.alpha > 0.4) fail("over a pole the tunnel should be dimmed; alpha " + overPole.alpha);
}
ops.length = 0;
move(px(101) + scale / 2, py(79) + scale / 2);       // hovering the entrance lights the whole run
{
  const overPole = tunnelSegment([100, 79]);
  if (!overPole) fail("the hovered underground drew no tunnel segment over (100,79)");
  if (overPole.alpha < 0.9) fail("a hovered tunnel should be solid the whole way; alpha " + overPole.alpha);
}

// Zoomed in, a belt is a dark track with two bright chevrons on it rather than one flat tile with a
// triangle. The chevrons are strokes in the tier's belt colour, inside the belt's own tile.
{
  for (const fn of windowListeners.keydown || []) fn({ key: "f", preventDefault() {} });   // fit, so every belt is on screen
  calibrate();
  const belt = bp.entities.find((e) => e.name === "transport-belt");
  if (!belt) fail("the fixture has no plain transport belt");
  if (scale < 8) fail("the fitted view is too small to draw chevrons: " + scale + " px a tile");
  const bx = Math.floor(belt.position.x), by = Math.floor(belt.position.y);
  ops.length = 0;
  move(px(bx) + scale / 2, py(by) + scale / 2);
  const inTile = (o) => o.args[0] > px(bx) && o.args[0] < px(bx) + scale && o.args[1] > py(by) && o.args[1] < py(by) + scale;
  const strokes = ops.filter((o) => (o.op === "moveTo" || o.op === "lineTo") && o.stroke === "#c9a227" && inTile(o));
  if (strokes.length < 6) fail("expected two chevrons (6 points) in the tier colour on the belt at " + [bx, by] + ", got " + strokes.length);
}

// A filtered splitter is marked on the side the filtered item leaves by. The mark has to name the
// same side the flow does, so this feeds a two-item belt into one and checks both: the flow sends
// iron plate out of one cell, and the drawing puts the filter mark on that same cell.
{
  const splitter = {
    entities: [
      { entity_number: 1, name: "transport-belt", position: { x: 0.5, y: 0.5 }, direction: 4 },
      { entity_number: 2, name: "splitter", position: { x: 1.5, y: 1 }, direction: 4,
        filter: { name: "iron-plate", quality: "normal", comparator: "=" }, output_priority: "right" },
      { entity_number: 3, name: "transport-belt", position: { x: 2.5, y: 0.5 }, direction: 4 },
      { entity_number: 4, name: "transport-belt", position: { x: 2.5, y: 1.5 }, direction: 4 },
    ],
    wires: [],
  };
  for (const fn of windowListeners.message) fn({ data: { type: "blueprint", bp: splitter, file: "splitter.json" } });
  calibrate();

  // what the flow says: the filtered item leaves by one cell, everything else by the other
  const feeds = [{ x: 0, y: 0, items: ["iron-plate", "copper-plate"], lane: "both" }];
  const flow = sandbox.window.FBPFlow.compute(splitter, null, sandbox.window.FBP_GAMEDATA || { recipes: {} }, feeds);
  const laneItems = (id) => { const L = flow.lanes[String(id)] || { left: [], right: [] }; return [...new Set(L.left.concat(L.right))].sort(); };
  const top = laneItems(3), bottom = laneItems(4);
  if (JSON.stringify(top) !== JSON.stringify(["copper-plate"]) || JSON.stringify(bottom) !== JSON.stringify(["iron-plate"])) {
    fail("the flow did not split the two items as expected: top " + JSON.stringify(top) + ", bottom " + JSON.stringify(bottom));
  }
  const wantCell = [1, 1];        // the splitter cell feeding the belt that gets the iron plate

  // what the page draws: the filter icon, or a coloured square when there is no atlas
  ops.length = 0;
  move(px(8) + scale / 2, py(8) + scale / 2);          // empty ground, so nothing is hovered
  const cell = sandbox.window.FBP_ICONS && sandbox.window.FBP_ICONS.names["iron-plate"];
  const marks = ops.filter((o) => (o.op === "drawImage" && cell && o.args[1] === cell[0] * sandbox.window.FBP_ICONS.size) ||
                                  (o.op === "fillRect" && o.fill === "#b9c4d2"));
  if (!marks.length) fail("a filtered splitter drew no filter mark");
  // both the edge bar and the icon are drawn in the filtered item's colours; every one of them
  // belongs to the cell the flow sends that item out of
  for (const m of marks) {
    const [mx, my, mw, mh] = m.op === "drawImage" ? [m.args[5], m.args[6], m.args[7], m.args[7]] : m.args;
    const got = [Math.floor((mx + mw / 2 - ox) / scale), Math.floor((my + mh / 2 - oy) / scale)];
    if (got[0] !== wantCell[0] || got[1] !== wantCell[1]) {
      fail("a filter mark (" + m.op + ") is on cell " + got + " but the flow sends the filtered item out of " + wantCell);
    }
  }
}

// The hosted page carries no icon atlas, so a visitor points it at the one `fbp icons` built on
// their machine. That path has to parse the manifest, switch the icons toggle on and say so.
(async () => {
  const manifest = { size: 4, cols: 2, rows: 1, file: "icons.png", names: { "iron-plate": [0, 0], radar: [1, 0] } };
  const body = "// generated by `fbp icons`" + String.fromCharCode(10) + "window.FBP_ICONS = " + JSON.stringify(manifest) + ";" + String.fromCharCode(10);
  const files = [{ name: "icons.png" }, { name: "icons.js", text: async () => body }];
  await nodes.get("iconpick").onchange({ target: { files, value: "" } });
  if (!/2 icons loaded from icons[.]png/.test(nodes.get("file").textContent)) {
    fail("picking an atlas by hand did not load it; the page says " + JSON.stringify(nodes.get("file").textContent));
  }
  if (nodes.get("icons").disabled || !nodes.get("icons").checked) fail("the icons toggle should be on after an atlas is loaded");

  await nodes.get("iconpick").onchange({ target: { files: [files[0]], value: "" } });
  if (!/pick both files/.test(nodes.get("file").textContent)) fail("picking only the png should say both files are needed");

  console.log("viewer smoke ok: %d draw calls, inserter hover marks pickup and drop, flow says %j", calls.fillRect, status);
})().catch((e) => fail("the icon picker threw: " + (e && e.stack ? e.stack.split(String.fromCharCode(10)).slice(0, 3).join(" | ") : e)));
