import type { ActionJobQueue } from "../action-jobs.js";
import type { NativeController } from "../native-control.js";
import type { RunManager } from "../runs.js";
import type { AlertStore } from "../alert-store.js";

/**
 * Dependency surface handed to the API route groups.
 *
 * `server.ts` stays responsible for process lifecycle (Factorio, RCON, runs,
 * job queue); the `/api/*` handlers receive exactly the state and callbacks
 * they need through this object. Keeping it structural makes the groups easy
 * to unit-test with fakes and avoids importing `server.ts` from `src/api/`
 * (which would create an import cycle).
 */

export type ApiLogLine = {
  ts: string;
  stream: "stdout" | "stderr";
  line: string;
};

export type ApiServerState = {
  save: string | null;
  logs: ApiLogLine[];
  rcon: {
    connected: boolean;
    lastError: string | null;
  };
};

export type ApiActiveRun = {
  id: string;
  state: string;
  agent: string;
};

export type ApiContext = {
  /** Live manager state (game save, log buffer, RCON connectivity). */
  state: ApiServerState;
  runManager: RunManager;
  alertStore: AlertStore;
  actionJobs: ActionJobQueue;
  nativeController: NativeController;
  /** Loopback dispatch authorization header value (`X-Autorio-Internal`). */
  internalKey: string;
  rconCommand: (command: string, timeoutMs?: number) => Promise<string>;
  getRunningPid: () => number | null;
  statusPayload: () => unknown;
  managerStartedAt: number;
  activeRunSummary: () => ApiActiveRun | null;
  /** The save/profile the running game was launched with (null after recovery). */
  getActiveSavePath: () => string | null;
  getActiveProfile: () => string | null;
  startGame: (savePath: string, profile: string, logFile?: string) => Promise<void>;
  stopGame: () => Promise<void>;
  shutdown: (signal: NodeJS.Signals) => Promise<void>;
};
