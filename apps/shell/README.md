# AgentAny 设备客户端壳（Tauri）

R-6 P5c / ADR-0037 薄壳：托盘常驻 + 设置窗（首跑 onboarding 复用）+ 会话借用授权弹窗（ADR-0038 四选）
+ 开机自启。**壳只做 UI 与进程编排**——配置/连接/执行/授权判定全在 host 侧车（`apps/host`，无头可测，
JSON-lines stdio 协议见 `apps/host/src/ipc.ts`）。

## 结构

- `src-tauri/` Rust 壳：sidecar 装配（stdout→`host-event` 事件 / `host_command` 命令写 stdin）、托盘菜单、
  consent 弹窗（加载后经 `pending_consent` 领取询问载荷，避开事件竞态）、autostart 插件。
- `ui/` 静态前端（无构建步）：`index.html` 设置/授权管理；`consent.html` 授权四选（60s 倒计时=拒绝；
  env 补全只有允许/拒绝）。`withGlobalTauri` 直用 `window.__TAURI__`。

## 构建与开发

```bash
bun install                      # 仓根（workspace）
bun scripts/make-icon.ts         # 首次/换图标：生成 dist/app-icon.png
cd apps/shell && bunx tauri icon ../../dist/app-icon.png
bash scripts/build-host.sh       # 仓根：host 侧车 → src-tauri/binaries/agentany-host-<triple>
cd apps/shell && bunx tauri build          # 出 .app + .dmg（或 bunx tauri dev 调试）
```

## 打包签名/公证排期（未做，前置清单）

- **mac 公证**：需 Apple Developer Program 账号 + Developer ID Application 证书；环境变量
  `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`（或 keychain `APPLE_SIGNING_IDENTITY`）+
  `APPLE_ID`/`APPLE_PASSWORD`（app-specific）/`APPLE_TEAM_ID`，tauri-bundler 自动 sign+notarize；
  hardened runtime + entitlements 由 bundler 默认。
- **Windows 签名**（归 P6 Win/Linux 桥同期）：OV/EV 证书或 Azure Trusted Signing；targets 增 `nsis`/`msi`。
