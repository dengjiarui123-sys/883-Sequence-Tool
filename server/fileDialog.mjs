import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function psQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function runPs1(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: false },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(err.trim() || `对话框退出码 ${code}`));
      else resolve(out.replace(/^\uFEFF/, "").trim());
    });
  });
}

async function withTempScript(name, body) {
  const scriptPath = path.join(os.tmpdir(), `${name}-${process.pid}.ps1`);
  await fs.writeFile(scriptPath, `\uFEFF${body}\n`, "utf8");
  try {
    return await runPs1(scriptPath);
  } finally {
    await fs.rm(scriptPath, { force: true });
  }
}

export async function showSaveDialog({ fileName, initialDir, title, filter, defaultExt }) {
  const init = initialDir ? `$d.InitialDirectory = ${psQuote(initialDir)}` : "";
  return withTempScript(
    "vsp-save",
    `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = ${psQuote(title || "保存工程")}
$d.Filter = ${psQuote(filter || "工程包 (*.zip)|*.zip")}
$d.DefaultExt = ${psQuote(defaultExt || "zip")}
$d.AddExtension = $true
$d.OverwritePrompt = $true
$d.FileName = ${psQuote(fileName)}
${init}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(0, 0)
$r = $d.ShowDialog($owner)
$owner.Dispose()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }`,
  );
}

export async function showOpenDialog({ initialDir }) {
  const init = initialDir ? `$d.InitialDirectory = ${psQuote(initialDir)}` : "";
  return withTempScript(
    "vsp-open",
    `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '打开工程'
$d.Filter = '工程包 (*.zip)|*.zip|所有文件 (*.*)|*.*'
$d.CheckFileExists = $true
$d.Multiselect = $false
${init}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(0, 0)
$r = $d.ShowDialog($owner)
$owner.Dispose()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }`,
  );
}
