@echo off
chcp 65001 >nul
rem Relaunch as administrator if needed (UAC prompt)
fltmc >nul 2>&1
if errorlevel 1 (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo 正在设置 CloudCLI 开机自启（不用登录也会启动），请稍等...
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "G:\CommonProject\tools\cloudcli\install-task.ps1"
echo.
echo 最后一行是 OK 就成功了；是 FAILED 或红字报错就截图给我。
echo 按任意键关闭...
pause >nul
