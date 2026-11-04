import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";

const HOME = os.homedir();
const PROGRAM_FILES = process.env.ProgramFiles || "C:\\Program Files";
const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] || PROGRAM_FILES;
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const APP_DATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];

/** Windows Steam/GOG/standalone locations, in the order the game is usually found. */
function windowsFactorioCandidates(): string[] {
  const roots = new Set<string>();
  const steamRoots = [
    path.join(PROGRAM_FILES_X86, "Steam"),
    path.join(PROGRAM_FILES, "Steam"),
    path.join(LOCAL_APP_DATA, "Steam"),
    "C:\\Steam",
    "C:\\SteamLibrary",
    "D:\\Steam",
    "D:\\SteamLibrary",
    "E:\\Steam",
    "E:\\SteamLibrary",
  ];
  for (const root of steamRoots) {
    roots.add(root);
    // Steam keeps additional library folders in libraryfolders.vdf.
    try {
      const text = fs.readFileSync(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8");
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(match[1].replace(/\\\\/g, "\\"));
    } catch {
      /* Steam may not be installed at this location. */
    }
  }
  const candidates: string[] = [];
  for (const root of roots)
    candidates.push(path.join(root, "steamapps", "common", "Factorio", "bin", "x64", "factorio.exe"));
  // GOG Galaxy, standalone ZIP builds, and the Microsoft Store-style install.
  candidates.push(
    path.join(PROGRAM_FILES_X86, "GOG Galaxy", "Games", "Factorio", "bin", "x64", "factorio.exe"),
    path.join(PROGRAM_FILES, "GOG Galaxy", "Games", "Factorio", "bin", "x64", "factorio.exe"),
    "C:\\GOG Games\\Factorio\\bin\\x64\\factorio.exe",
    "D:\\GOG Games\\Factorio\\bin\\x64\\factorio.exe",
    path.join(PROGRAM_FILES, "Factorio", "bin", "x64", "factorio.exe"),
    path.join(PROGRAM_FILES_X86, "Factorio", "bin", "x64", "factorio.exe"),
    path.join(LOCAL_APP_DATA, "Programs", "Factorio", "bin", "x64", "factorio.exe"),
    path.join(HOME, "Factorio", "bin", "x64", "factorio.exe"),
  );
  return candidates;
}

export function defaultFactorioBin(): string {
  if (IS_WINDOWS) {
    const candidates = windowsFactorioCandidates();
    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
  }
  if (IS_MACOS) {
    return path.join(
      HOME,
      "Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio",
    );
  }
  const candidates = [
    path.join(HOME, "factorio/bin/x64/factorio"),
    "/opt/factorio/bin/x64/factorio",
    "/usr/share/factorio/bin/x64/factorio",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

/** macOS data lives inside the app bundle; every other build uses <install>/data. */
export function defaultFactorioData(factorioBin: string): string {
  if (IS_MACOS) return path.resolve(path.dirname(factorioBin), "../data");
  return path.resolve(path.dirname(factorioBin), "../../data");
}

export function personalFactorioConfig(): string {
  if (IS_WINDOWS) return path.join(APP_DATA, "Factorio", "config", "config.ini");
  if (IS_MACOS) return path.join(HOME, "Library/Application Support/Factorio/config/config.ini");
  return path.join(HOME, ".factorio/config/config.ini");
}

function isFile(file: string | undefined): file is string {
  if (!file) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve an executable the way a POSIX shell or Windows PATHEXT search would. */
export function resolveExecutable(bin: string): string | undefined {
  if (bin.includes("/") || bin.includes("\\")) return isFile(bin) ? bin : undefined;
  const extensions = IS_WINDOWS ? WINDOWS_EXECUTABLE_EXTENSIONS : [""];
  const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, bin + extension);
      if (isFile(candidate)) return candidate;
      if (IS_WINDOWS) {
        const upper = path.join(directory, bin + extension.toUpperCase());
        if (isFile(upper)) return upper;
      }
    }
  }
  return undefined;
}

/** Quote one argument using the MSVCRT/CommandLineToArgvW rules. */
function quoteWindowsArgument(argument: string): string {
  if (argument === "") return '""';
  if (!/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2) + '"';
  return quoted;
}

/** Spawn an executable, unwrapping npm-style .cmd/.bat shims through cmd.exe on Windows. */
export function spawnExecutable(bin: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (!IS_WINDOWS) return spawn(bin, args, options);
  const resolved = resolveExecutable(bin) || bin;
  const base: SpawnOptions = { ...options, windowsHide: options.windowsHide ?? true };
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    // Batch shims cannot carry multi-line arguments; prompts tolerate collapsed whitespace.
    const safeArgs = args.map((argument) => argument.replace(/\r?\n/g, " "));
    const line = ""
      .concat(quoteWindowsArgument(resolved), " ", safeArgs.map(quoteWindowsArgument).join(" "))
      .trimEnd();
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...base,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(resolved, args, base);
}

export type ExecResult = { stdout: string; stderr: string };

/** execFile replacement that works for .cmd shims (codex, npm-provided tools). */
export function execExecutable(
  bin: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnExecutable(bin, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const timer = options.timeout
      ? setTimeout(() => {
          if (child.pid) killProcessTree(child.pid, true);
          else {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          }
          finish(() => reject(new Error(`${path.basename(bin)} timed out after ${options.timeout} ms`)));
        }, options.timeout)
      : undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) =>
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else
          reject(
            new Error(
              `${path.basename(bin)} exited with ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}` : ""}`,
            ),
          );
      }),
    );
  });
}

/** Kill a process and its descendants; Windows needs taskkill for the tree. */
export function killProcessTree(pid: number, force = true): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    return;
  } catch {
    /* no process group */
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    /* already exited */
  }
}

/** Close every top-level window whose title matches exactly (Windows only). */
export function closeWindowsWithTitle(title: string): void {
  if (!IS_WINDOWS) return;
  spawnSync("taskkill", ["/F", "/FI", `WINDOWTITLE eq ${title}`], { windowsHide: true, stdio: "ignore" });
}

/** Wait until a top-level window with this title exists (Windows only). */
export async function waitForWindowTitle(title: string, timeoutMs = 10_000): Promise<boolean> {
  if (!IS_WINDOWS) return false;
  const escaped = title.replace(/'/g, "''");
  const script = `(Get-Process | Where-Object { $_.MainWindowTitle -like '*${escaped}*' } | Measure-Object).Count`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execExecutable(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 5000 },
      );
      if (Number(stdout.trim()) > 0) return true;
    } catch {
      /* the window may still be loading */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function windowsTasklist(filter: string): Promise<string> {
  const { stdout } = await execExecutable("tasklist", ["/FI", filter, "/FO", "CSV", "/NH"], {
    timeout: 5000,
  });
  return stdout;
}

/** Confirm a pid still belongs to the expected executable. */
export async function isProcessExecutable(pid: number, executable: string): Promise<boolean> {
  if (!isProcessRunning(pid)) return false;
  if (IS_WINDOWS) {
    try {
      const { stdout } = await execExecutable("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        timeout: 5000,
      });
      const match = stdout.match(/^"([^"]+)"/m);
      if (!match) return false;
      return match[1].toLowerCase() === path.basename(executable).toLowerCase();
    } catch {
      return false;
    }
  }
  try {
    const { stdout } = await execExecutable(
      process.platform === "darwin" ? "/bin/ps" : "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 3000 },
    );
    return stdout.includes(executable) || stdout.includes(path.basename(executable));
  } catch {
    return false;
  }
}

export async function requireSteamRunning(factorioBin: string): Promise<void> {
  const looksLikeSteam = /[\\/]steamapps[\\/]/i.test(factorioBin);
  if (!looksLikeSteam) return;
  if (IS_WINDOWS) {
    if (!/steam\.exe/i.test(await windowsTasklist("IMAGENAME eq steam.exe"))) {
      throw new Error("Open Steam and sign in before starting a graphical Factorio run.");
    }
    return;
  }
  if (IS_MACOS) {
    const { stdout } = await execExecutable("/bin/ps", ["-axo", "comm="], { timeout: 5000 });
    if (!stdout.split("\n").some((line) => line.trim().endsWith("/steam_osx"))) {
      throw new Error("Open Steam and sign in before starting a graphical Factorio run.");
    }
  }
}

type UsageSample = { pid: number; at: number; cpuSeconds: number };
let previousUsage: UsageSample | undefined;

/** CPU/RSS sampling without /proc; Windows uses Get-Process and a delta of CPU seconds. */
export async function sampleProcessUsage(
  pid: number,
): Promise<{ cpuPercent: number | null; rssBytes: number | null }> {
  if (IS_WINDOWS) {
    try {
      const { stdout } = await execExecutable(
        process.env.SystemRoot
          ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
          : "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.CPU)|$($p.WorkingSet64)"`,
        ],
        { timeout: 5000 },
      );
      const [cpuText, rssText] = stdout.trim().split("|");
      const cpuSeconds = Number(cpuText);
      const rssBytes = Number(rssText);
      const now = Date.now();
      let cpuPercent: number | null = null;
      if (
        previousUsage &&
        previousUsage.pid === pid &&
        now > previousUsage.at &&
        Number.isFinite(cpuSeconds)
      ) {
        const cores = os.cpus().length || 1;
        const elapsed = Math.max((now - previousUsage.at) / 1000, 0.001);
        cpuPercent = Math.max(0, ((cpuSeconds - previousUsage.cpuSeconds) / elapsed / cores) * 100);
      }
      if (Number.isFinite(cpuSeconds)) previousUsage = { pid, at: now, cpuSeconds };
      return { cpuPercent, rssBytes: Number.isFinite(rssBytes) ? rssBytes : null };
    } catch {
      previousUsage = undefined;
      return { cpuPercent: null, rssBytes: null };
    }
  }
  try {
    const { stdout } = await execExecutable(
      process.platform === "darwin" ? "/bin/ps" : "ps",
      ["-p", String(pid), "-o", "%cpu=,rss="],
      { timeout: 2000 },
    );
    const [cpu, rss] = stdout.trim().split(/\s+/).map(Number);
    return {
      cpuPercent: Number.isFinite(cpu) ? cpu : null,
      rssBytes: Number.isFinite(rss) ? rss * 1024 : null,
    };
  } catch {
    return { cpuPercent: null, rssBytes: null };
  }
}

