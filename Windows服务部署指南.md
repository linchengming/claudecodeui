# CloudCLI Windows 开机自启部署指南

## 方案：Windows 任务计划程序 + S4U 模式

使用 Windows 自带的任务计划程序，配合 S4U (Schedule As User) 登录类型，实现：
- ✅ 系统启动时自动运行（开机就启动，不需要用户登录）
- ✅ 无需存储密码（S4U 模式不要求用户密码）
- ✅ 以当前用户身份运行（可访问用户目录下的 Claude 配置）
- ✅ 进程崩溃自动重启（最多 3 次，间隔 1 分钟）

## 前置条件

1. **Node.js 已安装**：确认 `C:\Program Files\nodejs\node.exe` 存在
2. **CloudCLI 已构建**：在项目目录执行 `npm run build`，生成 `dist/` 与 `dist-server/`
3. **.env 配置已完成**：至少配置 `SERVER_PORT`、`HOST`、`WORKSPACES_ROOT`、`TOTP_SECRET`

> **注意**：服务运行的是 `dist-server/` 里的编译产物，不是 `server/` 源码。每次 `git pull` 拉到新代码后必须重新 `npm run build`，再重启任务，否则新功能（如 2FA）不会生效。

## 部署步骤

### 1. 创建计划任务

在 CloudCLI 项目目录下运行（需要**管理员权限**的 PowerShell）：

```powershell
# 切换到 CloudCLI 目录
cd I:\CommonProject\claudecodeui

# 创建任务（替换路径为你的实际安装路径）
$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "dist-server/server/index.js" -WorkingDirectory "I:\CommonProject\claudecodeui"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "CloudCLI" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "CloudCLI Web UI for Claude Code CLI"
```

### 2. 验证任务配置

```powershell
Get-ScheduledTask -TaskName "CloudCLI" | Select-Object TaskName, State, @{N='Trigger';E={($_.Triggers | ForEach-Object {$_.CimClass.CimClassName}) -join ', '}}, @{N='LogonType';E={$_.Principal.LogonType}}
```

期望输出：
```
TaskName  : CloudCLI
State     : Ready
Trigger   : MSFT_TaskBootTrigger
LogonType : S4U
```

### 3. 手动测试启动

```powershell
Start-ScheduledTask -TaskName "CloudCLI"
Start-Sleep -Seconds 5
curl.exe http://localhost:33001
```

看到 `<!doctype html>` 和 `<title>CloudCLI UI</title>` 说明服务正常。

### 4. 验证配置细节

确认以下关键配置：

| 配置项 | 值 | 说明 |
|--------|-----|------|
| **触发器** | 系统启动时（AtStartup） | 开机就启动，不需要用户登录 |
| **登录类型** | S4U | 不管用户是否登录都能运行，且不存储密码 |
| **保留** | 最高权限、无时限、失败等同 | 无时限（不会被 72 小时自动杀死），崩溃重启 3 次 |
| **执行时限** | 0（无限制） | 服务进程不会因超时被强制终止 |

## 验证服务运行

```powershell
# 1. 检查任务最后运行时间和结果
Get-ScheduledTask -TaskName "CloudCLI" | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns

# 2. 检查进程是否存在
Get-Process -Name node | Where-Object {(Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like "*claudecodeui*"}

# 3. 检查服务端口
Test-NetConnection -ComputerName localhost -Port 33001

# 4. 验证 HTTP 响应
curl.exe http://192.168.66.100:33001
```

## 管理命令

```powershell
# 更新代码后重新部署（重新构建 + 重启）
cd I:\CommonProject\claudecodeui
git pull
npm run build
Stop-ScheduledTask -TaskName "CloudCLI"
Get-Process -Name node | Where-Object {(Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like "*dist-server/server/index.js*"} | Stop-Process -Force
Start-ScheduledTask -TaskName "CloudCLI"

# 确认 2FA 已开启（totpRequired 应为 true）
curl.exe http://localhost:33003/api/auth/status

# 启动服务
Start-ScheduledTask -TaskName "CloudCLI"

# 停止服务（需要先找到进程 ID）
Get-Process -Name node | Where-Object {(Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like "*claudecodeui*"} | Stop-Process -Force

# 查看任务状态
Get-ScheduledTask -TaskName "CloudCLI"

# 删除任务
Unregister-ScheduledTask -TaskName "CloudCLI" -Confirm:$false
```

## 为什么不用 NSSM/真正的 Windows 服务？

你的另一台机器测试的结论：

> **NSSM/真正的服务已满足"不登录就能启动"，而且仍然是用户身份运行，且不需要密码**

实际上 S4U 模式已经达到同样效果：
- ✅ 系统启动时自动运行（不需要登录）
- ✅ 以用户身份运行（能直接读取 `~\.claude`）
- ✅ 不存储密码

选择任务计划程序而非 NSSM 的原因：
1. **无需第三方工具**：Windows 自带，不需要下载 NSSM
2. **配置透明**：PowerShell 命令可读性强，易于版本控制
3. **权限清晰**：S4U 模式运行在 Limited 权限，减少攻击面

但如果你需要更强的服务管理功能（如依赖其他服务、详细日志、GUI 配置），可以用 NSSM。

## CloudCLI 用到的路径

服务启动后会访问以下路径（需确保 S4U 用户身份有权限）：

| 路径 | 用途 |
|------|------|
| `%USERPROFILE%\.cloudcli\auth.db` | CloudCLI 账号数据库 |
| `%USERPROFILE%\.cloudcli\local-server.json` | 服务器配置 |
| `%USERPROFILE%\.claude\projects\` | Claude 会话历史（如果使用 Claude SDK） |
| `%USERPROFILE%\.claude\settings.json` | Claude Token 配置 |
| `WORKSPACES_ROOT` 下的所有目录 | 工作区项目文件 |

## 故障排查

### 服务未启动

```powershell
# 查看任务历史记录（需要管理员权限）
Get-WinEvent -LogName Microsoft-Windows-TaskScheduler/Operational -MaxEvents 50 | Where-Object {$_.Message -like "*CloudCLI*"}
```

### 环境变量未加载

任务计划程序启动的进程**不会加载用户的 PowerShell Profile**，`.env` 文件必须放在正确位置：
```
I:\CommonProject\claudecodeui\.env
```

### 端口被占用

```powershell
Get-NetTCPConnection -LocalPort 33001 -ErrorAction SilentlyContinue
```

如果被占用，修改 `.env` 里的 `SERVER_PORT` 后重启任务。

---

**测试通过环境**：
- Windows 11
- Node.js v24.12.0
- CloudCLI v1.37.3
- 用户：非管理员账号
- 部署时间：2026-09-26
