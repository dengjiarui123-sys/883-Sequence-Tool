import { persistSoon } from "./persist";
import { setState } from "./store";

const MAX = 15;

interface HistoryEntry {
  label: string;
  undo: () => void;
}

const stack: HistoryEntry[] = [];

function bump(): void {
  setState({ historyRev: Date.now() });
}

export function push(label: string, undo: () => void): void {
  stack.push({ label, undo });
  while (stack.length > MAX) stack.shift();
  bump();
}

export function undo(): boolean {
  const entry = stack.pop();
  if (!entry) return false;
  entry.undo();
  setState({ dirty: true, historyRev: Date.now(), status: `已撤销：${entry.label}` });
  persistSoon();
  return true;
}

export function clear(): void {
  if (!stack.length) {
    bump();
    return;
  }
  stack.length = 0;
  bump();
}

export function canUndo(): boolean {
  return stack.length > 0;
}

export function peekLabel(): string | null {
  return stack.at(-1)?.label ?? null;
}
