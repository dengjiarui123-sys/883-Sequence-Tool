export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少节点 #${id}`);
  return el;
}

export function noticeDialog(message: string): Promise<void> {
  const overlay = document.getElementById("modal-root")!;
  return new Promise((resolve) => {
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(message)}</h3>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" data-act="ok">确定</button>
        </div>
      </div>`;
    overlay.hidden = false;
    const close = () => {
      overlay.hidden = true;
      overlay.innerHTML = "";
      resolve();
    };
    overlay.querySelector("[data-act=ok]")!.addEventListener("click", () => close());
  });
}

export async function confirmDialog(opts: {
  title: string;
  body: string;
  ok?: string;
  cancel?: string;
  danger?: boolean;
}): Promise<boolean> {
  const overlay = document.getElementById("modal-root")!;
  return new Promise((resolve) => {
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(opts.title)}</h3>
        <p>${opts.body}</p>
        <div class="modal-actions">
          <button type="button" class="btn" data-act="cancel">${escapeHtml(opts.cancel || "取消")}</button>
          <button type="button" class="btn ${opts.danger ? "btn-danger" : "btn-primary"}" data-act="ok">${escapeHtml(opts.ok || "确定")}</button>
        </div>
      </div>`;
    overlay.hidden = false;
    const close = (value: boolean) => {
      overlay.hidden = true;
      overlay.innerHTML = "";
      resolve(value);
    };
    overlay.querySelector("[data-act=ok]")!.addEventListener("click", () => close(true));
    overlay.querySelector("[data-act=cancel]")!.addEventListener("click", () => close(false));
  });
}

export async function choiceDialog(opts: {
  title: string;
  body: string;
  primary: string;
  secondary: string;
  cancel?: string;
}): Promise<"primary" | "secondary" | "cancel"> {
  const overlay = document.getElementById("modal-root")!;
  return new Promise((resolve) => {
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(opts.title)}</h3>
        <p>${opts.body}</p>
        <div class="modal-actions">
          <button type="button" class="btn" data-act="cancel">${escapeHtml(opts.cancel || "取消")}</button>
          <button type="button" class="btn" data-act="secondary">${escapeHtml(opts.secondary)}</button>
          <button type="button" class="btn btn-primary" data-act="primary">${escapeHtml(opts.primary)}</button>
        </div>
      </div>`;
    overlay.hidden = false;
    const close = (value: "primary" | "secondary" | "cancel") => {
      overlay.hidden = true;
      overlay.innerHTML = "";
      resolve(value);
    };
    overlay.querySelector("[data-act=primary]")!.addEventListener("click", () => close("primary"));
    overlay.querySelector("[data-act=secondary]")!.addEventListener("click", () => close("secondary"));
    overlay.querySelector("[data-act=cancel]")!.addEventListener("click", () => close("cancel"));
  });
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

let toastTimer: number | null = null;

export function showToast(message: string): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
    toastTimer = null;
  }, 2500);
}

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return img;
}

export function imageDataFrom(img: CanvasImageSource & { width: number; height: number }): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法读取像素");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function putImageDataCanvas(data: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法写入像素");
  ctx.putImageData(data, 0, 0);
  return canvas;
}

export async function imageDataToPng(data: ImageData): Promise<Blob> {
  const canvas = putImageDataCanvas(data);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("PNG 编码失败"));
      else resolve(blob);
    }, "image/png");
  });
}
