import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DATA_DIR, execFileAsync } from "./runtime.js";
import { ObsClient, ObsConnection } from "./obs-client.js";
import { IS_WINDOWS, execExecutable, spawnExecutable } from "./platform.js";
import { arrayOf, asBoolean, asNumber, asRecord, asString, numberOr } from "./validation.js";
export const OBS_SCENE = "Autorio Runs",
  OBS_PROFILE = "Autorio Timelapse";
const GAME = "Autorio · Factorio",
  LOG = "Autorio · Codex";
const settingsFile = path.join(DATA_DIR, "obs-settings.json");

/** One OBS window candidate from GetInputPropertiesListPropertyItems. */
export type ObsWindowItem = {
  itemEnabled?: boolean;
  itemName?: string;
  itemValue?: unknown;
};

function asWindowItem(value: unknown): ObsWindowItem | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    itemEnabled: asBoolean(record.itemEnabled),
    itemName: asString(record.itemName),
    itemValue: record.itemValue,
  };
}

/** Parses the `propertyItems` list of one untrusted OBS window-property response. */
export function parseWindowItems(value: unknown): ObsWindowItem[] {
  return arrayOf(value, asWindowItem);
}

/** Parses a list of JSON objects from an untrusted OBS response field. */
function recordList(value: unknown): Record<string, unknown>[] {
  return arrayOf(value, asRecord);
}

/** Throws a contextual error for a required string field of an OBS response. */
function requiredString(value: unknown, field: string): string {
  const text = asString(value);
  if (text === undefined) throw new Error(`OBS response is missing ${field}`);
  return text;
}

/** Profile names from a GetProfileList reply (string or `{profileName}` entries). */
function profileNames(value: unknown): string[] {
  return arrayOf(value, (item) => (typeof item === "string" ? item : asString(asRecord(item)?.profileName)));
}

