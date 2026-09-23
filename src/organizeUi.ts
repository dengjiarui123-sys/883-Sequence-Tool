import { deleteFrame, frameUrl } from "./api";
import { confirmDialog, imageDataFrom, loadImage, noticeDialog } from "./dom";
import * as history from "./history";
import { persistNow, persistSoon } from "./persist";
import { getPlaybackRate, onPlaybackRateChange } from "./playbackSpeed";
import { buildThumb, findLoopCandidates } from "./ssm";
import { selectedFrames, setState, state } from "./store";
import type { KeepPosition, LoopCandidate } from "./types";

let previewTimer = 0;
let previewIndex = 0;
let previewIds: string[] = [];
let playing = false;
let lastPreviewId: string | null = null;
let drawToken = 0;
let previewImage: HTMLImageElement | null = null;
let previewImageKey = "";
let previewZoom = 1;
let previewPanX = 0;
let previewPanY = 0;
const MIN_PREVIEW_ZOOM = 1;
const MAX_PREVIEW_ZOOM = 8;

function fileName(frameFile: string): string {
  return frameFile.split("/").pop()!;
}

function selectedIndices(): number[] {
  const frames = state.project?.frames ?? [];
  return frames.map((f, i) => (f.inWorkingSet ? i : -1)).filter((i) => i >= 0);
}

export function previewDecimate(n: number, keep: KeepPosition): { keep: number; drop: number; keepSet: Set<number> } {
  const idxs = selectedIndices();
  const keepSet = new Set<number>();
  for (let g = 0; g < Math.ceil(idxs.length / n); g++) {
    const group = idxs.slice(g * n, g * n + n);
    if (!group.length) continue;
    keepSet.add(keep === "first" ? group[0] : group[group.length - 1]);
  }
  return { keep: keepSet.size, drop: idxs.length - keepSet.size, keepSet };
}

function updateDecimatePreview(): void {
  const n = Math.max(2, Number((document.getElementById("decimate-n") as HTMLInputElement).value) || 2);
  const keep = (document.getElementById("decimate-keep") as HTMLSelectElement).value as KeepPosition;
  const { keep: kx, drop } = previewDecimate(n, keep);
  document.getElementById("decimate-count")!.textContent = `当前工作集选中 ${selectedIndices().length} 帧`;
  document.getElementById("decimate-preview")!.textContent =
    `预计保留约 ${kx} 帧（剔除 ${drop} 帧，变为未选中，不会删除）`;
}

function snapshotWorkingSet(): boolean[] {
  return (state.project?.frames ?? []).map((f) => f.inWorkingSet);
}

function restoreWorkingSet(snap: boolean[]): void {
  state.project?.frames.forEach((f, i) => {
    f.inWorkingSet = snap[i] ?? f.inWorkingSet;
  });
}

function applyDecimate(): void {
  const project = state.project;
  if (!project) return;
  const n = Math.max(2, Number((document.getElementById("decimate-n") as HTMLInputElement).value) || 2);
  const keep = (document.getElementById("decimate-keep") as HTMLSelectElement).value as KeepPosition;
  const { keepSet, keep: kx, drop } = previewDecimate(n, keep);
  if (drop === 0) {
    setState({ status: "没有可减的帧" });
    return;
  }
  const undo = snapshotWorkingSet();
  history.push("减帧", () => restoreWorkingSet(undo));
  for (const [i, frame] of project.frames.entries()) {
    if (!undo[i]) continue;
    frame.inWorkingSet = keepSet.has(i);
  }
  document.getElementById("decimate-root")!.hidden = true;
  setState({
    dirty: true,
    status: `减帧完成：约 ${kx} 帧仍选中，${drop} 帧未选中`,
  });
  persistSoon();
}

export function selectAllFrames(): void {
  const project = state.project;
  if (!project) return;
  if (project.frames.every((f) => f.inWorkingSet)) {
    setState({ status: "已经全部勾选" });
    return;
  }
  const undo = snapshotWorkingSet();
  history.push("全部勾选", () => restoreWorkingSet(undo));
  project.frames.forEach((f) => {
    f.inWorkingSet = true;
  });
  setState({ dirty: true, status: "已全部勾选", loopCandidates: [] });
  persistSoon();
}

export function deselectAllFrames(): void {
  const project = state.project;
  if (!project) return;
  if (project.frames.every((f) => !f.inWorkingSet)) {
    setState({ status: "已经全部取消勾选" });
    return;
  }
  const undo = snapshotWorkingSet();
  history.push("全部取消", () => restoreWorkingSet(undo));
  project.frames.forEach((f) => {
    f.inWorkingSet = false;
  });
  setState({ dirty: true, status: "已全部取消勾选", loopCandidates: [] });
  persistSoon();
}

