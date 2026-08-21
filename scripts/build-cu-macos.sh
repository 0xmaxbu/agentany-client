#!/usr/bin/env bash
# 构建 macOS computer-use 桥并安装到 ~/.agentany/bin/computeruse（device-core 默认解析路径）。
# 前置：Xcode Command Line Tools（swiftc）。产物 arm64/Intel 视宿主。
set -euo pipefail
pkg="$(cd "$(dirname "$0")/.." && pwd)/packages/computer-use-macos"
out="${AGENTANY_CU_BIN:-$HOME/.agentany/bin/computeruse}"
mkdir -p "$(dirname "$out")"
echo "building computer-use bridge…"
swift build -c release --package-path "$pkg"
cp "$pkg/.build/release/computeruse" "$out"
echo "installed: $out"