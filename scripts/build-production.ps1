<#
.SYNOPSIS
    Builds a standalone bundled Windows desktop distribution of Caudate IDE
    into ..\VSCode-win32-x64\Caudate IDE.exe and compiles the production
    Windows Setup Wizard installer (.exe) via Inno Setup.
#>
$ErrorActionPreference = 'Stop'
$env:VSCODE_SKIP_NODE_VERSION_CHECK = '1'
$env:NODE_OPTIONS = '--max-old-space-size=8192'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

Write-Host "1/5 Compiling Caudate AI built-in extension..." -ForegroundColor Cyan
& .\node_modules\.bin\tsc --project extensions\aether-ai\tsconfig.json

Write-Host "2/5 Generating custom Caudate icons & Inno Setup wizard bitmaps..." -ForegroundColor Cyan
node scripts\generate-caudate-icon.mjs
node scripts\generate-caudate-inno-bitmaps.mjs

Write-Host "3/5 Building standalone Windows x64 package (VSCode-win32-x64)..." -ForegroundColor Cyan
pnpm run gulp vscode-win32-x64-min

Write-Host "4/5 Preparing Windows updater helper..." -ForegroundColor Cyan
pnpm run gulp vscode-win32-x64-inno-updater

Write-Host "5/5 Compiling Windows Setup Wizard installer (.exe)..." -ForegroundColor Cyan
pnpm run gulp vscode-win32-x64-user-setup

Write-Host "`nProduction build & Windows installer complete!" -ForegroundColor Green
Write-Host "  Standalone app: ..\VSCode-win32-x64\Caudate IDE.exe" -ForegroundColor Green
Write-Host "  Setup .exe:     .build\win32-x64\user-setup\CaudateIDESetup-x64-1.0.0.exe" -ForegroundColor Green
