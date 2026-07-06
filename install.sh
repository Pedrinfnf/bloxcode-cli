#!/bin/bash
# BloxCode installer — downloads pre-built binary for your platform
set -e

REPO="Pedrinfnf/bloxcode-cli"
INSTALL_DIR="${PREFIX:-/usr/local}/bin"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS-$ARCH" in
  linux-aarch64) BINARY="bloxcode-linux-arm64" ;;
  linux-x86_64)  BINARY="bloxcode-linux-x64" ;;
  darwin-arm64)  BINARY="bloxcode-macos-arm64" ;;
  darwin-x86_64) BINARY="bloxcode-macos-x64" ;;
  *) echo "Unsupported: $OS-$ARCH"; exit 1 ;;
esac

echo "  ● bloxcode installer"
echo "  platform: $OS/$ARCH"
echo "  binary: $BINARY"
echo ""

# Get latest release URL
LATEST=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep "browser_download_url.*$BINARY" | cut -d '"' -f 4)

if [ -z "$LATEST" ]; then
  echo "  ✗ no release found — building from source..."
  echo ""
  if ! command -v cargo &> /dev/null; then
    echo "  installing rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  
  TMPDIR=$(mktemp -d)
  git clone --depth 1 "https://github.com/$REPO.git" "$TMPDIR/bloxcode"
  cd "$TMPDIR/bloxcode/tui"
  echo "  compiling (this takes a few minutes)..."
  cargo build --release
  
  mkdir -p "$INSTALL_DIR"
  cp target/release/bloxcode "$INSTALL_DIR/bloxcode"
  chmod +x "$INSTALL_DIR/bloxcode"
  rm -rf "$TMPDIR"
else
  echo "  downloading..."
  TMPDIR=$(mktemp -d)
  curl -sL "$LATEST" -o "$TMPDIR/bloxcode.tar.gz"
  cd "$TMPDIR"
  tar xzf bloxcode.tar.gz
  
  mkdir -p "$INSTALL_DIR"
  cp "$BINARY" "$INSTALL_DIR/bloxcode"
  chmod +x "$INSTALL_DIR/bloxcode"
  rm -rf "$TMPDIR"
fi

echo "  ✓ installed to $INSTALL_DIR/bloxcode"
echo ""
echo "  run: bloxcode"
echo ""