export function obsEnabled() {
  try {
    return (
      process.env.AUTORIO_OBS !== "0" &&
      (process.env.AUTORIO_OBS === "1" || JSON.parse(fs.readFileSync(settingsFile, "utf8")).enabled === true)
    );
  } catch {
    return process.env.AUTORIO_OBS === "1";
  }
}
function obsConfigPath() {
  if (IS_WINDOWS)
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "obs-studio",
      "plugin_config",
      "obs-websocket",
      "config.json",
    );
  return path.join(
    os.homedir(),
    "Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json",
  );
}
export async function connectObs() {
  let config: Record<string, unknown> = {};
  try {
    config = asRecord(JSON.parse(fs.readFileSync(obsConfigPath(), "utf8"))) ?? {};
  } catch {
    /* Environment settings also supported. */
  }
  return ObsClient.connect(
    process.env.OBS_WEBSOCKET_URL || `ws://127.0.0.1:${asNumber(config.server_port) || 4455}`,
    process.env.OBS_WEBSOCKET_PASSWORD || asString(config.server_password),
  );
}
export async function obsStatus() {
  let client: ObsConnection | undefined;
  try {
    client = await connectObs();
    const version = asRecord(await client.request("GetVersion")) ?? {};
    const status = asRecord(await client.request("GetRecordStatus")) ?? {};
    return {
      enabled: obsEnabled(),
      connected: true,
      version: asString(version.obsVersion),
      recording: asBoolean(status.outputActive),
      capture_fps: 5,
      playback_fps: 30,
      speed: 6,
    };
  } catch (error) {
    return {
      enabled: obsEnabled(),
      connected: false,
      message: error instanceof Error ? error.message : String(error),
      capture_fps: 5,
      playback_fps: 30,
      speed: 6,
    };
  } finally {
    client?.close();
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function selectWindow(
  items: ObsWindowItem[],
  which: "game" | "log",
  runId: string,
  windowId?: number,
): unknown {
  const enabled = items.filter((item) => item.itemEnabled !== false);
  const candidates = enabled.filter((item) => {
    const name = String(item.itemName);
    if (which === "game")
      return /^\[Factorio\]/i.test(name) || /^Factorio\b/i.test(name) || /\bFactorio \d+\.\d+/.test(name);
    // macOS screen-capture lists use "[Source] Agent transcript"; Windows
    // window-capture lists use "<title>: <class>: <executable>".
    const transcript = /(?:^|\] )Agent transcript$/.test(name) || /^Agent transcript\b/i.test(name);
    if (windowId !== undefined) return transcript && Number(item.itemValue) === windowId;
    return name.includes(`Codex run ${runId}`) || /^Agent transcript\b/i.test(name);
  });
  if (candidates.length !== 1)
    throw new Error(
      `OBS could not uniquely find the ${which === "game" ? "Factorio" : "current Codex log"} window. Keep both windows open and allow OBS Screen Recording permission.`,
    );
  return candidates[0].itemValue;
}
export class ObsRunRecorder {
  private originalProfile?: string;
  private originalScene?: string;
  private originalDirectory?: string;
  private mutes = new Map<string, boolean>();
  private owns = false;
  private restoreAllowed = true;
  private constructor(
    readonly dir: string,
    private client: ObsConnection,
    private windowRunId: string,
    private windowId?: number,
  ) {}
  static async start(dir: string, client?: ObsConnection, runId = path.basename(dir), windowId?: number) {
    const recorder = new ObsRunRecorder(dir, client || (await connectObs()), runId, windowId);
    try {
      await recorder.prepare();
      return recorder;
    } catch (error) {
      await recorder.restore().catch(() => {});
      recorder.client.close();
      throw error;
    }
  }
  private async prepare() {
    for (const request of [
      "GetRecordStatus",
      "GetStreamStatus",
      "GetReplayBufferStatus",
      "GetVirtualCamStatus",
    ]) {
      let status: unknown;
      try {
        status = await this.client.request(request);
      } catch (error) {
        if (
          ["GetReplayBufferStatus", "GetVirtualCamStatus"].includes(request) &&
          /not (available|configured)/i.test(String(error))
        )
          continue;
        throw error;
      }
      if (asBoolean(asRecord(status)?.outputActive))
        throw new Error(
          "OBS already has an active output. Stop it before starting an automatically recorded run.",
        );
    }
    const profiles = asRecord(await this.client.request("GetProfileList")) ?? {};
    this.originalProfile = asString(profiles.currentProfileName);
    this.originalScene = asString(asRecord(await this.client.request("GetCurrentProgramScene"))?.sceneName);
    if (profileNames(profiles.profiles).includes(OBS_PROFILE))
      await this.client.request("SetCurrentProfile", { profileName: OBS_PROFILE });
    else await this.client.request("CreateProfile", { profileName: OBS_PROFILE });
    await this.client.request("SetCurrentProfile", { profileName: OBS_PROFILE });
    let profileReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (
        asString(asRecord(await this.client.request("GetProfileList"))?.currentProfileName) === OBS_PROFILE
      ) {
        profileReady = true;
        break;
      }
      await pause(100);
    }
    if (!profileReady) throw new Error("OBS profile did not finish switching");
    this.originalDirectory = requiredString(
      asRecord(await this.client.request("GetRecordDirectory"))?.recordDirectory,
      "recordDirectory",
    );
    const outputSettings: Array<[string, string, string]> = IS_WINDOWS
      ? // Windows has no apple_h264; mkv is crash-safe and FFmpeg converts it afterwards.
        [
          ["Output", "Mode", "Simple"],
          ["SimpleOutput", "RecFormat2", "mkv"],
          ["SimpleOutput", "RecQuality", "HQ"],
        ]
      : [
          ["Output", "Mode", "Simple"],
          ["SimpleOutput", "RecFormat2", "hybrid_mov"],
          ["SimpleOutput", "RecEncoder", "apple_h264"],
          ["SimpleOutput", "RecQuality", "HQ"],
        ];
    for (const [category, name, value] of outputSettings)
      await this.client.request("SetProfileParameter", {
        parameterCategory: category,
        parameterName: name,
        parameterValue: value,
      });
    await this.client.request("SetVideoSettings", {
      fpsNumerator: 5,
      fpsDenominator: 1,
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
    });
    let videoReady = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const video = asRecord(await this.client.request("GetVideoSettings")) ?? {};
      if (
        numberOr(video.fpsNumerator, 0) / numberOr(video.fpsDenominator, 1) === 5 &&
        asNumber(video.outputWidth) === 1920 &&
        asNumber(video.outputHeight) === 1080
      ) {
        videoReady = true;
        break;
      }
      await pause(100);
    }
    if (!videoReady) throw new Error("OBS did not apply 1920×1080 at 5 fps");
    const sceneList = asRecord(await this.client.request("GetSceneList")) ?? {};
    if (!recordList(sceneList.scenes).some((scene) => scene.sceneName === OBS_SCENE))
      await this.client.request("CreateScene", { sceneName: OBS_SCENE });
    const inputs = recordList((asRecord(await this.client.request("GetInputList")) ?? {}).inputs);
    const inputKind = IS_WINDOWS ? "window_capture" : "screen_capture";
    const inputSettings = (window: unknown) =>
      IS_WINDOWS
        ? window === undefined
          ? {}
          : { window, cursor: false }
        : { type: 1, window: window ?? 0, show_cursor: false, show_hidden_windows: true };
    for (const name of [GAME, LOG]) {
      const existing = inputs.find((input) => input.inputName === name);
      if (existing && asString(existing.inputKind) !== inputKind)
        throw new Error(`Reserved OBS source name is already in use: ${name}`);
      if (!existing)
        await this.client.request("CreateInput", {
          sceneName: OBS_SCENE,
          inputName: name,
          inputKind,
          inputSettings: inputSettings(undefined),
          sceneItemEnabled: true,
        });
      const sceneItems = recordList(
        (asRecord(await this.client.request("GetSceneItemList", { sceneName: OBS_SCENE })) ?? {}).sceneItems,
      );
      if (!sceneItems.some((item) => asString(item.sourceName) === name))
        await this.client.request("CreateSceneItem", {
          sceneName: OBS_SCENE,
          sourceName: name,
          sceneItemEnabled: true,
        });
      let window: unknown;
      for (let attempt = 0; attempt < 10; attempt++) {
        const items = parseWindowItems(
          (
            asRecord(
              await this.client.request("GetInputPropertiesListPropertyItems", {
                inputName: name,
                propertyName: "window",
              }),
            ) ?? {}
          ).propertyItems,
        );
        try {
          window = selectWindow(items, name === GAME ? "game" : "log", this.windowRunId, this.windowId);
          break;
        } catch (error) {
          if (attempt === 9) throw error;
          await pause(300);
        }
      }
      await this.client.request("SetInputSettings", {
        inputName: name,
        inputSettings: inputSettings(window),
        overlay: false,
      });
      const itemId = asNumber(
        (
          asRecord(await this.client.request("GetSceneItemId", { sceneName: OBS_SCENE, sourceName: name })) ??
          {}
        ).sceneItemId,
      );
      await this.client.request("SetSceneItemEnabled", {
        sceneName: OBS_SCENE,
        sceneItemId: itemId,
        sceneItemEnabled: true,
      });
      await this.client.request("SetSceneItemTransform", {
        sceneName: OBS_SCENE,
        sceneItemId: itemId,
        sceneItemTransform: {
          positionX: name === GAME ? 0 : 1280,
          positionY: 0,
          rotation: 0,
          alignment: 5,
          boundsType: "OBS_BOUNDS_SCALE_INNER",
          boundsAlignment: 0,
          boundsWidth: name === GAME ? 1280 : 640,
          boundsHeight: 1080,
          cropLeft: 0,
          cropRight: 0,
          cropTop: 0,
          cropBottom: 0,
        },
      });
    }
    // The dedicated scene must contain exactly the two approved windows.
    const sceneItems = recordList(
      (asRecord(await this.client.request("GetSceneItemList", { sceneName: OBS_SCENE })) ?? {}).sceneItems,
    );
    if (sceneItems.some((item) => ![GAME, LOG].includes(asString(item.sourceName) ?? "")))
      throw new Error("Autorio Runs scene has extra sources; remove them before automatic recording");
    const audio = asRecord(await this.client.request("GetSpecialInputs")) ?? {};
    for (const name of new Set<string>([
      ...Object.values(audio).filter((value): value is string => typeof value === "string" && !!value),
      GAME,
      LOG,
    ])) {
      const mute = asRecord(await this.client.request("GetInputMute", { inputName: name }));
      this.mutes.set(name, asBoolean(mute?.inputMuted) ?? false);
      await this.client.request("SetInputMute", { inputName: name, inputMuted: true });
    }
    await this.client.request("SetCurrentProgramScene", { sceneName: OBS_SCENE });
    const captureDir = path.join(this.dir, "video");
    fs.mkdirSync(captureDir, { recursive: true });
    await this.client.request("SetRecordDirectory", { recordDirectory: captureDir });
    for (let attempt = 0; attempt < 30; attempt++) {
      const directory = requiredString(
        asRecord(await this.client.request("GetRecordDirectory"))?.recordDirectory,
        "recordDirectory",
      );
      if (path.resolve(directory) === captureDir) break;
      if (attempt === 29) throw new Error("OBS did not apply the run recording directory");
      await pause(100);
    }
    this.owns = true;
    await this.client.request("StartRecord");
    let recordingReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (asBoolean(asRecord(await this.client.request("GetRecordStatus"))?.outputActive)) {
        recordingReady = true;
        break;
      }
      await pause(100);
    }
    if (!recordingReady) throw new Error("OBS recording did not start");
    fs.writeFileSync(
      path.join(this.dir, "video", "capture.json"),
      JSON.stringify(
        {
          capture_fps: 5,
          playback_fps: 30,
          speed: 6,
          scene: OBS_SCENE,
          started_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
  async stop(): Promise<string> {
    try {
      const directory = requiredString(
        asRecord(await this.client.request("GetRecordDirectory"))?.recordDirectory,
        "recordDirectory",
      );
      const profile = asString(asRecord(await this.client.request("GetProfileList"))?.currentProfileName);
      if (path.resolve(directory) !== path.join(this.dir, "video") || profile !== OBS_PROFILE) {
        this.owns = false;
        this.restoreAllowed = false;
        throw new Error("OBS output ownership changed; refusing to stop an unrelated recording");
      }
      const result = await this.client.request("StopRecord");
      this.owns = false;
      const output = path.resolve(requiredString(asRecord(result)?.outputPath, "outputPath"));
      if (path.dirname(output) !== path.join(this.dir, "video"))
        throw new Error("OBS saved the recording outside this run's video directory");
      return output;
    } finally {
      try {
        if (this.restoreAllowed) await this.restore();
      } finally {
        this.client.close();
      }
    }
  }
  private async restoreSetting(type: string, data: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.request(type, data);
      } catch (error) {
        if (attempt >= 99 || !/: 500$/.test(String(error))) throw error;
        await pause(100);
      }
    }
  }
  private async restore() {
    if (this.owns) {
      const directory = requiredString(
        asRecord(await this.client.request("GetRecordDirectory"))?.recordDirectory,
        "recordDirectory",
      );
      if (
        path.resolve(directory) !== path.join(this.dir, "video") ||
        asString(asRecord(await this.client.request("GetProfileList"))?.currentProfileName) !== OBS_PROFILE
      )
        throw new Error("OBS output ownership changed during cleanup");
      if (asBoolean(asRecord(await this.client.request("GetRecordStatus"))?.outputActive))
        await this.client.request("StopRecord");
      this.owns = false;
    }
    for (const [name, inputMuted] of this.mutes)
      await this.client.request("SetInputMute", { inputName: name, inputMuted });
    if (this.originalDirectory)
      await this.restoreSetting("SetRecordDirectory", { recordDirectory: this.originalDirectory });
    if (this.originalProfile)
      await this.restoreSetting("SetCurrentProfile", { profileName: this.originalProfile });
    if (this.originalScene)
      await this.client.request("SetCurrentProgramScene", { sceneName: this.originalScene });
  }
}
export async function ensureObsRunning() {
  if (IS_WINDOWS) {
    try {
      const { stdout } = await execExecutable("tasklist", ["/FI", "IMAGENAME eq obs64.exe", "/NH"], {
        timeout: 5000,
      });
      if (/obs64\.exe/i.test(stdout)) return;
    } catch {
      /* fall through to locating OBS */
    }
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || programFiles;
    const candidates = [
      process.env.OBS_BIN,
      path.join(programFiles, "obs-studio", "bin", "64bit", "obs64.exe"),
      path.join(programFilesX86, "obs-studio", "bin", "64bit", "obs64.exe"),
    ].filter((value): value is string => Boolean(value));
    const binary = candidates.find((candidate) => fs.existsSync(candidate));
    if (!binary) throw new Error("OBS Studio was not found. Install OBS 28+ or set OBS_BIN to obs64.exe.");
    const processHandle = spawnExecutable(binary, [], {
      cwd: path.dirname(binary),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    processHandle.unref();
    await pause(2000);
    return;
  }
  await execFileAsync("/usr/bin/open", ["-g", "-a", "/Applications/OBS.app"], { timeout: 10000 });
}
