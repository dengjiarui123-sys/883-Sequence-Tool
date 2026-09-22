import { putFrame } from "./api";
import { applyChromaKey, opsEqual } from "./chroma";
import { confirmDialog, imageDataFrom, imageDataToPng, loadImage } from "./dom";
import { persistNow } from "./persist";
import * as history from "./history";
import { currentFrame, selectedFrames, setState, state } from "./store";
import type { ChromaOp } from "./types";

let original: ImageData | null = null;
let preview: ImageData | null = null;
let sample: { x: number; y: number; color: [number, number, number] } | null = null;

type EditorSnap = {
  sample: { x: number; y: number; color: [number, number, number] } | null;
  tolerance: number;
  edgeCleanup: number;
};

const EDITOR_MAX = 15;
let editorLocalStack: EditorSnap[] = [];
let sliderSnap: EditorSnap | null = null;
let sliderTimer = 0;
let editorBaseline: EditorSnap = { sample: null, tolerance: 24, edgeCleanup: 8 };

function canvas(): HTMLCanvasElement {
  return document.getElementById("editor-canvas") as HTMLCanvasElement;
}

function fileName(frameFile: string): string {
  return frameFile.split("/").pop()!;
}

function readParams(): Pick<ChromaOp, "tolerance" | "edgeCleanup"> {
  return {
    tolerance: Number((document.getElementById("tolerance") as HTMLInputElement).value),
    edgeCleanup: Number((document.getElementById("edge-cleanup") as HTMLInputElement).value),
  };
}

function paint(data: ImageData): void {
  const c = canvas();
  c.width = data.width;
  c.height = data.height;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(data, 0, 0);
}

function currentOp(): ChromaOp | null {
  if (!sample || !original) return null;
  const { tolerance, edgeCleanup } = readParams();
  return {
    type: "chromaKey",
    x: sample.x,
    y: sample.y,
    color: sample.color,
    tolerance,
    edgeCleanup,
  };
}

function refreshPreview(): void {
  if (!original) return;
  const op = currentOp();
  preview = op ? applyChromaKey(original, op) : original;
  paint(preview);
}

function captureEditor(): EditorSnap {
  const { tolerance, edgeCleanup } = readParams();
  return {
    sample: sample
      ? { x: sample.x, y: sample.y, color: [sample.color[0], sample.color[1], sample.color[2]] }
      : null,
    tolerance,
    edgeCleanup,
  };
}

