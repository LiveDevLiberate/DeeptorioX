// Node entry point used by the tests to compare the JavaScript flow with the Python one:
//   node flow_cli.js <blueprint.txt|json> <gamedata.json> [feeds.json]
// Prints the same JSON shape as `fbp flow --json`.
const fs = require("fs");
const zlib = require("zlib");
const { compute } = require("./flow.js");

const [, , bpPath, gdPath, feedsPath] = process.argv;
const text = fs.readFileSync(bpPath, "utf8").trim();
const obj = text.startsWith("{") ? JSON.parse(text) : JSON.parse(zlib.inflateSync(Buffer.from(text.slice(1), "base64")).toString("utf8"));
function first(o) { if (o.blueprint) return o.blueprint; for (const e of (o.blueprint_book || {}).blueprints || []) { const b = first(e); if (b) return b; } return null; }
const gd = JSON.parse(fs.readFileSync(gdPath, "utf8"));
const feeds = feedsPath ? JSON.parse(fs.readFileSync(feedsPath, "utf8")) : [];
process.stdout.write(JSON.stringify(compute(first(obj), gd.footprints, gd, feeds)));
