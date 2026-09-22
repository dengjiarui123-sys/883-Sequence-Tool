import { zipSync } from "fflate";
import { frameUrl } from "./api";
import { canvasToPngBlob, createCellCanvas, drawCell, drawSpriteSheetPage, layoutSheet } from "./drawCell";
import { downloadBlob, loadImage } from "./dom";
import { persistSoon } from "./persist";
import * as history from "./history";
import { selectedFrames, setState, state } from "./store";
import type { ExportSettings } from "./types";

let sheetPage = 0;

function fileName(frameFile: string): string {
  return frameFile.split("/").pop()!;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function readSettings(): ExportSettings | null {
  const project = state.project;
  if (!project) return null;
  const format = (document.getElementById("export-format") as HTMLSelectElement).value as "zip" | "spritesheet";
  const preset = (document.getElementById("cell-preset") as HTMLSelectElement).value;
  const custom = preset === "custom";
  document.getElementById("cell-custom")!.hidden = !custom;
  const cellW = custom ? Number((document.getElementById("cell-w") as HTMLInputElement).value) : Number(preset);
  const cellH = custom ? Number((document.getElementById("cell-h") as HTMLInputElement).value) : Number(preset);
  const scalePct = Number((document.getElementById("scale") as HTMLInputElement).value);
  document.getElementById("scale-val")!.textContent = `${scalePct}%`;
  const fill = (document.getElementById("fill") as HTMLSelectElement).value as "transparent" | "solid";
  document.getElementById("fill-color-field")!.hidden = fill !== "solid";
  document.getElementById("atlas-field")!.hidden = format !== "spritesheet";
  const fillColor = hexToRgb((document.getElementById("fill-color") as HTMLInputElement).value);
  const next: ExportSettings = {
    format,
    cell: { w: Math.max(8, cellW || 256), h: Math.max(8, cellH || 256) },
    scale: { x: scalePct / 100, y: scalePct / 100 },
    offset: {
      x: Number((document.getElementById("off-x") as HTMLInputElement).value) || 0,
      y: Number((document.getElementById("off-y") as HTMLInputElement).value) || 0,
    },
    fit: (document.getElementById("fit") as HTMLSelectElement).value as "contain" | "stretch",
    smoothing: (document.getElementById("smoothing") as HTMLSelectElement).value as "smooth" | "pixel",
    fill,
    fillColor,
    atlasSize: Number((document.getElementById("atlas-size") as HTMLSelectElement).value) || 2048,
    padding: 0,
    zipPrefix: (document.getElementById("zip-prefix") as HTMLInputElement).value.trim(),
  };
  project.export = next;
  state.dirty = true;
  return next;
}

export function syncExportFields(): void {
  const ex = state.project?.export;
  if (!ex) return;
  (document.getElementById("export-format") as HTMLSelectElement).value = ex.format;
  const { w, h } = ex.cell;
  const preset = w === h && [64, 128, 256, 512].includes(w) ? String(w) : "custom";
  (document.getElementById("cell-preset") as HTMLSelectElement).value = preset;
  (document.getElementById("cell-w") as HTMLInputElement).value = String(w);
  (document.getElementById("cell-h") as HTMLInputElement).value = String(h);
  document.getElementById("cell-custom")!.hidden = preset !== "custom";
  (document.getElementById("smoothing") as HTMLSelectElement).value = ex.smoothing;
  (document.getElementById("fit") as HTMLSelectElement).value = ex.fit;
  const pct = Math.round(ex.scale.x * 100);
  (document.getElementById("scale") as HTMLInputElement).value = String(pct);
  document.getElementById("scale-val")!.textContent = `${pct}%`;
  (document.getElementById("off-x") as HTMLInputElement).value = String(ex.offset.x);
  (document.getElementById("off-y") as HTMLInputElement).value = String(ex.offset.y);
  (document.getElementById("fill") as HTMLSelectElement).value = ex.fill;
  (document.getElementById("fill-color") as HTMLInputElement).value = rgbToHex(ex.fillColor || [0, 0, 0]);
  document.getElementById("fill-color-field")!.hidden = ex.fill !== "solid";
  (document.getElementById("atlas-size") as HTMLSelectElement).value = String(ex.atlasSize);
  (document.getElementById("zip-prefix") as HTMLInputElement).value = ex.zipPrefix || "";
  document.getElementById("atlas-field")!.hidden = ex.format !== "spritesheet";
}

async function loadedSelected() {
  const project = state.project;
  if (!project) return [];
  const frames = selectedFrames();
  const out = [];
  for (const frame of frames) {
    const img = await loadImage(frameUrl(project.id, fileName(frame.file), state.bust));
    out.push({ source: img, srcW: img.width, srcH: img.height, frame });
  }
  return out;
}

export async function refreshExportPreview(): Promise<void> {
  const settings = state.project?.export;
  const canvas = document.getElementById("export-preview") as HTMLCanvasElement;
  if (!settings) return;
  try {
    const loaded = await loadedSelected();
  if (!loaded.length) {
    const ctx = canvas.getContext("2d");
    canvas.width = settings.cell.w;
    canvas.height = settings.cell.h;
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    document.getElementById("export-preview-title")!.textContent = "没有选中帧";
    document.getElementById("sheet-page")!.textContent = "";
    return;
  }
  if (settings.format === "zip") {
    const current = loaded.find((f) => f.frame.id === state.currentFrameId) || loaded[0];
    canvas.width = settings.cell.w;
    canvas.height = settings.cell.h;
    const ctx = canvas.getContext("2d");
    if (ctx) drawCell(ctx, current.source, current.srcW, current.srcH, settings);
    document.getElementById("export-preview-title")!.textContent = `格子预览 · ${settings.cell.w}×${settings.cell.h}`;
    document.getElementById("sheet-page")!.textContent = "";
    return;
  }
  const layout = layoutSheet(
    loaded.length,
    settings.cell.w,
    settings.cell.h,
    settings.atlasSize,
    settings.padding,
  );
  sheetPage = Math.min(sheetPage, layout.pages - 1);
  const page = drawSpriteSheetPage(loaded, settings, sheetPage);
  canvas.width = page.width;
  canvas.height = page.height;
  canvas.getContext("2d")!.drawImage(page, 0, 0);
  document.getElementById("export-preview-title")!.textContent = `Sprite Sheet · cell ${settings.cell.w}×${settings.cell.h}`;
  document.getElementById("sheet-page")!.innerHTML =
    layout.pages > 1
      ? `<button type="button" class="btn" id="sheet-prev">上一页</button> ${sheetPage + 1}/${layout.pages} <button type="button" class="btn" id="sheet-next">下一页</button>`
      : `1/1 · ${layout.columns} 列`;
  document.getElementById("sheet-prev")?.addEventListener("click", () => {
    sheetPage = Math.max(0, sheetPage - 1);
    void refreshExportPreview();
  });
  document.getElementById("sheet-next")?.addEventListener("click", () => {
    sheetPage += 1;
    void refreshExportPreview();
  });
  } catch (err) {
    setState({ status: `预览失败：${(err as Error).message}` });
  }
}

async function exportZip(settings: ExportSettings): Promise<void> {
  const loaded = await loadedSelected();
  const cell = createCellCanvas(settings.cell.w, settings.cell.h);
  const ctx = cell.getContext("2d");
  if (!ctx) throw new Error("无法创建格子");
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < loaded.length; i++) {
    drawCell(ctx, loaded[i].source, loaded[i].srcW, loaded[i].srcH, settings);
    const blob = await canvasToPngBlob(cell);
    const name = `${settings.zipPrefix}${String(i + 1).padStart(3, "0")}.png`;
    files[name] = new Uint8Array(await blob.arrayBuffer());
  }
  const zipped = zipSync(files, { level: 6 });
      downloadBlob(new Blob([new Uint8Array(zipped)], { type: "application/zip" }), `${state.project?.id || "sequence"}.zip`);
}

