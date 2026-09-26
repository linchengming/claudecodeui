@echo off
rem 开机 S4U 任务在用户 profile 加载前运行，USERPROFILE 会回落到 C:\Users\Default，
rem 导致 ~/.cloudcli/auth.db 与 ~/.claude 全部指错位置。这里钉死真实 profile 与用户 PATH。
set "USERPROFILE=C:\Users\Administrator"
set "HOMEDRIVE=C:"
set "HOMEPATH=\Users\Administrator"
set "APPDATA=C:\Users\Administrator\AppData\Roaming"
set "LOCALAPPDATA=C:\Users\Administrator\AppData\Local"
set "PATH=C:\Users\Administrator\.local\bin;C:\Users\Administrator\AppData\Roaming\npm;C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" dist-server\server\index.js
