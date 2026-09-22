import { createProject, fetchRegistry, loadProject } from "./api";
import { confirmDialog, isTypingTarget, showToast } from "./dom";
import { initEditor, syncEditorVisibility, undoEditorLocal } from "./editorUi";
import { initExport, refreshExportPreview, syncExportFields } from "./exportUi";
import { initExtract, layoutCrop, syncExtractFieldsFromProject, toggleVideoPlay } from "./extractUi";
import { initLayout } from "./layout";
import { deselectCurrentFrame, initFilmstrip, renderFilmstrip } from "./filmstrip";
import * as history from "./history";
import { initOrganize, syncOrganize, toggleOrganizePreview } from "./organizeUi";
import { formatSavedClock, persistNow, persistSoon } from "./persist";
import { openProjectFromDisk, saveProjectFile } from "./projectFile";
import { patchProject, setState, state, subscribe } from "./store";
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

  const labelEl = document.getElementById("project-label") as HTMLInputElement;
  if (document.activeElement !== labelEl) {
    labelEl.value = state.project?.label || "";
  }
  document.getElementById("status-line")!.textContent = state.status;
  const saveEl = document.getElementById("save-state")!;
  saveEl.textContent = state.dirty
    ? "有未保存更改"
    : state.lastSavedAt
      ? `已保存 ${formatSavedClock(state.lastSavedAt)}`
      : "未保存";

  const frame = state.project?.frames.find((f) => f.id === state.currentFrameId);
  document.getElementById("current-frame-info")!.textContent = frame
    ? `当前第 ${frame.index + 1} 帧 · ${frame.width}×${frame.height} · 操作 ${frame.ops.length} 条 · ${frame.inWorkingSet ? "选中" : "未选中"}`
    : "未选择帧";

  document.getElementById("extract-error")!.textContent = state.extractError;
  const undoBtn = document.getElementById("btn-undo") as HTMLButtonElement | null;
  if (undoBtn) {
    const peek = history.peekLabel();
    undoBtn.disabled = !history.canUndo();
    undoBtn.title = peek ? `撤销：${peek}` : "没有可撤销的操作";
  }
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

async function quickSave(): Promise<void> {
  if (!state.project) {
    setState({ status: "没有可保存的工程" });
    return;
  }
  try {
    await persistNow();
    const at = state.lastSavedAt ?? Date.now();
    showToast(`已保存 ${formatSavedClock(at)}`);
  } catch (err) {
    setState({ status: `保存失败：${(err as Error).message}` });
  }
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
  document.getElementById("btn-quick-save")!.addEventListener("click", () => {
    void quickSave();
  });
  document.getElementById("btn-save")!.addEventListener("click", () => {
    // #region agent log
    fetch("http://127.0.0.1:7271/ingest/c2c91e4c-5391-4090-8dac-685983b9b108", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "360abd" },
      body: JSON.stringify({
        sessionId: "360abd",
        hypothesisId: "A",
        location: "main.ts:btn-save",
        message: "save button clicked",
        data: { dirty: state.dirty, status: state.status, lastSavedAt: state.lastSavedAt },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    setState({ status: "请选择保存位置和文件名…" });
    saveProjectFile().catch((err) => {
      // #region agent log
      fetch("http://127.0.0.1:7271/ingest/c2c91e4c-5391-4090-8dac-685983b9b108", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "360abd" },
        body: JSON.stringify({
          sessionId: "360abd",
          hypothesisId: "D",
          location: "main.ts:btn-save:catch",
          message: "saveProjectFile rejected",
          data: { error: (err as Error).message },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      setState({ status: `保存失败：${(err as Error).message}` });
    });
  });
  document.getElementById("btn-undo")!.addEventListener("click", () => {
    history.undo();
  });
  document.getElementById("btn-open")!.addEventListener("click", () => {
    const hasFrames = (state.project?.frames.length || 0) > 0;
    const proceed = async () => {
      if (state.dirty || hasFrames) {
        const ok = await confirmDialog({
          title: "打开工程",
          body: "未保存的撤销记录将丢失。",
          ok: "打开",
          danger: true,
        });
        if (!ok) return;
      }
      setState({ status: "请选择要打开的工程文件…" });
      const opened = await openProjectFromDisk();
      if (!opened) return;
      history.clear();
      syncExtractFieldsFromProject();
      syncExportFields();
    };
    proceed().catch((err) => {
      // #region agent log
      fetch("http://127.0.0.1:7271/ingest/c2c91e4c-5391-4090-8dac-685983b9b108", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "360abd" },
        body: JSON.stringify({
          sessionId: "360abd",
          runId: "post-fix",
          hypothesisId: "G",
          location: "main.ts:btn-open:catch",
          message: "openProjectFromDisk rejected",
          data: { error: (err as Error).message },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      setState({ status: `打开失败：${(err as Error).message}` });
    });
  });
  const nameEl = document.getElementById("project-label") as HTMLInputElement;
  let labelSnap: string | null = null;
  let labelTimer = 0;
  const commitLabelHistory = () => {
    window.clearTimeout(labelTimer);
    if (labelSnap === null || !state.project) return;
    const before = labelSnap;
    labelSnap = null;
    if (before === state.project.label) return;
    history.push("工程名", () => {
      if (!state.project) return;
      state.project.label = before;
      (document.getElementById("project-label") as HTMLInputElement).value = before;
    });
  };
  nameEl.addEventListener("input", () => {
    const label = nameEl.value;
    // #region agent log
    fetch("http://127.0.0.1:7271/ingest/c2c91e4c-5391-4090-8dac-685983b9b108", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "360abd" },
      body: JSON.stringify({
        sessionId: "360abd",
        hypothesisId: "H",
        location: "main.ts:project-label",
        message: "project label edited",
        data: { label },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    if (labelSnap === null) labelSnap = state.project?.label ?? "";
    patchProject((project) => {
      project.label = label;
    });
    persistSoon();
    window.clearTimeout(labelTimer);
    labelTimer = window.setTimeout(commitLabelHistory, 400);
  });
  nameEl.addEventListener("change", commitLabelHistory);
  nameEl.addEventListener("blur", () => {
    if (!state.project) return;
    if (!state.project.label.trim()) {
      if (labelSnap === null) labelSnap = state.project.label;
      patchProject((project) => {
        project.label = "未命名序列";
      });
      persistSoon();
    }
    commitLabelHistory();
  });
  window.addEventListener("keydown", (ev) => {
    if (isTypingTarget(ev.target)) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (state.editorOpen) {
        undoEditorLocal();
        return;
      }
      history.undo();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) {
      ev.preventDefault();
      void quickSave();
      return;
    }
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
  initLayout();
  await restore();
  renderShell();
}

void boot();
