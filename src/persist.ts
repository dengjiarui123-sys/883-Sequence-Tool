import { saveProject } from "./api";
import { setState, state } from "./store";

let timer: number | null = null;

export async function persistNow(): Promise<void> {
  const project = state.project;
  if (!project) return;
  await saveProject(project);
  setState({
    dirty: false,
    lastSavedAt: Date.now(),
    status: /保存/.test(state.status) || !state.status ? "工程已保存" : state.status,
  });
}

export function persistSoon(): void {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    persistNow().catch((err) => {
      setState({ status: `保存失败：${(err as Error).message}` });
    });
  }, 350);
}
