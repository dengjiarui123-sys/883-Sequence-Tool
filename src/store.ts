import type { Project, StepId, EditTab, LoopCandidate } from "./types";

export interface ExtractProgress {
  current: number;
  total: number;
}

export interface AppState {
  step: StepId;
  editTab: EditTab;
  project: Project | null;
  videoFile: File | null;
  videoUrl: string | null;
  extractError: string;
  extracting: boolean;
  extractProgress: ExtractProgress | null;
  extractAbort: AbortController | null;
  currentFrameId: string | null;
  editorOpen: boolean;
  status: string;
  lastSavedAt: number | null;
  dirty: boolean;
  exportDone: boolean;
  loopCandidates: LoopCandidate[];
  loopSelected: number;
  loopBusy: boolean;
  decimateUndo: boolean[] | null;
  bust: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();

export const state: AppState = {
  step: "extract",
  editTab: "edit",
  project: null,
  videoFile: null,
  videoUrl: null,
  extractError: "",
  extracting: false,
  extractProgress: null,
  extractAbort: null,
  currentFrameId: null,
  editorOpen: false,
  status: "选择视频开始",
  lastSavedAt: null,
  dirty: false,
  exportDone: false,
  loopCandidates: [],
  loopSelected: 0,
  loopBusy: false,
  decimateUndo: null,
  bust: Date.now(),
};

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  notify();
}

export function patchProject(mutator: (project: Project) => void): void {
  if (!state.project) return;
  mutator(state.project);
  state.dirty = true;
  notify();
}

export function selectedFrames() {
  return state.project?.frames.filter((f) => f.inWorkingSet) ?? [];
}

export function currentFrame() {
  const id = state.currentFrameId;
  if (!id || !state.project) return null;
  return state.project.frames.find((f) => f.id === id) ?? null;
}
