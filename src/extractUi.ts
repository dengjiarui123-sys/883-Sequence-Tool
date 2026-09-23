import { clearFrames, createProject, fetchFfmpegStatus, installFfmpeg, probeVideoFile, putFrame, putOriginalFrame, runEncodedExtract } from "./api";
import { choiceDialog, confirmDialog, noticeDialog } from "./dom";
import {
  clamp,
  estimateFrameCount,
  formatTime,
  padFrameFile,
  relativeFramePath,
  sampleTimes,
} from "./extractMath";
import { persistNow, persistSoon } from "./persist";
import { applyVideoPlaybackRate } from "./playbackSpeed";
import * as history from "./history";
import { setState, state } from "./store";
import type { CropRect, FrameRecord, Project } from "./types";

function videoEl(): HTMLVideoElement {
  return document.getElementById("source-video") as HTMLVideoElement;
}

function cropNorm(): CropRect {
  return state.project?.extract.crop ?? { x: 0, y: 0, w: 1, h: 1 };
}

export function videoContentBox(video: HTMLVideoElement) {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const drawW = vw * scale;
  const drawH = vh * scale;
  const ox = (rect.width - drawW) / 2;
  const oy = (rect.height - drawH) / 2;
  return { rect, vw, vh, scale, drawW, drawH, ox, oy };
}

function setCrop(crop: CropRect) {
  const next = {
    x: clamp(crop.x, 0, 1),
    y: clamp(crop.y, 0, 1),
    w: clamp(crop.w, 0.02, 1),
    h: clamp(crop.h, 0.02, 1),
  };
  if (next.x + next.w > 1) next.x = 1 - next.w;
  if (next.y + next.h > 1) next.y = 1 - next.h;
  if (!state.project) return;
  state.project.extract.crop = next;
  state.dirty = true;
  layoutCrop();
}

export function layoutCrop(): void {
  const video = videoEl();
  const layer = document.getElementById("crop-layer")!;
  const rectEl = document.getElementById("crop-rect")!;
  const box = videoContentBox(video);
  if (!box || !state.videoUrl) {
    layer.hidden = true;
    return;
  }
  layer.hidden = false;
  const crop = cropNorm();
  rectEl.style.left = `${box.ox + crop.x * box.drawW}px`;
  rectEl.style.top = `${box.oy + crop.y * box.drawH}px`;
  rectEl.style.width = `${crop.w * box.drawW}px`;
  rectEl.style.height = `${crop.h * box.drawH}px`;
}

