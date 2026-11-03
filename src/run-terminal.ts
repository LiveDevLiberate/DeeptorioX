import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execFileAsync } from "./runtime.js";
import { IS_WINDOWS } from "./platform.js";

const shellQuote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** A dedicated profile closes only this viewer window when its command exits. */
export async function openRunTerminal(dir: string) {
  if (IS_WINDOWS) return openWindowsTerminal(dir);
  const template = await fs.promises.readFile(
    "/System/Applications/Utilities/Terminal.app/Contents/Resources/Initial Settings/Pro.terminal",
    "utf8",
  );
  const viewer = fileURLToPath(new URL("./terminal-view.js", import.meta.url));
  // Terminal's command parser is not a shell parser. Give it a single executable
  // path without spaces; perform all argument quoting inside our own shell script.
  const launcherDir = await fs.promises.mkdtemp("/private/tmp/autorio-terminal-");
  const launcher = path.join(launcherDir, "view.command");
  await fs.promises.writeFile(
    launcher,
    [
      "#!/bin/sh",
      `rm -f -- ${shellQuote(launcher)}`,
      `rmdir -- ${shellQuote(launcherDir)}`,
      "exec " + [process.execPath, viewer, dir].map(shellQuote).join(" "),
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const profile = template
    .replace(/(<key>name<\/key>\s*)<string>[^<]*<\/string>/, "$1<string>Agent transcript</string>")
    .replace(/(<key>shellExitAction<\/key>\s*)<integer>\d+<\/integer>/, "$1<integer>0</integer>")
    .replace(/(<key>ShowWindowSettingsNameInTitle<\/key>\s*)<false\/>/, "$1<false/>")
    .replace(
      "</dict>",
      [
        `<key>CommandString</key><string>${xml(launcher)}</string>`,
        // Terminal uses true to run the configured program as the session itself.
        // false runs it inside an interactive shell, leaving a prompt afterward.
        "<key>RunCommandAsShell</key><true/>",
        "<key>columnCount</key><integer>64</integer>",
        "<key>rowCount</key><integer>40</integer>",
        "</dict>",
      ].join("\n"),
    );
  const file = path.join(dir, "Autorio.terminal");
  await fs.promises.writeFile(file, profile, { mode: 0o600 });
  await execFileAsync("/usr/bin/open", ["-a", "Terminal", file], { timeout: 10_000 });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(dir, "terminal-view.json")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(path.join(dir, "terminal-view.json"))) {
    await fs.promises.rm(launcherDir, { recursive: true, force: true });
    throw new Error(
      "Terminal did not start its viewer. Inspect the Terminal window; full run logs remain available.",
    );
  }
}

/**
 * Windows opens a dedicated console window running the same viewer. `start`
 * gives it a title (used by OBS window lists) and the console closes with the
 * viewer, leaving the invoking shell untouched.
 */
async function openWindowsTerminal(dir: string): Promise<void> {
  const viewer = fileURLToPath(new URL("./terminal-view.js", import.meta.url));
  const launcherDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autorio-terminal-"));
  const launcher = path.join(launcherDir, "view.cmd");
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  await fs.promises.writeFile(
    launcher,
    [
      "@echo off",
      "title Agent transcript",
      `${quote(process.execPath)} ${quote(viewer)} ${quote(path.resolve(dir))}`,
      "del /q %~f0 >nul 2>nul",
      "",
    ].join("\r\n"),
    { mode: 0o700 },
  );
  const child = spawn(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", `start "Agent transcript" ${quote(launcher)}`],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: true,
    },
  );
  child.unref();
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path.join(dir, "terminal-view.json")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(path.join(dir, "terminal-view.json"))) {
    await fs.promises.rm(launcherDir, { recursive: true, force: true });
    throw new Error(
      "Windows Terminal did not start its viewer. Full run logs remain available in the run directory.",
    );
  }
}
