import {
  BIREFNET_INSTALL_SIZE,
  BIREFNET_MODEL_URL,
  fetchMatteStatus,
  frameUrl,
  installMatte,
  originalFrameUrl,
  putFrame,
  putOriginalFrame,
  requestMatte,
} from "./api";
import {
  MAX_CHROMA_SAMPLES,
  alphaFromGrayImageData,
  applyBirefNet,
  applyChromaKey,
  opsEqual,
  rgbNear,
  serializeChromaOp,
} from "./chroma";
import { confirmDialog, imageDataFrom, imageDataToPng, isTypingTarget, loadImage, showToast } from "./dom";
import { showAppliedFramePreview } from "./organizeUi";
import { persistNow } from "./persist";
import * as history from "./history";
import {
  bakeStroke,
  cloneRefine,
  compositeRefine,
  createRefine,
  stampRefine,
  unionRect,
  type PixelRect,
  type RefineBuffers,
} from "./refine";
import { currentFrame, selectedFrames, setState, state } from "./store";
import type { BirefNetOp, ChromaOp, FrameOp } from "./types";

type MatteMethod = "chroma" | "birefNet";
type PreviewBg = "checker" | "white" | "black" | "gray";
type EditorTool = "sample" | "brush" | "eraser";
type LoupeScale = 2 | 4 | 8;
type Rgb = [number, number, number];
type Sample = { x: number; y: number; color: Rgb };

let original: ImageData | null = null;
let plate: ImageData | null = null;
let matted: ImageData | null = null;
let preview: ImageData | null = null;
let refine: RefineBuffers | null = null;
let stroke: RefineBuffers | null = null;
let refineRev = 0;
let refineMarks = 0;
let samples: Sample[] = [];
let method: MatteMethod = "chroma";
let tool: EditorTool = "sample";
let loupeScale: LoupeScale = 4;
let painting = false;
let lastDab: { x: number; y: number } | null = null;
let loupePoint: { x: number; y: number } | null = null;
let previewBg: PreviewBg = "checker";
let matteAlpha: Float32Array | null = null;
let matteFile: string | null = null;
let matteBusy = false;
let matteGen = 0;

type EditorSnap = {
  method: MatteMethod;
  samples: Sample[];
  tolerance: number;
  halo: number;
  despill: number;
  threshold: number;
  feather: number;
  refine: RefineBuffers | null;
  refineRev: number;
  refineMarks: number;
};

const EDITOR_MAX = 15;
let editorLocalStack: EditorSnap[] = [];
let sliderSnap: EditorSnap | null = null;
let sliderTimer = 0;
let editorBaseline: EditorSnap = {
  method: "chroma",
  samples: [],
  tolerance: 24,
  halo: 2,
  despill: 8,
  threshold: 0.5,
  feather: 1,
  refine: null,
  refineRev: 0,
  refineMarks: 0,
};

function canvas(): HTMLCanvasElement {
  return document.getElementById("editor-canvas") as HTMLCanvasElement;
}

function canvasWrap(): HTMLElement {
  return canvas().parentElement as HTMLElement;
}

const MIN_ZOOM = 0.12;
const MAX_ZOOM = 8;
let zoom = 1;
let zoomMode: "fit" | "manual" = "fit";

function fitZoom(): number {
  if (!original) return 1;
  const wrap = canvasWrap();
  const pad = 32;
  const availW = Math.max(80, wrap.clientWidth - pad);
  const availH = Math.max(80, wrap.clientHeight - pad);
  return Math.min(availW / original.width, availH / original.height);
}

function applyCanvasCss(): void {
  if (!original) return;
  const c = canvas();
  c.style.width = `${original.width * zoom}px`;
  c.style.height = `${original.height * zoom}px`;
  const label = document.getElementById("editor-zoom-val");
  if (label) label.textContent = zoomMode === "fit" ? "适应" : `${Math.round(zoom * 100)}%`;
}

function setZoom(next: number, mode: "fit" | "manual", anchor?: { x: number; y: number }): void {
  const wrap = canvasWrap();
  const prev = zoom;
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  zoomMode = mode;
  applyCanvasCss();
  if (anchor && prev > 0) {
    const ratio = zoom / prev;
    wrap.scrollLeft = anchor.x * ratio - (anchor.x - wrap.scrollLeft);
    wrap.scrollTop = anchor.y * ratio - (anchor.y - wrap.scrollTop);
  }
}

function zoomToFit(): void {
  setZoom(fitZoom(), "fit");
  canvasWrap().scrollLeft = 0;
  canvasWrap().scrollTop = 0;
}

function fileName(frameFile: string): string {
  return frameFile.split("/").pop()!;
}

function showBatchProgress(current: number, total: number, hint: string): void {
  const root = document.getElementById("batch-progress-root")!;
  root.hidden = false;
  const bar = document.getElementById("batch-progress-bar") as HTMLElement;
  bar.style.width = total ? `${(current / total) * 100}%` : "0%";
  document.getElementById("batch-progress-label")!.textContent = `${current} / ${total}`;
  document.getElementById("batch-progress-hint")!.textContent = hint;
}

