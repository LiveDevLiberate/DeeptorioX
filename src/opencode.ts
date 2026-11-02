import { IS_WINDOWS, resolveExecutable } from "./platform.js";

export const DEFAULT_OPENCODE_MODEL = "opencode-go/deepseek-v4.1-flash";

export function wslDistro(): string {
  return process.env.AUTORIO_WSL_DISTRO?.trim() || "Ubuntu-24.04";
}

/** OpenCode v2 inside WSL; $HOME is expanded by the generated shell script. */
export function wslOpenCodeBin(): string {
  return process.env.AUTORIO_WSL_OPENCODE?.trim() || "$HOME/.opencode/bin/opencode";
}

export function nativeOpenCodeBin(): string | undefined {
  return process.env.OPENCODE_BIN?.trim() || resolveExecutable("opencode");
}

/** Prefer a native OpenCode binary; on Windows fall back to WSL. */
export function opencodeTransport(): "native" | "wsl" {
  if (nativeOpenCodeBin()) return "native";
  return IS_WINDOWS ? "wsl" : "native";
}

export function opencodeModel(requested?: string): string {
  const value = requested?.trim() || process.env.AUTORIO_OPENCODE_MODEL?.trim() || DEFAULT_OPENCODE_MODEL;
  return value.includes("/") ? value : `opencode-go/${value}`;
}

export function toWslPath(value: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (match) return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
  return value.replace(/\\/g, "/");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A shell word for the OpenCode executable; expands $HOME only for the default. */
export function wslBinCommand(): string {
  const bin = wslOpenCodeBin();
  if (bin.includes("$")) return `"${bin.replace(/"/g, '\\"')}"`;
  return shellQuote(bin);
}

export function opencodeVersionCommand(): { bin: string; args: string[] } {
  if (opencodeTransport() === "wsl") {
    return {
      bin: "wsl.exe",
      args: ["-d", wslDistro(), "-e", "sh", "-c", `exec ${wslBinCommand()} --version`],
    };
  }
  return { bin: nativeOpenCodeBin() || "opencode", args: ["--version"] };
}