function applyEditorSnap(snap: EditorSnap): void {
  sample = snap.sample
    ? { x: snap.sample.x, y: snap.sample.y, color: [snap.sample.color[0], snap.sample.color[1], snap.sample.color[2]] }
    : null;
  (document.getElementById("tolerance") as HTMLInputElement).value = String(snap.tolerance);
  (document.getElementById("edge-cleanup") as HTMLInputElement).value = String(snap.edgeCleanup);
  document.getElementById("tol-val")!.textContent = String(snap.tolerance);
  document.getElementById("edge-val")!.textContent = String(snap.edgeCleanup);
  if (sample) {
    document.getElementById("sample-rgb")!.textContent = `RGB ${sample.color.join(", ")}`;
    (document.getElementById("sample-swatch") as HTMLElement).style.background = `rgb(${sample.color.join(",")})`;
  } else {
    document.getElementById("sample-rgb")!.textContent = "未采样";
    (document.getElementById("sample-swatch") as HTMLElement).style.background = "";
  }
  refreshPreview();
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

function flushEditorSliderHistory(): void {
  window.clearTimeout(sliderTimer);
  if (!sliderSnap) return;
  const before = sliderSnap;
  sliderSnap = null;
  const now = captureEditor();
  if (
    before.tolerance === now.tolerance &&
    before.edgeCleanup === now.edgeCleanup &&
    JSON.stringify(before.sample) === JSON.stringify(now.sample)
  ) {
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

async function openEditor(): Promise<void> {
  const project = state.project;
  const frame = currentFrame();
  if (!project || !frame) {
    setState({ editorOpen: false, status: "请先在胶片条选择一帧" });
    return;
  }
  const img = await loadImage(
    `/api/projects/${encodeURIComponent(project.id)}/frames/${encodeURIComponent(fileName(frame.file))}?t=${state.bust}`,
  );
  original = imageDataFrom(img);
  preview = original;
  sample = null;
  document.getElementById("editor-frame-name")!.textContent = `第 ${frame.index + 1} 帧 · ${frame.width}×${frame.height}`;
  document.getElementById("sample-rgb")!.textContent = "未采样";
  (document.getElementById("sample-swatch") as HTMLElement).style.background = "";
  (document.getElementById("tolerance") as HTMLInputElement).value = "24";
  (document.getElementById("edge-cleanup") as HTMLInputElement).value = "8";
  document.getElementById("tol-val")!.textContent = "24";
  document.getElementById("edge-val")!.textContent = "8";
  paint(original);
  document.getElementById("editor-root")!.hidden = false;
  clearEditorLocal();
  rememberEditorBaseline();
}

function closeEditor(): void {
  original = null;
  preview = null;
  sample = null;
  clearEditorLocal();
  document.getElementById("editor-root")!.hidden = true;
  if (state.editorOpen) setState({ editorOpen: false });
}

async function applyEditor(): Promise<void> {
  const project = state.project;
  const frame = currentFrame();
  const op = currentOp();
  if (!project || !frame || !op || !preview) {
    setState({ status: "请先点击画面采样颜色" });
    return;
  }
  const ok = await confirmDialog({
    title: "应用换色",
    body: "将写入该帧像素，无法撤销。",
    ok: "应用",
    danger: true,
  });
  if (!ok) return;
  try {
    const blob = await imageDataToPng(preview);
    await putFrame(project.id, fileName(frame.file), blob);
    if (!frame.ops.some((o) => o.type === "chromaKey" && opsEqual(o, op))) {
      frame.ops.push(op);
    }
    state.dirty = true;
    history.clear();
    clearEditorLocal();
    closeEditor();
    setState({ bust: Date.now(), status: `第 ${frame.index + 1} 帧已应用换色` });
    await persistNow();
  } catch (err) {
    setState({ status: `应用失败：${(err as Error).message}` });
  }
}

export async function batchApply(): Promise<void> {
  const project = state.project;
  const frame = currentFrame();
  if (!project || !frame) {
    setState({ status: "请先选择一帧并完成换色" });
    return;
  }
  const ops = frame.ops.filter((o): o is ChromaOp => o.type === "chromaKey");
  const targets = selectedFrames();
  if (!ops.length) {
    setState({ status: "当前帧还没有已应用的操作。请先在编辑器里应用换色。" });
    return;
  }
  if (!targets.length) {
    setState({ status: "没有选中帧。" });
    return;
  }
  const ok = await confirmDialog({
    title: "批量应用",
    body: `将 ${ops.length} 个操作应用到 ${targets.length} 帧？含当前帧时，已应用过的同一条会跳过，避免叠两次。请确认各帧背景色接近。`,
    ok: "开始批量",
  });
  if (!ok) return;

  let failed: number[] = [];
  let done = 0;
  setState({ status: "批量应用中…" });
  for (const target of targets) {
    try {
      const pending = ops.filter((op) => !target.ops.some((existing) => existing.type === "chromaKey" && opsEqual(existing, op)));
      if (!pending.length) {
        done += 1;
        continue;
      }
      const img = await loadImage(
        `/api/projects/${encodeURIComponent(project.id)}/frames/${encodeURIComponent(fileName(target.file))}?t=${state.bust}`,
      );
      let data = imageDataFrom(img);
      for (const op of pending) data = applyChromaKey(data, op);
      const blob = await imageDataToPng(data);
      await putFrame(project.id, fileName(target.file), blob);
      target.ops.push(...pending);
      done += 1;
    } catch {
      failed.push(target.index + 1);
    }
    setState({ status: `批量应用中… ${done}/${targets.length}` });
    await new Promise((r) => setTimeout(r, 0));
  }
  state.dirty = true;
  setState({
    bust: Date.now(),
    status: failed.length
      ? `已完成 ${done} 帧，失败序号：${failed.join("、")}`
      : `已将 ${ops.length} 个操作应用到 ${targets.length} 帧`,
  });
  await persistNow();
  history.clear();
}

export function initEditor(): void {
  document.getElementById("btn-open-editor")!.addEventListener("click", () => {
    setState({ editorOpen: true });
  });
  document.getElementById("btn-editor-cancel")!.addEventListener("click", () => closeEditor());
  document.getElementById("btn-editor-apply")!.addEventListener("click", () => void applyEditor());
  document.getElementById("btn-editor-undo")!.addEventListener("click", () => {
    undoEditorLocal();
  });
  document.getElementById("btn-batch")!.addEventListener("click", () => void batchApply());

  canvas().addEventListener("click", (ev) => {
    if (!original) return;
    flushEditorSliderHistory();
    const before = captureEditor();
    const c = canvas();
    const rect = c.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * original.width);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * original.height);
    const i = (y * original.width + x) * 4;
    const color: [number, number, number] = [original.data[i], original.data[i + 1], original.data[i + 2]];
    sample = { x: x / original.width, y: y / original.height, color };
    document.getElementById("sample-rgb")!.textContent = `RGB ${color.join(", ")}`;
    (document.getElementById("sample-swatch") as HTMLElement).style.background = `rgb(${color.join(",")})`;
    pushEditorLocal(before);
    rememberEditorBaseline();
    refreshPreview();
  });

  for (const id of ["tolerance", "edge-cleanup"]) {
    const el = document.getElementById(id)!;
    el.addEventListener("pointerdown", () => {
      if (!sliderSnap) sliderSnap = editorBaseline;
    });
    el.addEventListener("input", () => {
      if (!sliderSnap) sliderSnap = editorBaseline;
      document.getElementById("tol-val")!.textContent = (document.getElementById("tolerance") as HTMLInputElement).value;
      document.getElementById("edge-val")!.textContent = (document.getElementById("edge-cleanup") as HTMLInputElement).value;
      refreshPreview();
      window.clearTimeout(sliderTimer);
      sliderTimer = window.setTimeout(flushEditorSliderHistory, 400);
    });
    el.addEventListener("change", flushEditorSliderHistory);
  }
}

export function syncEditorVisibility(): void {
  const root = document.getElementById("editor-root")!;
  if (state.editorOpen) {
    if (root.hidden) void openEditor();
  } else if (!root.hidden) {
    original = null;
    preview = null;
    sample = null;
    clearEditorLocal();
    root.hidden = true;
  }
}
