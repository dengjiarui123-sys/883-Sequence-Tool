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
