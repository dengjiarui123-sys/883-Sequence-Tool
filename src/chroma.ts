import type { ChromaOp } from "./types";

function dilateMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const out = new Uint8Array(mask);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) {
      acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / span;
      const leave = src[y * w + Math.max(0, x - radius)];
      const enter = src[y * w + Math.min(w - 1, x + radius + 1)];
      acc += enter - leave;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) {
      acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / span;
      const leave = tmp[Math.max(0, y - radius) * w + x];
      const enter = tmp[Math.min(h - 1, y + radius + 1) * w + x];
      acc += enter - leave;
    }
  }
  return out;
}

/** RGB 欧氏距离 / √3，与容差（0–100，按 255 比例）比较。 */
export function chromaDistance(r: number, g: number, b: number, cr: number, cg: number, cb: number): number {
  const dr = r - cr;
  const dg = g - cg;
  const db = b - cb;
  return Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
}

export function applyChromaKey(src: ImageData, op: ChromaOp): ImageData {
  const { width: w, height: h } = src;
  const out = new ImageData(new Uint8ClampedArray(src.data), w, h);
  const data = out.data;
  const [cr, cg, cb] = op.color;
  const threshold = (Math.max(0, op.tolerance) / 100) * 255;
  const mask = new Uint8Array(w * h);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] === 0) {
      mask[p] = 1;
      continue;
    }
    const dist = chromaDistance(data[i], data[i + 1], data[i + 2], cr, cg, cb);
    if (dist <= threshold) mask[p] = 1;
  }

  const radius = Math.round(Math.max(0, op.edgeCleanup) / 4);
  const dilated = dilateMask(mask, w, h, radius);
  const coverage = new Float32Array(w * h);
  for (let p = 0; p < coverage.length; p++) coverage[p] = dilated[p] ? 0 : 1;
  const feather = Math.round(Math.max(0, op.edgeCleanup) / 2);
  const soft = boxBlur(coverage, w, h, feather);
  const despill = Math.min(1, Math.max(0, op.edgeCleanup) / 20);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const keep = Math.max(0, Math.min(1, soft[p]));
    data[i + 3] = Math.round(data[i + 3] * keep);
    if (keep > 0.02 && despill > 0) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const maxRB = Math.max(r, b);
      if (g > maxRB) {
        const spill = (g - maxRB) * despill * (1 - keep * 0.35);
        data[i + 1] = Math.max(0, g - spill);
        const pull = spill * 0.35;
        data[i] = Math.min(255, r + pull * 0.15);
        data[i + 2] = Math.min(255, b + pull * 0.15);
      }
    }
    if (keep < 0.02) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }
  return out;
}

export function opsEqual(a: ChromaOp, b: ChromaOp): boolean {
  return (
    a.type === b.type &&
    a.color[0] === b.color[0] &&
    a.color[1] === b.color[1] &&
    a.color[2] === b.color[2] &&
    a.tolerance === b.tolerance &&
    a.edgeCleanup === b.edgeCleanup
  );
}
