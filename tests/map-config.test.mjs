import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMapGen, mapConfigMeta } from "../dist/map-config.js";

const base = {
  seed: 424242,
  peaceful_mode: true,
  autoplace_controls: { "enemy-base": { frequency: 0, size: 0 } },
};

test("normalizeMapGen validates and merges launch map settings", () => {
  const result = normalizeMapGen(
    {
      seed: 7,
      peaceful_mode: false,
      starting_area: 2.5,
      autoplace_controls: {
        "iron-ore": { frequency: 2, size: 1.5, richness: 4 },
        water: { frequency: 0.5 },
      },
    },
    base,
  );
  assert.deepEqual(result, {
    seed: 7,
    peaceful_mode: false,
    starting_area: 2.5,
    autoplace_controls: {
      "iron-ore": { frequency: 2, size: 1.5, richness: 4 },
      water: { frequency: 0.5 },
    },
  });
  assert.deepEqual(base, {
    seed: 424242,
    peaceful_mode: true,
    autoplace_controls: { "enemy-base": { frequency: 0, size: 0 } },
  });
});

test("normalizeMapGen falls back to the benchmark seed and keeps base fields", () => {
  const result = normalizeMapGen({ autoplace_controls: {} }, base);
  assert.equal(result.seed, 424242);
  assert.equal(result.peaceful_mode, true);
  assert.deepEqual(result.autoplace_controls, {});
});

test("normalizeMapGen rejects invalid or unsupported settings", () => {
  assert.throws(() => normalizeMapGen(null, base), /object/);
  assert.throws(() => normalizeMapGen({ seed: 1.5 }, base), /seed/);
  assert.throws(() => normalizeMapGen({ seed: -1 }, base), /seed/);
  assert.throws(() => normalizeMapGen({ seed: "42" }, base), /seed/);
  assert.throws(() => normalizeMapGen({ peaceful_mode: "yes" }, base), /peaceful_mode/);
  assert.throws(() => normalizeMapGen({ starting_area: 0.1 }, base), /starting_area/);
  assert.throws(() => normalizeMapGen({ unsupported: true }, base), /Unsupported map_gen field/);
  assert.throws(
    () => normalizeMapGen({ autoplace_controls: { "gold-ore": {} } }, base),
    /Unknown map resource/,
  );
  assert.throws(
    () => normalizeMapGen({ autoplace_controls: { "iron-ore": { frequency: 99 } } }, base),
    /between 0 and 10/,
  );
  assert.throws(
    () => normalizeMapGen({ autoplace_controls: { "iron-ore": { unknown: 1 } } }, base),
    /Unsupported control field/,
  );
});

test("mapConfigMeta exposes resources, presets and limits for the launch form", () => {
  const meta = mapConfigMeta();
  assert.ok(meta.resources.some((resource) => resource.id === "iron-ore"));
  assert.ok(meta.resources.some((resource) => resource.id === "enemy-base"));
  assert.ok(meta.presets.some((preset) => preset.value === 0));
  assert.equal(meta.limits.seed.max, 4294967295);
});
