import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const CACHE_DIR = path.join(os.tmpdir(), "vsp-videos");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_DIR = path.join(ROOT, "tools", "ffmpeg");
const FFMPEG_ZIP_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
const videos = new Map();
let installBusy = false;

function which(cmd) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [cmd], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  const line = String(result.stdout || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  return line || null;
}

let bins = null;

function localBin(name) {
  const file = path.join(LOCAL_DIR, process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(file) ? file : null;
}

export function ffmpegStatus() {
  if (!bins) {
    bins = {
      ffmpeg: localBin("ffmpeg") || which("ffmpeg"),
      ffprobe: localBin("ffprobe") || which("ffprobe"),
    };
  }
  const local = Boolean(localBin("ffmpeg") && localBin("ffprobe"));
  return {
    available: Boolean(bins.ffmpeg && bins.ffprobe),
    source: local ? "local" : bins.ffmpeg ? "path" : null,
    ffmpeg: bins.ffmpeg,
    ffprobe: bins.ffprobe,
  };
}

function requireBins() {
  const status = ffmpegStatus();
  if (!status.available) {
    throw Object.assign(new Error("尚未下载 ffmpeg。请在抽样方式里选择「全部编码帧」并确认下载。"), { status: 503 });
  }
  return status;
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

async function downloadBuffer(url, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载 ffmpeg 失败 (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(Buffer.from(chunk.value));
    loaded += chunk.value.byteLength;
    onProgress?.(loaded, total);
  }
  return Buffer.concat(chunks);
}

export async function installLocalFfmpeg(onProgress) {
  if (process.platform !== "win32") {
    throw new Error("自动下载目前只支持 Windows。");
  }
  if (installBusy) {
    throw Object.assign(new Error("正在下载 ffmpeg"), { status: 409 });
  }
  installBusy = true;
  try {
    const ready = localBin("ffmpeg") && localBin("ffprobe");
    if (ready) {
      bins = null;
      onProgress?.({ phase: "done", line: "ffmpeg 已就绪", percent: 100 });
      return ffmpegStatus();
    }
    onProgress?.({ phase: "download", line: "正在下载 ffmpeg…", percent: 1 });
    const zip = await downloadBuffer(FFMPEG_ZIP_URL, (loaded, total) => {
      const percent = total ? Math.max(1, Math.min(90, Math.round((loaded / total) * 90))) : 5;
      const line = total
        ? `正在下载 ffmpeg… ${formatMb(loaded)} / ${formatMb(total)}`
        : `正在下载 ffmpeg… ${formatMb(loaded)}`;
      onProgress?.({ phase: "download", line, percent });
    });
    onProgress?.({ phase: "unpack", line: "正在解压…", percent: 93 });
    const files = unzipSync(new Uint8Array(zip), {
      filter: (file) => /(^|[\\/])ffmpeg\.exe$/i.test(file.name) || /(^|[\\/])ffprobe\.exe$/i.test(file.name),
    });
    let ffmpeg = null;
    let ffprobe = null;
    for (const [name, data] of Object.entries(files)) {
      const base = name.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
      if (base === "ffmpeg.exe") ffmpeg = data;
      if (base === "ffprobe.exe") ffprobe = data;
    }
    if (!ffmpeg || !ffprobe) throw new Error("压缩包里没有 ffmpeg.exe / ffprobe.exe");
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, "ffmpeg.exe"), ffmpeg);
    await fs.writeFile(path.join(LOCAL_DIR, "ffprobe.exe"), ffprobe);
    bins = null;
    const status = ffmpegStatus();
    if (!status.available) throw new Error("下载完成但无法运行 ffmpeg");
    onProgress?.({ phase: "done", line: "ffmpeg 已就绪", percent: 100 });
    return status;
  } finally {
    installBusy = false;
  }
}

function runCapture(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(err.trim() || `${path.basename(bin)} 退出码 ${code}`));
      else resolve(out);
    });
  });
}

function parseRate(value) {
  if (!value || value === "0/0") return 0;
  const [num, den] = String(value).split("/").map(Number);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (!Number.isFinite(den) || den === 0) return num;
  return num / den;
}

export async function probeFile(filePath) {
  const { ffprobe } = requireBins();
  const raw = await runCapture(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=avg_frame_rate,r_frame_rate,width,height,duration",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(raw);
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error("视频里没有画面流");
  const fps = parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate);
  const duration = Number(stream.duration) || Number(parsed.format?.duration) || 0;
  return {
    fps,
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    duration,
  };
}

