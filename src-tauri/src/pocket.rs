// Pocket runtime: "Run on this phone" — boots the bundled Node backend on-device.
//
// The runtime rides in the APK as jniLibs (lib*.so is the only exec()-able location at
// targetSdk 29+; see scripts/fetch-pocket-runtime.sh for the packaging). At start we recreate
// the real binary names as symlinks under filesDir (exec through a symlink is allowed — SELinux
// checks the target's context), extract the embedded pure-JS backend payload next to them, and
// spawn node with the same env contract the desktop sidecar gets, plus the pocket hooks:
// claude is a musl binary run through the bundled Alpine loader (CORRAL_EXEC_LOADER), and its
// DNS is routed through the backend's CONNECT proxy (musl can't resolve on Android —
// CORRAL_DNS_PROXY_PORT / CORRAL_AGENT_HTTPS_PROXY).
//
// The per-run CORRAL_TOKEN is mandatory here: 127.0.0.1 is reachable by every app on the phone,
// and the loopback dev-permissive mode the desktop enjoys would hand them the agent loop.
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

const PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pocket-payload.tar.gz"));
const PAYLOAD_SHA: &str = include_str!(concat!(env!("OUT_DIR"), "/pocket-payload.sha"));
const DNS_PROXY_PORT: u16 = 8899;

pub struct Pocket(pub Mutex<Option<Run>>);
pub struct Run {
    child: Child,
    port: u16,
    token: String,
}

// In-flight `claude auth login` (OAuth manual paste-back): child + its accumulated output +
// stdin for the code. Login MUST run inside the app (this process): the credentials land in the
// app-private HOME, which adb shell can't write.
pub struct PocketLogin(pub Mutex<Option<LoginRun>>);
pub struct LoginRun {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
    out: std::sync::Arc<Mutex<String>>,
}

#[derive(serde::Serialize, Clone)]
pub struct PocketInfo {
    running: bool,
    port: u16,
    token: String,
}

// --- foreground service bridge ---
// PocketBridge.init (called from the CI-patched MainActivity, pocket flavor only) lands in
// nativeInit below with a JNIEnv; we keep the VM + a global ref to the class so start/stop can
// call back into Kotlin from any thread. Slim builds never call init — BRIDGE stays empty and
// fgs() is a no-op, matching the rest of pocket being dormant there.
struct Bridge {
    vm: jni::JavaVM,
    cls: jni::objects::GlobalRef,
}
static BRIDGE: OnceLock<Bridge> = OnceLock::new();

#[no_mangle]
pub extern "system" fn Java_io_github_mapika_corral_PocketBridge_nativeInit(
    env: jni::JNIEnv,
    class: jni::objects::JClass,
) {
    let Ok(vm) = env.get_java_vm() else { return };
    let Ok(cls) = env.new_global_ref(&class) else { return };
    let _ = BRIDGE.set(Bridge { vm, cls });
}

// Keep the app process un-cached while the backend runs (phantom-process killer protection).
fn fgs(method: &'static str) {
    let Some(b) = BRIDGE.get() else { return };
    let Ok(mut env) = b.vm.attach_current_thread() else { return };
    let cls = unsafe { jni::objects::JClass::from_raw(b.cls.as_raw()) };
    if env.call_static_method(&cls, method, "()V", &[]).is_err() {
        let _ = env.exception_describe(); // full Java stack → logcat (W/System.err)
        let _ = env.exception_clear();
        log::warn!("PocketBridge.{method} failed");
    }
}

// nativeLibraryDir without JNI: the app's own cdylib (libapp_lib.so) is extracted to and loaded
// from exactly that directory, so its mapping in /proc/self/maps reveals the path. (Tauri doesn't
// expose the Android context to app code, so the usual getApplicationInfo() route isn't open.)
fn native_library_dir() -> Option<PathBuf> {
    let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
    for line in maps.lines() {
        if let Some(idx) = line.find('/') {
            let path = &line[idx..];
            if path.ends_with("/libapp_lib.so") {
                return Path::new(path).parent().map(|p| p.to_path_buf());
            }
        }
    }
    None
}

fn pocket_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map(|d| d.join("pocket")).map_err(|e| e.to_string())
}

// Extract the embedded backend payload, skipped when the on-disk sha matches (the sha is computed
// at build time by prepare-pocket.mjs — nothing hashes at runtime).
fn extract_payload(root: &Path) -> Result<(), String> {
    let sha_file = root.join("payload.sha");
    let backend = root.join("backend");
    if backend.is_dir() && std::fs::read_to_string(&sha_file).ok().as_deref() == Some(PAYLOAD_SHA) {
        return Ok(());
    }
    if PAYLOAD.is_empty() {
        return Err("no pocket payload embedded in this build".into());
    }
    let _ = std::fs::remove_dir_all(&backend);
    std::fs::create_dir_all(&backend).map_err(|e| e.to_string())?;
    let tarball = flate2::read::GzDecoder::new(PAYLOAD);
    tar::Archive::new(tarball).unpack(&backend).map_err(|e| format!("payload extract: {e}"))?;
    std::fs::write(&sha_file, PAYLOAD_SHA).map_err(|e| e.to_string())?;
    Ok(())
}

