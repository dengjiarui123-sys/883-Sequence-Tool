export type StepId = "extract" | "edit" | "export";
export type EditTab = "edit" | "organize";
export type KeepPosition = "first" | "last";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChromaOp {
  type: "chromaKey";
  x: number;
  y: number;
  color: [number, number, number];
  colors?: [number, number, number][];
  tolerance: number;
  halo?: number;
  despill?: number;
  /** 旧工程字段：halo = round(edgeCleanup/4)，despill = min(20, edgeCleanup) */
  edgeCleanup?: number;
}

export interface BirefNetOp {
  type: "birefNet";
  model: "hr-matting";
  threshold: number;
  feather: number;
}

export type FrameOp = ChromaOp | BirefNetOp;

export interface FrameRecord {
  id: string;
  index: number;
  file: string;
  width: number;
  height: number;
  inWorkingSet: boolean;
  ops: FrameOp[];
}

export interface ExportSettings {
  format: "zip" | "spritesheet";
  cell: { w: number; h: number };
  scale: { x: number; y: number };
  offset: { x: number; y: number };
  fit: "contain" | "stretch";
  smoothing: "smooth" | "pixel";
  fill: "transparent" | "solid";
  fillColor: [number, number, number];
  atlasSize: number;
  padding: number;
  zipPrefix: string;
}

export interface Project {
  schemaVersion: 1;
  id: string;
  label: string;
  kind: "video_sequence";
  source: {
    filename: string;
    width: number;
    height: number;
    durationSec: number;
  };
  extract: {
    crop: CropRect;
    startSec: number;
    endSec: number;
    fps: number;
  };
  frames: FrameRecord[];
  editConfirmed?: boolean;
  export: ExportSettings;
}

export interface RegistryEntry {
  id: string;
  label: string;
  kind: "video_sequence";
  dataDir: string;
  workspaceDir: string;
}

export interface Registry {
  schemaVersion: 1;
  activeProjectId: string | null;
  projects: RegistryEntry[];
}

export interface LoopCandidate {
  startSel: number;
  endSel: number;
  seamSel: number;
  startId: string;
  endInclusiveId: string;
  seamId: string;
  startDisplay: number;
  endDisplay: number;
  frameCount: number;
  smoothness: number;
  coverage: number;
  score: number;
  label: string;
}
