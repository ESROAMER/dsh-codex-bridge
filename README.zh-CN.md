# DSH–Codex Bridge

[English](README.md)

连接 Codex 与正在运行的 DeepSeek Harness（DSH）桌面会话，让 Codex 可以派发任务并查看对话和执行结果。本项目由社区维护，与 DeepSeek、OpenAI 无关。

## 安装

1. 在 DSH 中打开 **设置 → 插件 → 添加插件**，输入 `https://github.com/ESROAMER/dsh-codex-bridge` 或本地解压目录。全部工作区和注册功能需要 **0.2.0 或更高**；npm 的 `@esroamer/dsh-codex-bridge` 发布到该版本后也可使用包名安装。
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

之后可以说：“让 DeepSeek 在 `C:\Projects\example` 完成任务，没有对应工作区就创建。”路径必须是已存在的目录。注册会复用同路径的已有工作区，不隐式创建文件夹。只想访问全部工作区时省略 `-AllowWorkspaceCreate`。旧令牌不会自动获得创建权限，部署层目录允许列表仍然生效。

如需由脚本管理插件安装，请先完全退出 DSH，再在仓库根目录运行 `install.ps1`（不加 `-ConfigureOnly`）。

## 环境与安全

- 需要 Windows、DSH Desktop 和 Codex。
- 安装和 Codex 客户端需要 Node.js 22+ 与 Python 3.10+。
- 桥接访问范围可以是所选工作区或显式授权的全部工作区；创建权限独立控制，DSH 原有工具审批继续生效。

桥接协议见 [PROTOCOL.md](PROTOCOL.md)。本项目采用 MIT 许可证。
