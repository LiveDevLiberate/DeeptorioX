import fs from "node:fs";
import path from "node:path";
import { execExecutable } from "./platform.js";
import { mapPreviewFile } from "./map-preview.js";

export type UploadMethod = "skip" | "local_sync" | "rclone";

export type UploadRequest = {
  id: string;
  method: UploadMethod;
  target?: string;
  remote?: string;
  rcloneExecutable?: string;
};

export type UploadResult = {
  ok: true;
  method: UploadMethod;
  id: string;
  file: string;
  destination?: string;
  output?: string;
};

/** Port of FactorioPreviewToolkit's skip/local_sync/rclone uploaders. */
export async function uploadMapPreview(request: UploadRequest): Promise<UploadResult> {
  const preview = mapPreviewFile(request.id);
  if (!preview) throw new Error("unknown map preview id");
  if (request.method === "skip") {
    return { ok: true, method: "skip", id: preview.id, file: preview.file };
  }
  if (request.method === "local_sync") {
    const target = request.target?.trim();
    if (!target) throw new Error("local_sync requires target");
    fs.mkdirSync(target, { recursive: true });
    const destination = path.join(target, `${preview.id}.png`);
    fs.copyFileSync(preview.file, destination);
    return { ok: true, method: "local_sync", id: preview.id, file: preview.file, destination };
  }
  if (request.method === "rclone") {
    const remote = request.remote?.trim();
    if (!remote) throw new Error("rclone requires remote");
    const executable =
      request.rcloneExecutable?.trim() ||
      process.env.RCLONE_BIN ||
      process.env.AUTORIO_RCLONE_BIN ||
      "rclone";
    const result = await execExecutable(executable, ["copy", preview.file, remote], {
      timeout: 120_000,
    });
    return {
      ok: true,
      method: "rclone",
      id: preview.id,
      file: preview.file,
      destination: remote,
      output: result.stdout.slice(-2000),
    };
  }
  throw new Error(`unsupported upload method: ${String(request.method)}`);
}
