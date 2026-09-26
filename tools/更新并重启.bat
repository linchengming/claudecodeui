@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "%~dp0.."
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
call npm.cmd install
if errorlevel 1 (
    echo 错误: npm install 失败
    pause
    exit /b 1
)
echo.

echo [3/4] 编译项目...
call npm.cmd run build
if errorlevel 1 (
    echo 错误: npm run build 失败
    pause
    exit /b 1
)
echo.

echo [4/4] 重启服务...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Stop-ScheduledTask -TaskName CloudCLI -ErrorAction SilentlyContinue; ^
     Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dist-server' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; ^
     [Threading.Thread]::Sleep(1500); ^
     Start-ScheduledTask -TaskName CloudCLI; ^
     $deadline=(Get-Date).AddSeconds(25); ^
     do { $l = Get-NetTCPConnection -LocalPort 33001 -State Listen -ErrorAction SilentlyContinue; if (-not $l) { [Threading.Thread]::Sleep(1000) } } while (-not $l -and (Get-Date) -lt $deadline); ^
     if ($l) { Write-Host '服务已启动: 192.168.1.202:33001' -ForegroundColor Green } else { Write-Host '警告: 服务未能在 25 秒内启动' -ForegroundColor Yellow }"

echo.
echo ========================================
echo 完成！
echo ========================================
pause