export async function storeVideo(req, limit = 1024 * 1024 * 1024) {
  requireBins();
  const token = crypto.randomBytes(8).toString("hex");
  const dir = path.join(CACHE_DIR, token);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "source.bin");
  await new Promise((resolve, reject) => {
    const out = createWriteStream(filePath);
    let size = 0;
    const fail = (err) => {
      out.destroy();
      reject(err);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) fail(Object.assign(new Error("视频超过 1GB"), { status: 413 }));
    });
    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", resolve);
    req.pipe(out);
  });
  const probe = await probeFile(filePath);
  videos.set(token, { path: filePath, probe });
  return { token, ...probe };
}

export function videoByToken(token) {
  return videos.get(token) || null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function extractEncodedFrames({
  inputPath,
  framesDir,
  originalDir,
  startSec,
  endSec,
  crop,
  onProgress,
  onChild,
  isAborted,
}) {
  const { ffmpeg } = requireBins();
  const duration = Math.max(0.01, endSec - startSec);
  const outDir = path.join(os.tmpdir(), `vsp-frames-${crypto.randomBytes(4).toString("hex")}`);
  const args = [
    "-hide_banner",
    "-y",
    "-progress",
    "pipe:1",
    "-nostats",
    "-i",
    inputPath,
    "-ss",
    String(startSec),
    "-t",
    String(duration),
    "-fps_mode",
    "passthrough",
  ];
  if (crop) args.push("-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  args.push("-start_number", "1", path.join(outDir, "%04d.png"));

  return new Promise((resolve, reject) => {
    let child;
    const fail = (err) => {
      if (child && !child.killed) child.kill();
      fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
      reject(err);
    };
    fs.mkdir(outDir, { recursive: true })
      .then(() => {
        child = spawn(ffmpeg, args, { windowsHide: true });
        onChild?.(child);
        let buf = "";
        let err = "";
        let frame = 0;
        child.stdout.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("frame=")) frame = Number(line.slice(6)) || frame;
            if (line.startsWith("progress=") && onProgress) onProgress(frame);
          }
        });
        child.stderr.on("data", (chunk) => {
          err = (err + chunk.toString("utf8")).slice(-2000);
        });
        child.on("error", fail);
        child.on("close", (code) => {
          if (isAborted?.()) {
            fail(Object.assign(new Error("已取消提取"), { status: 499 }));
            return;
          }
          if (code !== 0) {
            fail(new Error(err.trim() || `ffmpeg 退出码 ${code}`));
            return;
          }
          commitPngs(outDir, framesDir, originalDir).then(resolve).catch(fail);
        });
      })
      .catch(fail);
  });
}

async function commitPngs(outDir, framesDir, originalDir) {
  const names = (await fs.readdir(outDir)).filter((name) => name.toLowerCase().endsWith(".png")).sort();
  if (!names.length) throw new Error("这个区间没有解出帧");
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.rm(originalDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });
  await fs.mkdir(originalDir, { recursive: true });
  const frames = [];
  for (let i = 0; i < names.length; i++) {
    const file = `${String(i + 1).padStart(4, "0")}.png`;
    const src = path.join(outDir, names[i]);
    await fs.copyFile(src, path.join(framesDir, file));
    await fs.copyFile(src, path.join(originalDir, file));
    const size = pngSize(await fs.readFile(src));
    frames.push({ file, w: size?.w || 0, h: size?.h || 0 });
  }
  await fs.rm(outDir, { recursive: true, force: true });
  return frames;
}

export function pixelCrop(probe, norm) {
  const width = probe.width;
  const height = probe.height;
  if (!width || !height) return null;
  const full =
    norm.x <= 0.001 && norm.y <= 0.001 && norm.w >= 0.999 && norm.h >= 0.999;
  if (full) return null;
  const w = Math.max(1, Math.round(width * norm.w));
  const h = Math.max(1, Math.round(height * norm.h));
  const x = Math.min(Math.max(0, Math.round(width * norm.x)), Math.max(0, width - w));
  const y = Math.min(Math.max(0, Math.round(height * norm.y)), Math.max(0, height - h));
  return { x, y, w, h };
}
