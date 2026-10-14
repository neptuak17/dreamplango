<#
.SYNOPSIS
    Adds the folder containing uv.exe to your *user* PATH. No administrator rights needed.

.DESCRIPTION
    uv was installed with `python -m pip install --user uv`, which puts uv.exe in Python's per-user Scripts
    folder (e.g. %APPDATA%\Python\Python314\Scripts). This script finds that folder, appends it to the user
    PATH stored in the registry (leaving existing entries, including %VARIABLE% ones, untouched) and tells
    running programs that the environment changed. Running it again does nothing.

.PARAMETER DryRun
    Show what would change without changing anything.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\add-uv-to-path.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\add-uv-to-path.ps1
#>
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

function Send-EnvironmentChanged {
    # Broadcast WM_SETTINGCHANGE ("Environment") so Explorer and newly started programs see the new PATH.
    Add-Type -Namespace DreamPlanGo -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    $result = [UIntPtr]::Zero
    $HWND_BROADCAST = [IntPtr]0xffff
    $WM_SETTINGCHANGE = 0x1A
    $SMTO_ABORTIFHUNG = 0x2
    [void][DreamPlanGo.NativeMethods]::SendMessageTimeout(
        $HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment', $SMTO_ABORTIFHUNG, 5000, [ref]$result)
}

# 1. Locate the per-user Scripts folder of the Python that has uv installed.
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'python was not found on PATH.' }
$scripts = (& $python.Source -c "import sysconfig; print(sysconfig.get_path('scripts', 'nt_user'))").Trim()
$uv = Join-Path $scripts 'uv.exe'
if (-not (Test-Path $uv)) {
    throw "uv.exe was not found in $scripts. Install it first with: python -m pip install --user uv"
}
Write-Host "uv found: $uv"

# 2. Read the user PATH from the registry without expanding %VARIABLES%.
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = @($raw -split ';' | Where-Object { $_.Trim() -ne '' })
    $present = @($entries | Where-Object {
            [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $scripts.TrimEnd('\')
        })

    if ($present.Count -gt 0) {
        Write-Host 'Already on your user PATH. Nothing to change.'
    }
    elseif ($DryRun) {
        Write-Host "Dry run: would append to your user PATH: $scripts"
        Write-Host ("Current user PATH has {0} entries; it would have {1}." -f $entries.Count, ($entries.Count + 1))
        return
    }
    else {
        $newPath = (@($entries) + $scripts) -join ';'
        $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        Send-EnvironmentChanged
        Write-Host "Added to your user PATH: $scripts"
    }
}
finally {
    $key.Close()
}

# 3. Make it work in this window too, then confirm.
if (-not (($env:Path -split ';') -contains $scripts)) { $env:Path = "$env:Path;$scripts" }
& $uv --version
Write-Host 'Done. Open a new terminal (and restart VS Code / the Claude app) so they pick up the new PATH.'
