import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ROOT, DATA_DIR, PORT, execFileAsync } from "./runtime.js";
import { IS_WINDOWS, closeWindowsWithTitle, findBrowser, killProcessTree, waitForWindowTitle } from "./platform.js";

export const RECORDING_APP = path.join(DATA_DIR, "Autorio Recording.app");
const executable = path.join(RECORDING_APP, "Contents/MacOS/autorio-recording-window");
let building: Promise<void> | undefined;
const TERMINAL_STATES = new Set(["completed", "failed", "stopped", "timed_out", "interrupted", "paused"]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function buildRecordingApp() {
  if (process.platform !== "darwin") throw new Error("The recording window requires macOS");
  if (building) return building;
  building = (async () => {
    const source = path.join(ROOT, "native/recording-window.swift");
    const hash = createHash("sha256").update(await fs.promises.readFile(source)).digest("hex");
    const stamp = path.join(DATA_DIR, "recording-app.sha256");
    if (fs.existsSync(executable) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === hash) return;
    await fs.promises.mkdir(path.dirname(executable), { recursive: true });
    const cache = path.join(DATA_DIR, "swift-module-cache");
    await fs.promises.mkdir(cache, { recursive: true });
    // A developer shell can export SDKROOT for a newer, incompatible SDK. Prefer
    // the installed Command Line Tools' selected SDK unless explicitly overridden.
    const selectedSDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
    const sdk = process.env.AUTORIO_MACOS_SDK || (fs.existsSync(selectedSDK) ? selectedSDK :
      (await execFileAsync("/usr/bin/xcrun", ["--show-sdk-path"])).stdout.trim());
    await execFileAsync("/usr/bin/xcrun", ["swiftc", "-sdk", sdk, "-O", "-module-cache-path", cache, source, "-o", executable], { timeout: 120_000 });
    await fs.promises.writeFile(path.join(RECORDING_APP, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.autorio.recording-window</string>
<key>CFBundleName</key><string>Autorio Recording</string>
<key>CFBundleExecutable</key><string>autorio-recording-window</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>

</dict></plist>`);
    await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", RECORDING_APP], { timeout: 10_000 });
    await fs.promises.writeFile(stamp, hash);
  })();
  try { await building; } finally { building = undefined; }
}

/** Owns a separate WKWebView window; never selects an unrelated browser window. */
export async function openRunRecording(dir: string): Promise<void> {
  if (IS_WINDOWS) return openWindowsRecording(dir);
  await buildRecordingApp();
  const resultFile = path.join(dir, "recording-window.json");
  const run=JSON.parse(fs.readFileSync(path.join(dir,"run.json"),"utf8"));
  const url = `http://127.0.0.1:${PORT}/recording.html?run=${encodeURIComponent(path.basename(dir))}&segment=${run.segments?.at(-1)?.index || 1}`;
  const args = ["--recording-url", url, "--run-file", path.join(dir, "run.json"), "--result", resultFile];
  await fs.promises.rm(resultFile, { force: true });
  // Return once opened; the app monitors run.json and closes itself after the run ends.
  await execFileAsync("/usr/bin/open", ["-n", RECORDING_APP, "--args", ...args], { timeout: 10_000 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      const result = JSON.parse(await fs.promises.readFile(resultFile, "utf8"));
      if (result.status !== "opened") throw new Error(result.message || "Recording page failed to open");
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Recording window did not finish opening. The recording view remains available from the dashboard.");
}

/**
 * Windows has no equivalent standalone WKWebView helper; use a Chromium app-mode
 * window with its own profile so the title ("Agent transcript") and process tree
 * are exclusively ours. OBS selects it by title on Windows.
 */
async function openWindowsRecording(dir: string): Promise<void> {
  const browser = findBrowser();
  if (!browser) throw new Error("Install Microsoft Edge or Google Chrome (or set AUTORIO_BROWSER) to open the recording window");
  const runFile = path.join(dir, "run.json");
  const resultFile = path.join(dir, "recording-window.json");
  const run = JSON.parse(await fs.promises.readFile(runFile, "utf8"));
  const url = `http://127.0.0.1:${PORT}/recording.html?run=${encodeURIComponent(path.basename(dir))}&segment=${run.segments?.at(-1)?.index || 1}`;
  const profileDir = path.join(DATA_DIR, "recording-window-profile", path.basename(dir));
  await fs.promises.rm(profileDir, { recursive: true, force: true });
  await fs.promises.mkdir(profileDir, { recursive: true });
  await fs.promises.rm(resultFile, { force: true });
  const child = spawn(browser, [
    `--app=${url}`,
    "--window-size=470,800",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--noerrdialogs",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-extensions",
    "--disable-background-mode",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-features=Translate,MediaRouter",
  ], { detached: false, stdio: "ignore", windowsHide: false });
  let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
  let opened = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !spawnError) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) { opened = true; break; }
    } catch { /* window is still starting */ }
    await sleep(250);
  }
  if (!opened) {
    if (child.pid) killProcessTree(child.pid, true);
    throw new Error(spawnError?.message || "Recording window did not finish opening. The recording view remains available from the dashboard.");
  }
  // OBS matches this title, so make sure the page has set it before recording starts.
  await waitForWindowTitle("Agent transcript", 10_000);
  await fs.promises.writeFile(resultFile, JSON.stringify({
    status: "opened", platform: process.platform, pid: child.pid ?? null,
    started_at: new Date().toISOString(), browser,
  }, null, 2));
  let closing = false;
  const monitor = setInterval(() => {
    if (closing) return;
    let state = "";
    try { state = JSON.parse(fs.readFileSync(runFile, "utf8")).state; } catch { return; }
    if (!TERMINAL_STATES.has(state)) return;
    closing = true;
    clearInterval(monitor);
    // Let the page drain final output before closing, matching the macOS window.
    setTimeout(() => {
      if (child.pid) killProcessTree(child.pid, true);
      closeWindowsWithTitle("Agent transcript");
      try {
        fs.writeFileSync(path.join(dir, "recording-window-exit.json"), JSON.stringify({
          reason: "run_ended", pid: child.pid ?? null, exited_at: new Date().toISOString(),
        }, null, 2));
      } catch { /* the run directory may have been moved */ }
      fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }, 2000);
  }, 250);
  monitor.unref();
}
