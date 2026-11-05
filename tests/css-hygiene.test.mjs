import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const STYLES = path.join(process.cwd(), "public", "styles");

/** Parse flat CSS rules with their at-rule context (media/supports/keyframes). */
function parseRules(text) {
  const rules = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text[i] === "}") {
      stack.pop();
      i += 1;
      continue;
    }
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < text.length && depth > 0) {
      if (text.startsWith("/*", cursor)) {
        const end = text.indexOf("*/", cursor + 2);
        cursor = end < 0 ? text.length : end + 2;
        continue;
      }
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = text.slice(open + 1, cursor - 1);
    if (head.startsWith("@")) {
      stack.push(head.replace(/\s+/g, " "));
      i = cursor;
      continue;
    }
    const context = stack.join(" / ");
    const selectors = head
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    const properties = body
      .split(";")
      .map((declaration) => declaration.split(":", 1)[0].trim())
      .filter(Boolean);
    rules.push({ context, selectors, properties });
    i = cursor;
  }
  return rules;
}

test("stylesheet modules have no duplicate declarations or fully shadowed rules", () => {
  const files = fs
    .readdirSync(STYLES)
    .filter((file) => file.endsWith(".css"))
    .sort();
  assert.ok(files.length >= 5);
  const problems = [];
  for (const file of files) {
    const rules = parseRules(fs.readFileSync(path.join(STYLES, file), "utf8"));
    for (const rule of rules) {
      const seen = new Set();
      for (const property of rule.properties) {
        if (seen.has(property))
          problems.push(`${file}: duplicate ${property} in ${rule.selectors.join(", ")}`);
        seen.add(property);
      }
    }
    // A rule is fully shadowed when a later rule in the same context and with
    // the same selector declares every property it declares.
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      const later = new Map();
      for (let next = rules.length - 1; next > index; next -= 1) {
        const candidate = rules[next];
        if (candidate.context !== rule.context) continue;
        for (const selector of candidate.selectors) {
          if (!later.has(selector)) later.set(selector, new Set());
          for (const property of candidate.properties) later.get(selector).add(property);
        }
      }
      for (const selector of rule.selectors) {
        const covered = later.get(selector);
        if (covered && rule.properties.length && rule.properties.every((property) => covered.has(property))) {
          problems.push(`${file}: fully shadowed rule ${selector} (${rule.properties.length} properties)`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});
