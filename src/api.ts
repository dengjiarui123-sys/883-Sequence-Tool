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
