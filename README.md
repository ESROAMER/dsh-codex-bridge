# DSH–Codex Bridge

[中文说明](README.zh-CN.md)

Connects Codex to a running DeepSeek Harness (DSH) Desktop session so Codex can delegate work and review the conversation and results. This is a community project and is not affiliated with DeepSeek or OpenAI.

## Install

1. In DSH, open **Settings → Plugins → Add plugin** and enter `@esroamer/dsh-codex-bridge` (version 0.1.3 or later). You can also install from this GitHub repository or a local checkout.
2. Download or clone this repository. From its root, run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ConfigureOnly
   ```

   Select the workspace to authorize. The setup installs the `$deepseek-harness` Codex skill and creates a local token for the selected workspace.
3. Restart DSH if needed, then check the connection:

   ```powershell
   .\install.ps1 -Check
   ```

4. In Codex, use `$deepseek-harness` and describe the task and workspace.

For a script-managed installation, fully exit DSH and run `install.ps1` without `-ConfigureOnly` from the repository root.

## Requirements and security

- Windows, DSH Desktop, and Codex.
- Node.js 22+ and Python 3.10+ for setup and the Codex client.
- Access is limited to the workspace you select. DSH tool approval settings remain in effect.

See [PROTOCOL.md](PROTOCOL.md) for the bridge protocol. Licensed under MIT.
