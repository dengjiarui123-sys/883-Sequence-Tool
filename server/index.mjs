import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { showOpenDialog, showSaveDialog } from "./fileDialog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8788;
const DATA_DIR = path.join(ROOT, "data");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const WORKSPACE_DIR = path.join(ROOT, "workspace", "projects");
const REGISTRY_PATH = path.join(DATA_DIR, "projects.json");
const LAST_PACK_PATH = path.join(DATA_DIR, "last-project-file.json");

const ID_RE = /^[A-Za-z0-9_-]+$/;
const FRAME_FILE_RE = /^[A-Za-z0-9_.-]+\.png$/i;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendError(res, status, message) {
  json(res, status, { error: message });
}

async function readBody(req, limit = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function atomicWriteFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(filePath, { force: true });
    await fs.rename(tmp, filePath);
    void err;
  }
}

async function atomicWriteJson(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWriteFile(filePath, payload);
}

function emptyRegistry() {
  return {
    schemaVersion: 1,
    activeProjectId: null,
    projects: [],
  };
}

async function loadRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects)) {
      return emptyRegistry();
    }
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

async function saveRegistry(registry) {
  await atomicWriteJson(REGISTRY_PATH, registry);
}

function defaultProject(id, label) {
  return {
    schemaVersion: 1,
    id,
    label,
    kind: "video_sequence",
    source: {
      filename: "",
      width: 0,
      height: 0,
      durationSec: 0,
    },
    extract: {
      crop: { x: 0, y: 0, w: 1, h: 1 },
      startSec: 0,
      endSec: 0,
      fps: 20,
    },
    frames: [],
    editConfirmed: false,
    export: {
      format: "spritesheet",
      cell: { w: 256, h: 256 },
      scale: { x: 0.2, y: 0.2 },
      offset: { x: 0, y: 0 },
      fit: "contain",
      smoothing: "smooth",
      fill: "transparent",
      fillColor: [0, 0, 0],
      atlasSize: 2048,
      padding: 0,
      zipPrefix: "",
    },
  };
}

function assertId(id) {
  if (!id || !ID_RE.test(id)) {
    throw Object.assign(new Error("非法工程 id"), { status: 400 });
  }
  return id;
}

function framePath(projectId, file) {
  if (!FRAME_FILE_RE.test(file)) {
    throw Object.assign(new Error("非法帧文件名"), { status: 400 });
  }
  return path.join(WORKSPACE_DIR, projectId, "frames", file);
}

function projectJsonPath(projectId) {
  return path.join(PROJECTS_DIR, projectId, "project.json");
}

async function loadLastPack() {
  try {
    const parsed = JSON.parse(await fs.readFile(LAST_PACK_PATH, "utf8"));
    if (parsed && typeof parsed.path === "string") return parsed;
  } catch {
    /* 还没有保存过 */
  }
  return { path: "", dir: "" };
}

async function saveLastPack(filePath) {
  const record = { path: filePath, dir: path.dirname(filePath) };
  await atomicWriteJson(LAST_PACK_PATH, record);
  return record;
}