export function codexExecutable(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const installed = resolveExecutable("codex");
  if (installed) return installed;
  if (IS_MACOS) {
    const bundled =
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    if (fs.existsSync(bundled)) return bundled;
  }
  if (IS_WINDOWS) {
    const bundled = [
      path.join(LOCAL_APP_DATA, "Programs", "ChatGPT", "resources", "codex-cli", "codex.exe"),
      path.join(LOCAL_APP_DATA, "Programs", "Codex", "codex.exe"),
      path.join(LOCAL_APP_DATA, "Programs", "codex", "codex.exe"),
    ];
    const found = bundled.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
  }
  return "codex";
}

export function browserExecutables(): string[] {
  const configured = process.env.AUTORIO_BROWSER;
  const candidates = configured ? [configured] : [];
  if (IS_WINDOWS) {
    for (const root of [PROGRAM_FILES_X86, PROGRAM_FILES, LOCAL_APP_DATA]) {
      candidates.push(
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      );
    }
    return candidates;
  }
  if (IS_MACOS) {
    candidates.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else {
    candidates.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  return candidates;
}

export function findBrowser(): string | undefined {
  return browserExecutables().find((candidate) => isFile(candidate));
}

export function findOnPath(name: string): string | undefined {
  return resolveExecutable(name);
}
