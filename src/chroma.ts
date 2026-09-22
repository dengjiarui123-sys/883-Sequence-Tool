import type { BirefNetOp, ChromaOp, FrameOp } from "./types";

export const MAX_CHROMA_SAMPLES = 8;
export const SAMPLE_NEAR = 2;

export type Rgb = [number, number, number];

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

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function rgbNear(a: Rgb, b: Rgb, tol = SAMPLE_NEAR): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

export function chromaColors(op: ChromaOp): Rgb[] {
  if (op.colors && op.colors.length) return op.colors;
  return [op.color];
}

export function chromaHalo(op: ChromaOp): number {
  if (typeof op.halo === "number" && Number.isFinite(op.halo)) return Math.max(0, op.halo);
  return Math.round(Math.max(0, op.edgeCleanup ?? 0) / 4);
}

export function chromaDespill(op: ChromaOp): number {
  if (typeof op.despill === "number" && Number.isFinite(op.despill)) return Math.max(0, op.despill);
  return Math.min(20, Math.max(0, op.edgeCleanup ?? 0));
}

export function serializeChromaOp(op: ChromaOp): ChromaOp {
  const colors = chromaColors(op).map((c) => [c[0], c[1], c[2]] as Rgb);
  return {
    type: "chromaKey",
    x: op.x,
    y: op.y,
    color: [colors[0][0], colors[0][1], colors[0][2]],
    colors,
    tolerance: op.tolerance,
    halo: chromaHalo(op),
    despill: chromaDespill(op),
  };
}

/** YCbCr 的 CbCr 距离（忽略亮度为主）。 */
export function chromaDistance(r: number, g: number, b: number, cr: number, cg: number, cb: number): number {
  const yP = 0.299 * r + 0.587 * g + 0.114 * b;
  const yS = 0.299 * cr + 0.587 * cg + 0.114 * cb;
  const cbP = b - yP;
  const crP = r - yP;
  const cbS = cb - yS;
  const crS = cr - yS;
  return Math.hypot(cbP - cbS, crP - crS);
}

function minSampleDist(r: number, g: number, b: number, samples: Rgb[]): number {
  let best = Infinity;
  for (const [sr, sg, sb] of samples) {
    const d = chromaDistance(r, g, b, sr, sg, sb);
    if (d < best) best = d;
  }
  return best;
}

export function applyChromaKey(src: ImageData, op: ChromaOp): ImageData {
  const { width: w, height: h } = src;
  const out = new ImageData(new Uint8ClampedArray(src.data), w, h);
  const data = out.data;
  const samples = chromaColors(op);
  if (!samples.length) return out;
  const threshold = (Math.max(0, op.tolerance) / 100) * 255;
  const mask = new Uint8Array(w * h);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] === 0) {
      mask[p] = 1;
      continue;
    }
    const dist = minSampleDist(data[i], data[i + 1], data[i + 2], samples);
    if (dist <= threshold) mask[p] = 1;
  }

  const halo = Math.round(chromaHalo(op));
  const dilated = dilateMask(mask, w, h, halo);
  const coverage = new Float32Array(w * h);
  for (let p = 0; p < coverage.length; p++) coverage[p] = dilated[p] ? 0 : 1;
  const soft = boxBlur(coverage, w, h, 1);
  const despill = Math.min(1, Math.max(0, chromaDespill(op)) / 20);

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

export function alphaFromGrayImageData(gray: ImageData): Float32Array {
  const a = new Float32Array(gray.width * gray.height);
  const d = gray.data;
  for (let p = 0, i = 0; p < a.length; p++, i += 4) a[p] = d[i] / 255;
  return a;
}

export function applyBirefNet(src: ImageData, alpha: Float32Array, op: BirefNetOp): ImageData {
  const { width: w, height: h } = src;
  if (alpha.length !== w * h) {
    throw new Error("BiRefNet 遮罩尺寸与原图不一致");
  }
  const out = new ImageData(new Uint8ClampedArray(src.data), w, h);
  const data = out.data;
  const radius = Math.max(0, Math.round(op.feather));
  const blurred = boxBlur(alpha, w, h, radius);
  const threshold = Math.max(0, Math.min(1, op.threshold));
  const softness = Math.max(0.02, radius * 0.04);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    const keep = smoothstep(threshold - softness, threshold + softness, blurred[p]);
    data[i + 3] = Math.round(data[i + 3] * keep);
    if (keep < 0.02) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }
  return out;
}

export function opsEqual(a: FrameOp, b: FrameOp): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "birefNet" && b.type === "birefNet") {
    return a.model === b.model && a.threshold === b.threshold && a.feather === b.feather;
  }
  if (a.type !== "chromaKey" || b.type !== "chromaKey") return false;
  const ac = chromaColors(a);
  const bc = chromaColors(b);
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    if (ac[i][0] !== bc[i][0] || ac[i][1] !== bc[i][1] || ac[i][2] !== bc[i][2]) return false;
  }
  return a.tolerance === b.tolerance && chromaHalo(a) === chromaHalo(b) && chromaDespill(a) === chromaDespill(b);
}
