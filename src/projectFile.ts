import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import {
  clearFrames,
  createProject,
  frameUrl,
  pickOpenPath,
  pickSavePath,
  putFrame,
  readProjectPack,
  saveProject,
  writeProjectPack,
} from "./api";
import { relativeFramePath } from "./extractMath";
import { persistNow } from "./persist";
import { setState, state } from "./store";
import type { Project } from "./types";

function fileName(frameFile: string): string {
  return frameFile.split("/").pop() || frameFile;
}

function suggestedPackName(label: string): string {
  const base = label.replace(/[\\/:*?"<>|]+/g, "_").trim() || "未命名序列";
  return `${base.slice(0, 80)}.vsp.zip`;
}

function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned || `seq_${Date.now()}`;
}

function portableProject(project: Project): Project {
  const copy = structuredClone(project);
  copy.id = safeId(copy.id);
  copy.kind = "video_sequence";
  copy.schemaVersion = 1;
  copy.frames = copy.frames.map((frame) => ({
    ...frame,
    file: `frames/${fileName(frame.file)}`,
  }));
  return copy;
}

function findProjectJson(files: Record<string, Uint8Array>): Project {
  const key = Object.keys(files).find((k) => k.replace(/\\/g, "/").endsWith("project.json"));
  if (!key) throw new Error("工程包里没有 project.json");
  const project = JSON.parse(strFromU8(files[key])) as Project;
  if (project.schemaVersion !== 1 || project.kind !== "video_sequence") {
    throw new Error("不是本工具的 video_sequence 工程包");
  }
  return project;
}

function findFrameBytes(files: Record<string, Uint8Array>, name: string): Uint8Array | null {
  const want = name.replace(/\\/g, "/");
  const exact = files[want] || files[`frames/${fileName(want)}`];
  if (exact) return exact;
  const hit = Object.keys(files).find((k) => k.replace(/\\/g, "/").endsWith("/" + fileName(want)) || k === fileName(want));
  return hit ? files[hit] : null;
}

async function packCurrentProject(): Promise<Uint8Array> {
  const project = state.project;
  if (!project) throw new Error("没有可保存的工程");
  const packed = portableProject(project);
  const files: Record<string, Uint8Array> = {
    "project.json": strToU8(`${JSON.stringify(packed, null, 2)}\n`),
  };
  for (const frame of packed.frames) {
    const name = fileName(frame.file);
    const res = await fetch(frameUrl(project.id, name, state.bust));
    if (!res.ok) throw new Error(`读取第 ${frame.index + 1} 帧失败`);
    files[`frames/${name}`] = new Uint8Array(await res.arrayBuffer());
  }
  return zipSync(files, { level: 6 });
}

function logPicker(hypothesisId: string, message: string, data: Record<string, unknown>): void {
  // #region agent log
  fetch("http://127.0.0.1:7271/ingest/c2c91e4c-5391-4090-8dac-685983b9b108", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "360abd" },
    body: JSON.stringify({
      sessionId: "360abd",
      runId: "post-fix",
      hypothesisId,
      location: "projectFile.ts",
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

function finishSave(status: string): void {
  const project = state.project;
  if (!project) throw new Error("没有可保存的工程");
  setState({
    dirty: false,
    lastSavedAt: Date.now(),
    status: `${status}（${project.frames.length} 帧）`,
  });
}

async function pickOpenFileInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

export async function saveProjectFile(): Promise<void> {
  const project = state.project;
  if (!project) throw new Error("没有可保存的工程");
  const suggestedName = suggestedPackName(project.label || project.id);
  logPicker("F", "save start", { suggestedName, method: "node-dialog" });

  const picked = await pickSavePath(suggestedName);
  logPicker("F", "save dialog result", {
    method: "node-dialog",
    suggestedName,
    canceled: picked.canceled,
    path: picked.path || "",
    dir: picked.dir || "",
  });
  if (picked.canceled || !picked.path) {
    setState({ status: "已取消保存" });
    return;
  }
  setState({ status: "正在写入工程文件…" });
  await persistNow();
  const zipped = await packCurrentProject();
  await writeProjectPack(picked.path, zipped);
  logPicker("F", "save write done", { path: picked.path, bytes: zipped.byteLength });
  finishSave(`已保存到 ${picked.path}`);
}

export async function openProjectFromDisk(): Promise<boolean> {
  logPicker("G", "open start", { method: "node-dialog" });
  try {
    const picked = await pickOpenPath();
    logPicker("G", "open dialog result", {
      method: "node-dialog",
      canceled: picked.canceled,
      path: picked.path || "",
      dir: picked.dir || "",
    });
    if (picked.canceled || !picked.path) {
      setState({ status: "已取消打开" });
      return false;
    }
    const bytes = await readProjectPack(picked.path);
    await applyProjectPack(bytes);
    setState({ status: `已打开 ${picked.path}` });
    return true;
  } catch (err) {
    logPicker("G", "node-dialog open failed", { error: (err as Error).message || String(err) });
  }

  const file = await pickOpenFileInput();
  if (!file) {
    logPicker("G", "open dialog result", { method: "file-input", canceled: true });
    setState({ status: "已取消打开" });
    return false;
  }
  logPicker("G", "open dialog result", { method: "file-input", canceled: false, name: file.name });
  await applyProjectPack(new Uint8Array(await file.arrayBuffer()));
  setState({ status: `已打开 ${file.name}` });
  return true;
}

async function applyProjectPack(bytes: Uint8Array): Promise<void> {
  const unzipped = unzipSync(bytes);
  const raw = findProjectJson(unzipped);
  const id = safeId(raw.id || `seq_${Date.now()}`);
  const project: Project = {
    ...raw,
    id,
    kind: "video_sequence",
    schemaVersion: 1,
    frames: (raw.frames || []).map((frame, index) => ({
      ...frame,
      index,
      file: relativeFramePath(id, fileName(frame.file)),
    })),
  };
  try {
    await createProject(project.label || id, id);
  } catch (err) {
    if (!String((err as Error).message).includes("已存在")) throw err;
  }
  await clearFrames(id);
  for (const frame of project.frames) {
    const frameBytes = findFrameBytes(unzipped, fileName(frame.file));
    if (!frameBytes) throw new Error(`工程包缺少 ${fileName(frame.file)}`);
    await putFrame(id, fileName(frame.file), new Blob([new Uint8Array(frameBytes)], { type: "image/png" }));
  }
  await saveProject(project);
  setState({
    project,
    currentFrameId: project.frames[0]?.id ?? null,
    step: project.frames.length ? "edit" : "extract",
    dirty: false,
    lastSavedAt: Date.now(),
    exportDone: false,
    loopCandidates: [],
    bust: Date.now(),
    videoFile: null,
    videoUrl: null,
    status: `已打开「${project.label}」，共 ${project.frames.length} 帧`,
  });
}
