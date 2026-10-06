# Codex–DSH 协作插件

[English](README.md)

让 Codex 向 DeepSeek Harness（DSH）工作区派发任务、跟踪执行、回读结果并继续协作。

npm 包名为 `@esroamer/codex-dsh-collab`。交互由 Codex 发起；DSH 不会主动唤醒空闲的 Codex 会话。

底层提供与客户端无关的本机认证 HTTP 协议。其他 agent 软件可按 [PROTOCOL.md](PROTOCOL.md) 实现工作区发现、任务派发、执行等待与消息回读来接入。目前项目附带并验证的是配套 skill 提供的 Codex 客户端；其他软件仍需自行适配和测试。在 DSH 中安装插件后，还需完成下方的 Codex 客户端配置步骤。

## 安装

1. 在 DSH 中打开 **设置 → 插件 → 添加插件**，输入 GitHub 仓库地址 `https://github.com/ESROAMER/codex-dsh-collab`、本地目录或 npm 包名 `@esroamer/codex-dsh-collab`。全部工作区和工作区注册功能需要 **0.2.0 或更高**。
2. 下载或克隆本仓库，在仓库根目录运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ConfigureOnly
   ```

   选择要授权的工作区。安装脚本会配置 `$deepseek-harness` Codex 技能，并为所选工作区生成本机令牌。
3. 必要时重启 DSH，然后检查连接：

   ```powershell
   .\install.ps1 -Check
   ```

4. 在 Codex 中使用 `$deepseek-harness`，并说明任务和工作区。

连接全部现有与未来工作区，并允许注册新的工作区：

```powershell
.\install.ps1 -ConfigureOnly -AllWorkspaces -AllowWorkspaceCreate
```

启用工作区注册权限后，在 Codex 中说明项目路径和任务即可。若 DSH 尚未登记该路径，Codex 会将这个已存在的目录注册为工作区；若同路径工作区已存在，则直接复用，不会新建文件夹。

如需由脚本管理插件安装，请先完全退出 DSH，再在仓库根目录运行 `install.ps1`（不加 `-ConfigureOnly`）。

## Windows 终端故障排查

如果桥接连接正常，但 DSH 的 `pwsh` 无输出并返回 `3221225794`（`0xC0000142`），请查阅 [Windows shell 启动案例](skills/deepseek-harness/references/windows-shell-startup.md)。已验证的一台安装中，`workspace-write` 受限令牌与父进程没有控制台的组合触发启动失败；由 ACL runner 预先建立隐藏控制台后成功。文档区分了已观测的触发条件与默认 DACL 机制推断，并说明保留沙箱限制的修复和验收方式。这属于 DSH 运行时问题，桥接安装脚本不会自动修改桌面安装包。

## 环境与安全

- 需要 Windows、DSH Desktop 和 Codex。
- 安装和 Codex 客户端需要 Node.js 22+ 与 Python 3.10+。
- 桥接访问范围可以是所选工作区或显式授权的全部工作区；创建权限独立控制，DSH 原有工具审批继续生效。

桥接协议见 [PROTOCOL.md](PROTOCOL.md)。本项目采用 MIT 许可证。
