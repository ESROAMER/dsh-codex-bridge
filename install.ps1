# Requires Windows PowerShell 5.1+ or PowerShell 7. No administrator rights needed.
[CmdletBinding()]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
    [string]$DshInstallPath,
    [string]$NodePath,
    [string]$PythonPath,
    [string[]]$WorkspaceId,
    [string]$BridgeUrl = 'http://127.0.0.1:19387/codex-bridge',
    [switch]$ConfigureOnly,
    [switch]$Uninstall,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
if (-not $NodePath) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $NodePath = $nodeCmd.Source }
    else {
        $candidates = @(
            (Join-Path $DshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
        )
        if ($DshInstallPath) {
            $candidates += Join-Path $DshInstallPath 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
        }
        $NodePath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
}
if (-not $NodePath) { throw 'Node.js 22+ not found. Pass -NodePath or install Node.js.' }
if (-not $PythonPath) {
    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCmd -and $pythonCmd.Source -notmatch 'WindowsApps') { $PythonPath = $pythonCmd.Source }
    elseif ($DshInstallPath) {
        $candidate = Join-Path $DshInstallPath 'resources\runtime\primary-runtime\dependencies\python\python.exe'
        if (Test-Path -LiteralPath $candidate) { $PythonPath = $candidate }
    }
}
$argsList = @((Join-Path $repo 'scripts\setup.mjs'), '--dsh-home', $DshHome, '--codex-home', $CodexHome, '--url', $BridgeUrl)
if ($PythonPath) { $argsList += @('--python', $PythonPath) }
if ($Uninstall) { $argsList += '--uninstall' }
elseif ($Check) { $argsList += '--check' }
else {
    if (-not $ConfigureOnly) {
        $active = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*Harness*' }
        if ($active) { throw 'Fully quit DeepSeek Harness first (including its tray process), then rerun. No running tasks will be killed.' }
    }
    if (-not $WorkspaceId) {
        Write-Host 'Registered workspaces:'
        & $NodePath (Join-Path $repo 'scripts\setup.mjs') --dsh-home $DshHome --list
        if ($LASTEXITCODE -ne 0) { throw 'Cannot read registered workspaces. Open DSH once and add a workspace first.' }
        $selection = Read-Host 'Enter workspace ID(s), comma separated'
        $WorkspaceId = @($selection -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    if (-not $WorkspaceId) { throw 'At least one explicit workspace ID is required.' }
    foreach ($id in $WorkspaceId) { $argsList += @('--workspace', $id) }
    if ($ConfigureOnly) { $argsList += '--configure-only' }
}
& $NodePath @argsList
if ($LASTEXITCODE -ne 0) { throw "Installer failed with exit code $LASTEXITCODE. See the error above." }
