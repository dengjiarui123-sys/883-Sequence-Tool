/** Per-pixel touch-up on top of a matte preview. 1 = erase toward transparent, 2 = restore from the extracted plate. */

export interface RefineBuffers {
  op: Uint8Array;
  amt: Float32Array;
}

export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function createRefine(width: number, height: number): RefineBuffers {
  const n = width * height;
  return { op: new Uint8Array(n), amt: new Float32Array(n) };
}

export function cloneRefine(src: RefineBuffers): RefineBuffers {
  return { op: new Uint8Array(src.op), amt: new Float32Array(src.amt) };
}

export function unionRect(a: PixelRect | null, b: PixelRect | null): PixelRect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export function stampRefine(
  buf: RefineBuffers,
  width: number,
  height: number,
  cx: number,
  cy: number,
  diameter: number,
  hardness: number,
  mode: "erase" | "restore",
): PixelRect | null {
  const radius = Math.max(0.5, diameter / 2);
  const opCode = mode === "erase" ? 1 : 2;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  if (x1 < x0 || y1 < y0) return null;
  const hard = Math.max(0, Math.min(100, hardness)) / 100;
  const inner = radius * hard;
  const soft = hard < 1 && radius > inner + 0.001;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (dist > radius) continue;
      const strength = !soft || dist <= inner ? 1 : 1 - (dist - inner) / (radius - inner);
      if (strength <= 0) continue;
      const p = y * width + x;
      if (buf.op[p] === opCode) buf.amt[p] = Math.max(buf.amt[p], strength);
      else {
        buf.op[p] = opCode;
        buf.amt[p] = strength;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/** Later stroke replaces whatever refine was on those pixels. */
export function bakeStroke(dst: RefineBuffers, stroke: RefineBuffers): boolean {
  let wrote = false;
  const n = stroke.op.length;
  for (let p = 0; p < n; p++) {
    if (stroke.op[p] === 0 || stroke.amt[p] <= 0) continue;
    dst.op[p] = stroke.op[p];
    dst.amt[p] = stroke.amt[p];
    wrote = true;
  }
  return wrote;
}

function applyPixel(
  op: number,
  amt: number,
  plateOk: boolean,
  pd: Uint8ClampedArray,
  i: number,
  px: { r: number; g: number; b: number; a: number },
): void {
  if (op === 0 || amt <= 0) return;
  const t = amt > 1 ? 1 : amt;
  if (op === 1) {
    px.a *= 1 - t;
    if (px.a < 1.5) {
      px.r = 0;
      px.g = 0;
      px.b = 0;
      px.a = 0;
    }
    return;
  }
  if (plateOk) {
    px.r += (pd[i] - px.r) * t;
    px.g += (pd[i + 1] - px.g) * t;
    px.b += (pd[i + 2] - px.b) * t;
    px.a += (pd[i + 3] - px.a) * t;
    return;
  }
  px.a += (255 - px.a) * t;
}

/** Writes base, then baked refine, then the in-progress stroke. `rect` limits the update. */
export function compositeRefine(
  base: ImageData,
  plate: ImageData,
  refine: RefineBuffers | null,
  stroke: RefineBuffers | null,
  into?: ImageData,
  rect?: PixelRect,
): ImageData {
  const w = base.width;
  const h = base.height;
  const out = into && into.width === w && into.height === h ? into : new ImageData(w, h);
  const x0 = rect ? Math.max(0, rect.x0) : 0;
  const y0 = rect ? Math.max(0, rect.y0) : 0;
  const x1 = rect ? Math.min(w - 1, rect.x1) : w - 1;
  const y1 = rect ? Math.min(h - 1, rect.y1) : h - 1;
  const plateOk = plate.width === w && plate.height === h;
  const bd = base.data;
  const pd = plate.data;
  const od = out.data;
  const ro = refine?.op;
  const ra = refine?.amt;
  const so = stroke?.op;
  const sa = stroke?.amt;
  const px = { r: 0, g: 0, b: 0, a: 0 };

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * w + x;
      const i = p * 4;
      px.r = bd[i];
      px.g = bd[i + 1];
      px.b = bd[i + 2];
      px.a = bd[i + 3];
      if (ro && ra) applyPixel(ro[p], ra[p], plateOk, pd, i, px);
      if (so && sa) applyPixel(so[p], sa[p], plateOk, pd, i, px);
      od[i] = Math.round(px.r);
      od[i + 1] = Math.round(px.g);
      od[i + 2] = Math.round(px.b);
      od[i + 3] = Math.round(px.a);
    }
  }
  return out;
}
