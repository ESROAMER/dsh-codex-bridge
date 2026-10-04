# DSH–Codex Bridge

[English](README.md)

连接 Codex 与正在运行的 DeepSeek Harness（DSH）桌面会话，让 Codex 可以派发任务并查看对话和执行结果。本项目由社区维护，与 DeepSeek、OpenAI 无关。

## 安装

1. 在 DSH 中打开 **设置 → 插件 → 添加插件**，输入 `@esroamer/dsh-codex-bridge`（版本 0.1.3 或更高）。也可以从本 GitHub 仓库或本地目录安装。
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

如需由脚本管理插件安装，请先完全退出 DSH，再在仓库根目录运行 `install.ps1`（不加 `-ConfigureOnly`）。

## 环境与安全

- 需要 Windows、DSH Desktop 和 Codex。
- 安装和 Codex 客户端需要 Node.js 22+ 与 Python 3.10+。
- 桥接访问仅限所选工作区；DSH 原有的工具审批设置继续生效。

桥接协议见 [PROTOCOL.md](PROTOCOL.md)。本项目采用 MIT 许可证。