function clientToNorm(ev: PointerEvent): { x: number; y: number } | null {
  const box = videoContentBox(videoEl());
  if (!box) return null;
  const x = (ev.clientX - box.rect.left - box.ox) / box.drawW;
  const y = (ev.clientY - box.rect.top - box.oy) / box.drawH;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

function readPreviewRange(): { start: number; end: number } {
  const video = videoEl();
  const duration =
    Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : state.project?.source.durationSec || 0;
  let start = Number((document.getElementById("start-sec") as HTMLInputElement).value);
  let end = Number((document.getElementById("end-sec") as HTMLInputElement).value);
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = duration;
  start = clamp(start, 0, duration || 0);
  end = clamp(end, 0, duration || 0);
  if (!(end > start)) {
    start = 0;
    end = duration > 0 ? duration : 1;
  }
  return { start, end };
}

function updateVideoTimeLabel(): void {
  const video = videoEl();
  const { end } = readPreviewRange();
  const t = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  (document.getElementById("video-scrub") as HTMLInputElement).value = String(t);
  document.getElementById("video-time")!.textContent = `${formatTime(t)} / ${formatTime(end)}`;
  document.getElementById("btn-play")!.textContent = video.paused ? "播放动画" : "暂停";
}

let extractRangeKey = "";

function noteExtractRangeChange(): void {
  const video = videoEl();
  const { start, end } = readPreviewRange();
  const key = `${start}:${end}`;
  const changed = extractRangeKey !== "" && key !== extractRangeKey;
  extractRangeKey = key;
  if (changed && state.videoUrl && !video.paused) {
    video.pause();
    updateVideoTimeLabel();
    void noticeDialog("动画序列已刷新");
  }
}

function applyPreviewRange(): void {
  const video = videoEl();
  const { start, end } = readPreviewRange();
  const scrub = document.getElementById("video-scrub") as HTMLInputElement;
  scrub.min = String(start);
  scrub.max = String(end);
  scrub.step = "0.01";
  if (Number.isFinite(video.currentTime)) {
    if (video.currentTime < start) video.currentTime = start;
    else if (video.currentTime > end) video.currentTime = end;
  }
  updateVideoTimeLabel();
}

function readExtractMode(): "time" | "frames" {
  const el = document.getElementById("extract-mode") as HTMLSelectElement | null;
  return el?.value === "frames" ? "frames" : "time";
}

let ffmpegAvailable = false;
let videoToken = "";
let videoTokenKey = "";

function encodedEstimate(start: number, end: number, fps: number): number {
  if (!(end > start) || !(fps > 0)) return 0;
  return Math.max(1, Math.round((end - start) * fps));
}

function syncExtractModeUi(): void {
  const mode = readExtractMode();
  const fpsField = document.getElementById("fps-field");
  if (fpsField) fpsField.hidden = mode === "frames";
  const hint = document.getElementById("extract-mode-hint");
  if (hint) {
    hint.textContent =
      mode === "frames"
        ? ffmpegAvailable
          ? "按解码顺序逐张提取这段视频里的每一帧。"
          : "尚未下载 ffmpeg。选中此项会提示下载到本工具目录，时间抽样仍可使用。"
        : "按时间抽样，不是解码器逐编码帧。";
  }
  const btn = document.getElementById("btn-extract") as HTMLButtonElement | null;
  if (btn && !state.extracting) btn.disabled = false;
}

export function refreshExtractStats(): void {
  const project = state.project;
  const start = Number((document.getElementById("start-sec") as HTMLInputElement).value);
  const end = Number((document.getElementById("end-sec") as HTMLInputElement).value);
  const fps = Number((document.getElementById("fps") as HTMLInputElement).value);
  const mode = readExtractMode();
  const fpsBox = document.getElementById("fps-val") as HTMLInputElement;
  if (document.activeElement !== fpsBox) fpsBox.value = String(fps);
  const span = Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) : 0;
  const sourceFps = project?.extract.sourceFps || 0;
  if (mode === "frames") {
    const count = encodedEstimate(start, end, sourceFps);
    document.getElementById("estimate")!.innerHTML = sourceFps
      ? `约 <b>${count}</b> 帧　（区间 ${formatTime(span)} 秒 × 源帧率 ${sourceFps.toFixed(3)}）`
      : `约 <b>—</b> 帧　（载入视频后读取源帧率）`;
  } else {
    const count = estimateFrameCount(start, end, fps);
    document.getElementById("estimate")!.innerHTML =
      `预估 <b>${count}</b> 帧　（区间 ${formatTime(span)} 秒 × 每秒 ${fps} 帧）`;
  }
  syncExtractModeUi();
  if (project) {
    const changed =
      project.extract.startSec !== start ||
      project.extract.endSec !== end ||
      project.extract.fps !== fps ||
      (project.extract.mode || "time") !== mode;
    project.extract.startSec = start;
    project.extract.endSec = end;
    project.extract.fps = fps;
    project.extract.mode = mode;
    if (changed && !state.dirty) setState({ dirty: true });
    else if (changed) state.dirty = true;
  }
  applyPreviewRange();
}

function syncMeta(): void {
  const video = videoEl();
  const project = state.project;
  const name = state.videoFile?.name || project?.source.filename || "—";
  const w = video.videoWidth || project?.source.width || 0;
  const h = video.videoHeight || project?.source.height || 0;
  const dur = video.duration && Number.isFinite(video.duration) ? video.duration : project?.source.durationSec || 0;
  document.getElementById("meta-name")!.textContent = name;
  document.getElementById("meta-res")!.textContent = w && h ? `${w} × ${h}` : "—";
  document.getElementById("meta-dur")!.textContent = dur ? `${formatTime(dur)} s` : "—";
}

export function syncExtractFieldsFromProject(): void {
  if (!state.project) return;
  const { startSec, endSec, fps, mode } = state.project.extract;
  (document.getElementById("start-sec") as HTMLInputElement).value = String(startSec);
  (document.getElementById("end-sec") as HTMLInputElement).value = String(endSec || 0);
  (document.getElementById("fps") as HTMLInputElement).value = String(fps || 20);
  (document.getElementById("extract-mode") as HTMLSelectElement).value = mode === "frames" ? "frames" : "time";
  refreshExtractStats();
  syncMeta();
  layoutCrop();
}

