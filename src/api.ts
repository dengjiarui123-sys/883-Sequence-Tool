import type { Project, Registry } from "./types";

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const err = body as { error?: string };
    throw new Error(err?.error || `请求失败 (${res.status})`);
  }
  return body as T;
}

export async function fetchRegistry(): Promise<Registry> {
  return parseJson(await fetch("/api/registry"));
}

export async function createProject(label: string, id?: string): Promise<Project> {
  return parseJson(
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, id }),
    }),
  );
}

export async function loadProject(id: string): Promise<Project> {
  return parseJson(await fetch(`/api/projects/${encodeURIComponent(id)}`));
}

export async function saveProject(project: Project): Promise<Project> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project),
    }),
  );
}

export async function putFrame(projectId: string, file: string, blob: Blob): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(file)}`,
    { method: "PUT", body: blob },
  );
  await parseJson(res);
}

export async function deleteFrame(projectId: string, file: string): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(file)}`,
    { method: "DELETE" },
  );
  await parseJson(res);
}

export async function clearFrames(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/frames`, {
    method: "DELETE",
  });
  await parseJson(res);
}

export function frameUrl(projectId: string, file: string, bust = 0): string {
  const q = bust ? `?t=${bust}` : "";
  return `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(file)}${q}`;
}

export function originalFrameUrl(projectId: string, file: string, bust = 0): string {
  const q = bust ? `?t=${bust}` : "";
  return `/api/projects/${encodeURIComponent(projectId)}/frames-original/${encodeURIComponent(file)}${q}`;
}

export async function putOriginalFrame(projectId: string, file: string, blob: Blob): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/frames-original/${encodeURIComponent(file)}`,
    { method: "PUT", body: blob },
  );
  await parseJson(res);
}

export const BIREFNET_MODEL_URL = "https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting";

/** Download sizes from the live pip log (torch cu128 cp314 wheel = 2771 MB). */
export const BIREFNET_INSTALL_SIZE = {
  torch: "约 2.7GB",
  rest: "约 0.2GB",
  model: "约 440MB",
  total: "约 3.3GB",
  summary: "依赖环境约 3.3GB：PyTorch CUDA 12.8 约 2.7GB，其余包约 0.2GB，模型约 440MB",
};

export interface MatteStatus {
  python: boolean;
  torch: boolean;
  cuda: boolean;
  model: boolean;
  ready: boolean;
  message: string;
  modelUrl?: string;
  error?: string;
}

export async function fetchMatteStatus(): Promise<MatteStatus> {
  return parseJson(await fetch("/api/matte/status"));
}

export async function downloadMatteModel(): Promise<MatteStatus> {
  return parseJson(await fetch("/api/matte/download", { method: "POST" }));
}

export async function installMatte(onProgress?: (ev: { line: string; percent?: number; phase?: string }) => void): Promise<MatteStatus> {
  const res = await fetch("/api/matte/install", { method: "POST" });
  const contentType = res.headers.get("content-type") || "";
  if (res.status === 409 || !res.body || !contentType.includes("ndjson")) {
    const text = await res.text();
    let msg: Record<string, unknown> = {};
    try {
      msg = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      msg = { error: text };
    }
    const error =
      (typeof msg.error === "string" && msg.error) ||
      (typeof msg.message === "string" && msg.message) ||
      `安装失败 (${res.status})`;
    if (res.status === 409 || /正在安装/.test(error)) {
      return {
        python: true,
        torch: false,
        cuda: false,
        model: false,
        ready: false,
        message: error,
        error,
      };
    }
    if (!res.ok) throw new Error(error);
    return msg as unknown as MatteStatus;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let last: MatteStatus | null = null;
  let lastError = "";
  const takeLine = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof parsed.line === "string") {
      onProgress?.({
        line: parsed.line,
        percent: typeof parsed.percent === "number" ? parsed.percent : undefined,
        phase: typeof parsed.phase === "string" ? parsed.phase : undefined,
      });
    }
    if (parsed.ok === false && typeof parsed.error === "string") lastError = parsed.error;
    if (typeof parsed.ready === "boolean" || parsed.ok === true || parsed.ok === false) {
      last = parsed as unknown as MatteStatus;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) takeLine(line);
  }
  takeLine(buf);
  if (last) return last;
  if (!res.ok) throw new Error(lastError || `安装失败 (${res.status})`);
  throw new Error(lastError || "安装无响应");
}

