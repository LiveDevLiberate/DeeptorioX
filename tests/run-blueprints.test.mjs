import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { decodeBlueprintString } from "../dist/blueprints.js";
import {
  listRunBlueprints,
  readRunBlueprint,
  registerRunBlueprint,
  updateRunBlueprint,
  deleteRunBlueprint,
} from "../dist/run-blueprints.js";

function blueprintWire(payload, { prefix = "0" } = {}) {
  return `${prefix}${zlib.deflateSync(Buffer.from(JSON.stringify(payload))).toString("base64")}`;
}

function payload(entities = [], extra = {}) {
  return {
    blueprint: {
      item: "blueprint",
      version: 562949953421312,
      label: "Smelting block",
      description: "Two columns of furnaces",
      entities,
      tiles: [{ name: "stone-path", position: { x: 0, y: 0 } }],
      ...extra,
    },
  };
}

test("decodes a Factorio blueprint and computes a display summary", () => {
  const wire = blueprintWire(
    payload([
      { entity_number: 1, name: "stone-furnace", position: { x: 0.5, y: 0.5 } },
      { entity_number: 2, name: "stone-furnace", position: { x: 2.5, y: 0.5 } },
      { entity_number: 3, name: "transport-belt", position: { x: 0.5, y: 2.5 } },
    ]),
  );
  const decoded = decodeBlueprintString(` \n${wire}\n`);
  assert.equal(decoded.summary.blueprint_type, "blueprint");
  assert.equal(decoded.summary.label, "Smelting block");
  assert.equal(decoded.summary.entity_count, 3);
  assert.equal(decoded.summary.tile_count, 1);
  assert.deepEqual(decoded.summary.top_entities, [
    { name: "stone-furnace", count: 2 },
    { name: "transport-belt", count: 1 },
  ]);
  assert.equal(decoded.summary.width, 3);
  assert.equal(decoded.summary.height, 3);
  assert.match(decoded.sha256, /^[a-f0-9]{64}$/);
});

test("accepts unprefixed and legacy version-byte blueprint payloads", () => {
  const value = payload([{ entity_number: 1, name: "stone-furnace", position: { x: 0.5, y: 0.5 } }]);
  const unprefixed = blueprintWire(value, { prefix: "" });
  assert.equal(decodeBlueprintString(unprefixed).summary.entity_count, 1);
  const legacy = `${"0"}${zlib
    .deflateSync(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value))]))
    .toString("base64")}`;
  assert.equal(decodeBlueprintString(legacy).summary.entity_count, 1);
});

test("rejects malformed blueprint strings", () => {
  assert.throws(() => decodeBlueprintString(""), /empty/);
  assert.throws(() => decodeBlueprintString("not*base64"), /base64/);
  assert.throws(() => decodeBlueprintString("0bm90LXpsaWI="), /zlib|JSON|blueprint/);
});

test("stores, deduplicates and reads run blueprints", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-blueprints-"));
  try {
    const wire = blueprintWire(
      payload([{ entity_number: 1, name: "stone-furnace", position: { x: 0.5, y: 0.5 } }]),
    );
    const first = registerRunBlueprint(runDir, "run-1", {
      blueprint: wire,
      label: "Starter smelting",
      source: "saved",
    });
    assert.equal(first.duplicate, false);
    assert.match(first.blueprint.id, /^[a-f0-9]{16}$/);
    assert.equal(first.blueprint.label, "Starter smelting");
    assert.ok(fs.existsSync(path.join(runDir, "blueprints", `${first.blueprint.sha256}.txt`)));
    const duplicate = registerRunBlueprint(runDir, "run-1", { blueprint: wire, source: "built" });
    assert.equal(duplicate.duplicate, true);
    assert.equal(listRunBlueprints(runDir, "run-1").length, 1);
    const detail = readRunBlueprint(runDir, "run-1", first.blueprint.id);
    assert.equal(detail.wire, wire);
    assert.equal(detail.payload.blueprint.label, "Smelting block");
    assert.equal(readRunBlueprint(runDir, "run-1", "0000000000000000"), undefined);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("rejects unavailable sources for a registered blueprint", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-blueprints-"));
  try {
    assert.throws(
      () => registerRunBlueprint(runDir, "run-1", { blueprint: "0", source: "unknown" }),
      /source|zlib|blueprint|base64/,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("updates and deletes an indexed blueprint", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-blueprints-"));
  try {
    const wire = blueprintWire(
      payload([{ entity_number: 1, name: "stone-furnace", position: { x: 0.5, y: 0.5 } }]),
    );
    const registered = registerRunBlueprint(runDir, "run-1", { blueprint: wire, source: "saved" });
    const updated = updateRunBlueprint(runDir, "run-1", registered.blueprint.id, {
      label: "Renamed smelting",
      description: "Reusable block",
    });
    assert.equal(updated.label, "Renamed smelting");
    assert.equal(updated.description, "Reusable block");
    assert.equal(listRunBlueprints(runDir, "run-1")[0].label, "Renamed smelting");
    assert.equal(deleteRunBlueprint(runDir, "run-1", registered.blueprint.id), true);
    assert.equal(listRunBlueprints(runDir, "run-1").length, 0);
    assert.equal(fs.existsSync(path.join(runDir, "blueprints", `${registered.blueprint.sha256}.txt`)), false);
    assert.equal(deleteRunBlueprint(runDir, "run-1", registered.blueprint.id), false);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
