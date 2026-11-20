<#
.SYNOPSIS
    Installs Caudate IDE Desktop shortcut, Start Menu shortcut (with custom Caudate icon),
    cleans up previous Aether shortcuts, and ensures the `caudate` CLI command is on User PATH.
#>
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $repoRoot 'launch-caudate.bat'
$iconPath = Join-Path $repoRoot 'resources\win32\caudate.ico'
$scriptsDir = Join-Path $repoRoot 'scripts'

$shell = New-Object -ComObject WScript.Shell

# Clean up old Aether IDE shortcuts if present
$oldDesktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Aether IDE.lnk'
if (Test-Path $oldDesktop) { Remove-Item $oldDesktop -Force }
$oldStartDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Aether IDE'
if (Test-Path $oldStartDir) { Remove-Item $oldStartDir -Recurse -Force }

# 1. Desktop shortcut
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Caudate IDE.lnk'
$sc1 = $shell.CreateShortcut($desktopShortcut)
$sc1.TargetPath = $launcher
$sc1.WorkingDirectory = $repoRoot
$sc1.IconLocation = $iconPath
$sc1.WindowStyle = 7
$sc1.Description = 'Caudate IDE - AI-Powered VS Code Fork'
$sc1.Save()
Write-Host "Created Desktop shortcut: $desktopShortcut"

# 2. Start Menu shortcut
$startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Caudate IDE'
New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
$startShortcut = Join-Path $startMenuDir 'Caudate IDE.lnk'
$sc2 = $shell.CreateShortcut($startShortcut)
$sc2.TargetPath = $launcher
$sc2.WorkingDirectory = $repoRoot
$sc2.IconLocation = $iconPath
$sc2.WindowStyle = 7
$sc2.Description = 'Caudate IDE - AI-Powered VS Code Fork'
$sc2.Save()
Write-Host "Created Start Menu shortcut: $startShortcut"

# 3. Ensure `caudate` CLI folder is on User PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$scriptsDir*") {
	$newPath = if ($userPath) { "$userPath;$scriptsDir" } else { $scriptsDir }
	[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
	Write-Host "Added '$scriptsDir' to User PATH. Open a new terminal and run: caudate ."
} else {
	Write-Host "User PATH already contains '$scriptsDir'. Run: caudate ."
}

Write-Host "`nCaudate IDE desktop installation complete!" -ForegroundColor Green
