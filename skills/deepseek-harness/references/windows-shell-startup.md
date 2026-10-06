# Windows shell startup: 0xC0000142

## Scope and ownership

This case was reproduced and repaired on one Windows DSH Desktop installation on 2026-10-06; its bundled `@deepseek-ai/dsh-win32-process` package reported version `0.2.0-rc.2`. It concerns DSH's `dsh-subprocess-local` and `dsh-sandbox-windows-acl` startup chain. The collaboration bridge dispatches sessions and reads their results; it does not implement this shell runner. Bridge `/health: ready` and successful file tools can coexist with a broken shell.

`3221225794` is `0xC0000142` (`STATUS_DLL_INIT_FAILED`). This exit code alone does not identify a DLL or establish the cause described below. Check the installed version, selected executable, launch chain, and reproduction before applying this diagnosis elsewhere.

## Verified observations

The installed chain was a Windows Job runner, followed by an ACL sandbox runner, followed by the requested shell. The ACL runner created the restricted token and launched the child through `CreateProcessAsUserW`.

With the same system Windows PowerShell 5.1 executable (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`) and unchanged sandbox implementation:

| Token mode | Parent console | Result |
| --- | --- | --- |
| `read-only` | Absent | Exit 0 |
| `workspace-write` | Absent | No output; exit `0xC0000142` |
| `workspace-write` | Preallocated hidden console | Exit 0; marker captured with piped stdout |

The isolated token probe used `manageDacls: false` and `tempDir: null`; both pipe and inherited stdio showed the same difference. A separate test of the complete Job → ACL runner → shell chain used the existing workspace and private-temp capability SIDs: the original runner failed, and the patched runner succeeded. This distinguishes the verified trigger from an assertion that every restricted token or every consoleless process fails.

The sandbox initializes a different token default DACL in the two modes: the read-only fallback uses Everyone, while workspace-write uses a capability SID. A plausible explanation is that creation of console-related objects under the workspace-write token fails during early initialization. **That object/DACL mechanism remains an inference:** no failing DLL or individual access check was directly identified. `windowsHide: true` exists on the outer launch, but changing that setting was not the repair tested here.

## Diagnosis and repair guidance

- Separate bridge transport, runner startup, and target-shell startup. Record the actual selected executable and target exit status; a managed outer runner may exit 0 while reporting a failed target through IPC.
- When reproducing this case, compare the same executable under the same token policy with and without a preallocated parent console. Keep active project work isolated from diagnostic commands. Use the existing desktop host and authorized workspace; a separate ACP/backend does not reproduce this chain.
- Preserve sandbox policy and approvals. Do not add token SIDs, weaken ACLs or integrity labels, or switch the agent to unrestricted execution to make its shell succeed.

The verified repair was in the **unrestricted, single-use ACL runner**, before it spawned the restricted child:

1. If the runner has no console, save its Win32 standard handles, allocate a console, and hide it immediately.
2. Restore the saved stdin/stdout/stderr handles so the child continues using the caller's pipes. Reapply the runner's ignored Ctrl+C handler after allocation.
3. Spawn the child using the existing restricted token, Job ownership, private temp, and control-pipe behavior.
4. Release only the console created by this runner in cleanup. Failures continue to use the runner's existing failure and cleanup paths.

This is a startup compatibility repair, not a change to the authorization boundary. Prefer an upstream DSH fix. The bridge installer does not automatically patch DSH's executable or `app.asar`.

The handle and handler restoration steps follow documented Win32 behavior: [`AllocConsole`](https://learn.microsoft.com/en-us/windows/console/allocconsole) initializes standard handles, and console allocation resets the control-handler table described by [`SetConsoleCtrlHandler`](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler). These references support the repair sequence; they do not establish the inferred DACL failure mechanism.

## Acceptance and local deployment limits

The repaired installation passed actual default-sandbox DSH `pwsh` calls: a marker command exited 0, and a native Python command printed its marker with `PY_EXIT=0`. The complete-chain probe still rejected a write outside the authorized workspace. The desktop was not restarted and the existing project session remained idle.

For an authorized local runtime repair, retain an exact installation backup and before/after hashes, review archive integrity requirements, and verify the installed entry plus real desktop tools. Preserve all token, ACL, temp, Job, and control-pipe behavior. The test above does not prove every Windows version, shell, pseudoconsole, cancellation path, or packaging layout behaves identically.

This installation accepted the modified runner in newly spawned processes without a desktop restart. That behavior is installation-specific; do not generalize it to plugin module changes or other packages. DSH updates can replace a local patch. Recheck the new implementation rather than replaying an old archive patch blindly; a rollback should refuse to overwrite unrelated installation changes.