// Recreate the real binary/library names as symlinks pointing into nativeLibraryDir, per
// runtime-map.txt ("kind original packed" lines, kinds bin|lib). Rebuilt on every start — the
// map changes across APK updates and symlinks are cheap.
fn link_runtime(root: &Path, native: &Path) -> Result<(PathBuf, PathBuf), String> {
    let map = std::fs::read_to_string(root.join("backend/runtime-map.txt")).map_err(|e| e.to_string())?;
    let (bin, lib) = (root.join("rt/bin"), root.join("rt/lib"));
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&lib).map_err(|e| e.to_string())?;
    for line in map.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() != 3 {
            continue;
        }
        let link = (if f[0] == "bin" { &bin } else { &lib }).join(f[1]);
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(native.join(f[2]), &link).map_err(|e| e.to_string())?;
    }
    Ok((bin, lib))
}

// A previous app process may have left its node running (Android kills us without callbacks),
// and server.js's single-instance guard would then make the fresh spawn exit on EADDRINUSE.
fn reap_stale(root: &Path) {
    if let Ok(s) = std::fs::read_to_string(root.join("run.pid")) {
        if let Ok(pid) = s.trim().parse::<i32>() {
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
    let _ = std::fs::remove_file(root.join("run.pid"));
}

fn gen_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

fn choose_port() -> u16 {
    for p in [7878u16, 0] {
        if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", p)) {
            if let Ok(a) = l.local_addr() {
                return a.port();
            }
        }
    }
    7878
}

// Keep node's stdio flowing (it blocks on a full pipe) and surface it in logcat.
fn drain<T: Read + Send + 'static>(pipe: Option<T>, tag: &'static str) {
    if let Some(p) = pipe {
        std::thread::spawn(move || {
            for line in BufReader::new(p).lines().map_while(Result::ok) {
                log::info!("[{tag}] {line}");
            }
        });
    }
}

// Shared env contract for anything spawned from the pocket runtime (backend, claude login):
// bionic-linked binaries resolve libs via LD_LIBRARY_PATH, HOME/TMPDIR live in the pocket root.
fn apply_runtime_env(cmd: &mut Command, root: &Path, native: &Path) {
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let (rt_bin, rt_lib) = (root.join("rt/bin"), root.join("rt/lib"));
    cmd.env("LD_LIBRARY_PATH", format!("{}:{}", s(&rt_lib), s(native)))
        .env("PATH", format!("{}:/system/bin:/system/xbin", s(&rt_bin)))
        .env("HOME", s(&root.join("home")))
        .env("TMPDIR", s(&root.join("tmp")))
        .env("LANG", "en_US.UTF-8")
        .env("USE_BUILTIN_RIPGREP", "0") // claude's npm-shipped rg is glibc; the bionic one on PATH works
        .env("DISABLE_AUTOUPDATER", "1") // runtime updates ride APK updates (Play policy)
        .env("DISABLE_TELEMETRY", "1");
}

fn spawn_backend(root: &Path, native: &Path) -> Result<Run, String> {
    extract_payload(root)?;
    let (rt_bin, _rt_lib) = link_runtime(root, native)?;
    let home = root.join("home");
    let tmp = root.join("tmp");
    std::fs::create_dir_all(home.join("projects")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    reap_stale(root);
    let port = choose_port();
    let token = gen_token();
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let mut cmd = Command::new(native.join("libnode_exec.so"));
    cmd.arg("server.js")
        .current_dir(root.join("backend"))
        .env("PORT", port.to_string())
        .env("CORRAL_BIND", "127.0.0.1")
        .env("CORRAL_TOKEN", &token)
        .env("CORRAL_CLAUDE_BIN", s(&rt_bin.join("claude")))
        .env("CORRAL_EXEC_LOADER", s(&rt_bin.join("ld-musl")))
        .env("CORRAL_DNS_PROXY_PORT", DNS_PROXY_PORT.to_string())
        .env("CORRAL_AGENT_HTTPS_PROXY", format!("http://127.0.0.1:{DNS_PROXY_PORT}"));
    apply_runtime_env(&mut cmd, root, native);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn node: {e}"))?;
    let _ = std::fs::write(root.join("run.pid"), child.id().to_string());
    drain(child.stdout.take(), "pocket");
    drain(child.stderr.take(), "pocket!");
    // Wait for the listener before handing the base URL to the webview (desktop sidecar pattern).
    let mut up = false;
    for _ in 0..600 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            up = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    if !up {
        let _ = child.kill();
        return Err("backend did not start listening within 15s".into());
    }
    Ok(Run { child, port, token })
}

// Like drain(), but also accumulates lines for the login flow (the OAuth URL + status text).
fn drain_into<T: Read + Send + 'static>(pipe: Option<T>, buf: std::sync::Arc<Mutex<String>>) {
    if let Some(p) = pipe {
        std::thread::spawn(move || {
            for line in BufReader::new(p).lines().map_while(Result::ok) {
                log::info!("[login] {line}");
                let mut b = buf.lock().unwrap();
                b.push_str(&line);
                b.push('\n');
            }
        });
    }
}