function normalizePackPath(filePath) {
  const abs = path.resolve(String(filePath || "").replace(/^["']+|["']+$/g, "").trim());
  if (/\.zip$/i.test(abs)) return abs;
  if (/\.vsp$/i.test(abs)) return `${abs}.zip`;
  return `${abs}.vsp.zip`;
}

function assertPackPath(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw Object.assign(new Error("缺少文件路径"), { status: 400 });
  }
  const abs = normalizePackPath(filePath);
  if (!/^[A-Za-z]:[\\/]/.test(abs) && !abs.startsWith("\\\\")) {
    throw Object.assign(new Error("只接受本机绝对路径"), { status: 400 });
  }
  if (!/\.zip$/i.test(abs)) {
    throw Object.assign(new Error("工程文件必须是 .zip / .vsp.zip"), { status: 400 });
  }
  return abs;
}

async function agentLog(hypothesisId, message, data) {
  // #region agent log
  try {
    await fs.appendFile(
      path.join(ROOT, ".cursor", "debug-360abd.log"),
      `${JSON.stringify({
        sessionId: "360abd",
        runId: "post-fix",
        hypothesisId,
        location: "server/index.mjs",
        message,
        data,
        timestamp: Date.now(),
      })}\n`,
    );
  } catch {
    /* ignore */
  }
  // #endregion
}

async function handleApi(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] !== "api") {
    return false;
  }

  try {
    if (req.method === "GET" && parts.length === 2 && parts[1] === "health") {
      json(res, 200, { ok: true, dialogs: true });
      return true;
    }

    if (req.method === "GET" && parts.length === 2 && parts[1] === "registry") {
      json(res, 200, await loadRegistry());
      return true;
    }

    if (req.method === "GET" && parts.length === 2 && parts[1] === "last-project-file") {
      json(res, 200, await loadLastPack());
      return true;
    }

    if (req.method === "POST" && parts.length === 3 && parts[1] === "dialogs" && parts[2] === "save") {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8") || "{}");
      const last = await loadLastPack();
      const picked = await showSaveDialog({
        fileName: String(body.suggestedName || "未命名序列.vsp.zip"),
        initialDir: last.dir || "",
      });
      if (!picked) {
        json(res, 200, { canceled: true, ...last });
        return true;
      }
      const abs = assertPackPath(picked);
      await agentLog("K", "save dialog path", { raw: picked, abs });
      json(res, 200, { canceled: false, ...(await saveLastPack(abs)) });
      return true;
    }

    if (req.method === "POST" && parts.length === 3 && parts[1] === "dialogs" && parts[2] === "open") {
      const last = await loadLastPack();
      const picked = await showOpenDialog({ initialDir: last.dir || "" });
      if (!picked) {
        json(res, 200, { canceled: true, dir: last.dir || "" });
        return true;
      }
      const abs = assertPackPath(picked);
      json(res, 200, { canceled: false, ...(await saveLastPack(abs)) });
      return true;
    }

    if (parts.length === 2 && parts[1] === "project-pack") {
      const packPath = assertPackPath(url.searchParams.get("path") || "");
      if (req.method === "PUT") {
        const buf = await readBody(req);
        await atomicWriteFile(packPath, buf);
        json(res, 200, await saveLastPack(packPath));
        return true;
      }
      if (req.method === "GET") {
        const buf = await fs.readFile(packPath);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Cache-Control": "no-store",
          "Content-Length": buf.length,
        });
        res.end(buf);
        return true;
      }
    }

    if (req.method === "POST" && parts.length === 2 && parts[1] === "projects") {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8") || "{}");
      const registry = await loadRegistry();
      const id = assertId(body.id || `seq_${Date.now()}`);
      if (registry.projects.some((p) => p.id === id)) {
        sendError(res, 409, "工程 id 已存在");
        return true;
      }
      const label = String(body.label || id);
      const project = defaultProject(id, label);
      const entry = {
        id,
        label,
        kind: "video_sequence",
        dataDir: `data/projects/${id}`,
        workspaceDir: `workspace/projects/${id}`,
      };
      await fs.mkdir(path.join(PROJECTS_DIR, id), { recursive: true });
      await fs.mkdir(path.join(WORKSPACE_DIR, id, "frames"), { recursive: true });
      await atomicWriteJson(projectJsonPath(id), project);
      registry.projects.push(entry);
      registry.activeProjectId = id;
      await saveRegistry(registry);
      json(res, 201, project);
      return true;
    }

    if (parts[1] === "projects" && parts[2]) {
      const id = assertId(parts[2]);

      if (req.method === "GET" && parts.length === 3) {
        try {
          const raw = await fs.readFile(projectJsonPath(id), "utf8");
          json(res, 200, JSON.parse(raw));
        } catch {
          sendError(res, 404, "工程不存在");
        }
        return true;
      }

      if (req.method === "PUT" && parts.length === 3) {
        const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString("utf8"));
        if (!body || body.kind !== "video_sequence" || body.schemaVersion !== 1) {
          sendError(res, 400, "工程 kind 必须是 video_sequence，schemaVersion 必须是 1");
          return true;
        }
        body.id = id;
        await fs.mkdir(path.join(PROJECTS_DIR, id), { recursive: true });
        await fs.mkdir(path.join(WORKSPACE_DIR, id, "frames"), { recursive: true });
        await atomicWriteJson(projectJsonPath(id), body);
        const registry = await loadRegistry();
        const entry = {
          id,
          label: body.label || id,
          kind: "video_sequence",
          dataDir: `data/projects/${id}`,
          workspaceDir: `workspace/projects/${id}`,
        };
        const idx = registry.projects.findIndex((p) => p.id === id);
        if (idx >= 0) registry.projects[idx] = entry;
        else registry.projects.push(entry);
        registry.activeProjectId = id;
        await saveRegistry(registry);
        json(res, 200, body);
        return true;
      }

      if (parts[3] === "frames" && parts.length === 4 && req.method === "DELETE") {
        const dir = path.join(WORKSPACE_DIR, id, "frames");
        await fs.rm(dir, { recursive: true, force: true });
        await fs.mkdir(dir, { recursive: true });
        json(res, 200, { ok: true });
        return true;
      }

      if (parts[3] === "frames" && parts[4]) {
        const file = parts[4];
        const abs = framePath(id, file);

        if (req.method === "GET") {
          try {
            const buf = await fs.readFile(abs);
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Cache-Control": "no-store",
              "Content-Length": buf.length,
            });
            res.end(buf);
          } catch {
            sendError(res, 404, "帧不存在");
          }
          return true;
        }

        if (req.method === "PUT") {
          const buf = await readBody(req);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          const tmp = `${abs}.tmp`;
          await fs.writeFile(tmp, buf);
          try {
            await fs.rename(tmp, abs);
          } catch {
            await fs.rm(abs, { force: true });
            await fs.rename(tmp, abs);
          }
          json(res, 200, { ok: true, file: `workspace/projects/${id}/frames/${file}` });
          return true;
        }

        if (req.method === "DELETE") {
          await fs.rm(abs, { force: true });
          json(res, 200, { ok: true });
          return true;
        }
      }
    }

    sendError(res, 404, "未知接口");
  } catch (err) {
    const status = err?.status || 500;
    sendError(res, status, err?.message || "服务器错误");
  }
  return true;
}

async function start() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  if (!(await fs.stat(REGISTRY_PATH).catch(() => null))) {
    await saveRegistry(emptyRegistry());
  }

  const server = http.createServer(async (req, res) => {
    if (req.url && req.url.startsWith("/api/")) {
      const handled = await handleApi(req, res);
      if (handled) return;
    }
    vite.middlewares(req, res);
  });

  const vite = await createViteServer({
    configFile: path.join(ROOT, "vite.config.ts"),
    server: {
      middlewareMode: true,
      hmr: { server },
    },
    appType: "spa",
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`883 Sequence Tool  http://127.0.0.1:${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
