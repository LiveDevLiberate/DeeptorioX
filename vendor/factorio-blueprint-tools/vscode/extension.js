// Factorio blueprint viewer for VS Code.
//
// Decoding happens here in the extension host with Node's zlib, so the webview
// only ever receives JSON. Footprints come from ../data/gamedata.json (built by
// `fbp gamedata`) so the map agrees with the command line tool.
const vscode = require("vscode");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

let panel = null;
let output = null;

function toolsPath() {
  const cfg = vscode.workspace.getConfiguration("fbp").get("toolsPath");
  return cfg && cfg.length ? cfg : path.resolve(__dirname, "..");
}

function decodeText(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  if (!t.startsWith("0")) throw new Error("Not a blueprint string (expected leading '0')");
  return JSON.parse(zlib.inflateSync(Buffer.from(t.slice(1), "base64")).toString("utf8"));
}

function firstBlueprint(obj) {
  if (obj.blueprint) return obj.blueprint;
  if (obj.blueprint_book) {
    for (const e of obj.blueprint_book.blueprints || []) {
      const bp = firstBlueprint(e);
      if (bp) return bp;
    }
  }
  return null;
}

let gamedataCache = null;
function loadGamedata() {
  if (gamedataCache) return gamedataCache;
  try {
    const p = path.join(toolsPath(), "data", "gamedata.json");
    const g = JSON.parse(fs.readFileSync(p, "utf8"));
    const items = new Set();
    for (const r of Object.values(g.recipes || {})) {
      for (const k of Object.keys(r.ingredients || {})) items.add(k);
      for (const k of Object.keys(r.results || {})) items.add(k);
    }
    gamedataCache = { footprints: g.footprints || {}, recipes: Object.keys(g.recipes || {}).sort(), items: [...items].sort() };
  } catch (e) {
    gamedataCache = { footprints: {}, recipes: [] };
  }
  return gamedataCache;
}

function send(doc) {
  if (!panel) return;
  current = doc;
  try {
    const obj = decodeText(doc.getText());
    const bp = firstBlueprint(obj);
    if (!bp) throw new Error("No blueprint in this file");
    const g = loadGamedata();
    const iconsPng = path.join(toolsPath(), "vscode", "media", "icons.png");
    const iconsUrl = fs.existsSync(iconsPng) ? String(panel.webview.asWebviewUri(vscode.Uri.file(iconsPng))) : null;
    panel.webview.postMessage({ type: "blueprint", bp, footprints: g.footprints, recipes: g.recipes,
                                items: g.items, iconsUrl, file: path.basename(doc.fileName) });
    panel.title = "fbp: " + (bp.label || path.basename(doc.fileName));
    runFlow(doc.fileName);
  } catch (e) {
    panel.webview.postMessage({ type: "error", message: String(e.message || e) });
  }
}

// Lane flow is computed by the Python side (single implementation of the belt rules) and
// pushed to the page. Edge feeds live beside the blueprint as <name>.feeds.json.
function feedsPath(file) { return file.replace(/\.[^.]+$/, "") + ".feeds.json"; }
let flowSeq = 0;
function log(line) {
  if (!output) output = vscode.window.createOutputChannel("fbp");
  output.appendLine(line);
}
async function runFlow(file) {
  const seq = ++flowSeq;
  const started = Date.now();
  const tmp = path.join(require("os").tmpdir(), "fbp-flow-" + process.pid + ".json");
  if (panel) panel.webview.postMessage({ type: "flowstatus", text: "running fbp flow…" });
  log("$ fbp flow \"" + file + "\" --json " + tmp);
  const res = await runFbpCollect(["flow", file, "--json", tmp]);
  const ms = Date.now() - started;
  if (seq !== flowSeq || !panel) return;
  if (res.code !== 0) {
    log(res.out);
    panel.webview.postMessage({ type: "flow", error: res.out.trim().split("\n").pop() + " (see the fbp output channel)" });
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(tmp, "utf8"));
    const st = { ok: 0, missing: 0, unknown: 0 };
    for (const m of Object.values(data.machines || {})) if (st[m.status] !== undefined) st[m.status]++;
    log("flow: " + Object.keys(data.lanes || {}).length + " belts resolved, " + (data.feeds || []).length + " feeds, machines ok/missing/unknown " +
        st.ok + "/" + st.missing + "/" + st.unknown + " in " + ms + " ms");
    panel.webview.postMessage({ type: "flow", data, feedsFile: path.basename(feedsPath(file)), ms });
  } catch (e) {
    panel.webview.postMessage({ type: "flow", error: String(e.message || e) });
  }
}
function saveFeeds(feeds) {
  if (!current) {
    if (panel) panel.webview.postMessage({ type: "flow", error: "no source file is attached to this panel; open the blueprint with the fbp command" });
    return;
  }
  const p = feedsPath(current.fileName);
  try {
    if (feeds.length) fs.writeFileSync(p, JSON.stringify(feeds, null, 1), "utf8");
    else if (fs.existsSync(p)) fs.unlinkSync(p);
    log("feeds: wrote " + feeds.length + " feed(s) to " + p);
  } catch (e) {
    panel.webview.postMessage({ type: "flow", error: "could not write " + p + ": " + String(e.message || e) });
    return;
  }
  runFlow(current.fileName);
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Next free "<name> - edit N.txt" beside the source. Never overwrites the source.
function nextOutputPath(src) {
  const dir = path.dirname(src), ext = path.extname(src);
  let stem = path.basename(src, ext).replace(/ - edit( \d+)?$/, "");
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, stem + " - edit" + (n === 1 ? "" : " " + n) + ext);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function runFbpCollect(args) {
  const py = vscode.workspace.getConfiguration("fbp").get("python") || "python";
  return new Promise((resolve) => {
    const child = spawn(py, ["-m", "fbp", ...args], { cwd: toolsPath() });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("close", (code) => resolve({ code, out }));
  });
}

// Export: save the patch beside the source, apply it with fbp patch, diff old vs new, load the result.
async function exportPatch(patch) {
  if (!current) { vscode.window.showWarningMessage("fbp: no source file for this blueprint."); return; }
  const src = current.fileName;
  const patchDir = path.join(path.dirname(src), "patches");
  fs.mkdirSync(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, path.basename(src, path.extname(src)).replace(/ - edit( \d+)?$/, "") + "-" + stamp() + ".json");
  fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2), "utf8");
  const outPath = nextOutputPath(src);
  if (!output) output = vscode.window.createOutputChannel("fbp");
  output.show(true);
  output.appendLine("=== export: " + path.basename(src) + " -> " + path.basename(outPath));
  output.appendLine("patch saved: " + patchPath);
  const applied = await runFbpCollect(["patch", src, patchPath, "-o", outPath]);
  output.append(applied.out);
  if (applied.code !== 0) {
    vscode.window.showErrorMessage("fbp patch refused the edit; see the fbp output channel.");
    return;
  }
  output.appendLine("--- fbp diff");
  const diff = await runFbpCollect(["diff", src, outPath]);
  output.append(diff.out);
  output.appendLine("--- fbp check");
  const chk = await runFbpCollect(["check", outPath]);
  output.append(chk.out.split("\n").filter((l) => !l.includes("only unknown sources")).join("\n"));
  const doc = await vscode.workspace.openTextDocument(outPath);
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One, preserveFocus: true });
  send(doc);
  const msg = "fbp: wrote " + path.basename(outPath) + (diff.code === 0 ? " (diff clean)" : " (diff reports NEW findings, see output)");
  if (diff.code === 0) vscode.window.showInformationMessage(msg); else vscode.window.showWarningMessage(msg);
}

