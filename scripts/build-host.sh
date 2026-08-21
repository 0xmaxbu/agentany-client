#!/usr/bin/env bash
# 构建设备客户端 host 侧车：bun 单文件可执行 → Tauri externalBin 三段命名（agentany-host-<triple>）。
# 先跑 client 仓根 bun install（file: 依赖快照），再本脚本；随后 apps/shell 可 bunx tauri build/dev。
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPLE=$(rustc -vV | awk '/^host:/ {print $2}')
mkdir -p apps/shell/src-tauri/binaries
bun build --compile apps/host/src/main.ts --outfile "apps/shell/src-tauri/binaries/agentany-host-$TRIPLE"
echo "sidecar → apps/shell/src-tauri/binaries/agentany-host-$TRIPLE"
