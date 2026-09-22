import { createProject, fetchRegistry, loadProject } from "./api";
import { isTypingTarget } from "./dom";
import { initEditor, syncEditorVisibility } from "./editorUi";
import { initExport, refreshExportPreview, syncExportFields } from "./exportUi";
import { initExtract, layoutCrop, syncExtractFieldsFromProject, toggleVideoPlay } from "./extractUi";
import { deselectCurrentFrame, initFilmstrip, renderFilmstrip } from "./filmstrip";
import { initOrganize, syncOrganize, toggleOrganizePreview } from "./organizeUi";
import { persistNow } from "./persist";
import { setState, state, subscribe } from "./store";
import type { EditTab, StepId } from "./types";

function hasFrames(): boolean {
  return (state.project?.frames.length || 0) > 0;
}

function renderShell(): void {
  const extractDone = hasFrames();
  const editDone = Boolean(
    state.project?.frames.some((f) => f.ops.length > 0 || !f.inWorkingSet),
  );
  document.getElementById("check-extract")!.classList.toggle("is-done", extractDone);
  document.getElementById("check-edit")!.classList.toggle("is-done", editDone);
  document.getElementById("check-export")!.classList.toggle("is-done", state.exportDone);
  document.getElementById("nav-extract")!.classList.toggle("is-on", state.step === "extract");
  document.getElementById("nav-edit")!.classList.toggle("is-on", state.step === "edit");
  document.getElementById("nav-export")!.classList.toggle("is-on", state.step === "export");
  (document.getElementById("nav-edit") as HTMLButtonElement).disabled = !extractDone && state.step !== "edit";
  (document.getElementById("nav-export") as HTMLButtonElement).disabled = !extractDone && state.step !== "export";

  document.getElementById("panel-extract")!.hidden = state.step !== "extract";
  document.getElementById("panel-edit")!.hidden = state.step !== "edit";
  document.getElementById("panel-export")!.hidden = state.step !== "export";
  document.getElementById("side-edit")!.hidden = state.editTab !== "edit";
  document.getElementById("side-organize")!.hidden = state.editTab !== "organize";
  document.querySelectorAll(".subtab").forEach((el) => {
    el.classList.toggle("is-on", (el as HTMLElement).dataset.tab === state.editTab);
  });

  document.getElementById("project-label")!.textContent = state.project?.label || "未命名工程";
  document.getElementById("status-line")!.textContent = state.status;
  const saveEl = document.getElementById("save-state")!;
  saveEl.textContent = state.dirty ? "有未保存更改" : state.lastSavedAt ? "已保存" : "未保存";

  const frame = state.project?.frames.find((f) => f.id === state.currentFrameId);
  document.getElementById("current-frame-info")!.textContent = frame
    ? `当前第 ${frame.index + 1} 帧 · ${frame.width}×${frame.height} · 操作 ${frame.ops.length} 条 · ${frame.inWorkingSet ? "选中" : "未选中"}`
    : "未选择帧";

  document.getElementById("extract-error")!.textContent = state.extractError;
  if (state.step === "edit") renderFilmstrip();
  syncOrganize();
  syncEditorVisibility();
  if (state.step === "extract") layoutCrop();
}

function goto(step: StepId): void {
  if ((step === "edit" || step === "export") && !hasFrames()) {
    setState({ status: "请先提取帧" });
    return;
  }
  setState({ step });
  if (step === "export") {
    syncExportFields();
    void refreshExportPreview();
  }
}

async function restore(): Promise<void> {
  try {
    const registry = await fetchRegistry();
    if (registry.activeProjectId) {
      const project = await loadProject(registry.activeProjectId);
      setState({
        project,
        currentFrameId: project.frames[0]?.id ?? null,
        step: project.frames.length ? "edit" : "extract",
        dirty: false,
        lastSavedAt: Date.now(),
        status: project.frames.length ? `已恢复工程「${project.label}」，共 ${project.frames.length} 帧` : "已恢复工程，请选择视频",
        bust: Date.now(),
      });
      syncExtractFieldsFromProject();
      syncExportFields();
      return;
    }
  } catch {
    /* 无工程时新建 */
  }
  const project = await createProject("未命名序列");
  setState({ project, status: "新工程已创建，请选择视频", dirty: false });
  syncExtractFieldsFromProject();
  syncExportFields();
}

function initShell(): void {
  document.querySelectorAll(".step").forEach((btn) => {
    btn.addEventListener("click", () => goto((btn as HTMLElement).dataset.step as StepId));
  });
  document.querySelectorAll(".subtab").forEach((btn) => {
    btn.addEventListener("click", () => {
      setState({ editTab: (btn as HTMLElement).dataset.tab as EditTab });
    });
  });
  document.getElementById("btn-save")!.addEventListener("click", () => {
    persistNow().catch((err) => setState({ status: `保存失败：${(err as Error).message}` }));
  });
  window.addEventListener("keydown", (ev) => {
    if (isTypingTarget(ev.target)) return;
    if (ev.code === "Space") {
      ev.preventDefault();
      if (state.step === "extract") toggleVideoPlay();
      else if (state.step === "edit" && state.editTab === "organize") toggleOrganizePreview();
      return;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (state.step === "edit" && !state.editorOpen) {
        ev.preventDefault();
        deselectCurrentFrame();
      }
    }
  });
}

subscribe(renderShell);

async function boot(): Promise<void> {
  initExtract();
  initFilmstrip();
  initEditor();
  initOrganize();
  initExport();
  initShell();
  await restore();
  renderShell();
}

void boot();