async function removeUnselected(): Promise<void> {
  const project = state.project;
  if (!project) return;
  const removed = project.frames.filter((f) => !f.inWorkingSet);
  if (!removed.length) {
    setState({ status: "没有未选中的帧" });
    return;
  }
  const ok = await confirmDialog({
    title: "移出未选中",
    body: `将 ${removed.length} 帧从胶片条移出（物理移出）。此操作无法撤销。`,
    ok: "移出",
    danger: true,
  });
  if (!ok) return;
  for (const frame of removed) {
    await deleteFrame(project.id, fileName(frame.file));
  }
  project.frames = project.frames.filter((f) => f.inWorkingSet);
  project.frames.forEach((f, i) => {
    f.index = i;
  });
  const current = project.frames.some((f) => f.id === state.currentFrameId)
    ? state.currentFrameId
    : project.frames[0]?.id ?? null;
  setState({
    dirty: true,
    currentFrameId: current,
    loopCandidates: [],
    bust: Date.now(),
    status: `已移出 ${removed.length} 帧`,
  });
  history.clear();
  await persistNow();
}

function renderLoopList(): void {
  const root = document.getElementById("loop-list")!;
  const list = state.loopCandidates;
  root.innerHTML = list
    .map((c, i) => {
      return `<div class="loop-card${i === state.loopSelected ? " is-on" : ""}" data-i="${i}">
        <div class="loop-card-body">
          <b>${c.label} · ${c.frameCount} 帧 · ${c.startDisplay}–${c.endDisplay}</b>
          平滑度 ${c.smoothness.toFixed(0)}%　覆盖率 ${c.coverage.toFixed(0)}%　胶片序号 ${c.startDisplay}–${c.endDisplay}
        </div>
        <button type="button" class="btn btn-primary" data-act="apply" data-i="${i}">应用</button>
      </div>`;
    })
    .join("");
}

async function findLoops(): Promise<void> {
  const project = state.project;
  const selected = selectedFrames();
  if (!project || selected.length < 9) {
    setState({ status: "选中帧太少，至少需要 9 帧才能寻找循环" });
    return;
  }
  setState({ loopBusy: true, status: "正在计算自相似矩阵…" });
  document.getElementById("loop-progress")!.hidden = false;
  const thumbs = [];
  for (let i = 0; i < selected.length; i++) {
    const frame = selected[i];
    document.getElementById("loop-progress")!.textContent = `分析帧 ${i + 1} / ${selected.length}`;
    const img = await loadImage(frameUrl(project.id, fileName(frame.file), state.bust));
    thumbs.push(buildThumb(imageDataFrom(img), frame.id, frame.index + 1));
    await new Promise((r) => setTimeout(r, 0));
  }
  const candidates = findLoopCandidates(thumbs);
  setState({
    loopBusy: false,
    loopCandidates: candidates,
    loopSelected: 0,
    status: candidates.length
      ? `找到 ${candidates.length} 个循环方案。点方案可预览胶片范围，点「应用」后关闭列表并写入选中`
      : "没有可用循环方案，试试别的选中区间",
  });
  document.getElementById("loop-progress")!.hidden = true;
  renderLoopList();
  if (candidates[0]) startPreview("loop", candidates[0]);
}

async function applyLoopAt(index: number): Promise<void> {
  const project = state.project;
  const candidate = state.loopCandidates[index];
  if (!project || !candidate) return;
  const selected = selectedFrames();
  const undo = snapshotWorkingSet();
  history.push("裁剪循环", () => restoreWorkingSet(undo));
  const keepFrames = selected.slice(candidate.startSel, candidate.endSel + 1);
  const keepIds = new Set(keepFrames.map((f) => f.id));
  for (const frame of project.frames) {
    frame.inWorkingSet = keepIds.has(frame.id);
  }
  setState({
    dirty: true,
    loopCandidates: [],
    loopSelected: 0,
    status: `已应用「${candidate.label}」：胶片序号 ${candidate.startDisplay}–${candidate.endDisplay}`,
  });
  persistSoon();
}

function previewCanvas(): HTMLCanvasElement | null {
  return document.getElementById("organize-preview") as HTMLCanvasElement | null;
}

function previewFit(img: HTMLImageElement, canvas: HTMLCanvasElement): number {
  return Math.min(canvas.width / img.width, canvas.height / img.height);
}

