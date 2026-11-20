#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"

chmod +x "$ROOT_DIR/launch-caudate.sh" "$ROOT_DIR/scripts/caudate" "$ROOT_DIR/scripts/build-linux.sh" "$ROOT_DIR/scripts/install-caudate-linux.sh"

# 1. Install 512x512 PNG application icon
ICON_SRC="$ROOT_DIR/resources/linux/caudate.png"
if [[ ! -f "$ICON_SRC" ]]; then
	ICON_SRC="$ROOT_DIR/resources/linux/code.png"
fi
if [[ ! -f "$ICON_SRC" ]]; then
	echo "Generating Caudate Linux PNG icon..."
	(cd "$ROOT_DIR" && node scripts/generate-caudate-icon.mjs)
	ICON_SRC="$ROOT_DIR/resources/linux/caudate.png"
fi

ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
mkdir -p "$ICON_DIR"
cp "$ICON_SRC" "$ICON_DIR/caudate-ide.png"

# 2. Install .desktop application launcher
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APP_DIR"
cat > "$APP_DIR/caudate-ide.desktop" <<EOF
[Desktop Entry]
Name=Caudate IDE
Comment=AI-native code editor with autonomous multi-agent workflows and local LLM support
GenericName=Text Editor
Exec=${ROOT_DIR}/launch-caudate.sh %F
Icon=caudate-ide
Type=Application
StartupNotify=false
StartupWMClass=caudate
Categories=TextEditor;Development;IDE;
MimeType=text/plain;inode/directory;x-scheme-handler/caudate;
Actions=new-empty-window;
Keywords=caudate;vscode;ai;ide;editor;

[Desktop Action new-empty-window]
Name=New Empty Window
Exec=${ROOT_DIR}/launch-caudate.sh --new-window %F
Icon=caudate-ide
EOF

# 3. Symlink CLI into ~/.local/bin/caudate
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$ROOT_DIR/scripts/caudate" "$BIN_DIR/caudate"

# 4. Refresh desktop & icon caches if available
if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Caudate IDE desktop integration installed:"
echo "  Icon:    $ICON_DIR/caudate-ide.png"
echo "  Desktop: $APP_DIR/caudate-ide.desktop"
echo "  CLI:     $BIN_DIR/caudate"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
	echo ""
	echo "Note: Add '$BIN_DIR' to your PATH (e.g. export PATH=\"\$HOME/.local/bin:\$PATH\") to run 'caudate' from any terminal."
fi