function isAllowedVideo(file: File): boolean {
  if (file.type === "video/mp4" || file.type === "video/webm") return true;
  return /\.(mp4|webm)$/i.test(file.name);
}

let extractParamSnap: { startSec: number; endSec: number; fps: number; mode: "time" | "frames"; sourceFps: number } | null = null;
let extractParamTimer = 0;

function beginExtractParamHistory(): void {
  if (extractParamSnap || !state.project) return;
  extractParamSnap = {
    startSec: state.project.extract.startSec,
    endSec: state.project.extract.endSec,
    fps: state.project.extract.fps,
    mode: state.project.extract.mode === "frames" ? "frames" : "time",
    sourceFps: state.project.extract.sourceFps || 0,
  };
}

function commitExtractParamHistory(): void {
  window.clearTimeout(extractParamTimer);
  if (!extractParamSnap || !state.project) return;
  const before = extractParamSnap;
  extractParamSnap = null;
  const cur = state.project.extract;
  const mode = cur.mode === "frames" ? "frames" : "time";
  if (
    before.startSec === cur.startSec &&
    before.endSec === cur.endSec &&
    before.fps === cur.fps &&
    before.mode === mode
  ) {
    return;
  }
  history.push("抽帧参数", () => {
    if (!state.project) return;
    state.project.extract.startSec = before.startSec;
    state.project.extract.endSec = before.endSec;
    state.project.extract.fps = before.fps;
    state.project.extract.mode = before.mode;
    state.project.extract.sourceFps = before.sourceFps;
    syncExtractFieldsFromProject();
  });
}

async function attachVideo(file: File): Promise<void> {
  if (!isAllowedVideo(file)) {
    setState({ extractError: "仅支持 mp4（H.264）或 webm。请换浏览器或先转 H.264。" });
    return;
  }
  const shouldClear = state.dirty || (state.project?.frames.length || 0) > 0;
  if (shouldClear) {
    const ok = await confirmDialog({
      title: "更换源视频？",
      body: "将替换提取设定，未保存的撤销记录将丢失。",
      ok: "更换",
      danger: true,
    });
    if (!ok) return;
  }
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  const url = URL.createObjectURL(file);
  const video = videoEl();
  setState({ videoFile: file, videoUrl: url, extractError: "" });
  document.getElementById("drop-hint")!.hidden = true;
  video.src = url;
  applyVideoPlaybackRate();
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onErr);
      applyVideoPlaybackRate();
      resolve();
    };
    const onErr = () => {
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onErr);
      reject(new Error("无法预览该视频"));
    };
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("error", onErr);
  }).catch((err: Error) => {
    setState({ extractError: `${err.message}。请换 Chrome / Edge，或先转 H.264。` });
    throw err;
  });
  const durationSec = await resolveDuration(video);
  if (!state.project) {
    const base = file.name.replace(/\.[^.]+$/, "") || "未命名序列";
    const project = await createProject(base);
    setState({ project });
  }
  const project = state.project!;
  project.source = {
    filename: file.name,
    width: video.videoWidth,
    height: video.videoHeight,
    durationSec,
  };
  project.label = project.label || file.name;
  project.extract.startSec = 0;
  project.extract.endSec = project.source.durationSec;
  if (!project.extract.fps) project.extract.fps = 20;
  extractParamSnap = null;
  window.clearTimeout(extractParamTimer);
  syncExtractFieldsFromProject();
  setState({ status: "已载入视频，可裁剪并提取", dirty: true });
  if (shouldClear) history.clear();
  videoToken = "";
  videoTokenKey = "";
  if (readExtractMode() === "frames") void ensureSourceProbe();
}

