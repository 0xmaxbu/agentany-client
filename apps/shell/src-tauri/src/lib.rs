// AgentAny 设备客户端壳（R-6 P5c / ADR-0037 薄壳）：托盘常驻 + 设置窗（onboarding 复用）+
// 授权弹窗 + 开机自启插件 + host 侧车（bun 编译的 device-core 单文件可执行，JSON-lines stdio）。
// 壳只做 UI 与进程编排；配置/连接/执行/授权判定全在 host（apps/host，无头可测）。
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct HostState {
    child: Mutex<Option<CommandChild>>,
    /// 最近一次未决授权请求（host stdout 原始行；consent 窗加载后经 pending_consent 领取）。
    last_consent: Mutex<Option<String>>,
}

#[tauri::command]
fn host_command(state: State<HostState>, cmd: String) {
    if let Some(child) = state.child.lock().unwrap().as_mut() {
        let _ = child.write(cmd.as_bytes());
        let _ = child.write(b"\n");
    }
}

#[tauri::command]
fn pending_consent(state: State<HostState>) -> Option<String> {
    state.last_consent.lock().unwrap().clone()
}

fn send_line(app: &AppHandle, line: &str) {
    if let Some(child) = app.state::<HostState>().child.lock().unwrap().as_mut() {
        let _ = child.write(line.as_bytes());
        let _ = child.write(b"\n");
    }
}

fn show_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) => {
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => {
            let _ = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("AgentAny 设备客户端")
                .inner_size(580., 760.)
                .build();
        }
    }
}

fn show_consent(app: &AppHandle) {
    match app.get_webview_window("consent") {
        Some(w) => {
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => {
            let _ = tauri::WebviewWindowBuilder::new(app, "consent", tauri::WebviewUrl::App("consent.html".into()))
                .title("会话借用授权")
                .inner_size(480., 440.)
                .resizable(false)
                .always_on_top(true)
                .build();
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_shell::init())
        .manage(HostState::default())
        .invoke_handler(tauri::generate_handler![host_command, pending_consent])
        .setup(|app| {
            // host 侧车：外部二进制（scripts/build-host.sh 编入 binaries/agentany-host-<triple>）
            let (mut rx, child) = app.shell().sidecar("agentany-host")?.spawn()?;
            *app.state::<HostState>().child.lock().unwrap() = Some(child);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let s = String::from_utf8_lossy(&line).trim().to_string();
                            if s.is_empty() {
                                continue;
                            }
                            // 授权询问 → 落状态 + 弹窗（窗加载后经 pending_consent 领取，避开事件竞态）
                            if s.starts_with("{\"t\":\"consent\"") {
                                *handle.state::<HostState>().last_consent.lock().unwrap() = Some(s.clone());
                                show_consent(&handle);
                            }
                            let _ = handle.emit("host-event", s);
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[host] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(_) => {
                            let _ = handle.emit("host-event", "{\"t\":\"stop\",\"reason\":\"stopped\"}");
                        }
                        _ => {}
                    }
                }
            });

            // 托盘：常驻入口（设置… / 退出）
            let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings, &quit])?;
            TrayIconBuilder::with_id("agentany-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "settings" => show_main(app),
                    "quit" => {
                        send_line(app, "{\"t\":\"shutdown\"}"); // 优雅停 host（关连接/拒残留询问）
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run agentany shell");
}