function hideBatchProgress(): void {
  document.getElementById("batch-progress-root")!.hidden = true;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function inputVal(id: string): number {
  return Number((document.getElementById(id) as HTMLInputElement).value);
}

function readChromaParams(): { tolerance: number; halo: number; despill: number } {
  return {
    tolerance: inputVal("tolerance"),
    halo: inputVal("halo"),
    despill: inputVal("despill"),
  };
}

function readBirefParams(): Pick<BirefNetOp, "threshold" | "feather"> {
  return {
    threshold: inputVal("biref-threshold"),
    feather: inputVal("biref-feather"),
  };
}

function cloneSamples(list: Sample[]): Sample[] {
  return list.map((s) => ({ x: s.x, y: s.y, color: [s.color[0], s.color[1], s.color[2]] }));
}

function paint(data: ImageData, rect?: PixelRect): void {
  const c = canvas();
  const resized = c.width !== data.width || c.height !== data.height;
  if (resized) {
    c.width = data.width;
    c.height = data.height;
  }
  const ctx = c.getContext("2d");
  if (!ctx) return;
  if (!resized && rect) {
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.y1 - rect.y0 + 1;
    ctx.putImageData(data, 0, 0, rect.x0, rect.y0, w, h);
  } else {
    ctx.putImageData(data, 0, 0);
  }
  if (resized) applyCanvasCss();
}

function brushDiameter(): number {
  return Math.max(1, Math.min(128, inputVal("brush-size") || 10));
}

function brushHardness(): number {
  return Math.max(0, Math.min(100, inputVal("brush-hardness")));
}

function hasRefine(): boolean {
  return refineMarks > 0 || stroke != null;
}

function resetRefine(): void {
  refine = null;
  stroke = null;
  refineRev = 0;
  refineMarks = 0;
}

function recomputeMatted(): void {
  if (!original) {
    matted = null;
    return;
  }
  if (method === "birefNet") {
    matted = matteAlpha ? applyBirefNet(original, matteAlpha, currentBirefOp()) : original;
    return;
  }
  const op = currentChromaOp();
  matted = op ? applyChromaKey(original, op) : original;
}

function present(rect?: PixelRect): void {
  if (!matted || !plate) return;
  if (!preview || preview.width !== matted.width || preview.height !== matted.height) {
    preview = new ImageData(matted.width, matted.height);
    rect = undefined;
  }
  compositeRefine(matted, plate, refine, stroke, preview, rect);
  paint(preview, rect);
}

function currentChromaOp(): ChromaOp | null {
  if (!samples.length || !original) return null;
  const { tolerance, halo, despill } = readChromaParams();
  return serializeChromaOp({
    type: "chromaKey",
    x: samples[0].x,
    y: samples[0].y,
    color: samples[0].color,
    colors: samples.map((s) => s.color),
    tolerance,
    halo,
    despill,
  });
}

function currentBirefOp(): BirefNetOp {
  const { threshold, feather } = readBirefParams();
  return { type: "birefNet", model: "hr-matting", threshold, feather };
}

function applyPreviewBg(bg: PreviewBg): void {
  previewBg = bg;
  const wrap = canvasWrap();
  wrap.classList.toggle("checker", bg === "checker");
  wrap.classList.toggle("preview-bg-white", bg === "white");
  wrap.classList.toggle("preview-bg-black", bg === "black");
  wrap.classList.toggle("preview-bg-gray", bg === "gray");
  for (const btn of document.querySelectorAll<HTMLElement>("#preview-bg [data-bg]")) {
    btn.classList.toggle("is-on", btn.dataset.bg === bg);
  }
}

function setMethodUi(next: MatteMethod): void {
  method = next;
  el("chroma-panel").hidden = next !== "chroma";
  el("biref-panel").hidden = next !== "birefNet";
  for (const btn of document.querySelectorAll<HTMLElement>("#matte-method [data-method]")) {
    btn.classList.toggle("is-on", btn.dataset.method === next);
  }
}

function renderSwatches(): void {
  const root = el("chroma-swatches");
  root.innerHTML = "";
  samples.forEach((s, index) => {
    const chip = document.createElement("div");
    chip.className = "chroma-chip";
    const sw = document.createElement("span");
    sw.style.background = `rgb(${s.color.join(",")})`;
    sw.title = `RGB ${s.color.join(", ")}`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.title = "删除色样";
    del.addEventListener("click", () => {
      flushEditorSliderHistory();
      const before = captureEditor();
      samples = samples.filter((_, i) => i !== index);
      pushEditorLocal(before);
      rememberEditorBaseline();
      renderSwatches();
      refreshPreview();
    });
    chip.append(sw, del);
    root.append(chip);
  });
  const rgb = el("sample-rgb");
  rgb.textContent = samples.length ? `${samples.length} 个背景色` : "未采样";
  const clearBtn = document.getElementById("btn-chroma-clear") as HTMLButtonElement | null;
  if (clearBtn) clearBtn.hidden = samples.length === 0;
}

function refreshPreview(): void {
  if (!original || !plate) return;
  recomputeMatted();
  present();
}

function captureEditor(): EditorSnap {
  const { tolerance, halo, despill } = readChromaParams();
  const { threshold, feather } = readBirefParams();
  return {
    method,
    samples: cloneSamples(samples),
    tolerance,
    halo,
    despill,
    threshold,
    feather,
    refine: refine ? cloneRefine(refine) : null,
    refineRev,
    refineMarks,
  };
}

function applyEditorSnap(snap: EditorSnap): void {
  samples = cloneSamples(snap.samples);
  el<HTMLInputElement>("tolerance").value = String(snap.tolerance);
  el<HTMLInputElement>("halo").value = String(snap.halo);
  el<HTMLInputElement>("despill").value = String(snap.despill);
  el<HTMLInputElement>("biref-threshold").value = String(snap.threshold);
  el<HTMLInputElement>("biref-feather").value = String(snap.feather);
  el<HTMLInputElement>("tol-val").value = String(snap.tolerance);
  el<HTMLInputElement>("halo-val").value = String(snap.halo);
  el<HTMLInputElement>("despill-val").value = String(snap.despill);
  el<HTMLInputElement>("biref-th-val").value = snap.threshold.toFixed(2);
  el<HTMLInputElement>("biref-feather-val").value = String(snap.feather);
  setMethodUi(snap.method);
  refine = snap.refine ? cloneRefine(snap.refine) : null;
  refineRev = snap.refineRev;
  refineMarks = snap.refineMarks;
  stroke = null;
  painting = false;
  lastDab = null;
  renderSwatches();
  refreshPreview();
  syncBirefRunBtn();
}

function rememberEditorBaseline(): void {
  editorBaseline = captureEditor();
}

function syncEditorUndoBtn(): void {
  const btn = document.getElementById("btn-editor-undo") as HTMLButtonElement | null;
  if (btn) btn.disabled = editorLocalStack.length === 0;
}

function pushEditorLocal(before: EditorSnap): void {
  editorLocalStack.push(before);
  while (editorLocalStack.length > EDITOR_MAX) editorLocalStack.shift();
  syncEditorUndoBtn();
}

function clearEditorLocal(): void {
  editorLocalStack = [];
  sliderSnap = null;
  window.clearTimeout(sliderTimer);
  syncEditorUndoBtn();
}

function snapsEqual(a: EditorSnap, b: EditorSnap): boolean {
  return (
    a.method === b.method &&
    a.tolerance === b.tolerance &&
    a.halo === b.halo &&
    a.despill === b.despill &&
    a.threshold === b.threshold &&
    a.feather === b.feather &&
    a.refineRev === b.refineRev &&
    JSON.stringify(a.samples) === JSON.stringify(b.samples)
  );
}

function flushEditorSliderHistory(): void {
  window.clearTimeout(sliderTimer);
  if (!sliderSnap) return;
  const before = sliderSnap;
  sliderSnap = null;
  const now = captureEditor();
  if (snapsEqual(before, now)) {
    rememberEditorBaseline();
    return;
  }
  pushEditorLocal(before);
  rememberEditorBaseline();
}

export function undoEditorLocal(): boolean {
  flushEditorSliderHistory();
  const snap = editorLocalStack.pop();
  if (!snap) return false;
  applyEditorSnap(snap);
  syncEditorUndoBtn();
  rememberEditorBaseline();
  return true;
}

function setBirefStatus(text: string): void {
  const node = document.getElementById("biref-status");
  if (node) node.textContent = text;
}

function syncBirefRunBtn(): void {
  const btn = document.getElementById("btn-biref-rerun");
  if (btn) btn.textContent = matteAlpha ? "重新推理" : "开始推理";
}

let birefClock: number | null = null;
let birefClockStart = 0;
let birefProgressMode: "install" | "infer" = "install";

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m} 分 ${r} 秒` : `${r} 秒`;
}

function startBirefClock(): void {
  if (birefClock != null) return;
  birefClockStart = Date.now();
  const tick = () => {
    const meta = document.getElementById("biref-progress-meta");
    if (meta) {
      meta.textContent =
        birefProgressMode === "infer"
          ? `已进行 ${formatElapsed(Date.now() - birefClockStart)} · 模型正在计算主体遮罩`
          : `已进行 ${formatElapsed(Date.now() - birefClockStart)} · 合计 ${BIREFNET_INSTALL_SIZE.total}，几分钟不动也正常`;
    }
  };
  tick();
  birefClock = window.setInterval(tick, 1000);
}

function stopBirefClock(): void {
  if (birefClock != null) {
    clearInterval(birefClock);
    birefClock = null;
  }
}

function showBirefProgress(line: string, percent?: number, phase?: string): void {
  const root = document.getElementById("biref-progress-root");
  const card = document.getElementById("biref-progress-card");
  const title = document.getElementById("biref-progress-title");
  const size = document.getElementById("biref-progress-size");
  const label = document.getElementById("biref-progress-label");
  const log = document.getElementById("biref-progress-log");
  const bar = document.getElementById("biref-progress-bar") as HTMLElement | null;
  const inferring = phase === "infer";
  birefProgressMode = inferring ? "infer" : "install";
  if (root) root.hidden = false;
  card?.classList.toggle("is-infer", inferring);
  card?.classList.remove("is-done");
  if (title) title.textContent = inferring ? "正在推理" : "正在下载安装 BiRefNet";
  if (size) size.hidden = inferring;
  startBirefClock();
  if (label) label.textContent = line;
  if (typeof percent === "number" && bar) {
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.classList.remove("is-waiting");
  } else if (bar) {
    bar.classList.add("is-waiting");
  }
  if (phase !== "heartbeat" && phase !== "infer" && log) {
    const parts = (log.textContent || "").split("\n").filter(Boolean);
    const progressLike = /\d\s*%| \/ /.test(line);
    if (progressLike && parts.length) parts[parts.length - 1] = line;
    else parts.push(line);
    log.textContent = parts.slice(-12).join("\n") + "\n";
    log.scrollTop = log.scrollHeight;
  }
  setBirefStatus(line);
}

function finishBirefProgress(ok: boolean, line: string): void {
  const root = document.getElementById("biref-progress-root");
  const card = document.getElementById("biref-progress-card");
  const title = document.getElementById("biref-progress-title");
  const size = document.getElementById("biref-progress-size");
  const label = document.getElementById("biref-progress-label");
  const meta = document.getElementById("biref-progress-meta");
  const bar = document.getElementById("biref-progress-bar") as HTMLElement | null;
  stopBirefClock();
  birefProgressMode = "infer";
  if (root) root.hidden = false;
  card?.classList.add("is-infer", "is-done");
  if (size) size.hidden = true;
  if (title) title.textContent = ok ? "推理完成" : "推理失败";
  if (label) label.textContent = line;
  if (meta) {
    meta.textContent = ok
      ? `已进行 ${formatElapsed(Date.now() - birefClockStart)} · 进度 100%。点关闭查看预览`
      : "点关闭返回编辑器";
  }
  if (bar) {
    bar.classList.remove("is-waiting");
    bar.style.width = ok ? "100%" : bar.style.width || "100%";
  }
  setBirefStatus(line);
}

function hideBirefProgress(): void {
  stopBirefClock();
  const root = document.getElementById("biref-progress-root");
  const card = document.getElementById("biref-progress-card");
  const size = document.getElementById("biref-progress-size");
  const bar = document.getElementById("biref-progress-bar") as HTMLElement | null;
  if (root) root.hidden = true;
  card?.classList.remove("is-infer", "is-done");
  if (size) size.hidden = false;
  if (bar) {
    bar.classList.add("is-waiting");
    bar.style.width = "";
  }
}

async function blobToImageData(blob: Blob): Promise<ImageData> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return imageDataFrom(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadEditorSource(projectId: string, file: string): Promise<{ data: ImageData; copied: boolean }> {
  const workRes = await fetch(frameUrl(projectId, file, state.bust));
  if (!workRes.ok) throw new Error("无法读取该帧");
  const blob = await workRes.blob();
  let copied = false;
  const origRes = await fetch(originalFrameUrl(projectId, file, state.bust));
  if (!origRes.ok) {
    copied = true;
    try {
      await putOriginalFrame(projectId, file, blob);
    } catch {
      /* keep working even if backup copy fails */
    }
  }
  return { data: await blobToImageData(blob), copied };
}

async function loadPlate(projectId: string, file: string, fallback: ImageData): Promise<ImageData> {
  const res = await fetch(originalFrameUrl(projectId, file, state.bust));
  if (!res.ok) return fallback;
  const data = await blobToImageData(await res.blob());
  if (data.width !== fallback.width || data.height !== fallback.height) return fallback;
  return data;
}

async function ensureMatte(force = false): Promise<boolean> {
  const project = state.project;
  const frame = currentFrame();
  if (!project || !frame || !original) return false;
  const file = fileName(frame.file);
  if (!force && matteAlpha && matteFile === file) return true;
  const gen = ++matteGen;
  matteBusy = true;
  setBirefStatus("检查模型…");
  showBirefProgress("检查模型…", undefined, "infer");
  try {
    let info = await fetchMatteStatus();
    if (gen !== matteGen) {
      hideBirefProgress();
      return false;
    }
    if (!info.ready && (info.message === "检查超时" || info.error === "检查超时")) {
      hideBirefProgress();
      setBirefStatus("环境检查超时，已安装的依赖不用重装");
      setState({ status: "BiRefNet 环境检查超时，请再点一次开始推理" });
      refreshPreview();
      return false;
    }
    if (!info.ready) {
      hideBirefProgress();
      const modelUrl = info.modelUrl || BIREFNET_MODEL_URL;
      const ok = await confirmDialog({
        title: "下载并安装 BiRefNet？",
        body:
          `将安装本地依赖环境并下载模型，<strong>合计 ${BIREFNET_INSTALL_SIZE.total}</strong>（网速慢时可能要十几分钟到一小时）：<br>` +
          `PyTorch CUDA 12.8：${BIREFNET_INSTALL_SIZE.torch}<br>` +
          `其余 Python 包：${BIREFNET_INSTALL_SIZE.rest}<br>` +
          `BiRefNet 模型：${BIREFNET_INSTALL_SIZE.model}<br>` +
          `<a href="${modelUrl}" target="_blank" rel="noopener">${modelUrl}</a><br>` +
          `点确定后开始下载安装；取消则留在色度。`,
        ok: "确定并下载",
      });
      if (!ok) {
        setMethodUi("chroma");
        setBirefStatus("未确认下载");
        refreshPreview();
        return false;
      }
      setBirefStatus("正在安装 / 下载…");
      setState({ status: "正在安装依赖并下载 BiRefNet…" });
      showBirefProgress("已开始下载安装…");
      try {
        info = await installMatte((ev) => {
          showBirefProgress(ev.line, ev.percent, ev.phase);
        });
        if (!info.ready && /正在安装|安装失败 \(409\)/.test(String(info.error || info.message || ""))) {
          showBirefProgress("后台仍在下载安装，请稍候…");
          for (;;) {
            if (gen !== matteGen) {
              hideBirefProgress();
              return false;
            }
            const s = await fetchMatteStatus();
            if (s.ready) {
              info = s;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        showBirefProgress("模型已就绪，开始推理…", undefined, "infer");
      } catch (installErr) {
        const thrown = (installErr as Error).message || "";
        if (/正在安装|安装失败 \(409\)/.test(thrown)) {
          showBirefProgress("后台仍在下载安装，请稍候…");
          for (;;) {
            if (gen !== matteGen) {
              hideBirefProgress();
              return false;
            }
            const s = await fetchMatteStatus();
            if (s.ready) {
              info = s;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } else {
          hideBirefProgress();
          throw installErr;
        }
      }
      if (gen !== matteGen) {
        hideBirefProgress();
        return false;
      }
      if (!info.ready && !info.model) {
        const fail = info.error || info.message || "安装失败";
        finishBirefProgress(false, fail);
        setBirefStatus(fail);
        setState({ status: `BiRefNet：${fail}` });
        setMethodUi("chroma");
        refreshPreview();
        return false;
      }
    }
    setBirefStatus("推理中");
    setState({ status: "BiRefNet 推理中…" });
    showBirefProgress("模型正在计算主体遮罩，请稍候…", undefined, "infer");
    const png = await imageDataToPng(original);
    const result = await requestMatte(png);
    if (gen !== matteGen) {
      hideBirefProgress();
      return false;
    }
    const gray = await blobToImageData(result.blob);
    matteAlpha = alphaFromGrayImageData(gray);
    matteFile = file;
    if (result.cudaFallback) {
      setBirefStatus("就绪（CUDA 失败已回退 CPU）");
      setState({ status: "CUDA 失败已回退 CPU" });
    } else {
      setBirefStatus(result.device === "cpu" ? "就绪（CPU）" : "就绪");
      setState({ status: "BiRefNet 预览已更新" });
    }
    refreshPreview();
    finishBirefProgress(true, "推理完成（100%）");
    return true;
  } catch (err) {
    if (gen !== matteGen) {
      hideBirefProgress();
      return false;
    }
    const message = (err as Error).message || "推理失败";
    matteAlpha = null;
    setBirefStatus(message);
    setState({ status: `BiRefNet：${message}` });
    refreshPreview();
    finishBirefProgress(false, message);
    return false;
  } finally {
    if (gen === matteGen) matteBusy = false;
    syncBirefRunBtn();
  }
}

async function switchMethod(next: MatteMethod): Promise<void> {
  if (next === method) return;
  flushEditorSliderHistory();
  const before = captureEditor();
  setMethodUi(next);
  pushEditorLocal(before);
  rememberEditorBaseline();
  refreshPreview();
  if (next === "birefNet") {
    setBirefStatus(matteAlpha ? "就绪" : "点开始推理");
    syncBirefRunBtn();
  }
}

async function openEditor(): Promise<void> {
  const project = state.project;
  const frame = currentFrame();
  if (!project || !frame) {
    setState({ editorOpen: false, status: "请先在胶片条选择一帧" });
    return;
  }
  const loaded = await loadEditorSource(project.id, fileName(frame.file));
  original = loaded.data;
  plate = await loadPlate(project.id, fileName(frame.file), original);
  matted = original;
  preview = null;
  resetRefine();
  samples = [];
  matteAlpha = null;
  matteFile = null;
  matteGen += 1;
  document.getElementById("editor-frame-name")!.textContent = `第 ${frame.index + 1} 帧 · ${frame.width}×${frame.height}`;
  el<HTMLInputElement>("tolerance").value = "24";
  el<HTMLInputElement>("halo").value = "2";
  el<HTMLInputElement>("despill").value = "8";
  el<HTMLInputElement>("biref-threshold").value = "0.5";
  el<HTMLInputElement>("biref-feather").value = "1";
  el<HTMLInputElement>("tol-val").value = "24";
  el<HTMLInputElement>("halo-val").value = "2";
  el<HTMLInputElement>("despill-val").value = "8";
  el<HTMLInputElement>("biref-th-val").value = "0.50";
  el<HTMLInputElement>("biref-feather-val").value = "1";
  setBirefStatus("点开始推理");
  setMethodUi("chroma");
  setTool("sample");
  applyPreviewBg("checker");
  renderSwatches();
  refreshPreview();
  document.getElementById("editor-root")!.hidden = false;
  clearEditorLocal();
  rememberEditorBaseline();
  syncBirefRunBtn();
  syncEditorNav();
  if (zoomMode === "manual") requestAnimationFrame(() => applyCanvasCss());
  else requestAnimationFrame(() => zoomToFit());
  if (loaded.copied) {
    setState({ status: "本工程无抽出原图备份，已用当前帧补了一份" });
  }
}

function closeEditor(): void {
  original = null;
  plate = null;
  matted = null;
  preview = null;
  resetRefine();
  samples = [];
  matteAlpha = null;
  matteFile = null;
  matteGen += 1;
  painting = false;
  lastDab = null;
  loupePoint = null;
  hideLoupe();
  hideBrushRing();
  hideBirefProgress();
  clearEditorLocal();
  document.getElementById("editor-root")!.hidden = true;
  if (state.editorOpen) setState({ editorOpen: false });
}

function replaceOps(frame: { ops: FrameOp[] }, op: FrameOp): void {
  if (op.type === "chromaKey") {
    frame.ops = frame.ops.filter((o) => o.type !== "birefNet");
    if (!frame.ops.some((o) => o.type === "chromaKey" && opsEqual(o, op))) frame.ops.push(op);
    return;
  }
  frame.ops = frame.ops.filter((o) => o.type !== "chromaKey");
  if (!frame.ops.some((o) => o.type === "birefNet" && opsEqual(o, op))) frame.ops.push(op);
}

function editorHasPending(): boolean {
  if (!original) return false;
  if (hasRefine()) return true;
  if (method === "birefNet") return matteAlpha != null;
  return currentChromaOp() != null;
}

function syncEditorNav(): void {
  const frames = state.project?.frames ?? [];
  const pos = frames.findIndex((f) => f.id === state.currentFrameId);
  const prev = document.getElementById("btn-editor-prev") as HTMLButtonElement | null;
  const next = document.getElementById("btn-editor-next") as HTMLButtonElement | null;
  if (prev) prev.disabled = pos <= 0;
  if (next) next.disabled = pos < 0 || pos >= frames.length - 1;
}

function editorOutput(): { op: FrameOp | null; output: ImageData } | null {
  if (!original || !plate || !matted) return null;
  bakeActiveStroke();
  const keyed = method === "birefNet" ? matteAlpha != null : currentChromaOp() != null;
  if (!keyed && !hasRefine()) return null;
  const output = compositeRefine(matted, plate, refine, null);
  if (method === "birefNet") return { op: keyed ? currentBirefOp() : null, output };
  return { op: keyed ? currentChromaOp() : null, output };
}

async function commitEditorFrame(): Promise<boolean> {
  const project = state.project;
  const frame = currentFrame();
  const built = editorOutput();
  if (!project || !frame || !built) return false;
  if (matteBusy) {
    setState({ status: "正在推理，请稍候" });
    return false;
  }
  try {
    const blob = await imageDataToPng(built.output);
    await putFrame(project.id, fileName(frame.file), blob);
    if (built.op) replaceOps(frame, built.op);
    state.dirty = true;
    history.clear();
    clearEditorLocal();
    const kind = built.op ? (built.op.type === "birefNet" ? "BiRefNet" : "色度") : "精修";
    const extra = built.op && refineMarks > 0 ? "和精修" : "";
    setState({
      bust: Date.now(),
      status: `第 ${frame.index + 1} 帧已应用${kind}${extra}`,
    });
    await persistNow();
    showAppliedFramePreview(frame.id);
    return true;
  } catch (err) {
    setState({ status: `应用失败：${(err as Error).message}` });
    return false;
  }
}

async function applyEditor(): Promise<void> {
  const project = state.project;
  const frame = currentFrame();
  if (!project || !frame || !original) {
    setState({ status: "请先选择一帧" });
    return;
  }
  if (matteBusy) {
    setState({ status: "正在推理，请稍候" });
    return;
  }
  const painted = hasRefine();
  const keyed = method === "birefNet" ? matteAlpha != null : currentChromaOp() != null;
  if (method === "birefNet" && !matteAlpha && !painted) {
    setState({ status: "请先完成 BiRefNet 推理" });
    return;
  }
  if (method !== "birefNet" && !keyed && !painted) {
    setState({ status: "请先点击画面采样颜色，或用画笔 / 橡皮精修" });
    return;
  }
  const ok = await confirmDialog({
    title: painted && !keyed ? "应用精修" : "应用抠图",
    body: painted && !keyed
      ? "将把这一帧的画笔 / 橡皮精修写入像素，无法撤销。精修不会批量到其它帧。"
      : painted
        ? "将写入该帧像素，无法撤销。精修只留在这一帧。"
        : method === "birefNet"
          ? "将写入该帧像素，无法撤销。按 AI 主体遮罩写入。"
          : "将写入该帧像素，无法撤销。",
    ok: "应用",
    danger: true,
  });
  if (!ok) return;
  if (await commitEditorFrame()) closeEditor();
}

let frameNavBusy = false;

async function shiftEditorFrame(delta: -1 | 1): Promise<void> {
  if (frameNavBusy) return;
  const root = document.getElementById("editor-root");
  if (!root || root.hidden) return;
  const project = state.project;
  const frame = currentFrame();
  if (!project || !frame || !original) return;
  if (matteBusy) {
    setState({ status: "正在推理，请稍候" });
    return;
  }
  const pos = project.frames.findIndex((f) => f.id === frame.id);
  const target = project.frames[pos + delta];
  if (!target) return;
  frameNavBusy = true;
  try {
    if (editorHasPending()) {
      const apply = await confirmDialog({
        title: "有未应用的更改",
        body: "切换帧前是否应用本次修改？应用会写入当前帧并打开相邻帧；暂不应用则留在抠图编辑器。",
        ok: "应用",
        cancel: "暂不应用",
      });
      if (!apply) return;
      const wrote = await commitEditorFrame();
      if (!wrote) return;
    }
    setState({ currentFrameId: target.id });
    showAppliedFramePreview(target.id);
    await openEditor();
  } finally {
    frameNavBusy = false;
    syncEditorNav();
  }
}

async function loadBatchPlate(projectId: string, file: string, alreadyKeyed: boolean): Promise<ImageData> {
  const origRes = await fetch(originalFrameUrl(projectId, file, state.bust));
  if (origRes.ok) return blobToImageData(await origRes.blob());
  if (alreadyKeyed) throw new Error("无抽出原图");
  const workRes = await fetch(frameUrl(projectId, file, state.bust));
  if (!workRes.ok) throw new Error("无法读取该帧");
  const blob = await workRes.blob();
  try {
    await putOriginalFrame(projectId, file, blob);
  } catch {
    /* this frame has never been keyed; still key the working image */
  }
  return blobToImageData(blob);
}

function cloneOps(ops: FrameOp[]): FrameOp[] {
  return ops.map((op) => (op.type === "birefNet" ? { ...op } : serializeChromaOp(op)));
}

function batchOpsForCurrent(): FrameOp[] {
  const frame = currentFrame();
  if (!frame?.ops.length) return [];
  const last = frame.ops.at(-1)!;
  if (last.type === "birefNet") return [last];
  return frame.ops.filter((o): o is ChromaOp => o.type === "chromaKey");
}

export async function batchApply(): Promise<void> {
  const project = state.project;
  const frame = currentFrame();
  if (!project || !frame) {
    setState({ status: "请先选择一帧并完成换色" });
    return;
  }
  const ops = batchOpsForCurrent();
  const targets = selectedFrames();
  if (!ops.length) {
    setState({ status: "当前帧还没有已应用的操作。请先在编辑器里应用抠图。" });
    return;
  }
  if (!targets.length) {
    setState({ status: "没有选中帧。" });
    return;
  }
  const kind = ops[0].type === "birefNet" ? "BiRefNet" : "色度";
  const ok = await confirmDialog({
    title: "批量应用",
    body: `从各帧抽出原图重新抠图，写入 ${targets.length} 帧，盖掉已经叠过一次的结果。色度：请确认各帧幕布接近。BiRefNet：将逐帧推理，可能较慢。`,
    ok: "开始批量",
  });
  if (!ok) return;

  const batchBtn = document.getElementById("btn-batch") as HTMLButtonElement;
  batchBtn.disabled = true;
  const failed: number[] = [];
  let done = 0;
  const matteCache = new Map<string, Float32Array>();
  showBatchProgress(0, targets.length, "开始处理…");
  setState({ status: "批量应用中…" });
  try {
    for (const target of targets) {
      const seq = target.index + 1;
      showBatchProgress(done, targets.length, `正在处理第 ${seq} 帧…`);
      try {
        const file = fileName(target.file);
        const dataIn = await loadBatchPlate(project.id, file, target.ops.length > 0);
        let data = dataIn;
        for (const op of ops) {
          if (op.type === "chromaKey") {
            data = applyChromaKey(data, op);
          } else {
            let alpha = matteCache.get(file);
            if (!alpha) {
              const png = await imageDataToPng(dataIn);
              const result = await requestMatte(png);
              const gray = await blobToImageData(result.blob);
              alpha = alphaFromGrayImageData(gray);
              matteCache.set(file, alpha);
            }
            data = applyBirefNet(dataIn, alpha, op);
          }
        }
        const blob = await imageDataToPng(data);
        await putFrame(project.id, file, blob);
        target.ops = cloneOps(ops);
      } catch {
        failed.push(seq);
      }
      done += 1;
      showBatchProgress(done, targets.length, `已完成第 ${seq} 帧`);
      setState({ status: `批量应用中… ${done}/${targets.length}` });
      await new Promise((r) => setTimeout(r, 0));
    }
    state.dirty = true;
    setState({
      bust: Date.now(),
      status: failed.length
        ? `已完成 ${done} 帧，失败序号：${failed.join("、")}`
        : `已将 ${kind} 应用到 ${targets.length} 帧`,
    });
    await persistNow();
    history.clear();
  } finally {
    hideBatchProgress();
    batchBtn.disabled = false;
  }
}

async function restoreSelectedFrames(): Promise<void> {
  const project = state.project;
  if (!project) {
    setState({ status: "没有打开的工程" });
    return;
  }
  const targets = selectedFrames();
  if (!targets.length) {
    setState({ status: "没有选中帧。" });
    return;
  }
  const ok = await confirmDialog({
    title: "还原帧？",
    body: `将把 ${targets.length} 帧还原为抽出时的绿幕原图。已应用的抠图会丢失，无法撤销。`,
    ok: "还原",
    danger: true,
  });
  if (!ok) return;
  const failed: number[] = [];
  let done = 0;
  for (const target of targets) {
    const file = fileName(target.file);
    try {
      const res = await fetch(originalFrameUrl(project.id, file, state.bust));
      if (!res.ok) throw new Error("无抽出原图");
      await putFrame(project.id, file, await res.blob());
      target.ops = [];
      done += 1;
    } catch {
      failed.push(target.index + 1);
    }
  }
  state.dirty = true;
  setState({
    bust: Date.now(),
    status: failed.length
      ? `已还原 ${done} 帧，失败序号：${failed.join("、")}（无抽出原图）`
      : `已将 ${done} 帧还原为抽出绿幕`,
  });
  await persistNow();
  history.clear();
  if (!document.getElementById("editor-root")!.hidden) closeEditor();
}

function bakeActiveStroke(): void {
  if (!stroke || !original) return;
  if (!refine) refine = createRefine(original.width, original.height);
  const wrote = bakeStroke(refine, stroke);
  stroke = null;
  lastDab = null;
  painting = false;
  if (wrote) {
    refineMarks = 1;
    refineRev += 1;
  }
}

function setTool(next: EditorTool): void {
  tool = next;
  canvas().classList.toggle("is-sample", next === "sample");
  canvas().classList.toggle("is-paint", next !== "sample");
  const panel = document.getElementById("refine-panel");
  if (panel) panel.hidden = next === "sample";
  for (const btn of document.querySelectorAll<HTMLElement>("#editor-tool [data-tool]")) {
    btn.classList.toggle("is-on", btn.dataset.tool === next);
  }
  if (next === "sample") hideBrushRing();
}

function setLoupeScale(next: LoupeScale): void {
  loupeScale = next;
  const label = document.getElementById("editor-loupe-label");
  if (label) label.textContent = `${next}×`;
  for (const btn of document.querySelectorAll<HTMLElement>("#editor-loupe-rates [data-loupe]")) {
    btn.classList.toggle("is-on", Number(btn.dataset.loupe) === next);
  }
  if (loupePoint) drawLoupe(loupePoint);
}

function hideLoupe(): void {
  const node = document.getElementById("editor-loupe");
  if (node) node.hidden = true;
}

function hideBrushRing(): void {
  const ring = document.getElementById("editor-brush-ring");
  if (ring) ring.hidden = true;
}

function imagePoint(ev: { clientX: number; clientY: number }): { x: number; y: number } | null {
  if (!original) return null;
  const c = canvas();
  const rect = c.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((ev.clientX - rect.left) / rect.width) * original.width;
  const y = ((ev.clientY - rect.top) / rect.height) * original.height;
  if (x < 0 || y < 0 || x >= original.width || y >= original.height) return null;
  return { x, y };
}

function loupeBg(ix: number, iy: number): [number, number, number] {
  if (previewBg === "white") return [255, 255, 255];
  if (previewBg === "black") return [0, 0, 0];
  if (previewBg === "gray") return [158, 158, 158];
  const odd = ((Math.floor(ix / 8) + Math.floor(iy / 8)) & 1) === 1;
  return odd ? [187, 182, 170] : [215, 210, 198];
}

function drawLoupe(pt: { x: number; y: number }): void {
  if (!preview) return;
  const view = document.getElementById("editor-loupe-view") as HTMLCanvasElement | null;
  if (!view) return;
  const css = 148;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bufW = Math.round(css * dpr);
  const bufH = bufW;
  if (view.width !== bufW) view.width = bufW;
  if (view.height !== bufH) view.height = bufH;
  const ctx = view.getContext("2d");
  if (!ctx) return;
  const pxPerImage = loupeScale * dpr;
  const src = css / loupeScale;
  const sx = pt.x - src / 2;
  const sy = pt.y - src / 2;
  const img = ctx.createImageData(bufW, bufH);
  const out = img.data;
  const srcData = preview.data;
  const sw = preview.width;
  const sh = preview.height;
  for (let dy = 0; dy < bufH; dy++) {
    const iy = Math.floor(sy + dy / pxPerImage);
    for (let dx = 0; dx < bufW; dx++) {
      const ix = Math.floor(sx + dx / pxPerImage);
      const o = (dy * bufW + dx) * 4;
      const bg = loupeBg(ix, iy);
      if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) {
        out[o] = bg[0];
        out[o + 1] = bg[1];
        out[o + 2] = bg[2];
        out[o + 3] = 255;
        continue;
      }
      const i = (iy * sw + ix) * 4;
      const a = srcData[i + 3] / 255;
      out[o] = Math.round(srcData[i] * a + bg[0] * (1 - a));
      out[o + 1] = Math.round(srcData[i + 1] * a + bg[1] * (1 - a));
      out[o + 2] = Math.round(srcData[i + 2] * a + bg[2] * (1 - a));
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const px = Math.max(0, Math.min(sw - 1, Math.floor(pt.x)));
  const py = Math.max(0, Math.min(sh - 1, Math.floor(pt.y)));
  const pi = (py * sw + px) * 4;
  const set = (id: string, n: number) => {
    const node = document.getElementById(id);
    if (node) node.textContent = String(n);
  };
  set("loupe-r", srcData[pi]);
  set("loupe-g", srcData[pi + 1]);
  set("loupe-b", srcData[pi + 2]);
  set("loupe-a", srcData[pi + 3]);
}

function placeLoupe(ev: { clientX: number; clientY: number }): void {
  const stage = document.querySelector(".editor-stage") as HTMLElement | null;
  const node = document.getElementById("editor-loupe");
  if (!stage || !node) return;
  const sr = stage.getBoundingClientRect();
  const gap = 16;
  const width = node.offsetWidth || 168;
  const height = node.offsetHeight || 210;
  let left = ev.clientX - sr.left - width / 2;
  let top = ev.clientY - sr.top - height - gap;
  if (top < 8) top = ev.clientY - sr.top + gap;
  left = Math.max(8, Math.min(left, stage.clientWidth - width - 8));
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function updateLoupe(ev: PointerEvent): void {
  const pt = imagePoint(ev);
  const node = document.getElementById("editor-loupe");
  if (!node) return;
  if (!pt || !preview) {
    hideLoupe();
    return;
  }
  if (node.hidden) node.hidden = false;
  loupePoint = pt;
  placeLoupe(ev);
  drawLoupe(pt);
}

function updateBrushRing(ev: PointerEvent): void {
  const ring = document.getElementById("editor-brush-ring");
  if (!ring) return;
  const pt = imagePoint(ev);
  if (tool === "sample" || !pt || !original) {
    ring.hidden = true;
    return;
  }
  const rect = canvas().getBoundingClientRect();
  const screen = brushDiameter() * (rect.width / original.width);
  ring.hidden = false;
  ring.style.width = `${Math.max(screen, 2)}px`;
  ring.style.height = `${Math.max(screen, 2)}px`;
  ring.style.left = `${ev.clientX}px`;
  ring.style.top = `${ev.clientY}px`;
}

function dabStroke(x: number, y: number): void {
  if (!stroke || !original) return;
  const mode = tool === "eraser" ? "erase" : "restore";
  const diameter = brushDiameter();
  let bounds: PixelRect | null = null;
  const stampAt = (sx: number, sy: number) => {
    bounds = unionRect(bounds, stampRefine(stroke!, original!.width, original!.height, sx, sy, diameter, brushHardness(), mode));
  };
  if (lastDab) {
    const dist = Math.hypot(x - lastDab.x, y - lastDab.y);
    const step = Math.max(1, diameter * 0.35);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      stampAt(lastDab.x + (x - lastDab.x) * t, lastDab.y + (y - lastDab.y) * t);
    }
  } else {
    stampAt(x, y);
  }
  lastDab = { x, y };
  if (bounds) present(bounds);
}

function beginStroke(ev: PointerEvent): void {
  if (!original || (tool !== "brush" && tool !== "eraser")) return;
  const pt = imagePoint(ev);
  if (!pt) return;
  flushEditorSliderHistory();
  pushEditorLocal(captureEditor());
  stroke = createRefine(original.width, original.height);
  painting = true;
  lastDab = null;
  canvas().setPointerCapture(ev.pointerId);
  dabStroke(pt.x, pt.y);
}

function endStroke(): void {
  if (!painting && !stroke) return;
  painting = false;
  const had = stroke != null;
  bakeActiveStroke();
  if (had) {
    rememberEditorBaseline();
    present();
  }
  lastDab = null;
}

export function initEditor(): void {
  document.getElementById("btn-open-editor")!.addEventListener("click", () => {
    setState({ editorOpen: true });
  });
  document.getElementById("btn-editor-cancel")!.addEventListener("click", () => closeEditor());
  document.getElementById("btn-editor-apply")!.addEventListener("click", () => void applyEditor());
  document.getElementById("btn-editor-prev")!.addEventListener("click", () => void shiftEditorFrame(-1));
  document.getElementById("btn-editor-next")!.addEventListener("click", () => void shiftEditorFrame(1));
  window.addEventListener("keydown", (ev) => {
    if (document.getElementById("editor-root")!.hidden) return;
    if (isTypingTarget(ev.target)) return;
    if (!document.getElementById("modal-root")!.hidden) return;
    const progress = document.getElementById("biref-progress-root");
    if (progress && !progress.hidden) return;
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    void shiftEditorFrame(ev.key === "ArrowLeft" ? -1 : 1);
  });
  document.getElementById("btn-editor-undo")!.addEventListener("click", () => {
    undoEditorLocal();
  });
  document.getElementById("btn-batch")!.addEventListener("click", () => void batchApply());
  document.getElementById("btn-restore-frames")!.addEventListener("click", () => void restoreSelectedFrames());
  document.getElementById("btn-editor-zoom-in")!.addEventListener("click", () => {
    setZoom(zoom * 1.25, "manual");
  });
  document.getElementById("btn-editor-zoom-out")!.addEventListener("click", () => {
    setZoom(zoom / 1.25, "manual");
  });
  document.getElementById("btn-editor-zoom-fit")!.addEventListener("click", () => zoomToFit());
  canvasWrap().addEventListener(
    "wheel",
    (ev) => {
      if (!original || document.getElementById("editor-root")!.hidden) return;
      ev.preventDefault();
      if (ev.altKey) {
        const order: LoupeScale[] = [2, 4, 8];
        const index = order.indexOf(loupeScale);
        const next = ev.deltaY < 0 ? order[Math.min(order.length - 1, index + 1)] : order[Math.max(0, index - 1)];
        setLoupeScale(next);
        return;
      }
      const wrap = canvasWrap();
      const rect = wrap.getBoundingClientRect();
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom(zoom * factor, "manual", {
        x: ev.clientX - rect.left + wrap.scrollLeft,
        y: ev.clientY - rect.top + wrap.scrollTop,
      });
    },
    { passive: false },
  );
  new ResizeObserver(() => {
    if (document.getElementById("editor-root")!.hidden || !original) return;
    if (zoomMode === "fit") zoomToFit();
  }).observe(canvasWrap());

  canvas().addEventListener("click", (ev) => {
    if (!original || method !== "chroma" || tool !== "sample") return;
    flushEditorSliderHistory();
    const before = captureEditor();
    const c = canvas();
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.max(0, Math.min(original.width - 1, Math.floor(((ev.clientX - rect.left) / rect.width) * original.width)));
    const y = Math.max(0, Math.min(original.height - 1, Math.floor(((ev.clientY - rect.top) / rect.height) * original.height)));
    const i = (y * original.width + x) * 4;
    const color: Rgb = [original.data[i], original.data[i + 1], original.data[i + 2]];
    if (samples.some((s) => rgbNear(s.color, color))) {
      refreshPreview();
      return;
    }
    if (samples.length >= MAX_CHROMA_SAMPLES) {
      showToast("最多 8 个背景色");
      return;
    }
    samples = [...samples, { x: x / original.width, y: y / original.height, color }];
    pushEditorLocal(before);
    rememberEditorBaseline();
    renderSwatches();
    refreshPreview();
  });

  canvas().addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || tool === "sample") return;
    ev.preventDefault();
    beginStroke(ev);
  });
  canvas().addEventListener("pointermove", (ev) => {
    if (!painting) return;
    const pt = imagePoint(ev);
    if (pt) dabStroke(pt.x, pt.y);
  });
  canvas().addEventListener("pointerup", () => endStroke());
  canvas().addEventListener("pointercancel", () => endStroke());

  const stage = document.querySelector(".editor-stage");
  stage?.addEventListener("pointermove", (ev) => {
    if (document.getElementById("editor-root")!.hidden) return;
    updateLoupe(ev as PointerEvent);
    updateBrushRing(ev as PointerEvent);
  });
  stage?.addEventListener("pointerleave", () => {
    loupePoint = null;
    hideLoupe();
    hideBrushRing();
  });
  document.getElementById("editor-tool")!.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-tool]");
    if (!btn?.dataset.tool) return;
    setTool(btn.dataset.tool as EditorTool);
  });
  document.getElementById("editor-loupe-rates")!.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-loupe]");
    const scale = Number(btn?.dataset.loupe);
    if (scale === 2 || scale === 4 || scale === 8) setLoupeScale(scale);
  });
  for (const id of ["brush-size", "brush-hardness"]) {
    document.getElementById(id)!.addEventListener("input", () => {
      const ring = document.getElementById("editor-brush-ring");
      if (!ring || ring.hidden) return;
      const size = brushDiameter() * (canvas().getBoundingClientRect().width / (original?.width || 1));
      ring.style.width = `${Math.max(size, 2)}px`;
      ring.style.height = `${Math.max(size, 2)}px`;
    });
  }

  document.getElementById("matte-method")!.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-method]");
    if (!btn?.dataset.method) return;
    void switchMethod(btn.dataset.method as MatteMethod);
  });
  document.getElementById("preview-bg")!.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-bg]");
    if (!btn?.dataset.bg) return;
    applyPreviewBg(btn.dataset.bg as PreviewBg);
  });
  document.getElementById("btn-chroma-clear")!.addEventListener("click", () => {
    if (!samples.length) return;
    flushEditorSliderHistory();
    const before = captureEditor();
    samples = [];
    pushEditorLocal(before);
    rememberEditorBaseline();
    renderSwatches();
    refreshPreview();
  });
  document.getElementById("btn-biref-rerun")!.addEventListener("click", () => {
    if (method !== "birefNet") return;
    void ensureMatte(true);
  });
  document.getElementById("biref-progress-close")!.addEventListener("click", () => {
    hideBirefProgress();
  });

  for (const id of ["tolerance", "halo", "despill", "biref-threshold", "biref-feather"]) {
    const node = document.getElementById(id)!;
    node.addEventListener("pointerdown", () => {
      if (!sliderSnap) sliderSnap = editorBaseline;
    });
    node.addEventListener("input", () => {
      if (!sliderSnap) sliderSnap = editorBaseline;
      refreshPreview();
      window.clearTimeout(sliderTimer);
      sliderTimer = window.setTimeout(flushEditorSliderHistory, 400);
    });
    node.addEventListener("change", flushEditorSliderHistory);
  }
}

export function syncEditorVisibility(): void {
  const root = document.getElementById("editor-root")!;
  if (state.editorOpen) {
    if (root.hidden) void openEditor();
  } else if (!root.hidden) {
    original = null;
    plate = null;
    matted = null;
    preview = null;
    resetRefine();
    samples = [];
    matteAlpha = null;
    matteFile = null;
    matteGen += 1;
    painting = false;
    lastDab = null;
    loupePoint = null;
    hideLoupe();
    hideBrushRing();
    clearEditorLocal();
    root.hidden = true;
  }
}