async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise<void>((resolve) => {
    const finish = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.removeEventListener("timeupdate", finish);
        video.removeEventListener("durationchange", finish);
        resolve();
      }
    };
    video.addEventListener("timeupdate", finish);
    video.addEventListener("durationchange", finish);
    try {
      video.currentTime = 1e10;
    } catch {
      resolve();
      return;
    }
    window.setTimeout(() => resolve(), 1200);
  });
  const fromSeekable =
    video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : 0;
  const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fromSeekable;
  video.currentTime = 0;
  return dur || 0;
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cap = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : t;
    const target = Math.min(Math.max(0, t), cap);
    const finish = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onSeeked = () => finish();
    const onError = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("seek 失败"));
    };
    if (Math.abs(video.currentTime - target) < 0.0008) {
      resolve();
      return;
    }
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.pause();
    video.currentTime = target;
    const timer = window.setTimeout(() => finish(), 900);
  });
}

function waitFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, 80);
    const anyVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (anyVideo.requestVideoFrameCallback) {
      anyVideo.requestVideoFrameCallback(() => done());
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
}

function captureCrop(video: HTMLVideoElement, crop: CropRect): Promise<{ blob: Blob; w: number; h: number }> {
  const sx = Math.round(crop.x * video.videoWidth);
  const sy = Math.round(crop.y * video.videoHeight);
  const sw = Math.max(1, Math.round(crop.w * video.videoWidth));
  const sh = Math.max(1, Math.round(crop.h * video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("无法截帧"));
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("PNG 编码失败"));
      else resolve({ blob, w: sw, h: sh });
    }, "image/png");
  });
}

async function ensureProject(): Promise<Project> {
  if (state.project) return state.project;
  const project = await createProject("未命名序列");
  setState({ project });
  return project;
}

async function commitBlobs(
  project: Project,
  captured: Array<{ blob: Blob; w: number; h: number }>,
): Promise<void> {
  await clearFrames(project.id);
  const frames: FrameRecord[] = [];
  for (let i = 0; i < captured.length; i++) {
    const file = padFrameFile(i + 1);
    await putFrame(project.id, file, captured[i].blob);
    await putOriginalFrame(project.id, file, captured[i].blob);
    frames.push({
      id: `f${String(i + 1).padStart(4, "0")}`,
      index: i,
      file: relativeFramePath(project.id, file),
      width: captured[i].w,
      height: captured[i].h,
      inWorkingSet: true,
      ops: [],
    });
  }
  project.frames = frames;
  project.editConfirmed = false;
}

async function ensureSourceProbe(force = false): Promise<void> {
  const file = state.videoFile;
  if (!file || readExtractMode() !== "frames" || !ffmpegAvailable) return;
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  if (!force && videoToken && videoTokenKey === key && (state.project?.extract.sourceFps || 0) > 0) return;
  setState({ status: "正在读取源帧率…" });
  const probe = await probeVideoFile(file);
  videoToken = probe.token;
  videoTokenKey = key;
  if (state.project) state.project.extract.sourceFps = probe.fps;
  refreshExtractStats();
  setState({ status: `源帧率 ${probe.fps.toFixed(3)}，可按全部编码帧提取` });
}

function paintExtractProgress(current: number, total: number): void {
  const safeTotal = Math.max(total, current, 1);
  const bar = document.getElementById("extract-bar") as HTMLElement;
  bar.style.width = `${Math.min(100, (current / safeTotal) * 100)}%`;
  document.getElementById("extract-label")!.textContent = total > 0 ? `${current} / ${total}` : `${current}`;
}

function showFfmpegProgress(line: string, percent?: number): void {
  const root = document.getElementById("ffmpeg-progress-root");
  const label = document.getElementById("ffmpeg-progress-label");
  const bar = document.getElementById("ffmpeg-progress-bar") as HTMLElement | null;
  if (root) root.hidden = false;
  if (label) label.textContent = line;
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
}

function hideFfmpegProgress(): void {
  const root = document.getElementById("ffmpeg-progress-root");
  if (root) root.hidden = true;
}

async function offerFfmpegInstall(): Promise<boolean> {
  if (ffmpegAvailable) return true;
  const ok = await confirmDialog({
    title: "下载 ffmpeg？",
    body: "全部编码帧需要 ffmpeg。<br>将下载到本工具目录（约 190MB），不用单独安装，也不用重启。<br>取消则继续使用按时间抽样。",
    ok: "确定并下载",
  });
  if (!ok) return false;
  showFfmpegProgress("正在下载 ffmpeg…", 1);
  try {
    await installFfmpeg((ev) => showFfmpegProgress(ev.line, ev.percent));
    ffmpegAvailable = true;
    syncExtractModeUi();
    hideFfmpegProgress();
    setState({ status: "ffmpeg 已就绪", extractError: "" });
    return true;
  } catch (err) {
    hideFfmpegProgress();
    ffmpegAvailable = false;
    syncExtractModeUi();
    setState({ extractError: (err as Error).message, status: "下载 ffmpeg 失败" });
    return false;
  }
}