function clampPreviewPan(img: HTMLImageElement, canvas: HTMLCanvasElement): void {
  if (previewZoom <= MIN_PREVIEW_ZOOM + 0.001) {
    previewZoom = MIN_PREVIEW_ZOOM;
    previewPanX = 0;
    previewPanY = 0;
    return;
  }
  const scale = previewFit(img, canvas) * previewZoom;
  const dw = img.width * scale;
  const dh = img.height * scale;
  const margin = 48 * (window.devicePixelRatio || 1);
  const x0 = (canvas.width - dw) / 2;
  const y0 = (canvas.height - dh) / 2;
  previewPanX = Math.min(canvas.width - margin - x0, Math.max(margin - dw - x0, previewPanX));
  previewPanY = Math.min(canvas.height - margin - y0, Math.max(margin - dh - y0, previewPanY));
}

function syncPreviewZoomCursor(canvas: HTMLCanvasElement): void {
  const zoomed = previewZoom > MIN_PREVIEW_ZOOM + 0.001;
  canvas.classList.toggle("is-zoomed", zoomed);
  const outBtn = document.getElementById("btn-preview-zoom-out") as HTMLButtonElement | null;
  const inBtn = document.getElementById("btn-preview-zoom-in") as HTMLButtonElement | null;
  if (outBtn) outBtn.disabled = !zoomed;
  if (inBtn) inBtn.disabled = previewZoom >= MAX_PREVIEW_ZOOM - 0.001;
}

function zoomPreviewBy(factor: number): void {
  const canvas = previewCanvas();
  if (!canvas?.width || !canvas.height) return;
  zoomPreviewAt(canvas.width / 2, canvas.height / 2, factor);
}

function paintPreview(): void {
  const canvas = previewCanvas();
  const ctx = canvas?.getContext("2d");
  const img = previewImage;
  if (!canvas || !ctx || !img || !canvas.width || !canvas.height) return;
  clampPreviewPan(img, canvas);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = previewFit(img, canvas) * previewZoom;
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, (canvas.width - dw) / 2 + previewPanX, (canvas.height - dh) / 2 + previewPanY, dw, dh);
  syncPreviewZoomCursor(canvas);
}

function zoomPreviewAt(canvasX: number, canvasY: number, factor: number): void {
  const canvas = previewCanvas();
  const img = previewImage;
  if (!canvas || !img || !canvas.width || !canvas.height) return;
  const prevScale = previewFit(img, canvas) * previewZoom;
  const prevX = (canvas.width - img.width * prevScale) / 2 + previewPanX;
  const prevY = (canvas.height - img.height * prevScale) / 2 + previewPanY;
  const ix = (canvasX - prevX) / prevScale;
  const iy = (canvasY - prevY) / prevScale;
  previewZoom = Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, previewZoom * factor));
  const nextScale = previewFit(img, canvas) * previewZoom;
  previewPanX = canvasX - ix * nextScale - (canvas.width - img.width * nextScale) / 2;
  previewPanY = canvasY - iy * nextScale - (canvas.height - img.height * nextScale) / 2;
  paintPreview();
}

function resetPreviewZoom(): void {
  previewZoom = MIN_PREVIEW_ZOOM;
  previewPanX = 0;
  previewPanY = 0;
  paintPreview();
}

async function drawPreviewFrame(id: string): Promise<void> {
  const project = state.project;
  const frame = project?.frames.find((f) => f.id === id);
  const canvas = previewCanvas();
  if (!project || !frame || !canvas) return;
  lastPreviewId = id;
  const imgKey = `${project.id}:${id}:${state.bust}`;
  if (previewImage && previewImageKey === imgKey) {
    paintPreview();
    syncPreviewScrub();
    return;
  }
  const token = ++drawToken;
  const img = await loadImage(frameUrl(project.id, fileName(frame.file), state.bust));
  if (token !== drawToken) return;
  previewImage = img;
  previewImageKey = imgKey;
  paintPreview();
  syncPreviewScrub();
}

export function showAppliedFramePreview(id: string): void {
  const frame = state.project?.frames.find((f) => f.id === id);
  if (!frame) return;
  stopPreview();
  const selected = selectedFrames();
  const at = selected.findIndex((f) => f.id === id);
  if (at >= 0) {
    previewIds = selected.map((f) => f.id);
    previewIndex = at;
  } else {
    previewIds = [id];
    previewIndex = 0;
  }
  lastPreviewId = id;
  syncPreviewScrub();
  if (state.step !== "edit") return;
  syncOrganizePreviewSize();
  void drawPreviewFrame(id);
}

