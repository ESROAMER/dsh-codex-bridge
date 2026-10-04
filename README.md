# DSH–Codex Bridge

[中文说明](README.zh-CN.md)

Delegate work from Codex to **the running DeepSeek Harness Desktop**, follow its visible conversation, and review or continue the same task. The bridge uses the desktop's existing workspace/session services: no separate agent runtime and no DevTools scripts.

**Experimental, Windows-first.** The original integration was tested on DSH Desktop `0.2.0-rc.2`. The portable installer is newly packaged and needs validation on a second machine. This is a community project, not an official DeepSeek or OpenAI integration.

## What it provides

- A standard DSH Cordis bundle, installable through the official **Add plugin** dialog using a GitHub repository or local directory.
- Workspace-scoped, dedicated bearer credentials; no browser-cookie extraction or model-account credentials.
- Desktop-visible sessions, model/effort selection, incremental transcripts, bounded waits, cancellation and persistent task bindings.
- A reusable Codex skill and a Python standard-library client.
- A Windows setup script for local installation/configuration, backups, upgrades, connectivity checks and uninstall.

It preserves the host's tool permission flow. It does not automatically wake an idle Codex chat. Task creation binds a conversation; a separate append request starts execution.

## Quick start: official plugin manager

1. Open DSH Desktop at least once, sign in/configure its model provider, and add a workspace.
2. In **Settings → Plugins → Add plugin**, paste this repository's GitHub URL (or an extracted local repository directory). Install it, then fully quit/reopen DSH if necessary.
3. Download this repository with **Code → Download ZIP**, extract it, and run the following from its directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ConfigureOnly
```

The script lists registered workspaces and asks which IDs to authorize. It installs the Codex skill and generates a credential locally. It does not print the credential.

4. Run `install.ps1 -Check` after opening DSH. Start a new Codex chat and say:

> Use $deepseek-harness to delegate this task to DeepSeek in the selected workspace. Follow its progress and review the result.

The script's `-ExecutionPolicy Bypass` applies only to that PowerShell process, not the machine's persistent execution policy.

## One-script local installation

Fully quit DSH first. From an extracted repository directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

This copies the plugin to a persistent directory under your DSH home, adds its bundle to the initialized desktop profile and creates a Windows junction in that profile's `node_modules`. It does not download another DSH runtime or require administrator privileges. Reopen DSH after installation. The official manager route above remains preferred for managing the plugin itself.

Requirements: Windows, initialized DSH Desktop profile, Node.js 22+, Python 3.10+ for the Codex client. Node is detected on PATH or in DSH's usual bundled runtime. You can supply explicit paths:

```powershell
.\install.ps1 -DshInstallPath 'C:\Apps\DeepseekHarness' `
  -NodePath 'C:\path\to\node.exe' -PythonPath 'C:\path\to\python.exe' `
  -WorkspaceId 'registered-workspace-id'
```

Use `-DshHome`, `-CodexHome`, or `-BridgeUrl` for nondefault layouts. DSH and the installer must use the same home. The default URL is `http://127.0.0.1:19387/codex-bridge`.

## Upgrade and uninstall

For an official-manager installation, update/reinstall the plugin there, then rerun `install.ps1 -ConfigureOnly` if the client needs updating. For a script-managed installation, quit DSH and rerun the new checkout's `install.ps1`. Existing token alias and scoped permissions are replaced only with the IDs you explicitly select; task history is retained.

```powershell
.\install.ps1 -Check
.\install.ps1 -Uninstall
```

Uninstall removes only owned configuration, revokes this installer's token, and archives the installed skill rather than deleting custom additions. If the plugin was installed through the official manager, remove it there separately. Reopen DSH afterwards. Configuration backups live under `<DSH home>/codex-bridge-install/backups`; setup errors attempt to restore changed configuration. Backups can contain local connection settings and must not be published.

## Test on another computer

1. Install using either route above. Confirm `-Check` reports `Bridge ready`.
2. Ask Codex to discover workspaces and capabilities, then create a short task with a requested model/effort from that catalog.
3. Confirm the conversation appears under the selected DSH workspace and messages update while it executes.
4. Ask Codex to read the result and send a second round to the same conversation.
5. Reopen DSH and verify the binding can be resumed. If available, test separate authorized workspaces.

Connectivity checks do not prove model execution or UI updates. Actual configuration is reported in `observedConfig`; the agent's own statement about its model is not evidence.

## Development and protocol

No production npm dependencies. Package root contains the `dsh.bundle.patch` entry and is suitable for the official GitHub/local package installer. An npm publication is optional and has not been performed.

```powershell
node --check index.js
node protocol_test.mjs
node readback_test.mjs
node codex_review_regression.mjs
node scripts/test-setup.mjs
```

See [PROTOCOL.md](PROTOCOL.md) and [skill operations](skills/deepseek-harness/references/operations.md). Model IDs and presets are discovered at runtime; examples are not fixed allowlists. Internally the plugin depends on DSH host services, so compatibility with other DSH releases must be checked.

Runtime state: `<DSH home>/codex-bridge`. Generated client credentials/settings never belong in Git. Requests are authenticated and workspace-scoped; tool execution remains governed by DSH. Loopback access is intended for the local user and is not a defense against malware running as that user.

## Related projects

[Official DSH](https://github.com/deepseek-ai/deepseek-harness), [DSH ACP adapter](https://github.com/openma-ai/deepseek-harness-acp), and [Codex conversations in DSH](https://github.com/yangbobo2021/relay-dsh-plugin-codex) solve adjacent integration needs. This project focuses on an external coordinator delegating to the existing DSH Desktop agent.

MIT license. Contributions and reproducible compatibility reports are welcome; redact credentials, private messages and project paths before sharing logs.