async function startEncodedExtract(project: Project): Promise<void> {
  if (!ffmpegAvailable) {
    const installed = await offerFfmpegInstall();
    if (!installed) return;
  }
  if (!state.videoFile) {
    setState({ extractError: "全部编码帧需要当前载入的视频。请重新选择 mp4 / webm。" });
    return;
  }
  const { startSec, endSec, crop, sourceFps } = project.extract;
  const expect = encodedEstimate(startSec, endSec, sourceFps || 0);
  const ok = await confirmDialog({
    title: project.frames.length ? "重新提取？" : "开始提取？",
    body: project.frames.length
      ? `将按解码顺序逐张提取，并替换当前 ${project.frames.length} 帧。此操作无法撤销。`
      : "将按解码顺序逐张提取这段视频，生成工作集 PNG。此操作无法撤销。",
    ok: "开始提取",
    danger: true,
  });
  if (!ok) return;

  const abort = new AbortController();
  setState({
    extracting: true,
    extractAbort: abort,
    extractError: "",
    extractProgress: { current: 0, total: expect },
    status: "正在按编码帧提取…",
  });
  document.getElementById("extract-progress")!.hidden = false;
  document.getElementById("btn-cancel-extract")!.hidden = false;
  paintExtractProgress(0, expect);
  try {
    await ensureSourceProbe();
    if (!videoToken) throw new Error("没有读到视频");
    let result;
    try {
      result = await runEncodedExtract(
        project.id,
        videoToken,
        { start: startSec, end: endSec, x: crop.x, y: crop.y, w: crop.w, h: crop.h },
        (current) => {
          paintExtractProgress(current, expect);
          setState({ extractProgress: { current, total: expect || current } });
        },
        abort.signal,
      );
    } catch (err) {
      if (!/缓存已失效/.test((err as Error).message)) throw err;
      videoToken = "";
      await ensureSourceProbe(true);
      result = await runEncodedExtract(
        project.id,
        videoToken,
        { start: startSec, end: endSec, x: crop.x, y: crop.y, w: crop.w, h: crop.h },
        (current) => {
          paintExtractProgress(current, expect);
          setState({ extractProgress: { current, total: expect || current } });
        },
        abort.signal,
      );
    }
    if (result.sourceFps) project.extract.sourceFps = result.sourceFps;
    project.frames = result.frames.map((frame, i) => ({
      id: `f${String(i + 1).padStart(4, "0")}`,
      index: i,
      file: relativeFramePath(project.id, frame.file),
      width: frame.w,
      height: frame.h,
      inWorkingSet: true,
      ops: [],
    }));
    project.editConfirmed = false;
    history.clear();
    setState({
      currentFrameId: project.frames[0]?.id ?? null,
      step: "edit",
      bust: Date.now(),
      dirty: true,
      exportDone: false,
      status: `已按编码帧提取 ${project.frames.length} 帧`,
      loopCandidates: [],
    });
    await persistNow();
  } catch (err) {
    if ((err as Error).name === "AbortError" || /已取消/.test((err as Error).message)) {
      setState({ status: "已取消提取", extractError: "" });
    } else {
      setState({ extractError: (err as Error).message, status: "提取失败" });
    }
  } finally {
    document.getElementById("extract-progress")!.hidden = true;
    document.getElementById("btn-cancel-extract")!.hidden = true;
    setState({ extracting: false, extractAbort: null });
    syncExtractModeUi();
  }
}

