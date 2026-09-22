"""BiRefNet HR-matting worker. Optional; chroma key works without it."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import traceback

REPO = "ZhengPeng7/BiRefNet_HR-matting"
REVISION = "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f"
MODEL_URL = f"https://huggingface.co/{REPO}"
TORCH_INDEX = os.environ.get("BIREFNET_TORCH_INDEX", "https://download.pytorch.org/whl/cu128")
NEEDED = ["torch", "torchvision", "PIL", "transformers", "huggingface_hub", "timm", "einops"]
PIP_REST = ["transformers", "huggingface_hub", "timm", "einops", "pillow", "kornia"]

_model = None
_device = "cpu"
_cuda_fallback = False
_out_lock = threading.Lock()
_PIP_PCT = re.compile(r"(?<!\d)(\d{1,3})\s*%")
_PIP_PAIR = re.compile(
    r"([\d.]+)\s*(kB|KiB|MB|MiB|GB|GiB)\s*/\s*([\d.]+)\s*(kB|KiB|MB|MiB|GB|GiB)",
    re.I,
)


def _reply(obj: dict) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def _missing_imports() -> list[str]:
    missing: list[str] = []
    for name in NEEDED:
        mod = "PIL" if name == "PIL" else name
        try:
            __import__(mod)
        except Exception:
            missing.append(name)
    return missing


def _model_cached() -> bool:
    try:
        from huggingface_hub import try_to_load_from_cache

        path = try_to_load_from_cache(REPO, "model.safetensors", revision=REVISION)
        return isinstance(path, (str, os.PathLike))
    except Exception:
        return False


def status() -> dict:
    info = {
        "python": True,
        "torch": False,
        "cuda": False,
        "model": False,
        "ready": False,
        "message": "未安装",
        "missing": _missing_imports(),
        "modelUrl": MODEL_URL,
    }
    try:
        import torch

        info["torch"] = True
        info["cuda"] = bool(torch.cuda.is_available())
    except Exception:
        info["message"] = "未安装 PyTorch"
        return info
    info["model"] = _model_cached()
    if info["missing"]:
        info["message"] = "未安装：" + ", ".join(info["missing"])
        return info
    if not info["model"]:
        info["message"] = "未下载模型"
        return info
    info["ready"] = True
    info["message"] = "就绪"
    return info


def _parse_pip_line(text: str) -> tuple[str, int | None]:
    pair = _PIP_PAIR.search(text)
    pct_m = _PIP_PCT.search(text)
    pct = int(pct_m.group(1)) if pct_m and 0 <= int(pct_m.group(1)) <= 100 else None
    if pair:
        line = f"已下载 {pair.group(1)} {pair.group(2)} / {pair.group(3)} {pair.group(4)}"
        if pct is not None:
            line += f"（{pct}%）"
        return line, pct
    return text[-240:], pct


def _pip(args: list[str]) -> None:
    cmd = [sys.executable, "-u", "-m", "pip", "install", "--upgrade", "--progress-bar", "on", *args]
    _reply({"phase": "pip", "line": "开始安装：" + " ".join(args[:2]), "percent": 5})
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        env={**os.environ, "PYTHONUNBUFFERED": "1", "PIP_PROGRESS_BAR": "on"},
    )
    assert proc.stdout is not None
    stop = threading.Event()
    last_emit = [0.0]
    last = ""

    def emit(payload: dict, force: bool = False) -> None:
        now = time.time()
        if not force and now - last_emit[0] < 0.25:
            return
        last_emit[0] = now
        _reply(payload)

    def beat() -> None:
        n = 0
        while not stop.wait(1.0):
            n += 1
            emit(
                {
                    "phase": "heartbeat",
                    "line": f"仍在下载安装，已进行 {n} 秒（合计约 3.3GB：PyTorch 2.7GB + 其余包 0.2GB + 模型 440MB）",
                    "elapsed": n,
                },
                force=True,
            )

    thr = threading.Thread(target=beat, daemon=True)
    thr.start()
    buf = b""
    try:
        while True:
            chunk = proc.stdout.read(256)
            if not chunk:
                break
            buf += chunk
            while True:
                npos = buf.find(b"\n")
                rpos = buf.find(b"\r")
                idxs = [i for i in (npos, rpos) if i >= 0]
                if not idxs:
                    break
                i = min(idxs)
                sep = buf[i : i + 1]
                piece = buf[:i]
                buf = buf[i + 1 :]
                if sep == b"\r" and buf[:1] == b"\n":
                    buf = buf[1:]
                text = piece.decode("utf-8", "replace").strip()
                if not text:
                    continue
                last = text
                line, pct = _parse_pip_line(text)
                payload = {"phase": "pip", "line": line}
                if pct is not None:
                    payload["percent"] = 5 + int(pct * 0.7)
                emit(payload, force=pct is not None)
        if buf.strip():
            last = buf.decode("utf-8", "replace").strip()
            line, pct = _parse_pip_line(last)
            payload = {"phase": "pip", "line": line}
            if pct is not None:
                payload["percent"] = 5 + int(pct * 0.7)
            emit(payload, force=True)
    finally:
        stop.set()
        try:
            proc.stdout.close()
        except Exception:
            pass
        thr.join(timeout=2)
    code = proc.wait()
    if code != 0:
        raise RuntimeError(last[-1800:] or "pip 失败")


def install() -> dict:
    missing = set(_missing_imports())
    _reply({"phase": "status", "line": "已开始下载安装（PyTorch 体积较大，请稍候）", "percent": 2})
    try:
        if "torch" in missing or "torchvision" in missing:
            try:
                _pip(["torch", "torchvision", "--index-url", TORCH_INDEX])
            except Exception:
                _pip(["torch", "torchvision"])
        _pip(PIP_REST)
    except Exception as exc:
        st = status()
        st["ok"] = False
        st["error"] = f"安装依赖失败：{exc}"
        return st
    try:
        _reply({"phase": "model", "line": "正在下载 BiRefNet 模型权重…", "percent": 80})
        return download()
    except Exception as exc:
        st = status()
        st["ok"] = False
        st["error"] = f"下载模型失败：{exc}"
        return st


def download() -> dict:
    missing = _missing_imports()
    if missing:
        return {"ok": False, "error": "未安装：" + ", ".join(missing), **status()}
    from huggingface_hub import snapshot_download

    snapshot_download(REPO, revision=REVISION)
    st = status()
    st["ok"] = bool(st.get("model"))
    if not st["ok"]:
        st["error"] = "下载完成但仍未找到模型文件"
    return st


def _infer_wh(w: int, h: int) -> tuple[int, int]:
    long = max(w, h)
    area = w * h
    side = 1024
    if area > 1024 * 1024:
        side = int(32 * round(math.sqrt(area) / 32))
        side = max(1024, min(2048, side))
    scale = side / long
    nw = max(32, int(round(w * scale / 32) * 32))
    nh = max(32, int(round(h * scale / 32) * 32))
    return nw, nh


def _load_model(force_cpu: bool = False):
    global _model, _device, _cuda_fallback
    import torch
    from transformers import AutoModelForImageSegmentation

    want = "cpu" if force_cpu or not torch.cuda.is_available() else "cuda"
    if _model is not None and _device == want:
        return _model
    if _model is not None:
        try:
            _model.to(want)
            if want == "cuda":
                _model.half()
            else:
                _model.float()
            _device = want
            return _model
        except Exception:
            _model = None

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    model = AutoModelForImageSegmentation.from_pretrained(
        REPO,
        revision=REVISION,
        trust_remote_code=True,
        local_files_only=True,
    )
    model.eval()
    try:
        model.to(want)
        if want == "cuda":
            model.half()
        else:
            model.float()
        _device = want
    except Exception:
        model.to("cpu")
        model.float()
        _device = "cpu"
        _cuda_fallback = True
    _model = model
    return _model


def infer(input_path: str, output_path: str) -> dict:
    global _cuda_fallback
    from PIL import Image
    import torch
    from torchvision import transforms

    image = Image.open(input_path).convert("RGB")
    ow, oh = image.size
    nw, nh = _infer_wh(ow, oh)
    transform = transforms.Compose(
        [
            transforms.Resize((nh, nw)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )

    def run(force_cpu: bool = False):
        model = _load_model(force_cpu=force_cpu)
        tensor = transform(image).unsqueeze(0)
        if _device == "cuda":
            tensor = tensor.to("cuda").half()
        else:
            tensor = tensor.to("cpu").float()
        with torch.no_grad():
            preds = model(tensor)[-1].sigmoid().cpu()
        pred = preds[0].squeeze()
        mask = transforms.ToPILImage()(pred.float()).resize((ow, oh), Image.BILINEAR)
        mask.convert("L").save(output_path)
        return True

    _cuda_fallback = False
    try:
        run(False)
    except Exception as exc:
        if torch.cuda.is_available() and _device != "cpu":
            _cuda_fallback = True
            try:
                run(True)
            except Exception as cpu_exc:
                raise RuntimeError(f"CUDA 失败且 CPU 回退也失败：{cpu_exc}") from cpu_exc
        else:
            raise RuntimeError(str(exc)) from exc
    return {
        "device": _device,
        "cudaFallback": _cuda_fallback,
    }


def serve() -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as exc:
            _reply({"ok": False, "error": f"坏请求：{exc}"})
            continue
        rid = msg.get("id")
        cmd = msg.get("cmd")
        try:
            if cmd == "infer":
                result = infer(msg["input"], msg["output"])
                _reply({"ok": True, "id": rid, **result})
            elif cmd == "status":
                _reply({"ok": True, "id": rid, **status()})
            elif cmd == "ping":
                _reply({"ok": True, "id": rid})
            else:
                _reply({"ok": False, "id": rid, "error": f"未知命令 {cmd}"})
        except Exception as exc:
            _reply({"ok": False, "id": rid, "error": str(exc), "trace": traceback.format_exc()})


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "status":
        _reply(status())
    elif cmd == "download":
        try:
            _reply(download())
        except Exception as exc:
            _reply({"ok": False, "error": str(exc), **status()})
    elif cmd == "install":
        try:
            _reply(install())
        except Exception as exc:
            _reply({"ok": False, "error": str(exc), **status()})
    elif cmd == "serve":
        serve()
    else:
        _reply({"ok": False, "error": f"未知命令 {cmd}"})
        sys.exit(1)