let current = null;

function openViewer(context) {
  const editor = vscode.window.activeTextEditor;
  // With no editor the panel still opens; its open… button picks a file.
  const doc = editor && !editor.document.fileName.endsWith(".js") ? editor.document : null;
  if (!panel) {
    panel = vscode.window.createWebviewPanel("fbpViewer", "fbp viewer", vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))],
    });
    const mediaUri = (f) => panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "media", f)));
    let html = fs.readFileSync(path.join(context.extensionPath, "media", "viewer.html"), "utf8");
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src ' + panel.webview.cspSource + ' data:; style-src ' +
      panel.webview.cspSource + " 'unsafe-inline'; script-src " + panel.webview.cspSource + ';">';
    html = html.replace("<!--CSP-->", csp)
      .replace('href="viewer.css"', 'href="' + mediaUri("viewer.css") + '"')
      .replace('src="gamedata.js"', 'src="' + mediaUri("gamedata.js") + '"')
      .replace('src="icons.js"', 'src="' + mediaUri("icons.js") + '"')
      .replace('src="flow.js"', 'src="' + mediaUri("flow.js") + '"')
      .replace('src="viewer.js"', 'src="' + mediaUri("viewer.js") + '"');
    panel.webview.html = html;
    panel.onDidDispose(() => { panel = null; });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === "copy") vscode.env.clipboard.writeText(m.text);
      if (m.type === "status") vscode.window.setStatusBarMessage(m.text, 3000);
      if (m.type === "export") await exportPatch(m.patch);
      if (m.type === "feeds") saveFeeds(m.feeds || []);
      if (m.type === "open") {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false, openLabel: "Open blueprint",
          filters: { "Blueprint strings": ["txt", "fbp", "json"], "All files": ["*"] },
        });
        if (picked && picked[0]) send(await vscode.workspace.openTextDocument(picked[0]));
      }
    });
  }
  if (doc) send(doc);
  const sub = vscode.workspace.onDidSaveTextDocument((d) => { if (d === current) send(d); });
  context.subscriptions.push(sub);
}

function runFbp(args, title) {
  const py = vscode.workspace.getConfiguration("fbp").get("python") || "python";
  if (!output) output = vscode.window.createOutputChannel("fbp");
  output.show(true);
  output.appendLine("$ " + py + " -m fbp " + args.map((a) => (a.includes(" ") ? '"' + a + '"' : a)).join(" "));
  const child = spawn(py, ["-m", "fbp", ...args], { cwd: toolsPath() });
  child.stdout.on("data", (d) => output.append(d.toString()));
  child.stderr.on("data", (d) => output.append(d.toString()));
  child.on("close", (code) => output.appendLine("[" + title + " exited " + code + "]"));
}

function activeFile() {
  const editor = vscode.window.activeTextEditor;
  return editor ? editor.document.fileName : null;
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("fbp.open", () => openViewer(context)));
  context.subscriptions.push(vscode.commands.registerCommand("fbp.check", () => {
    const f = activeFile(); if (f) runFbp(["check", f], "check");
  }));
  context.subscriptions.push(vscode.commands.registerCommand("fbp.trace", async () => {
    const f = activeFile(); if (!f) return;
    const recipe = await vscode.window.showInputBox({ prompt: "Recipe to trace (e.g. big-electric-pole)" });
    if (recipe) runFbp(["trace", f, "--recipe", recipe], "trace");
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
