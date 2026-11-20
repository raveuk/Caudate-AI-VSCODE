#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"

detect_arch() {
	case "$(uname -m)" in
		x86_64|amd64) echo "x64" ;;
		aarch64|arm64) echo "arm64" ;;
		armv7l|armhf) echo "armhf" ;;
		*) echo "x64" ;;
	esac
}

ARCH="$(detect_arch)"
BUILD_DEB=0
BUILD_RPM=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--deb)
			BUILD_DEB=1
			shift
			;;
		--rpm)
			BUILD_RPM=1
			shift
			;;
		--all)
			BUILD_DEB=1
			BUILD_RPM=1
			shift
			;;
		--arch)
			ARCH="$2"
			shift 2
			;;
		-h|--help)
			echo "Usage: $0 [--deb] [--rpm] [--all] [--arch x64|arm64|armhf]"
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			exit 1
			;;
	esac
done

export VSCODE_SKIP_NODE_VERSION_CHECK="1"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

cd "$ROOT_DIR"

echo "1/4 Compiling Caudate AI built-in extension..."
./node_modules/.bin/tsc --project extensions/aether-ai/tsconfig.json

echo "2/4 Generating custom Caudate Linux PNG icons..."
node scripts/generate-caudate-icon.mjs

echo "3/4 Building standalone Linux ${ARCH} bundle (../VSCode-linux-${ARCH})..."
pnpm run gulp "vscode-linux-${ARCH}-min"

TARBALL="$ROOT_DIR/../Caudate-IDE-linux-${ARCH}.tar.gz"
echo "4/4 Creating portable tarball ($TARBALL)..."
tar -czf "$TARBALL" -C "$ROOT_DIR/.." "VSCode-linux-${ARCH}"

if [[ "$BUILD_DEB" -eq 1 ]]; then
	echo "Building Debian/Ubuntu .deb package for linux-${ARCH}..."
	pnpm run gulp "vscode-linux-${ARCH}-build-deb"
	echo "DEB output: $ROOT_DIR/.build/linux/deb/"
fi

if [[ "$BUILD_RPM" -eq 1 ]]; then
	echo "Building Fedora/RHEL/openSUSE .rpm package for linux-${ARCH}..."
	pnpm run gulp "vscode-linux-${ARCH}-build-rpm"
	echo "RPM output: $ROOT_DIR/.build/linux/rpm/"
fi

echo ""
echo "Linux build complete!"
echo "  Standalone app: $ROOT_DIR/../VSCode-linux-${ARCH}/caudate"
echo "  Portable archive: $TARBALL"
