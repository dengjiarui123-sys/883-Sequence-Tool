function isPartial(raw: string): boolean {
  return raw === "" || raw === "-" || raw === "." || raw === "-." || raw.endsWith(".");
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Keep a range and its number box on the same value. Typing past min/max waits until blur. */
export function bindSliderNumber(
  rangeId: string,
  numberId: string,
  format: (n: number) => string = (n) => String(n),
): void {
  const range = document.getElementById(rangeId) as HTMLInputElement | null;
  const num = document.getElementById(numberId) as HTMLInputElement | null;
  if (!range || !num) return;

  const limits = () => ({
    min: Number(range.min),
    max: Number(range.max),
    step: Number(range.step) || 1,
  });

  const show = (n: number) => {
    const text = format(n);
    if (num.value !== text) num.value = text;
  };

  range.addEventListener("input", () => {
    if (document.activeElement === num) return;
    show(Number(range.value));
  });

  num.addEventListener("input", () => {
    const raw = num.value.trim();
    if (isPartial(raw)) return;
    const n = Number(raw);
    const { min, max } = limits();
    if (!Number.isFinite(n) || n < min || n > max) return;
    range.value = String(n);
    range.dispatchEvent(new Event("input", { bubbles: true }));
  });

  num.addEventListener("change", () => {
    const { min, max, step } = limits();
    let n = Number(num.value);
    if (!Number.isFinite(n)) n = Number(range.value);
    n = Math.min(max, Math.max(min, n));
    const snapped = min + Math.round((n - min) / step) * step;
    const clamped = Math.min(max, Math.max(min, Number(snapped.toFixed(decimalsOf(step)))));
    range.value = String(clamped);
    show(Number(range.value));
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function initSliderFields(): void {
  bindSliderNumber("fps", "fps-val");
  bindSliderNumber("scale", "scale-val");
  bindSliderNumber("tolerance", "tol-val");
  bindSliderNumber("halo", "halo-val");
  bindSliderNumber("despill", "despill-val");
  bindSliderNumber("biref-threshold", "biref-th-val", (n) => n.toFixed(2));
  bindSliderNumber("biref-feather", "biref-feather-val");
}
