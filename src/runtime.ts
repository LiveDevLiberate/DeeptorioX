import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import {
  defaultFactorioBin,
  defaultFactorioData,
  execExecutable,
  personalFactorioConfig,
  requireSteamRunning,
  spawnExecutable,
} from "./platform.js";

export const ROOT = process.cwd();
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

export const PORT = Number(process.env.AUTORIO_PORT || 3000);
export const DATA_DIR = path.resolve(process.env.AUTORIO_DATA_DIR || path.join(ROOT, ".autorio"));
export const FACTORIO_BIN = process.env.FACTORIO_BIN || defaultFactorioBin();
export const FACTORIO_DATA = process.env.FACTORIO_DATA || defaultFactorioData(FACTORIO_BIN);
export const SAVES_DIR = path.join(DATA_DIR, "saves");
export const MANAGER_PROFILE = path.join(DATA_DIR, "manager");
export const RCON_HOST = "127.0.0.1";
export const RCON_PORT = Number(process.env.RCON_PORT || 27015);
/** Multiplayer host port; a cluster gives every instance its own port. */
export const GAME_PORT = Number(process.env.AUTORIO_GAME_PORT || 34197);
fs.mkdirSync(DATA_DIR, { recursive: true });
const passwordFile = path.join(DATA_DIR, "rcon-password");
export const RCON_PASSWORD =
  process.env.RCON_PASSWORD ||
  (fs.existsSync(passwordFile)
    ? fs.readFileSync(passwordFile, "utf8").trim()
    : randomBytes(24).toString("hex"));
if (!fs.existsSync(passwordFile)) fs.writeFileSync(passwordFile, RCON_PASSWORD, { mode: 0o600 });
export const factorioEnv = { ...process.env, SteamAppId: "427520", SteamGameId: "427520" };
export const execFileAsync = promisify(execFile);

