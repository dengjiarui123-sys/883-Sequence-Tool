/** UI 与抽帧必须使用同一公式。 */
export function estimateFrameCount(startSec: number, endSec: number, fps: number): number {
  if (!(endSec > startSec) || !(fps > 0)) return 0;
  return Math.floor((endSec - startSec) * fps) + 1;
}

export function sampleTimes(startSec: number, endSec: number, fps: number): number[] {
  const count = estimateFrameCount(startSec, endSec, fps);
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = startSec + i / fps;
    if (t > endSec) break;
    times.push(t);
  }
  return times;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0.00";
  return sec.toFixed(2);
}

export function padFrameFile(index1: number): string {
  return `${String(index1).padStart(4, "0")}.png`;
}

export function displayIndex(index0: number): number {
  return index0 + 1;
}

export function relativeFramePath(projectId: string, file: string): string {
  return `workspace/projects/${projectId}/frames/${file}`;
}
