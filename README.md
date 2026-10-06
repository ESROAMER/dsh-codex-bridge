# Codex ↔ DSH Collaboration

[中文说明](README.zh-CN.md)

Lets Codex delegate tasks to DeepSeek Harness (DSH) workspaces, follow execution, read results, and continue collaborating.

The npm package is `@esroamer/codex-dsh-collab`. Codex initiates each interaction; DSH does not wake an idle Codex session.

The underlying authenticated loopback HTTP protocol is client-independent. Other agent applications can integrate by implementing workspace discovery, task dispatch, execution waits, and transcript reads described in [PROTOCOL.md](PROTOCOL.md). This project currently ships and has verified a Codex client through the companion skill; other applications require their own adaptation and testing. Installing the DSH plugin alone does not configure the Codex client—complete both installation steps below.

## Install

1. In DSH, open **Settings → Plugins → Add plugin** and enter `https://github.com/ESROAMER/codex-dsh-collab`, a local checkout, or `@esroamer/codex-dsh-collab`. All-workspace setup and workspace registration require **0.2.0+**.
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

With workspace registration enabled, give Codex the project path and task. Codex registers the existing directory only if DSH has no workspace at that path; it reuses an existing one and does not create directories.

For a script-managed installation, fully exit DSH and run `install.ps1` without `-ConfigureOnly` from the repository root.

## Windows shell troubleshooting

If the bridge is healthy but DSH `pwsh` returns `3221225794` (`0xC0000142`) without output, see the [Windows shell startup case](skills/deepseek-harness/references/windows-shell-startup.md). On one verified installation, `workspace-write` restricted-token startup failed without a parent console and succeeded after the ACL runner prepared a hidden console. The guide separates observed behavior from the inferred DACL mechanism and describes validation while preserving confinement. This is a DSH runtime issue; the bridge installer does not automatically patch the desktop installation.

## Requirements and security

- Windows, DSH Desktop, and Codex.
- Node.js 22+ and Python 3.10+ for setup and the Codex client.
- Access covers selected workspaces or explicitly authorized all-workspace scope. Creation permission is separate; DSH tool approvals remain in effect.

See [PROTOCOL.md](PROTOCOL.md) for the bridge protocol. Licensed under MIT.