export async function startExtract(): Promise<void> {
  const video = videoEl();
  if (!state.videoUrl || !video.videoWidth) {
    setState({ extractError: "请先选择可预览的 mp4 / webm。" });
    return;
  }
  refreshExtractStats();
  commitExtractParamHistory();
  const project = await ensureProject();
  const { startSec, endSec, fps, crop } = project.extract;
  if (!(endSec > startSec)) {
    setState({ extractError: "结束时间必须大于起始时间。" });
    return;
  }
  if ((project.extract.mode || "time") === "frames") {
    await startEncodedExtract(project);
    return;
  }
  const times = sampleTimes(startSec, endSec, fps);
  if (!times.length) {
    setState({ extractError: "预估帧数为 0，请调整时间或帧率。" });
    return;
  }
  const ok = await confirmDialog({
    title: project.frames.length ? "重新提取？" : "开始提取？",
    body: project.frames.length
      ? `当前工作集已有 ${project.frames.length} 帧。开始提取将替换整套工作集。`
      : "将生成整套工作集帧 PNG。此操作无法撤销。",
    ok: "开始提取",
    danger: true,
  });
  if (!ok) return;

  const abort = new AbortController();
  setState({
    extracting: true,
    extractAbort: abort,
    extractError: "",
    extractProgress: { current: 0, total: times.length },
    status: "正在提取…",
  });
  document.getElementById("extract-progress")!.hidden = false;
  document.getElementById("btn-cancel-extract")!.hidden = false;

  const captured: Array<{ blob: Blob; w: number; h: number }> = [];
  try {
    for (let i = 0; i < times.length; i++) {
      if (abort.signal.aborted) break;
      await seekTo(video, times[i]);
      await waitFrame(video);
      captured.push(await captureCrop(video, crop));
      setState({ extractProgress: { current: i + 1, total: times.length } });
      const bar = document.getElementById("extract-bar") as HTMLElement;
      bar.style.width = `${((i + 1) / times.length) * 100}%`;
      document.getElementById("extract-label")!.textContent = `${i + 1} / ${times.length}`;
    }

    if (abort.signal.aborted) {
      if (!captured.length) {
        setState({ status: "已取消提取", extractError: "" });
      } else {
        const choice = await choiceDialog({
          title: "提取已取消",
          body: `已抽出 ${captured.length} / ${times.length} 帧。取消不得留下半套脏工作集：回退到提取前，或保留已抽出的帧。`,
          primary: `保留已抽出的 ${captured.length} 帧`,
          secondary: "回退到提取前",
        });
        if (choice === "primary") {
          await commitBlobs(project, captured);
          history.clear();
          setState({
            currentFrameId: project.frames[0]?.id ?? null,
            step: "edit",
            bust: Date.now(),
            dirty: true,
            exportDone: false,
            status: `已保留 ${captured.length} 帧`,
            loopCandidates: [],
          });
          await persistNow();
        } else {
          setState({ status: "已回退到提取前" });
        }
      }
      return;
    }

    await commitBlobs(project, captured);
    history.clear();
    setState({
      currentFrameId: project.frames[0]?.id ?? null,
      step: "edit",
      bust: Date.now(),
      dirty: true,
      exportDone: false,
      status: `已提取 ${project.frames.length} 帧`,
      loopCandidates: [],
    });
    await persistNow();
  } catch (err) {
    setState({ extractError: (err as Error).message, status: "提取失败" });
  } finally {
    setState({ extracting: false, extractAbort: null, extractProgress: null });
    document.getElementById("extract-progress")!.hidden = true;
    document.getElementById("btn-cancel-extract")!.hidden = true;
    syncExtractModeUi();
  }
}

export function toggleVideoPlay(): void {
  const video = videoEl();
  if (!state.videoUrl) return;
  if (video.paused) {
    const { start, end } = readPreviewRange();
    if (video.currentTime < start || video.currentTime >= end - 0.01) {
      video.currentTime = start;
    }
    applyVideoPlaybackRate();
    void video.play();
  } else {
    video.pause();
  }
}

