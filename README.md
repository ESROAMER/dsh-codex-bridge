# DSH–Codex Bridge

[中文说明](README.zh-CN.md)

Connects Codex to a running DeepSeek Harness (DSH) Desktop session so Codex can delegate work and review the conversation and results. This is a community project and is not affiliated with DeepSeek or OpenAI.

## Install

1. In DSH, open **Settings → Plugins → Add plugin** and enter `https://github.com/ESROAMER/dsh-codex-bridge` or a local checkout. All-workspace setup and workspace registration require **0.2.0+**. Once that version is published to npm, `@esroamer/dsh-codex-bridge` is also supported.
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

For all current/future workspaces and registration of new workspaces:

```powershell
.\install.ps1 -ConfigureOnly -AllWorkspaces -AllowWorkspaceCreate
```

Then ask Codex to work at a project path and register it if needed. The path must be an existing, fully qualified directory. Registration reuses canonical paths without retitling and creates no directories. Omit `-AllowWorkspaceCreate` for discovery/dispatch only. Old tokens do not gain creation permission automatically. Deployment allowlists still apply.

For a script-managed installation, fully exit DSH and run `install.ps1` without `-ConfigureOnly` from the repository root.

## Requirements and security

- Windows, DSH Desktop, and Codex.
- Node.js 22+ and Python 3.10+ for setup and the Codex client.
- Access covers selected workspaces or explicitly authorized all-workspace scope. Creation permission is separate; DSH tool approvals remain in effect.

See [PROTOCOL.md](PROTOCOL.md) for the bridge protocol. Licensed under MIT.
