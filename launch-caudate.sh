#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

detect_arch() {
	case "$(uname -m)" in
		x86_64|amd64) echo "x64" ;;
		aarch64|arm64) echo "arm64" ;;
		armv7l|armhf) echo "armhf" ;;
		*) echo "x64" ;;
	esac
}

ARCH="$(detect_arch)"
PROD_BIN="$ROOT_DIR/../VSCode-linux-${ARCH}/caudate"

EXTRA_FLAGS=(
	"--ozone-platform-hint=auto"
	"--disable-extension=GitHub.copilot-chat"
)

if [[ -x "$PROD_BIN" ]]; then
	exec "$PROD_BIN" "${EXTRA_FLAGS[@]}" "$@"
fi

export NODE_ENV="development"
export VSCODE_DEV="1"
export VSCODE_CLI="1"
export VSCODE_SKIP_NODE_VERSION_CHECK="1"
export VSCODE_SKIP_PRELAUNCH="1"

DEV_BIN=""
for candidate in \
	"$ROOT_DIR/.build/electron/caudate" \
	"$ROOT_DIR/.build/electron/code-oss" \
	"$ROOT_DIR/.build/electron/electron"; do
	if [[ -x "$candidate" ]]; then
		DEV_BIN="$candidate"
		break
	fi
done

if [[ -z "$DEV_BIN" ]]; then
	echo "Caudate IDE Electron binary not found." >&2
	echo "Run 'VSCODE_SKIP_NODE_VERSION_CHECK=1 pnpm run electron' (dev) or './scripts/build-linux.sh' (production) first." >&2
	exit 1
fi

cd "$ROOT_DIR"
exec "$DEV_BIN" . --disable-extension=vscode.vscode-api-tests "${EXTRA_FLAGS[@]}" "$@"
