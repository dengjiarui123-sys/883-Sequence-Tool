import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "server", "birefnet_worker.py");
const VENV_DIR = path.join(ROOT, "workspace", ".birefnet-venv");
const DOWNLOAD_MS = 15 * 60 * 1000;
const INSTALL_MS = 45 * 60 * 1000;
const INFER_MS = 3 * 60 * 1000;
const STATUS_MS = 120 * 1000;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

let pythonCmd = null;
let workerChild = null;
let workerBuf = "";
let rpcId = 0;
const pending = new Map();
let installBusy = false;
let statusCache = null;

function venvPythonPath() {
  return process.platform === "win32"
    ? path.join(VENV_DIR, "Scripts", "python.exe")
    : path.join(VENV_DIR, "bin", "python");
}

function probePython(cmd) {
  try {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "-c", "print(1)"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    return r.status === 0 && String(r.stdout || "").trim() === "1";
  } catch {
    return false;
  }
}

function findBasePython() {
  const extra = process.env.BIREFNET_PYTHON ? [[process.env.BIREFNET_PYTHON]] : [];
  const candidates = [...extra, ["python"], ["py", "-3"], ["python3"]];
  for (const cmd of candidates) {
    if (probePython(cmd)) return cmd;
  }
  return null;
}

function findPython() {
  if (pythonCmd) return pythonCmd;
  const venvPy = venvPythonPath();
  if (existsSync(venvPy) && probePython([venvPy])) {
    pythonCmd = [venvPy];
    return pythonCmd;
  }
  const base = findBasePython();
  if (base) pythonCmd = base;
  return pythonCmd;
}

function stopWorker() {
  if (!workerChild) return;
  try {
    workerChild.kill();
  } catch {
    /* ignore */
  }
  workerChild = null;
  rejectAll(new Error("BiRefNet worker 已重启"));
}

function runSpawn(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("超时"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

async function ensureVenv() {
  const venvPy = venvPythonPath();
  if (existsSync(venvPy) && probePython([venvPy])) {
    pythonCmd = [venvPy];
    return;
  }
  const base = findBasePython();
  if (!base) throw new Error("未安装 Python");
  await fs.mkdir(path.dirname(VENV_DIR), { recursive: true });
  const made = await runSpawn(base, ["-m", "venv", VENV_DIR], 120000);
  if (made.status !== 0 || !existsSync(venvPy)) {
    throw new Error(made.stderr || made.stdout || "无法创建虚拟环境");
  }
  pythonCmd = [venvPy];
}

function noPythonStatus() {
  return {
    python: false,
    torch: false,
    cuda: false,
    model: false,
    ready: false,
    message: "未安装 Python",
    modelUrl: "https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting",
  };
}

function streamWorker(args, timeoutMs, onLine) {
  const py = findPython();
  if (!py) return Promise.reject(new Error("未安装 Python"));
  return new Promise((resolve, reject) => {
    const child = spawn(py[0], [...py.slice(1), "-u", "-B", WORKER, ...args], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
      },
    });
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("超时"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf.trim());
      resolve(code);
    });
  });
}

