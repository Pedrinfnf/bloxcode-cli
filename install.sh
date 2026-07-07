#!/bin/bash
set -e

REPO="Pedrinfnf/bloxcode-cli"
INSTALL_DIR="${PREFIX:-/usr/local}/bin"
BACKEND_DIR="$HOME/.bloxcode/backend"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS-$ARCH" in
  linux-aarch64) BINARY="bloxcode-linux-arm64" ;;
  linux-x86_64)  BINARY="bloxcode-linux-x64" ;;
  darwin-arm64)  BINARY="bloxcode-macos-arm64" ;;
  darwin-x86_64) BINARY="bloxcode-macos-x64" ;;
  *) echo "Unsupported: $OS-$ARCH"; exit 1 ;;
esac

echo ""
echo "  ● bloxcode installer"
echo "  $OS/$ARCH"
echo ""

# 1. Install/update TS backend
echo "  installing backend..."
rm -rf "$BACKEND_DIR"
mkdir -p "$BACKEND_DIR"
git clone --depth 1 "https://github.com/$REPO.git" "$BACKEND_DIR" 2>/dev/null || {
  echo "  ✗ git clone failed"; exit 1;
}
cd "$BACKEND_DIR" && npm install --production 2>/dev/null
echo "  ✓ backend ready"

# 2. Download pre-built binary (or build from source)
LATEST=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep "browser_download_url.*$BINARY" | cut -d '"' -f 4)

if [ -n "$LATEST" ]; then
  echo "  downloading binary..."
  TMPDIR=$(mktemp -d)
  curl -sL "$LATEST" -o "$TMPDIR/bloxcode.tar.gz"
  cd "$TMPDIR" && tar xzf bloxcode.tar.gz
  mkdir -p "$INSTALL_DIR"
  cp "$BINARY" "$INSTALL_DIR/bloxcode"
  chmod +x "$INSTALL_DIR/bloxcode"
  rm -rf "$TMPDIR"
  echo "  ✓ binary installed"
else
  echo "  no pre-built binary, building from source..."
  if ! command -v cargo &> /dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  cd "$BACKEND_DIR/tui" && cargo build --release
  mkdir -p "$INSTALL_DIR"
  cp target/release/bloxcode "$INSTALL_DIR/bloxcode"
  chmod +x "$INSTALL_DIR/bloxcode"
  echo "  ✓ built from source"
fi

echo ""
echo "  ✓ installed!"
echo ""
echo "  run:  bloxcode"
echo "  then: /api → choose provider → paste key"
echo ""
