import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {DATA_DIR,ROOT,execFileAsync} from "./runtime.js";
import {IS_WINDOWS, execExecutable, findOnPath} from "./platform.js";
export const TIMELAPSE_TOOL=path.join(DATA_DIR,"tools","autorio-timelapse");
let building:Promise<void>|undefined;
let ffmpegPath:string|undefined;
let ffprobePath:string|undefined;

function resolveFfmpegTools() {
  const ffmpeg=process.env.FFMPEG_BIN || findOnPath("ffmpeg");
  if(!ffmpeg)throw new Error("Timelapse conversion requires FFmpeg on Windows. Install it (for example: winget install Gyan.FFmpeg) or set FFMPEG_BIN to ffmpeg.exe.");
  const ffprobe=process.env.FFPROBE_BIN || findOnPath("ffprobe") ||
    path.join(path.dirname(ffmpeg),process.platform==="win32"?"ffprobe.exe":"ffprobe");
  if(!fs.existsSync(ffprobe))throw new Error("FFprobe is required for timelapse verification. Install the full FFmpeg package or set FFPROBE_BIN.");
  return {ffmpeg,ffprobe};
}

export async function buildTimelapseTool() {
  if(IS_WINDOWS){if(!ffmpegPath){const tools=resolveFfmpegTools();ffmpegPath=tools.ffmpeg;ffprobePath=tools.ffprobe;}return;}
  if(building)return building;
  building=(async()=>{
    const source=path.join(ROOT,"native/timelapse.swift"),stamp=TIMELAPSE_TOOL+".sha256";
    const hash=createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    if(fs.existsSync(TIMELAPSE_TOOL) && fs.existsSync(stamp) && fs.readFileSync(stamp,"utf8")===hash)return;
    fs.mkdirSync(path.dirname(TIMELAPSE_TOOL),{recursive:true});
    const cache=path.join(DATA_DIR,"swift-module-cache");fs.mkdirSync(cache,{recursive:true});
    await execFileAsync("/usr/bin/xcrun",["swiftc","-sdk",process.env.AUTORIO_MACOS_SDK || "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk","-parse-as-library","-O","-module-cache-path",cache,source,"-o",TIMELAPSE_TOOL],{timeout:120000});
    fs.writeFileSync(stamp,hash);
  })();
  try{await building;}finally{building=undefined;}
}
export function verifyTimelapseMetadata(metadata:any) {
  // AVFoundation reports nominal frame rates as floats (e.g. 30.0000019).
  if(!Number.isFinite(metadata?.fps) || Math.abs(metadata.fps-30)>0.01 || !Number.isInteger(metadata?.frames) || metadata.frames<1)throw new Error("Timelapse output verification failed");
}
export async function renderTimelapse(source:string,dir:string) {
  await buildTimelapseTool();
  const target=path.join(dir,"timelapse.mp4"),temporary=path.join(dir,"timelapse.partial.mp4");
  fs.rmSync(temporary,{force:true});
  if(IS_WINDOWS)return renderWindowsTimelapse(source,temporary,target,dir);
  const {stdout}=await execFileAsync(TIMELAPSE_TOOL,[source,temporary],{timeout:12*60*60*1000,maxBuffer:1024*1024});
  const metadata=JSON.parse(stdout);
  verifyTimelapseMetadata(metadata);
  fs.renameSync(temporary,target);fs.writeFileSync(path.join(dir,"timelapse.json"),JSON.stringify(metadata,null,2));
  return {file:target,...metadata};
}

/**
 * The capture is 5 fps, so declaring 30 fps for the same frames yields the 6×
 * timelapse. FFmpeg's setpts also handles variable capture timing, and x264
 * writes a silent H.264 MP4 playable in the dashboard.
 */
async function renderWindowsTimelapse(source:string,temporary:string,target:string,dir:string) {
  if(!ffmpegPath||!ffprobePath){const tools=resolveFfmpegTools();ffmpegPath=tools.ffmpeg;ffprobePath=tools.ffprobe;}
  fs.mkdirSync(path.dirname(target),{recursive:true});
  await execExecutable(ffmpegPath,[
    "-hide_banner","-nostdin","-y","-i",source,
    "-vf","setpts=PTS/6","-r","30","-an",
    "-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p",
    "-movflags","+faststart",temporary,
  ],{timeout:12*60*60*1000});
  const {stdout}=await execExecutable(ffprobePath,[
    "-v","error","-select_streams","v:0","-count_frames",
    "-show_entries","stream=nb_read_frames,avg_frame_rate,duration","-of","json",temporary,
  ],{timeout:10*60*1000});
  const stream=JSON.parse(stdout)?.streams?.[0];
  const frames=Number(stream?.nb_read_frames);
  const [numerator,denominator]=String(stream?.avg_frame_rate || "30/1").split("/").map(Number);
  const fps=denominator?numerator/denominator:numerator;
  const duration=Number(stream?.duration) || (Number.isFinite(frames)&&Number.isFinite(fps)&&fps>0?frames/fps:undefined);
  const metadata={fps,frames,duration};
  verifyTimelapseMetadata(metadata);
  fs.renameSync(temporary,target);fs.writeFileSync(path.join(dir,"timelapse.json"),JSON.stringify(metadata,null,2));
  return {file:target,...metadata};
}