function runWorkerOnce(args, timeoutMs) {
  const py = findPython();
  if (!py) {
    return Promise.resolve({ status: 0, stdout: JSON.stringify(noPythonStatus()), stderr: "" });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(py[0], [...py.slice(1), "-B", WORKER, ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("超时"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function parseLastJson(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function rejectAll(err) {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(err);
  }
  pending.clear();
}

function ensureWorker() {
  const py = findPython();
  if (!py) throw new Error("未安装 Python");
  if (workerChild && !workerChild.killed) return workerChild;
  workerBuf = "";
  const child = spawn(py[0], [...py.slice(1), "-B", WORKER, "serve"], {
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      HF_HUB_OFFLINE: "1",
    },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    workerBuf += chunk;
    let idx;
    while ((idx = workerBuf.indexOf("\n")) >= 0) {
      const line = workerBuf.slice(0, idx).trim();
      workerBuf = workerBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const job = pending.get(msg.id);
      if (!job) continue;
      pending.delete(msg.id);
      clearTimeout(job.timer);
      if (msg.ok) job.resolve(msg);
      else job.reject(new Error(msg.error || "推理失败"));
    }
  });
  child.on("error", (err) => {
    workerChild = null;
    rejectAll(err);
  });
  child.on("close", () => {
    workerChild = null;
    rejectAll(new Error("BiRefNet worker 已退出"));
  });
  workerChild = child;
  return child;
}

function workerRpc(payload, timeoutMs = INFER_MS) {
  const child = ensureWorker();
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      workerChild = null;
      reject(new Error("超时"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
  });
}

export async function handleMatteApi(req, res, parts, readBody) {
  if (parts[0] !== "api" || parts[1] !== "matte") return false;

  if (req.method === "GET" && parts.length === 3 && parts[2] === "status") {
    const py = findPython();
    if (statusCache?.ready) {
      json(res, 200, statusCache);
      return true;
    }
    try {
      const ran = await runWorkerOnce(["status"], STATUS_MS);
      const body = parseLastJson(ran.stdout) || noPythonStatus();
      if (body.ready) statusCache = body;
      if (!findPython()) json(res, 200, noPythonStatus());
      else json(res, 200, body);
    } catch (err) {
      const timedOut = err?.message === "超时";
      json(res, 200, timedOut
        ? {
            python: Boolean(py),
            torch: false,
            cuda: false,
            model: false,
            ready: false,
            message: "检查超时",
            error: "检查超时",
            modelUrl: "https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting",
          }
        : { ...noPythonStatus(), message: err?.message || "未安装" });
    }
    return true;
  }

  if (req.method === "POST" && parts.length === 3 && parts[2] === "download") {
    try {
      const ran = await runWorkerOnce(["download"], DOWNLOAD_MS);
      const body = parseLastJson(ran.stdout);
      if (!body) {
        json(res, 500, { error: ran.stderr || "下载失败" });
        return true;
      }
      if (body.ok === false) json(res, 400, { error: body.error || body.message || "下载失败", ...body });
      else json(res, 200, body);
    } catch (err) {
      json(res, 500, { error: err?.message || "下载失败" });
    }
    return true;
  }

  if (req.method === "POST" && parts.length === 3 && parts[2] === "install") {
    if (installBusy) {
      json(res, 409, { ok: false, error: "正在安装中，请看编辑器里的进度" });
      return true;
    }
    installBusy = true;
    try {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      const send = (obj) => {
        res.write(`${JSON.stringify(obj)}\n`);
      };
      send({ phase: "status", line: "已开始下载安装…", percent: 1 });
      stopWorker();
      pythonCmd = null;
      statusCache = null;
      await ensureVenv();
      send({ phase: "status", line: "虚拟环境已就绪，开始安装依赖…", percent: 4 });
      await streamWorker(["install"], INSTALL_MS, (line) => {
        try {
          send(JSON.parse(line));
        } catch {
          send({ phase: "pip", line: String(line).slice(-240) });
        }
      });
      res.end();
    } catch (err) {
      try {
        if (!res.headersSent) json(res, 500, { error: err?.message || "安装失败" });
        else {
          res.write(`${JSON.stringify({ ok: false, error: err?.message || "安装失败" })}\n`);
          res.end();
        }
      } catch {
        /* ignore */
      }
    } finally {
      installBusy = false;
    }
    return true;
  }

  if (req.method === "POST" && parts.length === 2) {
    let inFile = "";
    let outFile = "";
    try {
      if (!findPython()) {
        json(res, 400, { error: "未安装 Python" });
        return true;
      }
      const buf = await readBody(req);
      if (!buf.length) {
        json(res, 400, { error: "缺少原图" });
        return true;
      }
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      inFile = path.join(os.tmpdir(), `vsp-matte-in-${stamp}.png`);
      outFile = path.join(os.tmpdir(), `vsp-matte-out-${stamp}.png`);
      await fs.writeFile(inFile, buf);
      const result = await workerRpc({ cmd: "infer", input: inFile, output: outFile }, INFER_MS);
      const alpha = await fs.readFile(outFile);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "Content-Length": alpha.length,
        "X-Matte-Device": String(result.device || ""),
        "X-Matte-Fallback": result.cudaFallback ? "1" : "0",
      });
      res.end(alpha);
    } catch (err) {
      json(res, 500, { error: err?.message || "推理失败" });
    } finally {
      if (inFile) await fs.rm(inFile, { force: true }).catch(() => {});
      if (outFile) await fs.rm(outFile, { force: true }).catch(() => {});
    }
    return true;
  }

  return false;
}
