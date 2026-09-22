import { frameUrl } from "./api";
import * as history from "./history";
import { persistSoon } from "./persist";
import { currentFrame, selectedFrames, setState, state } from "./store";

let lastKey = "";
let lastLoopScroll = "";

function loopPreviewIds(): Set<string> | null {
  const candidate = state.loopCandidates[state.loopSelected];
  if (!candidate || !state.loopCandidates.length) return null;
  const selected = selectedFrames();
  return new Set(selected.slice(candidate.startSel, candidate.endSel + 1).map((f) => f.id));
}

export function renderFilmstrip(): void {
  const root = document.getElementById("filmstrip");
  const project = state.project;
  if (!root) return;
  const frames = project?.frames ?? [];
  const loopIds = loopPreviewIds();
  const loopPart = loopIds
    ? `${state.loopSelected}:${[...loopIds].join(",")}`
    : "none";
  const key = `${project?.id}:${state.bust}:${state.currentFrameId}:${loopPart}:${frames.map((f) => `${f.id}:${f.inWorkingSet}:${f.index}`).join("|")}`;
  document.getElementById("film-count")!.textContent = `${frames.length} 帧 · 选中 ${frames.filter((f) => f.inWorkingSet).length}`;
  if (key === lastKey) return;
  lastKey = key;
  root.innerHTML = "";
  if (!project) return;
  for (const frame of frames) {
    const inLoop = loopIds ? loopIds.has(frame.id) : false;
    const loopClass = loopIds ? (inLoop ? " is-loop-in" : " is-loop-out") : "";
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `cell${frame.id === state.currentFrameId ? " is-current" : ""}${frame.inWorkingSet ? "" : " is-off"}${loopClass}`;
    cell.dataset.id = frame.id;
    const img = document.createElement("img");
    img.alt = frame.id;
    img.src = frameUrl(project.id, frame.file.split("/").pop()!, state.bust);
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(frame.index + 1);
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.dataset.act = "toggle";
    mark.textContent = frame.inWorkingSet ? "✓" : "";
    cell.append(img, idx, mark);
    root.append(cell);
  }
  if (loopIds) {
    if (loopPart !== lastLoopScroll) {
      lastLoopScroll = loopPart;
      root.querySelector(".cell.is-loop-in")?.scrollIntoView({ block: "nearest" });
    }
  } else {
    lastLoopScroll = "";
  }
}

export function initFilmstrip(): void {
  const root = document.getElementById("filmstrip")!;
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const cell = target.closest(".cell") as HTMLElement | null;
    if (!cell || !state.project) return;
    const id = cell.dataset.id!;
    if (target.dataset.act === "toggle" || target.classList.contains("mark")) {
      const frame = state.project.frames.find((f) => f.id === id);
      if (!frame) return;
      const was = frame.inWorkingSet;
      history.push(was ? "取消选中" : "选中帧", () => {
        const f = state.project?.frames.find((x) => x.id === id);
        if (f) f.inWorkingSet = was;
      });
      frame.inWorkingSet = !was;
      state.dirty = true;
      lastKey = "";
      setState({ currentFrameId: id });
      persistSoon();
      root.focus();
      return;
    }
    setState({ currentFrameId: id });
    root.focus();
  });
  root.addEventListener("dblclick", (ev) => {
    const cell = (ev.target as HTMLElement).closest(".cell") as HTMLElement | null;
    if (!cell) return;
    setState({ currentFrameId: cell.dataset.id!, editorOpen: true });
  });
}

export function deselectCurrentFrame(): void {
  const frame = currentFrame();
  if (!frame || !frame.inWorkingSet) return;
  const id = frame.id;
  history.push("取消选中", () => {
    const f = state.project?.frames.find((x) => x.id === id);
    if (f) f.inWorkingSet = true;
  });
  frame.inWorkingSet = false;
  state.dirty = true;
  lastKey = "";
  setState({ status: `第 ${frame.index + 1} 帧已标为未选中` });
  persistSoon();
}
