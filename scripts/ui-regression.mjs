#!/usr/bin/env node
/**
 * Dependency-free browser regression check for the recording UI.
 *
 * Serves the real public/recording.html with mocked manager API responses, runs
 * system Edge/Chrome headless, and asserts layout, contrast, target sizes, icon
 * sizes, dialog focus handling and the connection-error state. The browser page
 * publishes its measurements as <html data-audit="<base64 JSON>">; this runner
 * reads them from --dump-dom output.
 *
 * Usage: npm run test:ui
 * Env: AUTORIO_UI_BROWSER (explicit browser path)
 *      AUTORIO_UI_REQUIRED=1 (fail instead of skipping when no browser exists)
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFixtureHtml, EVENT_LOG, RUN_FIXTURE, TELEMETRY_LOG } from "./ui-regression-fixture.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC = join(ROOT, "public");
const ARTIFACTS = join(ROOT, ".ui-review", "ui-regression");
const ARTIFACT_ENABLED = process.env.AUTORIO_UI_SCREENSHOTS !== "0";

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function browserCandidates() {
  if (process.env.AUTORIO_UI_BROWSER) return [process.env.AUTORIO_UI_BROWSER];
  if (process.platform === "win32") {
    return [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  const linux = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const wsl = [
    "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  ];
  return [...linux, ...wsl];
}

function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "msedge"]) {
    const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

const isWindowsBinary = (browser) => process.platform !== "win32" && /\.exe$/i.test(browser);

function windowsPath(path) {
  if (process.platform === "win32" || !isWindowsBinary(browser)) return path;
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : path;
}

function startServer() {
  const html = buildFixtureHtml(readFileSync(join(PUBLIC, "recording.html"), "utf8"));
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/runs") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ schema_version: 2, runs: [{ id: RUN_FIXTURE.id }] }));
      return;
    }
    if (url.pathname === `/api/runs/${RUN_FIXTURE.id}`) {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(RUN_FIXTURE));
      return;
    }
    if (url.pathname === `/api/runs/${RUN_FIXTURE.id}/log`) {
      const source = url.searchParams.get("source") || "events";
      const offset = Number(url.searchParams.get("offset") || "0");
      const text = source === "telemetry" ? TELEMETRY_LOG : EVENT_LOG;
      const data = offset === 0 ? text : "";
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          data: Buffer.from(data, "utf8").toString("base64"),
          offset: offset === 0 ? Buffer.byteLength(text, "utf8") : offset,
        }),
      );
      return;
    }
    if (url.pathname === "/" || url.pathname === "/recording.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    const requested = normalize(url.pathname).replace(/^([/\\])+/, "");
    const file = join(PUBLIC, requested);
    if (!file.startsWith(PUBLIC + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(file));
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port }));
  });
}

function decodeAudit(dom) {
  const match = dom.match(/data-audit="([^"]+)"/);
  if (!match) {
    throw new Error("recording page did not publish an audit result (data-audit missing)");
  }
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

function pngSize(path) {
  const buffer = readFileSync(path);
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function runBrowser(browser, url, { width, height, screenshot, profile }) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--hide-scrollbars",
    "--virtual-time-budget=9000",
    `--window-size=${width},${height}`,
    `--user-data-dir=${windowsPath(profile)}`,
  ];
  if (screenshot) args.push(`--screenshot=${windowsPath(screenshot)}`);
  else args.push("--dump-dom");
  args.push(url);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`browser timed out after 45s: ${stderr.slice(-500)}`));
    }, 45000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0 && !screenshot) {
        finish(new Error(`browser exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      if (!screenshot) {
        if (!stdout) {
          finish(new Error(`browser produced no DOM (exit ${code}): ${stderr.slice(-500)}`));
          return;
        }
        finish(null, { dom: stdout, stderr, status: code });
        return;
      }
      if (!existsSync(screenshot) || statSync(screenshot).size < 100) {
        finish(new Error(`browser produced no screenshot (exit ${code}): ${stderr.slice(-500)}`));
        return;
      }
      finish(null, { dom: "", stderr, status: code });
    });
  });
}

let browser = null;
const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

function assertNormalAudit(theme, width, audit) {
  check(`${theme}-${width}: audit completed`, () => {
    assert.equal(audit.mode, "normal");
    assert.ok(audit.ready, "recording page did not finish rendering");
  });
  check(`${theme}-${width}: no horizontal overflow`, () => {
    assert.deepEqual(audit.overflow, []);
  });
  check(`${theme}-${width}: metrics and radar share a row`, () => {
    const { metrics, radar } = audit.geometry;
    assert.ok(metrics && radar, "metrics table or radar missing");
    assert.ok(Math.abs(metrics.h - radar.h) <= 1, `height mismatch ${metrics.h} vs ${radar.h}`);
    assert.ok(Math.abs(metrics.y - radar.y) <= 1, `top mismatch ${metrics.y} vs ${radar.y}`);
    assert.ok(
      Math.abs(metrics.bottom - radar.bottom) <= 1,
      `bottom mismatch ${metrics.bottom} vs ${radar.bottom}`,
    );
  });
  check(`${theme}-${width}: core contrast`, () => {
    for (const key of ["statusMeta", "sectionKicker", "done", "reasoning", "command"]) {
      if (audit.contrast[key] == null) continue;
      assert.ok(audit.contrast[key] >= 4.5, `${key} contrast ${audit.contrast[key]}`);
    }
    if (audit.mapNoteContrast != null) {
      assert.ok(audit.mapNoteContrast >= 4.5, `map dialog note contrast ${audit.mapNoteContrast}`);
    }
  });
  check(`${theme}-${width}: 30px controls`, () => {
    for (const [selector, rect] of Object.entries(audit.targets)) {
      assert.ok(rect.h >= 24, `${selector} height ${rect.h}`);
      if (selector !== ".search-field") assert.ok(rect.w >= 24, `${selector} width ${rect.w}`);
    }
  });
  check(`${theme}-${width}: icon scale`, () => {
    const allowed = new Set(["12", "14", String(Math.round(audit.icons.heroFont))]);
    for (const [size, count] of Object.entries(audit.icons.sizes)) {
      assert.ok(
        allowed.has(size),
        `${count} icon(s) at ${size}px, expected 12/14/hero (${audit.icons.heroFont})`,
      );
    }
    assert.ok(audit.icons.allAriaHidden, "visible icons missing aria-hidden");
    assert.ok(audit.icons.heroSize != null, "work-order icon missing");
    assert.ok(
      Math.abs(audit.icons.heroSize - audit.icons.heroFont) <= 0.5,
      `hero icon ${audit.icons.heroSize} vs font ${audit.icons.heroFont}`,
    );
  });
  check(`${theme}-${width}: dialog focus`, () => {
    assert.ok(audit.dialog.opened, "map dialog did not open");
    assert.ok(audit.dialog.backgroundInert, "background was not inert/aria-hidden");
    assert.ok(audit.dialog.wrapForward, "Tab from last focusable did not wrap to first");
    assert.ok(audit.dialog.wrapBackward, "Shift+Tab from first focusable did not wrap to last");
    assert.ok(audit.dialog.closed, "Escape did not close the map dialog");
    assert.ok(audit.dialog.focusReturned, "focus did not return to the map trigger");
  });
}

function assertErrorAudit(audit) {
  check("error: connection notice is visible", () => {
    assert.equal(audit.mode, "error");
    assert.ok(audit.notice && audit.notice.text, "connection notice missing");
    assert.ok(audit.alert.includes("connection lost"), `alert text: ${audit.alert}`);
  });
  check("error: notice contrast", () => {
    assert.ok(audit.notice.contrast >= 4.5, `notice contrast ${audit.notice.contrast}`);
  });
}

async function main() {
  browser = findBrowser();
  if (!browser) {
    const message = "no Edge/Chrome found; set AUTORIO_UI_BROWSER to run browser UI checks";
    if (process.env.AUTORIO_UI_REQUIRED === "1") throw new Error(message);
    console.warn(`SKIP ui regression: ${message}`);
    return;
  }
  if (ARTIFACT_ENABLED) mkdirSync(ARTIFACTS, { recursive: true });
  console.log(`ui regression browser: ${browser}`);
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}/recording.html`;
  const profile = mkdtempSync(join(tmpdir(), "autorio-ui-"));
  try {
    for (const theme of ["dark", "light"]) {
      for (const [width, height] of [
        [1280, 900],
        [390, 844],
      ]) {
        const url = `${base}?theme=${theme}&status=expanded`;
        const { dom } = await runBrowser(browser, url, { width, height, profile });
        const audit = decodeAudit(dom);
        assertNormalAudit(theme, width, audit);
        if (ARTIFACT_ENABLED) {
          const screenshot = join(ARTIFACTS, `recording-${theme}-${width}.png`);
          await runBrowser(browser, url, { width, height, screenshot, profile });
          const size = pngSize(screenshot);
          check(`${theme}-${width}: screenshot`, () => {
            assert.equal(size.width, width);
            assert.equal(size.height, height);
          });
        }
      }
    }

    const dialogUrl = `${base}?theme=light&status=expanded&dialog=1`;
    const dialogDom = (await runBrowser(browser, dialogUrl, { width: 1280, height: 900, profile })).dom;
    check("map dialog: visual artifact", () => {
      assert.ok(decodeAudit(dialogDom).dialog.opened);
    });
    if (ARTIFACT_ENABLED) {
      const screenshot = join(ARTIFACTS, "recording-light-1280-dialog.png");
      await runBrowser(browser, dialogUrl, { width: 1280, height: 900, screenshot, profile });
      check("map dialog: screenshot", () => {
        assert.deepEqual(pngSize(screenshot), { width: 1280, height: 900 });
      });
    }

    const errorUrl = `${base}?theme=dark&status=expanded&fail=1`;
    const errorDom = (await runBrowser(browser, errorUrl, { width: 1280, height: 900, profile })).dom;
    assertErrorAudit(decodeAudit(errorDom));
    if (ARTIFACT_ENABLED) {
      const screenshot = join(ARTIFACTS, "recording-dark-1280-error.png");
      await runBrowser(browser, errorUrl, { width: 1280, height: 900, screenshot, profile });
      check("error: screenshot", () => {
        assert.deepEqual(pngSize(screenshot), { width: 1280, height: 900 });
      });
    }
  } finally {
    server.close();
    if (ARTIFACT_ENABLED) {
      console.log(`ui screenshots: ${ARTIFACTS}`);
    }
    if (!isWindowsBinary(browser)) rmSync(profile, { recursive: true, force: true });
  }

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure.name}: ${failure.message}`);
    throw new Error(`${failures.length} browser UI check(s) failed`);
  }
  console.log("browser UI regression: OK");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
