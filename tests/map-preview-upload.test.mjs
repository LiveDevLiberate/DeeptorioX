import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadMapPreview } from "../dist/map-preview-upload.js";

const id = "feedfacecafebeef";

test("preview uploaders support skip and local_sync", async () => {
  const sourceDir = path.join(process.cwd(), ".autorio", "map-previews");
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = path.join(sourceDir, `${id}.png`);
  fs.writeFileSync(source, "png");
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-upload-"));
  try {
    const skip = await uploadMapPreview({ id, method: "skip" });
    assert.equal(skip.method, "skip");
    const local = await uploadMapPreview({ id, method: "local_sync", target });
    assert.equal(local.method, "local_sync");
    assert.equal(fs.readFileSync(path.join(target, `${id}.png`), "utf8"), "png");
    await assert.rejects(() => uploadMapPreview({ id: "0123456789abcdef", method: "skip" }));
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(source, { force: true });
  }
});

test("toolkit viewer config accepts a dynamic preview query", () => {
  const config = fs.readFileSync("public/toolkit-viewer/viewer_config.js", "utf8");
  assert.match(config, /URLSearchParams/);
  assert.match(config, /planetPreviewSources/);
});
