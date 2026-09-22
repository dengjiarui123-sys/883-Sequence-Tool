import { layoutCrop } from "./extractUi";
import { syncOrganizePreviewSize } from "./organizeUi";

const KEYS = {
  extractSide: "vsp.layout.extractSide",
  editSide: "vsp.layout.editSide",
  exportSide: "vsp.layout.exportSide",
  organizePreviewH: "vsp.layout.organizePreviewH",
} as const;

const DEFAULTS = {
  extractSide: 360,
  editSide: 340,
  exportSide: 360,
  organizePreviewH: 220,
};

const MIN_PANE = 280;
const MIN_ABS = 80;
const MIN_PREVIEW_H = 160;
const SPLITTER = 7;

const layout = {
  extractSide: DEFAULTS.extractSide,
  editSide: DEFAULTS.editSide,
  exportSide: DEFAULTS.exportSide,
  organizePreviewH: DEFAULTS.organizePreviewH,
};

let cropRaf = 0;

function readStored(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* private mode */
  }
}

function clearStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

function setVar(name: string, px: number): void {
  document.documentElement.style.setProperty(name, `${Math.round(px)}px`);
}

function measurableWidth(el: HTMLElement | null): number {
  if (!el || el.hidden || el.clientWidth <= 0) return 0;
  return el.clientWidth;
}

function clampSide(value: number, total: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (total <= 0) return Math.min(Math.max(value, MIN_ABS), 4000);
  const floor = Math.min(MIN_PANE, Math.max(MIN_ABS, total - SPLITTER - MIN_PANE));
  const max = Math.max(floor, total - SPLITTER - Math.min(MIN_PANE, Math.max(MIN_ABS, total - SPLITTER - MIN_ABS)));
  return Math.min(Math.max(value, floor), max);
}

function clampPreviewH(value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS.organizePreviewH;
  const max = Math.max(MIN_PREVIEW_H, Math.round(window.innerHeight * 0.7));
  return Math.min(Math.max(value, MIN_PREVIEW_H), max);
}

function applyExtract(value: number, persist: boolean): void {
  const total = measurableWidth(document.getElementById("panel-extract"));
  layout.extractSide = clampSide(value, total, DEFAULTS.extractSide);
  setVar("--extract-side", layout.extractSide);
  if (persist) writeStored(KEYS.extractSide, layout.extractSide);
}

function applyEdit(value: number, persist: boolean): void {
  const total = measurableWidth(document.querySelector(".edit-layout"));
  layout.editSide = clampSide(value, total, DEFAULTS.editSide);
  setVar("--edit-side", layout.editSide);
  if (persist) writeStored(KEYS.editSide, layout.editSide);
}

function applyExport(value: number, persist: boolean): void {
  const total = measurableWidth(document.getElementById("panel-export"));
  layout.exportSide = clampSide(value, total, DEFAULTS.exportSide);
  setVar("--export-side", layout.exportSide);
  if (persist) writeStored(KEYS.exportSide, layout.exportSide);
}

function applyPreviewH(value: number, persist: boolean): void {
  layout.organizePreviewH = clampPreviewH(value);
  setVar("--organize-preview-h", layout.organizePreviewH);
  if (persist) writeStored(KEYS.organizePreviewH, layout.organizePreviewH);
}

function scheduleCrop(): void {
  if (cropRaf) return;
  cropRaf = requestAnimationFrame(() => {
    cropRaf = 0;
    layoutCrop();
  });
}

function bindSplitter(opts: {
  id: string;
  axis: "x" | "y";
  invert: boolean;
  get: () => number;
  set: (value: number, persist: boolean) => void;
  reset: () => void;
  onMove?: () => void;
  onEnd?: () => void;
}): void {
  const el = document.getElementById(opts.id);
  if (!el) return;
  let dragging = false;
  let startPos = 0;
  let startVal = 0;

  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    dragging = true;
    startPos = opts.axis === "x" ? ev.clientX : ev.clientY;
    startVal = opts.get();
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* untrusted or inactive pointer */
    }
    el.classList.add("is-active");
    document.body.classList.add(opts.axis === "x" ? "is-col-resize" : "is-row-resize");
  });

  el.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const pos = opts.axis === "x" ? ev.clientX : ev.clientY;
    const next = opts.invert ? startVal - (pos - startPos) : startVal + (pos - startPos);
    opts.set(next, false);
    opts.onMove?.();
  });

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("is-active");
    document.body.classList.remove("is-col-resize", "is-row-resize");
    opts.set(opts.get(), true);
    opts.onEnd?.();
  };

  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    opts.reset();
    opts.onEnd?.();
  });
}

function restoreFromStorage(): void {
  applyExtract(readStored(KEYS.extractSide, DEFAULTS.extractSide), false);
  applyEdit(readStored(KEYS.editSide, DEFAULTS.editSide), false);
  applyExport(readStored(KEYS.exportSide, DEFAULTS.exportSide), false);
  applyPreviewH(readStored(KEYS.organizePreviewH, DEFAULTS.organizePreviewH), false);
}

function reclampVisible(): void {
  applyExtract(layout.extractSide, false);
  applyEdit(layout.editSide, false);
  applyExport(layout.exportSide, false);
  applyPreviewH(layout.organizePreviewH, false);
  layoutCrop();
  syncOrganizePreviewSize();
}

export function initLayout(): void {
  restoreFromStorage();

  bindSplitter({
    id: "split-extract",
    axis: "x",
    invert: true,
    get: () => layout.extractSide,
    set: applyExtract,
    reset: () => {
      clearStored(KEYS.extractSide);
      applyExtract(DEFAULTS.extractSide, false);
    },
    onMove: scheduleCrop,
    onEnd: () => layoutCrop(),
  });

  bindSplitter({
    id: "split-edit",
    axis: "x",
    invert: true,
    get: () => layout.editSide,
    set: applyEdit,
    reset: () => {
      clearStored(KEYS.editSide);
      applyEdit(DEFAULTS.editSide, false);
    },
    onMove: () => syncOrganizePreviewSize(),
    onEnd: () => syncOrganizePreviewSize(),
  });

  bindSplitter({
    id: "split-export",
    axis: "x",
    invert: false,
    get: () => layout.exportSide,
    set: applyExport,
    reset: () => {
      clearStored(KEYS.exportSide);
      applyExport(DEFAULTS.exportSide, false);
    },
  });

  bindSplitter({
    id: "split-organize-preview",
    axis: "y",
    invert: true,
    get: () => layout.organizePreviewH,
    set: applyPreviewH,
    reset: () => {
      clearStored(KEYS.organizePreviewH);
      applyPreviewH(DEFAULTS.organizePreviewH, false);
    },
    onMove: () => syncOrganizePreviewSize(),
    onEnd: () => syncOrganizePreviewSize(),
  });

  window.addEventListener("resize", reclampVisible);
  const canvas = document.getElementById("organize-preview");
  if (canvas) {
    new ResizeObserver(() => syncOrganizePreviewSize()).observe(canvas);
  }
  layoutCrop();
  syncOrganizePreviewSize();
}
