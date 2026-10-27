import type { ExportSettings } from "./types";

export function createCellCanvas(cellW: number, cellH: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = cellW;
  canvas.height = cellH;
  return canvas;
}

/** 预览与导出必须走这一套绘制。分辨率是格子；缩放是人在格子里多大。 */
export function drawCell(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  settings: ExportSettings,
): void {
  const cellW = settings.cell.w;
  const cellH = settings.cell.h;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cellW, cellH);
  if (settings.fill === "solid") {
    const [r, g, b] = settings.fillColor || [0, 0, 0];
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, cellW, cellH);
  }

  ctx.imageSmoothingEnabled = settings.smoothing !== "pixel";
  ctx.imageSmoothingQuality = "high";

  const scaleX = settings.scale.x;
  const scaleY = settings.scale.y;
  let dw: number;
  let dh: number;
  if (settings.fit === "stretch") {
    dw = cellW * scaleX;
    dh = cellH * scaleY;
  } else {
    const fit = Math.min(cellW / srcW, cellH / srcH);
    dw = srcW * fit * scaleX;
    dh = srcH * fit * scaleY;
  }
  const dx = (cellW - dw) / 2 + settings.offset.x;
  const dy = (cellH - dh) / 2 + settings.offset.y;
  ctx.drawImage(source, 0, 0, srcW, srcH, dx, dy, dw, dh);
}

export function layoutSheet(
  frameCount: number,
  cellW: number,
  cellH: number,
  atlasSize: number,
  padding: number,
): { columns: number; rowsPerPage: number; framesPerPage: number; pages: number } {
  if (atlasSize > 8192) {
    throw new Error("图集单边不能超过 8192，请减小分辨率或图集边长");
  }
  if (cellW > 8192 || cellH > 8192) {
    throw new Error("导出分辨率单边不能超过 8192");
  }
  const strideW = cellW + padding;
  const strideH = cellH + padding;
  const columns = Math.floor((atlasSize + padding) / strideW);
  const rowsPerPage = Math.floor((atlasSize + padding) / strideH);
  if (columns < 1 || rowsPerPage < 1) {
    throw new Error("格子大于图集边长，请减小导出分辨率或增大图集");
  }
  const framesPerPage = columns * rowsPerPage;
  const pages = Math.max(1, Math.ceil(frameCount / framesPerPage));
  return { columns, rowsPerPage, framesPerPage, pages };
}

/** 只去掉整页末尾的空行/空列；保留完整格子，不缩放像素。 */
export function sheetPageLayout(
  frameCount: number,
  settings: ExportSettings,
  pageIndex: number,
): { start: number; count: number; columns: number; rows: number; width: number; height: number } {
  const layout = layoutSheet(frameCount, settings.cell.w, settings.cell.h, settings.atlasSize, settings.padding);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= layout.pages) {
    throw new Error("图集页码超出范围");
  }
  const start = pageIndex * layout.framesPerPage;
  const count = Math.min(layout.framesPerPage, frameCount - start);
  const columns = Math.max(1, Math.min(layout.columns, count));
  const rows = Math.max(1, Math.ceil(count / columns));
  return {
    start,
    count,
    columns,
    rows,
    width: columns * settings.cell.w + (columns - 1) * settings.padding,
    height: rows * settings.cell.h + (rows - 1) * settings.padding,
  };
}

export function drawSpriteSheetPage(
  frames: Array<{ source: CanvasImageSource; srcW: number; srcH: number }>,
  settings: ExportSettings,
  pageIndex: number,
): HTMLCanvasElement {
  const { start, count, columns, width, height } = sheetPageLayout(frames.length, settings, pageIndex);
  const slice = frames.slice(start, start + count);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (settings.fill === "solid") {
    const [r, g, b] = settings.fillColor || [0, 0, 0];
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const cell = createCellCanvas(settings.cell.w, settings.cell.h);
  const cellCtx = cell.getContext("2d");
  if (!cellCtx) throw new Error("无法创建格子画布");
  slice.forEach((frame, i) => {
    drawCell(cellCtx, frame.source, frame.srcW, frame.srcH, settings);
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col * (settings.cell.w + settings.padding);
    const y = row * (settings.cell.h + settings.padding);
    ctx.drawImage(cell, x, y);
  });
  return canvas;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("PNG 编码失败"));
      else resolve(blob);
    }, "image/png");
  });
}
