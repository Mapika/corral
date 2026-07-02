// Corral Tauri shell: launches the Node backend as a bundled sidecar on a loopback port with a
// per-run auth token, then opens the WebView at that loopback URL. In dev, the vite dev server
// (which auto-starts the backend) is used instead.
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Sidecar(Mutex<Option<CommandChild>>);
struct AppToken(String);

// The WebView fetches this once at boot and attaches it to every backend request.
#[tauri::command]
fn get_token(token: tauri::State<AppToken>) -> String {
    token.0.clone()
}

// The dashboard pushes its needs-attention count here; the tray tooltip mirrors it so a glance
// at the system tray answers "does the herd need me?" without raising the window.
#[tauri::command]
fn set_attention(app: tauri::AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if count > 0 {
            format!("Corral — {count} need attention")
        } else {
            "Corral".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(7878)
}

fn gen_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port = free_port();
    let token = gen_token();

    tauri::Builder::default()
        // Single instance FIRST: a second launch just raises the existing window (the backend
        // guards its side too — a second sidecar exits on EADDRINUSE).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // Shortcut registration happens in setup() below — registering at plugin init makes a
        // hotkey collision fatal to the whole app (another program owning the combo panicked us).
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppToken(token.clone()))
        .manage(Sidecar(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_token, set_attention])
        .setup(move |app| {
            let handle = app.handle().clone();

            // System-wide summon: first free candidate wins. A taken hotkey (other apps, AltGr-
            // heavy layouts where Ctrl+Alt doubles as AltGr) must never crash startup — the tray
            // click covers summoning if every candidate is taken.
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
                let mut summon = None;
                for combo in ["ctrl+alt+r", "ctrl+shift+alt+r"] {
                    let res = app.global_shortcut().on_shortcut(combo, |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            show_main(app);
                        }
                    });
                    if res.is_ok() {
                        summon = Some(combo);
                        break;
                    }
                }
                match summon {
                    Some(c) => log::info!("global summon shortcut: {c}"),
                    None => log::warn!("no global summon shortcut available (all candidates taken) — tray click still raises the window"),
                }
            }

            // Tray: left-click raises the window; the menu offers Show / Quit; set_attention
            // rewrites the tooltip with the dashboard's needs-attention count.
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Corral")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Dev: `npm run dev` (vite) serves the UI with HMR and auto-starts the backend.
            if cfg!(debug_assertions) {
                WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External("http://localhost:5173".parse().unwrap()))
                    .title("Corral")
                    .decorations(false)
                    .inner_size(1280.0, 832.0)
                    .build()?;
                return Ok(());
            }

            // Prod: spawn the Node backend as a sidecar from the bundled resources.
            let resource_dir = app.path().resource_dir()?;
            let (mut rx, child) = app
                .shell()
                .sidecar("node")?
                .current_dir(&resource_dir)
                .args(["server.js"])
                .env("PORT", port.to_string())
                .env("CORRAL_BIND", "127.0.0.1")
                .env("CORRAL_TOKEN", token.clone())
                .spawn()?;
            app.state::<Sidecar>().0.lock().unwrap().replace(child);

            // Keep the sidecar's stdio pipe flowing.
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    if let CommandEvent::Stderr(line) | CommandEvent::Stdout(line) = ev {
                        let _ = String::from_utf8_lossy(&line);
                    }
                }
            });

            // Hand the per-run token to the page via the URL fragment. The WebView loads a remote
            // loopback origin (http://127.0.0.1:PORT), which doesn't reliably get Tauri IPC, so we
            // can't depend on invoke('get_token'); the fragment is never sent to the server, and
            // main.js scrubs it from the address immediately after reading it.
            let url = format!("http://127.0.0.1:{}/#tk={}", port, token);

            // Wait for the backend to accept connections, then open the window.
            std::thread::spawn(move || {
                // Poll tightly — the backend listens in ~0.3s, so a short interval shaves visible
                // startup latency without busy-waiting (1000 * 25ms = 25s ceiling).
                for _ in 0..1000 {
                    if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                let _ = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url.parse().unwrap()))
                    .title("Corral")
                    .decorations(false)
                    .inner_size(1280.0, 832.0)
                    .build();
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Tear down the whole sidecar process tree on exit (Windows has no process groups).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(child) = app_handle.state::<Sidecar>().0.lock().unwrap().take() {
                    let pid = child.pid();
                    let _ = child.kill();
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .creation_flags(0x08000000) // CREATE_NO_WINDOW — no console flash on exit
                            .spawn();
                    }
                }
            }
        });
}