export interface MatteResult {
  blob: Blob;
  device: string;
  cudaFallback: boolean;
}

export async function requestMatte(png: Blob): Promise<MatteResult> {
  const res = await fetch("/api/matte", { method: "POST", body: png });
  if (!res.ok) {
    const text = await res.text();
    let message = `推理失败 (${res.status})`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }
  return {
    blob: await res.blob(),
    device: res.headers.get("X-Matte-Device") || "",
    cudaFallback: res.headers.get("X-Matte-Fallback") === "1",
  };
}

export async function pickSavePath(suggestedName: string): Promise<{ canceled: boolean; path?: string; dir?: string }> {
  return parseJson(
    await fetch("/api/dialogs/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestedName }),
    }),
  );
}

export async function pickOpenPath(): Promise<{ canceled: boolean; path?: string; dir?: string }> {
  return parseJson(await fetch("/api/dialogs/open", { method: "POST" }));
}

export async function fetchFfmpegStatus(): Promise<{ available: boolean }> {
  return parseJson(await fetch("/api/ffmpeg"));
}

export async function installFfmpeg(
  onProgress: (ev: { line: string; percent?: number; phase?: string }) => void,
): Promise<{ available: boolean }> {
  const res = await fetch("/api/ffmpeg/install", { method: "POST" });
  if (!res.ok || !res.body) {
    let message = `下载失败 (${res.status})`;
    try {
      const body = JSON.parse(await res.text()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* 保持默认文案 */
    }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let available = false;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { phase?: string; line?: string; percent?: number; error?: string; available?: boolean };
      if (msg.error || msg.phase === "error") throw new Error(msg.error || msg.line || "下载失败");
      if (msg.line) onProgress({ line: msg.line, percent: msg.percent, phase: msg.phase });
      if (msg.phase === "done") available = msg.available !== false;
    }
  }
  if (!available) throw new Error("下载结束但 ffmpeg 仍不可用");
  return { available: true };
}

export interface VideoProbe {
  token: string;
  fps: number;
  width: number;
  height: number;
  duration: number;
}

export async function probeVideoFile(file: File): Promise<VideoProbe> {
  return parseJson(
    await fetch("/api/ffmpeg/probe", {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/octet-stream" },
    }),
  );
}

export interface EncodedFrameFile {
  file: string;
  w: number;
  h: number;
}

export async function runEncodedExtract(
  projectId: string,
  token: string,
  range: { start: number; end: number; x: number; y: number; w: number; h: number },
  onProgress: (current: number) => void,
  signal: AbortSignal,
): Promise<{ sourceFps: number; frames: EncodedFrameFile[] }> {
  const params = new URLSearchParams({
    token,
    start: String(range.start),
    end: String(range.end),
    x: String(range.x),
    y: String(range.y),
    w: String(range.w),
    h: String(range.h),
  });
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/extract-frames?${params}`, {
    method: "POST",
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `提取失败 (${res.status})`;
    try {
      const body = JSON.parse(await res.text()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* 保持默认文案 */
    }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let doneMsg: { sourceFps: number; frames: EncodedFrameFile[] } | null = null;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as {
        type: string;
        current?: number;
        error?: string;
        sourceFps?: number;
        frames?: EncodedFrameFile[];
      };
      if (msg.type === "progress") onProgress(msg.current || 0);
      if (msg.type === "error") throw new Error(msg.error || "提取失败");
      if (msg.type === "done" && msg.frames) doneMsg = { sourceFps: msg.sourceFps || 0, frames: msg.frames };
    }
  }
  if (!doneMsg) throw new Error("提取没有返回帧");
  return doneMsg;
}

export async function writeProjectPack(filePath: string, data: Uint8Array): Promise<void> {
  const res = await fetch(`/api/project-pack?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/zip" },
    body: new Blob([new Uint8Array(data)]),
  });
  await parseJson(res);
}

export async function readProjectPack(filePath: string): Promise<Uint8Array> {
  const res = await fetch(`/api/project-pack?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `读取工程失败 (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
