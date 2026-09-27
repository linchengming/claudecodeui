@echo off
chcp 65001 >nul
rem The service runs in session 0 via the S4U scheduled task, so stopping it needs elevation
fltmc >nul 2>&1
if errorlevel 1 (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
setlocal enabledelayedexpansion

cd /d "%~dp0.."
rem Portable Node used on machines whose system Node is too old for the build
if exist "G:\CommonProject\tools\node-v24.21.0-win-x64\node.exe" set "PATH=G:\CommonProject\tools\node-v24.21.0-win-x64;%PATH%"
echo ========================================
echo CloudCLI 更新并重启
echo ========================================
echo.

echo [1/4] 拉取最新代码...
git -c http.proxy=http://127.0.0.1:10808 pull --ff-only
if errorlevel 1 (
    echo 错误: git pull 失败
    pause
    exit /b 1
)
echo.

echo [2/4] 安装依赖...
set HTTPS_PROXY=http://127.0.0.1:10808
set HTTP_PROXY=http://127.0.0.1:10808
npm install
if errorlevel 1 (
    echo 错误: npm install 失败
    pause
    exit /b 1
)
echo.

echo [3/4] 编译项目...
npm run build
if errorlevel 1 (
    echo 错误: npm run build 失败
    pause
    exit /b 1
)
echo.

echo [4/4] 重启服务...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$port = (Get-Content .env | Where-Object { $_ -match '^SERVER_PORT=' }) -replace 'SERVER_PORT=',''; ^
     Stop-ScheduledTask -TaskName CloudCLI -ErrorAction SilentlyContinue; ^
     Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dist-server' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; ^
     [Threading.Thread]::Sleep(1500); ^
     Start-ScheduledTask -TaskName CloudCLI; ^
     $deadline=(Get-Date).AddSeconds(25); ^
     do { $l = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if (-not $l) { [Threading.Thread]::Sleep(1000) } } while (-not $l -and (Get-Date) -lt $deadline); ^
     if ($l) { Write-Host \"服务已启动: 端口 $port\" -ForegroundColor Green } else { Write-Host '警告: 服务未能在 25 秒内启动' -ForegroundColor Yellow }"

echo.
echo ========================================
echo 完成！
echo ========================================
pause
