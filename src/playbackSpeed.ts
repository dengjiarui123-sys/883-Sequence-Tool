const SPEED_MIN = 0.25;
const SPEED_MAX = 2;
const SPEED_DEFAULT = 1;

let rate = SPEED_DEFAULT;
const listeners = new Set<(next: number) => void>();

function clampRate(next: number): number {
  const n = Math.round(Number(next) * 100) / 100;
  if (!Number.isFinite(n)) return SPEED_DEFAULT;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

function syncSliders(): void {
  document.querySelectorAll<HTMLInputElement>("[data-speed]").forEach((el) => {
    const value = String(rate);
    if (el.value !== value) el.value = value;
  });
}

export function getPlaybackRate(): number {
  return rate;
}

export function setPlaybackRate(next: number): void {
  const clamped = clampRate(next);
  if (clamped === rate) {
    syncSliders();
    applyVideoPlaybackRate();
    return;
  }
  rate = clamped;
  syncSliders();
  applyVideoPlaybackRate();
  listeners.forEach((fn) => fn(rate));
}

export function resetPlaybackRate(): void {
  setPlaybackRate(SPEED_DEFAULT);
}

export function onPlaybackRateChange(fn: (next: number) => void): void {
  listeners.add(fn);
}

export function applyVideoPlaybackRate(): void {
  const video = document.getElementById("source-video") as HTMLVideoElement | null;
  if (!video) return;
  video.playbackRate = rate;
  video.preservesPitch = true;
}

export function initPlaybackSpeed(): void {
  document.querySelectorAll<HTMLInputElement>("[data-speed]").forEach((el) => {
    el.min = String(SPEED_MIN);
    el.max = String(SPEED_MAX);
    el.step = "0.05";
    el.value = String(rate);
    el.addEventListener("input", () => setPlaybackRate(Number(el.value)));
  });
  document.querySelectorAll("[data-speed-reset]").forEach((el) => {
    el.addEventListener("click", () => resetPlaybackRate());
  });
  applyVideoPlaybackRate();
}
