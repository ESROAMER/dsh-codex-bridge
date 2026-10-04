# DSH–Codex Bridge

让 Codex 向正在运行的 DeepSeek Harness 桌面 agent 派发任务，在 DSH 的真实工作区会话中查看实时进度，再由 Codex 回读结果、审查和继续协作。

这是社区项目。初始桥接实现已经在 Windows 的 DSH Desktop `0.2.0-rc.2` 上验证；本次整理的跨电脑安装脚本仍是实验版，需要在另一台电脑验收。不代表所有 DSH 版本兼容。

## 安装方式一：官方“添加插件”入口

1. 先启动 DSH，配置模型账号，并添加要使用的工作区。
2. 打开设置中的“添加插件”，输入本仓库 GitHub 地址，或者下载解压后的本地仓库目录。仓库根目录就是标准插件包。
3. 从本仓库 **Code → Download ZIP** 下载并解压，在解压目录打开 PowerShell，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ConfigureOnly
```

脚本会列出 DSH 已注册工作区，请输入要授权的工作区 ID；多个 ID 用逗号分隔。它会安装 Codex skill，并在本机生成专用令牌，不需要复制浏览器 Cookie，也不输出密钥值。

4. 必要时完全退出并重开 DSH，执行连接检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Check
```

5. 新开 Codex 会话，说：

> 使用 $deepseek-harness，在指定工作区让 DeepSeek 完成这项任务，你负责规划、跟进和审查。

## 安装方式二：脚本一次完成

完全退出 DSH（包括托盘进程），在下载解压的仓库目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本将插件复制到 DSH 用户目录中的持久位置，备份桌面 profile 配置，添加 bundle 和模块目录 junction，随后安装 skill、签发限定工作区令牌。无需管理员权限，不启动另一套 DSH。完成后重开 DSH，再执行 `-Check`。

`ExecutionPolicy Bypass` 只作用于这次 PowerShell 进程，不修改系统执行策略。

## 环境与参数

- Windows；DSH Desktop 至少运行过一次并创建了工作区。
- Node.js 22+：优先 PATH，其次 DSH 常见的内置运行时位置。
- Python 3.10+：用于 Codex 客户端，只使用标准库。
- 自动探测不到时可用 `-NodePath`、`-PythonPath`；`-DshInstallPath` 是 DSH 安装目录。
- 非默认布局用 `-DshHome`、`-CodexHome`，两者默认为环境变量对应值或用户目录下 `.dsh` / `.codex`。
- 接口默认 `http://127.0.0.1:19387/codex-bridge`，可用 `-BridgeUrl` 指定实际桌面地址。
- `-WorkspaceId 'id1','id2'` 可以免交互选择；不默认授权全部工作区。

```powershell
.\install.ps1 -DshInstallPath 'C:\Apps\DeepseekHarness' `
  -WorkspaceId '工作区ID' -PythonPath 'C:\path\to\python.exe'
```

如果已经通过官方入口装过插件，请使用 `-ConfigureOnly`，脚本不会覆盖官方管理的插件。自定义的插件 stateDir/tokenFile 配置需要手动保持一致；不要把本机凭据复制到另一台电脑。

## 升级、卸载和备份

官方入口安装的插件由官方插件管理器更新或卸载；客户端配置可重新执行 `-ConfigureOnly`。脚本安装的版本在完全退出 DSH 后重新运行新版本 `install.ps1` 即可更新。

```powershell
.\install.ps1 -Uninstall
```

卸载会吊销本次安装生成的令牌，移除脚本拥有的插件配置，并归档 skill，保留 DSH 桌面会话和桥接任务状态。官方入口装的插件仍需到界面中卸载。备份在 `<DSH用户目录>/codex-bridge-install/backups`，不要上传其中的本机配置或凭据。

## 另一台电脑的简短验收

1. `-Check` 返回 ready。
2. 让 Codex 发现工作区、模型和推理强度，派发一句简单指令。
3. 观察 DSH 对话归入正确工作区，执行过程实时更新。
4. 让 Codex 回读结果，再向同一个对话发送第二轮反馈。
5. 重开 DSH 后验证恢复；有两个工作区时再验证隔离。

连接检查只验证接口可达，不代表模型执行和桌面实时更新已经通过。模型与推理强度应查看 `observedConfig`，不依赖 agent 自述。

## 边界

使用桌面的同一个宿主与会话服务，保留工具权限审批，不自动批准工具，不替 Codex 放宽沙箱。创建 task 仅绑定会话，真正执行需要 append。桥接插件不能自行唤醒空闲的 Codex 会话。

协议见 [PROTOCOL.md](PROTOCOL.md)，英文维护说明见 [README.md](README.md)。许可证为 MIT。当前只发布 GitHub 源码；未发布 npm 包。
