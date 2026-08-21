// swift-tools-version: 5.9
// agentany computer-use mac 桥（ADR-0036 D1 内核实为 pi-computer-use 移植，MIT）。
// 独立 CLI 可执行：stdin 收 JSON-lines 请求（{id,cmd,...}），stdout 回 JSON-lines 响应（{id,ok,...}）。
// device-core 以子进程承载（AGENTANY_CU_BIN）；命令：screens / observe / act。
import PackageDescription

let package = Package(
  name: "agentany-computer-use-macos",
  targets: [
    .executableTarget(
      name: "computeruse",
      path: "Sources/computeruse",
      swiftSettings: [
        .unsafeFlags(["-framework", "Carbon"]) // HIToolbox key codes（kVK_*）
      ]
    ),
  ]
)