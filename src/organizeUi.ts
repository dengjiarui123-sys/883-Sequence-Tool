import { deleteFrame, frameUrl } from "./api";
import { confirmDialog, imageDataFrom, loadImage } from "./dom";
import * as history from "./history";
import { persistNow, persistSoon } from "./persist";
import { buildThumb, findLoopCandidates } from "./ssm";
import { selectedFrames, setState, state } from "./store";
import type { KeepPosition, LoopCandidate } from "./types";

let previewTimer = 0;
let previewIndex = 0;
let previewIds: string[] = [];
let playing = false;
let lastPreviewId: string | null = null;

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

function restoreUnselected(): void {
  const project = state.project;
  if (!project) return;
  if (project.frames.every((f) => f.inWorkingSet)) {
    setState({ status: "已经全部选中" });
    return;
  }
  const undo = snapshotWorkingSet();
  history.push("全部恢复", () => restoreWorkingSet(undo));
  project.frames.forEach((f) => {
    f.inWorkingSet = true;
  });
  setState({ dirty: true, status: "已全部恢复为选中", loopCandidates: [] });
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
      return `<button type="button" class="loop-card${i === state.loopSelected ? " is-on" : ""}" data-i="${i}">
        <b>${c.label} · ${c.frameCount} 帧 · ${c.startDisplay}–${c.endDisplay}</b>
        平滑度 ${c.smoothness.toFixed(0)}%　覆盖率 ${c.coverage.toFixed(0)}%　范围 ${c.startDisplay}–${c.endDisplay}
      </button>`;
    })
    .join("");
  document.getElementById("btn-apply-loop")!.toggleAttribute("disabled", list.length === 0);
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
    status: candidates.length ? `找到 ${candidates.length} 个循环方案` : "没有可用循环方案，试试别的选中区间",
  });
  document.getElementById("loop-progress")!.hidden = true;
  renderLoopList();
  if (candidates[0]) startPreview("loop", candidates[0]);
}

function applyLoop(): void {
  const project = state.project;
  const candidate = state.loopCandidates[state.loopSelected];
  if (!project || !candidate) return;
  const undo = snapshotWorkingSet();
  history.push("裁剪循环", () => restoreWorkingSet(undo));
  const selected = selectedFrames();
  const keepIds = new Set(
    selected.slice(candidate.startSel, candidate.endSel + 1).map((f) => f.id),
  );
  for (const frame of project.frames) {
    frame.inWorkingSet = keepIds.has(frame.id);
  }
  setState({
    dirty: true,
    status: `已裁剪到循环区间 ${candidate.startDisplay}–${candidate.endDisplay}（不含接缝对照帧）`,
  });
  persistSoon();
}

async function drawPreviewFrame(id: string): Promise<void> {
  const project = state.project;
  const frame = project?.frames.find((f) => f.id === id);
  const canvas = document.getElementById("organize-preview") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!project || !frame || !ctx) return;
  lastPreviewId = id;
  const img = await loadImage(frameUrl(project.id, fileName(frame.file), state.bust));
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  document.getElementById("preview-info")!.textContent = `第 ${frame.index + 1} 帧`;
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

function stopPreview(): void {
  playing = false;
  window.clearInterval(previewTimer);
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
    document.getElementById("preview-info")!.textContent = "没有可播放的选中帧";
    return;
  }
  previewIndex = 0;
  playing = true;
  const fps = Math.max(4, Math.min(30, state.project?.extract.fps || 12));
  void drawPreviewFrame(previewIds[0]);
  previewTimer = window.setInterval(() => {
    if (!playing || !previewIds.length) return;
    previewIndex = (previewIndex + 1) % previewIds.length;
    void drawPreviewFrame(previewIds[previewIndex]);
  }, 1000 / fps);
}

export function toggleOrganizePreview(): void {
  if (playing) {
    stopPreview();
    document.getElementById("btn-preview-play")!.textContent = "预览选中";
    return;
  }
  const candidate = state.loopCandidates[state.loopSelected];
  startPreview(candidate ? "loop" : "selected", candidate);
  document.getElementById("btn-preview-play")!.textContent = "暂停";
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
  document.getElementById("btn-restore")!.addEventListener("click", restoreUnselected);
  document.getElementById("btn-remove")!.addEventListener("click", () => void removeUnselected());
  document.getElementById("btn-find-loop")!.addEventListener("click", () => void findLoops());
  document.getElementById("btn-apply-loop")!.addEventListener("click", applyLoop);
  document.getElementById("btn-preview-play")!.addEventListener("click", toggleOrganizePreview);
  document.getElementById("loop-list")!.addEventListener("click", (ev) => {
    const card = (ev.target as HTMLElement).closest(".loop-card") as HTMLElement | null;
    if (!card) return;
    const i = Number(card.dataset.i);
    setState({ loopSelected: i });
    renderLoopList();
    const candidate = state.loopCandidates[i];
    if (candidate) startPreview("loop", candidate);
  });
}

export function syncOrganize(): void {
  document.getElementById("btn-undo-decimate")!.toggleAttribute("disabled", !history.canUndo());
  if (state.editTab === "organize") {
    renderLoopList();
    syncOrganizePreviewSize();
  }
}
