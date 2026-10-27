import assert from "node:assert/strict";
import { test } from "node:test";
import { drawSpriteSheetPage, layoutSheet, sheetPageLayout } from "../src/drawCell.ts";

const settings = {
  cell: { w: 256, h: 256 }, atlasSize: 2048, padding: 0,
  scale: { x: 1, y: 1 }, offset: { x: 0, y: 0 },
  fit: "contain", smoothing: "smooth", fill: "transparent",
};

test("256 cells retain their size while unused sheet rows and columns are removed", () => {
  for (const [count, width, height] of [
    [1, 256, 256], [7, 1792, 256], [8, 2048, 256], [9, 2048, 512],
    [22, 2048, 768], [32, 2048, 1024], [33, 2048, 1280], [40, 2048, 1280],
    [43, 2048, 1536], [64, 2048, 2048],
  ]) {
    const page = sheetPageLayout(count, settings, 0);
    assert.deepEqual([page.width, page.height, page.count], [width, height, count]);
  }
});

test("each page uses its own occupied size and preserves source frame order", () => {
  assert.equal(layoutSheet(65, 256, 256, 2048, 0).pages, 2);
  assert.deepEqual(sheetPageLayout(65, settings, 1), {
    start: 64, count: 1, columns: 1, rows: 1, width: 256, height: 256,
  });
  assert.throws(() => sheetPageLayout(65, settings, 2), /页码/);
});

test("non-square cells and inter-cell padding stay within the page limit", () => {
  const custom = { ...settings, cell: { w: 300, h: 128 }, atlasSize: 1024, padding: 2 };
  assert.deepEqual(sheetPageLayout(5, custom, 0), {
    start: 0, count: 5, columns: 3, rows: 2, width: 904, height: 258,
  });
  assert.equal(layoutSheet(4, 256, 256, 514, 2).framesPerPage, 4);
  assert.throws(() => layoutSheet(1, 1024, 256, 512, 0), /格子大于/);
  assert.throws(() => layoutSheet(1, 256, 256, 16384, 0), /8192/);
});

test("drawing copies full cells at original pixel size, including a shortened last page", () => {
  const canvases = [];
  const previous = globalThis.document;
  globalThis.document = { createElement() {
    const calls = [];
    const canvas = { width: 0, height: 0, calls, getContext() {
      return { setTransform() {}, clearRect() {}, drawImage(...args) { calls.push(args); } };
    } };
    canvases.push(canvas);
    return canvas;
  } };
  try {
    const frames = Array.from({ length: 65 }, (_, id) => ({ source: { id }, srcW: 256, srcH: 256 }));
    const first = drawSpriteSheetPage(frames.slice(0, 22), settings, 0);
    assert.deepEqual([first.width, first.height], [2048, 768]);
    assert.equal(first.calls.length, 22);
    assert.deepEqual(first.calls[21].slice(1), [1280, 512]);
    // drawImage(cell, x, y) copies pixels 1:1, with no destination resize.
    assert.ok(first.calls.every((call) => call.length === 3));
    const last = drawSpriteSheetPage(frames, settings, 1);
    assert.deepEqual([last.width, last.height], [256, 256]);
    assert.equal(last.calls.length, 1);
    assert.equal(canvases.at(-1).calls[0][0].id, 64);
  } finally {
    globalThis.document = previous;
  }
});