// Start `claude auth login --claudeai` (OAuth manual paste-back) and return its output once the
// login URL appears. Needs the backend running — its CONNECT proxy is the musl binary's DNS.
#[tauri::command]
pub async fn pocket_login(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let native = native_library_dir().ok_or("pocket runtime not present in this build")?;
        let root = pocket_root(&app)?;
        if app.state::<Pocket>().0.lock().unwrap().is_none() {
            return Err("start the on-device backend first".into());
        }
        let state = app.state::<PocketLogin>();
        if let Some(mut old) = state.0.lock().unwrap().take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        let rt_bin = root.join("rt/bin");
        let mut cmd = Command::new(rt_bin.join("ld-musl"));
        cmd.arg(rt_bin.join("claude"))
            .args(["auth", "login", "--claudeai"])
            .current_dir(root.join("home"))
            .env("HTTPS_PROXY", format!("http://127.0.0.1:{DNS_PROXY_PORT}"))
            .env("HTTP_PROXY", format!("http://127.0.0.1:{DNS_PROXY_PORT}"));
        apply_runtime_env(&mut cmd, &root, &native);
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn claude login: {e}"))?;
        let out = std::sync::Arc::new(Mutex::new(String::new()));
        let stdin = child.stdin.take();
        drain_into(child.stdout.take(), out.clone());
        drain_into(child.stderr.take(), out.clone());
        let mut snapshot = String::new();
        for _ in 0..300 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            snapshot = out.lock().unwrap().clone();
            if snapshot.contains("https://") {
                break;
            }
        }
        let got_url = snapshot.contains("https://");
        *state.0.lock().unwrap() = Some(LoginRun { child, stdin, out });
        if got_url {
            Ok(snapshot)
        } else {
            Err(format!("no login URL after 30s:\n{snapshot}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// Paste-back: hand the OAuth code to the waiting login child and report how it ended.
#[tauri::command]
pub async fn pocket_login_code(app: tauri::AppHandle, code: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<PocketLogin>();
        let mut run = state.0.lock().unwrap().take().ok_or("no login in progress")?;
        {
            use std::io::Write;
            let mut stdin = run.stdin.take().ok_or("login stdin gone")?;
            stdin
                .write_all(code.trim().as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .map_err(|e| format!("write code: {e}"))?;
        }
        for _ in 0..900 {
            if let Ok(Some(status)) = run.child.try_wait() {
                let outs = run.out.lock().unwrap().clone();
                return if status.success() {
                    Ok(outs)
                } else {
                    Err(format!("login exited {status}:\n{outs}"))
                };
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = run.child.kill();
        Err("login did not finish within 90s".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Runtime check, not a build flag: the same binary serves the slim and pocket flavors — only the
// pocket APK carries the jniLibs runtime, and that's what gates the UI.
#[tauri::command]
pub fn pocket_available() -> bool {
    native_library_dir().map(|d| d.join("libnode_exec.so").exists()).unwrap_or(false)
}

// Idempotent: a live backend is returned as-is (its token belongs to this app run). First run
// extracts the payload (~seconds), so the blocking work stays off the main thread.
#[tauri::command]
pub async fn pocket_start(app: tauri::AppHandle) -> Result<PocketInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let native = native_library_dir().ok_or("pocket runtime not present in this build")?;
        if !native.join("libnode_exec.so").exists() {
            return Err("pocket runtime not present in this build".into());
        }
        let root = pocket_root(&app)?;
        let state = app.state::<Pocket>();
        let mut guard = state.0.lock().unwrap();
        if let Some(run) = guard.as_mut() {
            if run.child.try_wait().ok().flatten().is_none() {
                return Ok(PocketInfo { running: true, port: run.port, token: run.token.clone() });
            }
        }
        let run = spawn_backend(&root, &native)?;
        let info = PocketInfo { running: true, port: run.port, token: run.token.clone() };
        *guard = Some(run);
        fgs("startService");
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn pocket_status(app: tauri::AppHandle) -> PocketInfo {
    use tauri::Manager;
    let state = app.state::<Pocket>();
    let mut guard = state.0.lock().unwrap();
    if let Some(run) = guard.as_mut() {
        if run.child.try_wait().ok().flatten().is_none() {
            return PocketInfo { running: true, port: run.port, token: run.token.clone() };
        }
    }
    PocketInfo { running: false, port: 0, token: String::new() }
}

#[tauri::command]
pub fn pocket_stop(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(mut run) = app.state::<Pocket>().0.lock().unwrap().take() {
        let _ = run.child.kill();
        let _ = run.child.wait();
    }
    if let Ok(root) = pocket_root(&app) {
        let _ = std::fs::remove_file(root.join("run.pid"));
    }
    fgs("stopService");
}
