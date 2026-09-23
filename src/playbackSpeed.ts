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

function formatSpeed(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function isPartialNumber(raw: string): boolean {
  return raw === "" || raw === "-" || raw === "." || raw === "-." || raw.endsWith(".");
}

function syncSliders(): void {
  const text = formatSpeed(rate);
  document.querySelectorAll<HTMLInputElement>("[data-speed]").forEach((el) => {
    const value = String(rate);
    if (el.value !== value) el.value = value;
  });
  document.querySelectorAll<HTMLInputElement>("[data-speed-num]").forEach((el) => {
    if (document.activeElement === el) return;
    if (el.value !== text) el.value = text;
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
  document.querySelectorAll<HTMLInputElement>("[data-speed-num]").forEach((el) => {
    el.min = String(SPEED_MIN);
    el.max = String(SPEED_MAX);
    el.step = "0.05";
    el.value = formatSpeed(rate);
    el.addEventListener("input", () => {
      const raw = el.value.trim();
      if (isPartialNumber(raw)) return;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < SPEED_MIN || n > SPEED_MAX) return;
      setPlaybackRate(n);
    });
    el.addEventListener("change", () => {
      const n = Number(el.value);
      setPlaybackRate(Number.isFinite(n) ? n : rate);
      el.value = formatSpeed(rate);
    });
  });
  document.querySelectorAll("[data-speed-reset]").forEach((el) => {
    el.addEventListener("click", () => resetPlaybackRate());
  });
  applyVideoPlaybackRate();
}
