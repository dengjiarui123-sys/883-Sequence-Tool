@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Video Sequence Packer
chcp 65001 >nul

echo.
echo   Video Sequence Packer
echo   双击启动：缺环境会先安装，装过则直接打开。
echo.

call :refresh_path
call :ensure_node
if errorlevel 1 goto :fail

call :ensure_deps
if errorlevel 1 goto :fail

call :is_running
if not errorlevel 1 (
  echo   已经在运行，正在打开浏览器…
  start "" "http://127.0.0.1:8788"
  echo.
  echo   关掉这个窗口不会停止已运行的程序。
  echo   若要停止，请关掉之前那个黑色启动窗口。
  echo.
  pause
  goto :eof
)

echo   正在启动本地服务…
echo   用完后关闭本窗口即可停止。
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8788"
call npm run dev
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo   启动失败。请把上面的文字截图发给开发者。
echo.
pause
exit /b 1

:refresh_path
set "PATH=%SystemRoot%\system32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0\"
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "PATH=%PATH%;%%B"
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "PATH=%PATH%;%%B"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\node\node.exe" set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"
exit /b 0

:ensure_node
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%V in ('node -v') do echo   Node.js 已就绪  %%V
  exit /b 0
)
echo   未找到 Node.js，正在安装 LTS…
where winget >nul 2>&1
if errorlevel 1 (
  echo   本机没有 winget，无法自动安装。
  echo   请打开 https://nodejs.org/ 安装 LTS 后，再双击本文件。
  start "" "https://nodejs.org/"
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo   自动安装失败。请打开 https://nodejs.org/ 手动安装 LTS。
  start "" "https://nodejs.org/"
  exit /b 1
)
call :refresh_path
where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js 已安装，但当前窗口还读不到。请关掉本窗口后再双击一次。
  exit /b 1
)
for /f "delims=" %%V in ('node -v') do echo   Node.js 已安装  %%V
exit /b 0

:ensure_deps
if exist "node_modules\vite\package.json" if exist "node_modules\fflate\package.json" (
  echo   项目依赖已就绪，跳过安装。
  exit /b 0
)
echo   正在安装项目依赖（只需一次）…
call npm install
if errorlevel 1 (
  echo   npm install 失败。
  exit /b 1
)
echo   依赖安装完成。
exit /b 0

:is_running
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8788/api/health' -TimeoutSec 1; if ($r.Content -match 'ok') { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %ERRORLEVEL%