export function controlModHash() {
  const dir = path.join(ROOT, "factorio-mod", "autorio-control");
  return createHash("sha256")
    .update(fs.readFileSync(path.join(dir, "info.json")))
    .update(fs.readFileSync(path.join(dir, "control.lua")))
    .digest("hex");
}
export async function prepareProfile(dir: string) {
  // Inherit only interface scaling; keep personal paths and credentials isolated.
  const personalConfig = personalFactorioConfig();
  let interfaceScale: string[] = [];
  try {
    let section = "";
    for (const line of (await fs.promises.readFile(personalConfig, "utf8")).split(/\r?\n/)) {
      const header = line.trim().match(/^\[([^\]]+)\]$/);
      if (header) section = header[1];
      const setting = line
        .trim()
        .match(
          /^(ui-scale-mode|custom-ui-scale|custom-proportional-ui-scale)\s*=\s*([^;#]+?)(?:\s*[;#].*)?$/,
        );
      if (section === "interface" && setting) interfaceScale.push(`${setting[1]}=${setting[2].trim()}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.promises.mkdir(path.join(dir, "mods"), { recursive: true });
  await fs.promises.mkdir(path.join(dir, "saves"), { recursive: true });
  await fs.promises.cp(
    path.join(ROOT, "factorio-mod", "autorio-control"),
    path.join(dir, "mods", "autorio-control_1.0.0"),
    { recursive: true },
  );
  await fs.promises.writeFile(
    path.join(dir, "mods/mod-list.json"),
    JSON.stringify(
      {
        mods: [
          { name: "base", enabled: true },
          { name: "autorio-control", enabled: true },
          ...["space-age", "quality", "elevated-rails"].map((name) => ({ name, enabled: false })),
        ],
      },
      null,
      2,
    ),
  );
  await fs.promises.writeFile(
    path.join(dir, "config.ini"),
    [
      "[path]",
      `read-data=${FACTORIO_DATA}`,
      `write-data=${dir}`,
      "[general]",
      "locale=en",
      "[other]",
      `port=${GAME_PORT}`,
      `local-rcon-socket=127.0.0.1:${RCON_PORT}`,
      `local-rcon-password=${RCON_PASSWORD}`,
      "[multiplayer-lobby]",
      "visibility-public=false",
      "visibility-steam=false",
      "visibility-lan=false",
      "[interface]",
      ...interfaceScale,
      "[graphics]",
      "full-screen=false",
      "graphics-quality=medium",
      "cache-sprite-atlas=false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await fs.promises.writeFile(
    path.join(dir, "server-settings.json"),
    JSON.stringify(
      {
        name: "Autorio local benchmark",
        description: "Local agent run",
        max_players: 1,
        visibility: { public: false, lan: false },
        require_user_verification: false,
        autosave_interval: 0,
        auto_pause: false,
        only_admins_can_pause_the_game: true,
      },
      null,
      2,
    ),
  );
  // Avoid the first-launch LAN username dialog without copying personal credentials.
  if (!fs.existsSync(path.join(dir, "player-data.json"))) {
    await fs.promises.writeFile(
      path.join(dir, "player-data.json"),
      JSON.stringify({
        "service-username": "Autorio",
        "service-token": "",
      }),
    );
  }
}

export function profileArgs(dir: string) {
  return ["--config", path.join(dir, "config.ini"), "--mod-directory", path.join(dir, "mods")];
}

export async function factorioVersion() {
  if (!["darwin", "win32", "linux"].includes(process.platform))
    throw new Error(`Autorio is not supported on ${process.platform}.`);
  if (!fs.existsSync(FACTORIO_BIN)) {
    throw new Error(
      `Factorio executable not found at ${FACTORIO_BIN}. Set FACTORIO_BIN in .env to the full game executable.`,
    );
  }
  let reported = "";
  let reportedError: unknown;
  try {
    reported = (await execExecutable(FACTORIO_BIN, ["--version"], { timeout: 20_000 })).stdout.trim();
  } catch (error) {
    reportedError = error;
  }
  if (/demo/i.test(reported)) throw new Error("FACTORIO_BIN points to the demo; select the full game.");
  if (reported) return reported;
  // The Windows Steam build is a GUI-subsystem executable and may not write
  // --version to a redirected stdout pipe. Its base mod metadata is authoritative.
  const dataVersion = readDataVersion();
  if (dataVersion) return `Version: ${dataVersion} (${process.platform}, data)`;
  if (reportedError) throw reportedError;
  throw new Error("Factorio did not report a version. Run the game once from Steam, then retry.");
}

function readDataVersion(): string | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(FACTORIO_DATA, "base", "info.json"), "utf8"));
    if (typeof info?.version === "string" && /^\d+\.\d+\.\d+/.test(info.version)) return info.version;
  } catch {
    /* fall through */
  }
  return undefined;
}

export async function requireSteam() {
  await requireSteamRunning(FACTORIO_BIN);
}

/** Map creation is an offline operation; the full game supports it without graphics. */
export async function createMap(save: string, profile: string, settings: object, signal?: AbortSignal) {
  await prepareProfile(profile);
  await fs.promises.mkdir(path.dirname(save), { recursive: true });
  const settingsPath = path.join(profile, "map-gen-settings.json");
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  await new Promise<void>((resolve, reject) => {
    const child = spawnExecutable(
      FACTORIO_BIN,
      [...profileArgs(profile), "--create", save, "--map-gen-settings", settingsPath],
      { env: factorioEnv, signal },
    );
    let tail = "";
    const log = fs.createWriteStream(path.join(profile, "create.log"));
    const capture = (chunk: Buffer) => {
      log.write(chunk);
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("error", reject);
    child.once("close", (code, sig) => {
      clearTimeout(timeout);
      log.end();
      if (code === 0) resolve();
      else reject(new Error(`Map creation failed (${sig || code}): ${tail}`));
    });
  });
}
