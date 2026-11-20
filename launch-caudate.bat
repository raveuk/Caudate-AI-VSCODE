@echo off
setlocal
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1
set VSCODE_SKIP_NODE_VERSION_CHECK=1
set VSCODE_SKIP_PRELAUNCH=1
pushd %~dp0
start "" ".build\electron\Caudate IDE.exe" . --disable-extension=vscode.vscode-api-tests --disable-extension=GitHub.copilot-chat %*
popd
endlocal
