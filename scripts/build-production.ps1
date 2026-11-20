<#
.SYNOPSIS
    Builds a standalone bundled Windows desktop distribution of Caudate IDE
    into ..\VSCode-win32-x64\Caudate IDE.exe (fast ~1-2s startup).
#>
$ErrorActionPreference = 'Stop'
$env:VSCODE_SKIP_NODE_VERSION_CHECK = '1'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

Write-Host "1/3 Compiling Caudate AI built-in extension..." -ForegroundColor Cyan
& .\node_modules\.bin\tsc --project extensions\aether-ai\tsconfig.json

Write-Host "2/3 Generating custom Caudate Windows icon..." -ForegroundColor Cyan
node scripts\generate-caudate-icon.mjs

Write-Host "3/3 Building standalone Windows x64 package (VSCode-win32-x64)..." -ForegroundColor Cyan
pnpm run gulp vscode-win32-x64-min

Write-Host "`nStandalone production build complete! Output: ..\VSCode-win32-x64\Caudate IDE.exe" -ForegroundColor Green