export function syncOrganizePreviewSize(): void {
  const canvas = document.getElementById("organize-preview") as HTMLCanvasElement | null;
  if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  if (lastPreviewId) void drawPreviewFrame(lastPreviewId);
}

let playbackSetKey = "";
let sequenceNoticeOpen = false;

function workingSetKey(): string {
  return (state.project?.frames ?? []).map((frame) => `${frame.id}:${frame.inWorkingSet ? 1 : 0}`).join("|");
}

function queueSequenceNotice(): void {
  if (sequenceNoticeOpen) return;
  sequenceNoticeOpen = true;
  void noticeDialog("动画序列已刷新").finally(() => {
    sequenceNoticeOpen = false;
  });
}

function syncPreviewScrub(): void {
  const ids = playing ? previewIds : selectedFrames().map((frame) => frame.id);
  const total = ids.length;
  let index = total ? Math.min(previewIndex, total - 1) : 0;
  if (!playing && lastPreviewId) {
    const at = ids.indexOf(lastPreviewId);
    if (at >= 0) index = at;
  }
  const scrub = document.getElementById("preview-scrub") as HTMLInputElement | null;
  if (scrub) {
    scrub.min = "0";
    scrub.max = String(Math.max(0, total - 1));
    scrub.value = String(total ? index : 0);
    scrub.disabled = total === 0;
  }
  const info = document.getElementById("preview-info");
  if (!info) return;
  if (!playing && lastPreviewId && ids.indexOf(lastPreviewId) < 0) {
    const frame = state.project?.frames.find((f) => f.id === lastPreviewId);
    info.textContent = frame ? `第 ${frame.index + 1} 帧` : "0 / 0";
    return;
  }
  info.textContent = total ? `${index + 1} / ${total}` : "没有可播放的选中帧";
}

function stopPreview(resetSequence = false): void {
  playing = false;
  window.clearInterval(previewTimer);
  if (resetSequence) {
    previewIds = [];
    previewIndex = 0;
  }
  syncPreviewPlayLabel();
  syncPreviewScrub();
}

function previewIntervalMs(): number {
  const extractMode = state.project?.extract.mode;
  const fps = extractMode === "frames" && (state.project?.extract.sourceFps || 0) > 0
    ? state.project!.extract.sourceFps!
    : Math.max(4, Math.min(30, state.project?.extract.fps || 12));
  return 1000 / (Math.max(1, Math.min(60, fps)) * getPlaybackRate());
}

function schedulePreviewTick(): void {
  window.clearInterval(previewTimer);
  if (!playing || !previewIds.length) return;
  previewTimer = window.setInterval(() => {
    if (!playing || !previewIds.length) return;
    previewIndex = (previewIndex + 1) % previewIds.length;
    syncPreviewScrub();
    void drawPreviewFrame(previewIds[previewIndex]);
  }, previewIntervalMs());
}

function syncPreviewPlayLabel(): void {
  const btn = document.getElementById("btn-preview-play");
  if (btn) btn.textContent = playing ? "暂停" : "播放动画";
}

function startPreview(mode: "selected" | "loop", candidate?: LoopCandidate): void {
  stopPreview();
  syncOrganizePreviewSize();
  const selected = selectedFrames();
  if (mode === "loop" && candidate) {
    previewIds = selected.slice(candidate.startSel, candidate.endSel + 1).map((f) => f.id);
  } else {
    previewIds = selected.map((f) => f.id);
  }
  if (!previewIds.length) {
    previewIndex = 0;
    syncPreviewPlayLabel();
    syncPreviewScrub();
    return;
  }
  previewIndex = 0;
  playbackSetKey = workingSetKey();
  playing = true;
  syncPreviewScrub();
  void drawPreviewFrame(previewIds[0]);
  schedulePreviewTick();
  syncPreviewPlayLabel();
}

export function toggleOrganizePreview(): void {
  if (playing) {
    stopPreview();
    return;
  }
  const candidate = state.loopCandidates[state.loopSelected];
  startPreview(candidate ? "loop" : "selected", candidate);
}

