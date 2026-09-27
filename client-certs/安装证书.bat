@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo ============================================================
echo   CloudCLI 证书安装
echo ============================================================
echo.

if not exist "cloudcli-ca.crt" goto :missing
if not exist "cloudcli-device.p12" goto :missing

echo [1/2] 信任 CloudCLI CA（消除浏览器"不安全"警告）
echo       稍后会弹出安全警告框，请点"是"。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Import-Certificate -FilePath 'cloudcli-ca.crt' -CertStoreLocation Cert:\CurrentUser\Root -ErrorAction Stop | Out-Null; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 goto :failed
echo       完成。
echo.

echo [2/2] 导入设备证书（访问 CloudCLI 的通行证）
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $p = ConvertTo-SecureString -String 'cloudcli' -AsPlainText -Force; Import-PfxCertificate -FilePath 'cloudcli-device.p12' -CertStoreLocation Cert:\CurrentUser\My -Password $p -ErrorAction Stop | Out-Null; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 goto :failed
echo       完成。
echo.

echo ============================================================
echo   安装成功
echo ============================================================
echo.
echo   请完全关闭浏览器后重新打开，再访问 CloudCLI。
echo   首次访问会弹出证书选择框，选 cloudcli-device 并确认。
echo.
goto :end

:missing
echo [错误] 找不到证书文件，请确认本 bat 与以下文件在同一目录：
echo        cloudcli-ca.crt
echo        cloudcli-device.p12
echo.
goto :end

:failed
echo.
echo [错误] 安装失败，请查看上方的错误信息。
echo        若提示拒绝访问，请右键本文件选"以管理员身份运行"。
echo.

:end
pause
endlocal
