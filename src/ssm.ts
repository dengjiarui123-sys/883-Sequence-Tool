import type { LoopCandidate } from "./types";

export const THUMB_SIZE = 32;

export interface FrameThumb {
  id: string;
  display: number;
  lum: Float32Array;
  opaque: Uint8Array;
}

export function buildThumb(image: ImageData, id: string, display: number): FrameThumb {
  const srcW = image.width;
  const srcH = image.height;
  const lum = new Float32Array(THUMB_SIZE * THUMB_SIZE);
  const opaque = new Uint8Array(THUMB_SIZE * THUMB_SIZE);
  for (let y = 0; y < THUMB_SIZE; y++) {
    for (let x = 0; x < THUMB_SIZE; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * (srcW / THUMB_SIZE)));
      const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * (srcH / THUMB_SIZE)));
      const i = (sy * srcW + sx) * 4;
      const a = image.data[i + 3];
      const p = y * THUMB_SIZE + x;
      if (a < 16) {
        opaque[p] = 0;
        lum[p] = 0;
        continue;
      }
      opaque[p] = 1;
      lum[p] = (0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]) / 255;
    }
  }
  return { id, display, lum, opaque };
}

export function similarity(a: FrameThumb, b: FrameThumb): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.lum.length; i++) {
    if (!a.opaque[i] || !b.opaque[i]) continue;
    const d = a.lum[i] - b.lum[i];
    sum += d * d;
    n++;
  }
  if (n < 8) return 0;
  const rmse = Math.sqrt(sum / n);
  return Math.max(0, Math.min(1, 1 - rmse * 1.35));
}

function overlapRatio(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): number {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const union = Math.max(a1, b1) - Math.min(a0, b0);
  return union <= 0 ? 0 : inter / union;
}

export function findLoopCandidates(thumbs: FrameThumb[]): LoopCandidate[] {
  const n = thumbs.length;
  if (n < 9) return [];

  const S: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    S[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = similarity(thumbs[i], thumbs[j]);
      S[i][j] = s;
      S[j][i] = s;
    }
  }

  const minLen = 8;
  const maxLen = Math.max(minLen, Math.floor(n * 0.8));
  type Raw = Omit<LoopCandidate, "label">;
  const raw: Raw[] = [];

  for (let start = 0; start < n - minLen; start++) {
    const lenLimit = Math.min(maxLen, n - start - 1);
    for (let len = minLen; len <= lenLimit; len++) {
      const endExclusive = start + len;
      const seam = endExclusive;
      if (seam >= n) continue;
      const seamSim = S[start][seam];
      let jump = 0;
      let jumpCount = 0;
      for (let k = start; k < endExclusive - 1; k++) {
        jump += 1 - S[k][k + 1];
        jumpCount++;
      }
      const avgJump = jumpCount ? jump / jumpCount : 0;
      const smoothness = Math.max(0, Math.min(100, (seamSim - avgJump * 0.45) * 100));
      const coverage = (len / n) * 100;
      let score = smoothness * 0.62 + coverage * 0.38;
      if (len < 12) score *= 0.82;
      if (len > n * 0.7 && seamSim < 0.55) score *= 0.7;
      if (seamSim < 0.22) score *= 0.45;
      raw.push({
        startSel: start,
        endSel: endExclusive - 1,
        seamSel: seam,
        startId: thumbs[start].id,
        endInclusiveId: thumbs[endExclusive - 1].id,
        seamId: thumbs[seam].id,
        startDisplay: thumbs[start].display,
        endDisplay: thumbs[seam].display,
        frameCount: len,
        smoothness,
        coverage,
        score,
      });
    }
  }

  raw.sort((a, b) => b.score - a.score);
  const picked: Raw[] = [];
  for (const c of raw) {
    const overlaps = picked.some(
      (p) => overlapRatio(c.startSel, c.endSel + 1, p.startSel, p.endSel + 1) > 0.72,
    );
    if (overlaps) continue;
    picked.push(c);
    if (picked.length >= 5) break;
  }

  const labels = ["最优", "次优", "较好", "一般", "较差"];
  return picked.map((c, i) => ({ ...c, label: labels[i] || "候选" }));
}