export function initOrganize(): void {
  document.getElementById("btn-decimate")!.addEventListener("click", () => {
    document.getElementById("decimate-root")!.hidden = false;
    updateDecimatePreview();
  });
  document.getElementById("decimate-n")!.addEventListener("input", updateDecimatePreview);
  document.getElementById("decimate-keep")!.addEventListener("change", updateDecimatePreview);
  document.getElementById("decimate-cancel")!.addEventListener("click", () => {
    document.getElementById("decimate-root")!.hidden = true;
  });
  document.getElementById("decimate-ok")!.addEventListener("click", applyDecimate);
  document.getElementById("btn-undo-decimate")!.addEventListener("click", () => {
    history.undo();
  });
  document.getElementById("btn-restore")!.addEventListener("click", selectAllFrames);
  document.getElementById("btn-restore-edit")!.addEventListener("click", selectAllFrames);
  document.getElementById("btn-deselect-all")!.addEventListener("click", deselectAllFrames);
  document.getElementById("btn-deselect-edit")!.addEventListener("click", deselectAllFrames);
  document.getElementById("btn-remove")!.addEventListener("click", () => void removeUnselected());
  document.getElementById("btn-find-loop")!.addEventListener("click", () => void findLoops());
  document.getElementById("btn-preview-play")!.addEventListener("click", toggleOrganizePreview);
  document.getElementById("btn-preview-zoom-in")!.addEventListener("click", () => zoomPreviewBy(1.25));
  document.getElementById("btn-preview-zoom-out")!.addEventListener("click", () => zoomPreviewBy(1 / 1.25));
  const preview = document.getElementById("organize-preview") as HTMLCanvasElement;
  preview.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const rect = preview.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomPreviewAt(
        (ev.clientX - rect.left) * (preview.width / rect.width),
        (ev.clientY - rect.top) * (preview.height / rect.height),
        factor,
      );
    },
    { passive: false },
  );
  preview.addEventListener("dblclick", () => resetPreviewZoom());
  let panning = false;
  let panLastX = 0;
  let panLastY = 0;
  preview.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || previewZoom <= MIN_PREVIEW_ZOOM + 0.001) return;
    panning = true;
    panLastX = ev.clientX;
    panLastY = ev.clientY;
    preview.classList.add("is-panning");
    preview.setPointerCapture(ev.pointerId);
  });
  preview.addEventListener("pointermove", (ev) => {
    if (!panning) return;
    const rect = preview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    previewPanX += (ev.clientX - panLastX) * (preview.width / rect.width);
    previewPanY += (ev.clientY - panLastY) * (preview.height / rect.height);
    panLastX = ev.clientX;
    panLastY = ev.clientY;
    paintPreview();
  });
  const endPan = () => {
    panning = false;
    preview.classList.remove("is-panning");
  };
  preview.addEventListener("pointerup", endPan);
  preview.addEventListener("pointercancel", endPan);
  (document.getElementById("preview-scrub") as HTMLInputElement).addEventListener("input", (ev) => {
    if (!previewIds.length) previewIds = selectedFrames().map((frame) => frame.id);
    if (!previewIds.length) return;
    previewIndex = Math.max(0, Math.min(previewIds.length - 1, Number((ev.target as HTMLInputElement).value)));
    syncPreviewScrub();
    void drawPreviewFrame(previewIds[previewIndex]);
  });
  onPlaybackRateChange(() => {
    if (playing) schedulePreviewTick();
  });
  document.getElementById("loop-list")!.addEventListener("click", (ev) => {
    const applyBtn = (ev.target as HTMLElement).closest("[data-act=apply]") as HTMLElement | null;
    if (applyBtn) {
      void applyLoopAt(Number(applyBtn.dataset.i));
      return;
    }
    const card = (ev.target as HTMLElement).closest(".loop-card") as HTMLElement | null;
    if (!card) return;
    const i = Number(card.dataset.i);
    const candidate = state.loopCandidates[i];
    if (!candidate) return;
    setState({
      loopSelected: i,
      status: `已选中「${candidate.label}」${candidate.startDisplay}–${candidate.endDisplay}，点「应用」写入选中`,
    });
    renderLoopList();
    startPreview("loop", candidate);
  });
}

export function syncOrganize(): void {
  document.getElementById("btn-undo-decimate")!.toggleAttribute("disabled", !history.canUndo());
  if (playing && workingSetKey() !== playbackSetKey) {
    playbackSetKey = workingSetKey();
    stopPreview(true);
    queueSequenceNotice();
  }
  if (state.editTab === "organize") renderLoopList();
  if (state.step !== "edit") return;
  if (!lastPreviewId && state.currentFrameId) lastPreviewId = state.currentFrameId;
  syncOrganizePreviewSize();
  if (!playing && lastPreviewId) void drawPreviewFrame(lastPreviewId);
  else if (!playing) syncPreviewScrub();
}
