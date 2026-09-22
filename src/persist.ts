import { saveProject } from "./api";
import { setState, state } from "./store";

let timer: number | null = null;

export function formatSavedClock(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export async function persistNow(): Promise<void> {
  const project = state.project;
  // #region agent log
  fetch("http://127.0.0.1:7271/ingest/c2c91e4c-5391-4090-8dac-685983b9b108", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "360abd" },
    body: JSON.stringify({
      sessionId: "360abd",
      hypothesisId: "B",
      location: "persist.ts:persistNow:entry",
      message: "persistNow called",
      data: {
        hasProject: Boolean(project),
        projectId: project?.id ?? null,
        dirty: state.dirty,
        lastSavedAt: state.lastSavedAt,
        statusBefore: state.status,
        keepOldStatus: Boolean(state.status && !/保存/.test(state.status)),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (!project) return;
  await saveProject(project);
  const nextStatus = /保存/.test(state.status) || !state.status ? "工程已保存" : state.status;
  setState({
    dirty: false,
    lastSavedAt: Date.now(),
    status: nextStatus,
  });
  // #region agent log
  fetch("http://127.0.0.1:7271/ingest/c2c91e4c-5391-4090-8dac-685983b9b108", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "360abd" },
    body: JSON.stringify({
      sessionId: "360abd",
      hypothesisId: "C",
      location: "persist.ts:persistNow:success",
      message: "persistNow finished",
      data: { nextStatus, dirtyAfter: false, lastSavedAt: Date.now() },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

export function persistSoon(): void {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    persistNow().catch((err) => {
      setState({ status: `保存失败：${(err as Error).message}` });
    });
  }, 350);
}