export function initExtract(): void {
  const video = videoEl();
  const input = document.getElementById("video-input") as HTMLInputElement;
  const hint = document.getElementById("drop-hint")!;
  const stage = document.getElementById("video-stage")!;

  hint.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) void attachVideo(file);
  });
  stage.addEventListener("dragover", (ev) => {
    ev.preventDefault();
  });
  stage.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const file = ev.dataTransfer?.files?.[0];
    if (file) void attachVideo(file);
  });

  video.addEventListener("timeupdate", () => {
    const { start, end } = readPreviewRange();
    if (!video.paused && video.currentTime >= end - 0.01) {
      video.currentTime = start;
    }
    updateVideoTimeLabel();
  });
  video.addEventListener("ended", () => {
    const { start } = readPreviewRange();
    video.currentTime = start;
    applyVideoPlaybackRate();
    void video.play();
  });
  (document.getElementById("video-scrub") as HTMLInputElement).addEventListener("input", (ev) => {
    video.currentTime = Number((ev.target as HTMLInputElement).value);
  });
  document.getElementById("btn-play")!.addEventListener("click", () => toggleVideoPlay());
  video.addEventListener("loadedmetadata", () => {
    applyVideoPlaybackRate();
    const { start, end } = readPreviewRange();
    extractRangeKey = `${start}:${end}`;
  });

  for (const id of ["start-sec", "end-sec", "fps"]) {
    const el = document.getElementById(id)!;
    el.addEventListener("input", () => {
      if (id === "start-sec" || id === "end-sec") noteExtractRangeChange();
      beginExtractParamHistory();
      refreshExtractStats();
      persistSoon();
      window.clearTimeout(extractParamTimer);
      extractParamTimer = window.setTimeout(commitExtractParamHistory, 400);
    });
    el.addEventListener("change", () => {
      if (id === "start-sec" || id === "end-sec") noteExtractRangeChange();
      beginExtractParamHistory();
      refreshExtractStats();
      persistSoon();
      commitExtractParamHistory();
    });
  }
  document.getElementById("btn-extract")!.addEventListener("click", () => void startExtract());
  document.getElementById("btn-cancel-extract")!.addEventListener("click", () => {
    state.extractAbort?.abort();
  });
  document.getElementById("extract-mode")!.addEventListener("change", () => {
    void (async () => {
      beginExtractParamHistory();
      if (readExtractMode() === "frames" && !ffmpegAvailable) {
        const installed = await offerFfmpegInstall();
        if (!installed) {
          (document.getElementById("extract-mode") as HTMLSelectElement).value = "time";
        }
      }
      refreshExtractStats();
      persistSoon();
      commitExtractParamHistory();
      if (readExtractMode() === "frames") {
        ensureSourceProbe().catch((err: Error) => {
          setState({ extractError: err.message, status: "读取源帧率失败" });
        });
      }
    })();
  });
  void fetchFfmpegStatus()
    .then((status) => {
      ffmpegAvailable = status.available;
      syncExtractModeUi();
    })
    .catch(() => {
      ffmpegAvailable = false;
      syncExtractModeUi();
    });

  const cropRect = document.getElementById("crop-rect")!;
  let drag: { mode: string; ox: number; oy: number; crop: CropRect } | null = null;
  cropRect.addEventListener("pointerdown", (ev) => {
    const handle = (ev.target as HTMLElement).dataset.h || "move";
    const pos = clientToNorm(ev);
    if (!pos) return;
    drag = { mode: handle, ox: pos.x, oy: pos.y, crop: { ...cropNorm() } };
    cropRect.setPointerCapture(ev.pointerId);
  });
  cropRect.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const pos = clientToNorm(ev);
    if (!pos) return;
    const dx = pos.x - drag.ox;
    const dy = pos.y - drag.oy;
    const c = { ...drag.crop };
    if (drag.mode === "move") {
      setCrop({ ...c, x: c.x + dx, y: c.y + dy });
    } else {
      let { x, y, w, h } = c;
      if (drag.mode.includes("w")) {
        x = c.x + dx;
        w = c.w - dx;
      }
      if (drag.mode.includes("e")) w = c.w + dx;
      if (drag.mode.includes("n")) {
        y = c.y + dy;
        h = c.h - dy;
      }
      if (drag.mode.includes("s")) h = c.h + dy;
      setCrop({ x, y, w, h });
    }
  });
  const finishCropDrag = () => {
    if (!drag) return;
    const before = drag.crop;
    const after = cropNorm();
    drag = null;
    if (before.x === after.x && before.y === after.y && before.w === after.w && before.h === after.h) return;
    history.push("裁剪框", () => {
      setCrop(before);
    });
  };
  cropRect.addEventListener("pointerup", finishCropDrag);
  cropRect.addEventListener("pointercancel", finishCropDrag);
  window.addEventListener("resize", () => layoutCrop());
  video.addEventListener("loadeddata", () => layoutCrop());
}
