# 883 Sequence Tool

本地网页工作台：从绿幕 / 纯色底 AI 视频抽出序列帧，抠透明、整理工作集，导出 ZIP 散图或等大格 Sprite Sheet。

后续接手（含网页版、与 FrameTest 的边界）先读 [docs/项目说明.md](docs/项目说明.md)。

## 启动

双击仓库里的 **`启动.bat`**（或 `start.bat`）。

- 第一次：若没有 Node.js 会尝试自动安装，并执行 `npm install`，然后打开浏览器。
- 之后：检测到环境已就绪就直接运行，浏览器打开 http://127.0.0.1:8788
- 若已经在跑，再点一次只会打开浏览器，不会重复启动。
- 用完后关掉那个黑色窗口即可停止服务。

命令行等价于：

```bash
npm install
npm run dev
```
