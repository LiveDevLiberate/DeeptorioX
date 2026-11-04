import test from "node:test";
import assert from "node:assert/strict";
import { factorioLocale, isSafeLocale } from "../dist/locale.js";

test("factorioLocale maps agent languages to installed Factorio locales", () => {
  assert.equal(factorioLocale("Chinese"), "zh-CN");
  assert.equal(factorioLocale("中文"), "zh-CN");
  assert.equal(factorioLocale("简体中文"), "zh-CN");
  assert.equal(factorioLocale("Traditional Chinese"), "zh-TW");
  assert.equal(factorioLocale("English"), "en");
  assert.equal(factorioLocale("Deutsch"), "de");
  assert.equal(factorioLocale("日本語"), "ja");
  assert.equal(factorioLocale("NotALanguage"), "en");
  assert.equal(factorioLocale(""), "en");
  assert.equal(factorioLocale(undefined), "en");
  assert.equal(factorioLocale("zh-CN"), "zh-CN");
  assert.equal(factorioLocale("es-ES"), "es-ES");
});

test("isSafeLocale only accepts config.ini-safe locale identifiers", () => {
  assert.equal(isSafeLocale("zh-CN"), true);
  assert.equal(isSafeLocale("en"), true);
  assert.equal(isSafeLocale("zh_cn"), false);
  assert.equal(isSafeLocale("zh-CN\nlocale"), false);
});