async function exportSheet(settings: ExportSettings): Promise<void> {
  const loaded = await loadedSelected();
  const layout = layoutSheet(
    loaded.length,
    settings.cell.w,
    settings.cell.h,
    settings.atlasSize,
    settings.padding,
  );
  if (layout.pages === 1) {
    const page = drawSpriteSheetPage(loaded, settings, 0);
    downloadBlob(await canvasToPngBlob(page), `${state.project?.id || "sheet"}.png`);
    return;
  }
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < layout.pages; i++) {
    const page = drawSpriteSheetPage(loaded, settings, i);
    const blob = await canvasToPngBlob(page);
    files[`spritesheet_${String(i + 1).padStart(2, "0")}.png`] = new Uint8Array(await blob.arrayBuffer());
  }
  const zipped = zipSync(files, { level: 6 });
      downloadBlob(new Blob([new Uint8Array(zipped)], { type: "application/zip" }), `${state.project?.id || "sheet"}_pages.zip`);
}

export async function downloadExport(): Promise<void> {
  const settings = readSettings();
  if (!settings) return;
  const count = selectedFrames().length;
  if (!count) {
    setState({ status: "没有选中帧可导出" });
    return;
  }
  try {
    setState({ status: "正在导出…" });
    if (settings.format === "zip") await exportZip(settings);
    else await exportSheet(settings);
    setState({ exportDone: true, status: `已导出 ${count} 帧` });
    persistSoon();
  } catch (err) {
    setState({ status: `导出失败：${(err as Error).message}` });
  }
}

export function initExport(): void {
  const ids = [
    "export-format",
    "cell-preset",
    "cell-w",
    "cell-h",
    "smoothing",
    "fit",
    "scale",
    "off-x",
    "off-y",
    "fill",
    "fill-color",
    "atlas-size",
    "zip-prefix",
  ];
  for (const id of ids) {
    document.getElementById(id)!.addEventListener("input", () => {
      if (!exportSnap && state.project) exportSnap = structuredClone(state.project.export);
      readSettings();
      persistSoon();
      void refreshExportPreview();
      window.clearTimeout(exportTimer);
      exportTimer = window.setTimeout(commitExportHistory, 400);
    });
    document.getElementById(id)!.addEventListener("change", () => {
      if (!exportSnap && state.project) exportSnap = structuredClone(state.project.export);
      readSettings();
      persistSoon();
      void refreshExportPreview();
      commitExportHistory();
    });
  }
  document.getElementById("btn-download")!.addEventListener("click", () => void downloadExport());
}

let exportSnap: ExportSettings | null = null;
let exportTimer = 0;

function commitExportHistory(): void {
  window.clearTimeout(exportTimer);
  if (!exportSnap || !state.project) return;
  const before = exportSnap;
  exportSnap = null;
  if (JSON.stringify(before) === JSON.stringify(state.project.export)) return;
  history.push("导出参数", () => {
    if (!state.project) return;
    state.project.export = structuredClone(before);
    syncExportFields();
    void refreshExportPreview();
  });
}
