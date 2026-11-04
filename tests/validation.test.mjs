import assert from "node:assert/strict";
import test from "node:test";

const {
  arrayOf,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  describeValue,
  invalidFields,
  invalidPayload,
  isRecord,
  isStringArray,
  missingFields,
  numberOr,
  parseJson,
  parseJsonObject,
  pick,
  stringOr,
} = await import("../dist/validation.js");

test("isRecord/asRecord accept plain objects only", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  assert.equal(asRecord([1, 2]), undefined);
});

test("primitive guards narrow and reject non-finite numbers", () => {
  assert.equal(asString("x"), "x");
  assert.equal(asString(1), undefined);
  assert.equal(asNumber(1.5), 1.5);
  assert.equal(asNumber(Number.NaN), undefined);
  assert.equal(asNumber(Number.POSITIVE_INFINITY), undefined);
  assert.equal(asBoolean(false), false);
  assert.equal(asBoolean("true"), undefined);
  assert.equal(numberOr(undefined, 7), 7);
  assert.equal(numberOr("8", 7), 7);
  assert.equal(stringOr(undefined, "fallback"), "fallback");
});

test("pick and arrayOf validate nested payloads", () => {
  const payload = { outer: { list: [1, "two", 3], flag: true } };
  assert.equal(pick(payload, "outer", asRecord)?.flag, true);
  assert.equal(pick(payload, "missing", asRecord), undefined);
  const outer = asRecord(pick(payload, "outer", asRecord));
  assert.deepEqual(arrayOf(outer?.list, asNumber), [1, 3]);
  assert.deepEqual(arrayOf("nope", asNumber), []);
  assert.equal(isStringArray(["a", "b"]), true);
  assert.equal(isStringArray(["a", 1]), false);
});

test("parseJson never throws and preserves objects", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson("{not json"), undefined);
  assert.equal(parseJson(""), undefined);
  assert.equal(parseJson(123), undefined);
  assert.deepEqual(parseJsonObject(' {"ok":true} '), { ok: true });
  assert.equal(parseJsonObject("[1,2]"), undefined);
});

test("describeValue labels JSON shapes for diagnostics", () => {
  assert.equal(describeValue(null), "null");
  assert.equal(describeValue([]), "array");
  assert.equal(describeValue({}), "object");
  assert.equal(describeValue(3), "number");
  assert.equal(describeValue(undefined), "undefined");
});

test("missingFields and invalidFields report actionable names", () => {
  assert.deepEqual(missingFields({ a: 1 }, ["a", "b"]), ["b"]);
  assert.deepEqual(missingFields("nope", ["a"]), ["a"]);
  const schema = {
    x: (value) => asNumber(value) !== undefined,
    name: (value) => asString(value) !== undefined,
  };
  assert.deepEqual(invalidFields({ x: 1, name: "n" }, schema), []);
  assert.deepEqual(invalidFields({ x: "1", name: "n" }, schema), ["x"]);
  assert.deepEqual(invalidFields([], schema), ["x", "name"]);
});

test("invalidPayload produces a consistent error", () => {
  const error = invalidPayload("build request", ["entities"]);
  assert.ok(error instanceof Error);
  assert.match(error.message, /build request is invalid: entities/);
  assert.match(invalidPayload("x", []).message, /expected a JSON object/);
});
