//! 零依赖启动探针：只用到 std 与几个 Win32 API，不链接 tauri/wry/webview2。
//!
//! 正式包在客户机上崩在 `__fastfail` 且一行启动日志都没有时，需要区分两件事：
//! 「这台机器的 Rust/CRT 运行环境本身跑不起来」和「是我们的业务代码跑不起来」。
//! 探针把每一步的结论实时落到多个候选位置（含 %TEMP%，那里几乎总是可写的），
//! 只要有一处写成功，就能拿到它到底走到了第几步。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const NAME: &str = "rnp-probe.log";

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        pub fn MessageBoxW(hwnd: *mut c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn RegOpenKeyExW(hkey: *mut c_void, sub: *const u16, flags: u32, sam: u32, out: *mut *mut c_void) -> i32;
        pub fn RegQueryValueExW(hkey: *mut c_void, name: *const u16, reserved: *mut u32, kind: *mut u32, buf: *mut u8, len: *mut u32) -> i32;
        pub fn RegCloseKey(hkey: *mut c_void) -> i32;
    }

    pub const KEY_WOW64_64KEY: u32 = 0x0100;
    pub const KEY_WOW64_32KEY: u32 = 0x0200;
    pub const KEY_READ: u32 = 0x20019;
    pub const HKLM: *mut c_void = 0x8000_0002 as *mut c_void;
    pub const HKCU: *mut c_void = 0x8000_0001 as *mut c_void;

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// 探针自己的日志：直接 open+write，不用 format!、不用 BufWriter。
/// 主程序如果是因为栈溢出死的，探针里任何“顺手”的写法都可能一起死，所以这里越笨越好。
fn write_raw(dir: &Path, text: &str) -> bool {
    let path = dir.join(NAME);
    match OpenOptions::new().create(true).write(true).truncate(true).open(&path) {
        Ok(mut f) => f.write_all(text.as_bytes()).and_then(|_| f.write_all(b"\n")).is_ok(),
        Err(_) => false,
    }
}

/// 最近一次写成功的位置，供结尾汇报用；探针全程只认这一个变量，不再多做一次写盘。
static LAST: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 不依赖任何环境变量的兜底位置（Windows 上 std 取 %TEMP%，受管环境里它可能指向写不了的地方）
fn first_writable(lines: &[String]) -> Option<PathBuf> {
    for dir in candidate_dirs(false) {
        if write_raw(&dir, &lines.join("\n")) {
            return Some(dir.join(NAME));
        }
    }
    None
}

/// 候选位置逐个写整份日志。每次全量重写，崩在半路也留得住前面几步。
/// 默认只往临时目录这类可写位置落，加 `--here` 才会写进 exe 同目录，避免探针自己留下垃圾文件。
fn flush_all(lines: &[String], also_exe_dir: bool) {
    for dir in candidate_dirs(also_exe_dir) {
        let _ = fs::create_dir_all(&dir);
        if write_raw(&dir, &lines.join("\n")) {
            *LAST.lock().unwrap() = Some(dir.join(NAME));
            return;
        }
    }
}

fn candidate_dirs(also_exe_dir: bool) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if also_exe_dir {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                dirs.push(parent.to_path_buf());
            }
        }
    }
    if let Some(dir) = std::env::var_os("TEMP").map(PathBuf::from) {
        dirs.push(dir);
    }
    dirs.push(std::env::temp_dir());
    #[cfg(target_os = "windows")]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("com.maple.rocketnotepad"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd);
    }
    dirs
}

fn main() {
    // panic=abort 下默认什么声音都没有，这里保证至少留一行
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("探针 panic：{info}");
        let _ = std::io::stderr().write_all(msg.as_bytes());
        let _ = std::io::stderr().write_all(b"\n");
        let path = std::env::temp_dir().join(NAME);
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{msg}");
        }
    }));

    let also_exe_dir = std::env::args().any(|a| a == "--here");
    // 从脚本里跑时不弹窗，免得把调用方卡住
    #[cfg(target_os = "windows")]
    let no_dialog = std::env::args().any(|a| a == "--quiet");

    // 第 0 步：用最笨的方式确认「这台机器允许我们写文件」，它失败时后面的都别抱希望
    let mut lines: Vec<String> = vec!["rnp-probe 1.0".to_string()];
    let bootstrap = first_writable(&lines);
    *LAST.lock().unwrap() = bootstrap.clone();
    lines.push(format!(
        "[0] 裸写日志：{}",
        bootstrap.as_ref().map_or_else(|| "所有位置都写不了".to_string(), |p| p.display().to_string())
    ));
    let mut say = |line: String| {
        lines.push(line.clone());
        let _ = std::io::stderr().write_all(line.as_bytes());
        let _ = std::io::stderr().write_all(b"\n");
        flush_all(&lines, also_exe_dir);
    };
    say(format!("进程已启动，参数 {:?}", std::env::args().skip(1).collect::<Vec<_>>()));
    say(format!(
        "current_exe：{}",
        std::env::current_exe().map_or_else(|e| format!("失败 {e}"), |p| p.display().to_string())
    ));
    say(format!("临时目录：{}", std::env::temp_dir().display()));
    for key in ["TEMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE"] {
        say(format!("{key}：{}", std::env::var(key).unwrap_or_else(|_| "没有".into())));
    }
    say(format!("系统：{} {}，Rust std 正常", std::env::consts::OS, std::env::consts::ARCH));

    #[cfg(target_os = "windows")]
    {
        let build = reg_string(win::HKLM, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "CurrentBuildNumber", true);
        let release = reg_string(win::HKLM, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "ReleaseId", true);
        let product = reg_string(win::HKLM, "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "ProductName", true);
        say(format!("系统版本：{product}，Build {build}，ReleaseId {release}"));

        const SUB: &str = "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-4295-8BDF-00C3A9A7E4C5}";
        let machine = format!(
            "64位视图 {} / 32位视图 {}",
            reg_string(win::HKLM, SUB, "pv", true),
            reg_string(win::HKLM, SUB, "pv", false)
        );
        let user = reg_string(win::HKCU, SUB, "pv", true);
        let fixed = Path::new(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application");
        let fixed_ok = fs::read_dir(fixed).map_or(false, |mut it| it.next().is_some());
        say(format!("WebView2：机器[{machine}] 用户[{user}] 固定版目录{:?}", fixed_ok));

        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let target = Path::new(&program_files).join("RocketNotepad").join("probe-write-test.txt");
        say(format!("往安装目录写文件：{}", match fs::write(&target, b"ok") {
            Ok(()) => { let _ = fs::remove_file(&target); "成功".into() }
            Err(e) => format!("失败 {e}"),
        }));

        // 探针自己就依赖这个 dll，先确认它在不在，免得把「缺 dll」误判成「代码有问题」
        let mut vc = Vec::new();
        for dir in ["System32", "SysWOW64"] {
            for name in ["vcruntime140.dll", "vcruntime140_1.dll"] {
                let p = Path::new(r"C:\Windows").join(dir).join(name);
                if let Ok(m) = fs::metadata(&p) {
                    vc.push(format!("{} {}B", p.display(), m.len()));
                }
            }
        }
        say(format!("VC++ 运行库：{}", if vc.is_empty() { "System32/SysWOW64 里都没有 vcruntime140".into() } else { vc.join("；") }));
    }

    drop(say);
    let written = LAST.lock().unwrap().clone();
    lines.push(format!(
        "日志已写到：{}",
        written.as_ref().map_or_else(|| "一处都写不了".to_string(), |p| p.display().to_string())
    ));
    flush_all(&lines, also_exe_dir);

    #[cfg(target_os = "windows")]
    if !no_dialog {
        let text = format!(
            "{}{}",
            lines.join("\n"),
            if written.is_some() { "" } else { "\n\n注意：日志文件一处都写不了。" }
        );
        let (t, c) = (win::wide(&text), win::wide("RocketNotePad 探针"));
        unsafe { win::MessageBoxW(std::ptr::null_mut(), t.as_ptr(), c.as_ptr(), 0x40) };
    }
    #[cfg(not(target_os = "windows"))]
    println!("{}", lines.join("\n"));
}

#[cfg(target_os = "windows")]
fn reg_string(hive: *mut std::ffi::c_void, sub_key: &str, value: &str, wide_view: bool) -> String {
    let (sub, name) = (win::wide(sub_key), win::wide(value));
    let sam = win::KEY_READ | if wide_view { win::KEY_WOW64_64KEY } else { win::KEY_WOW64_32KEY };
    unsafe {
        let mut key = std::ptr::null_mut();
        if win::RegOpenKeyExW(hive, sub.as_ptr(), 0, sam, &mut key) != 0 {
            return "读不到键".into();
        }
        let mut kind = 0u32;
        let mut bytes = vec![0u8; 1024];
        let mut len = bytes.len() as u32;
        let code = win::RegQueryValueExW(key, name.as_ptr(), std::ptr::null_mut(), &mut kind, bytes.as_mut_ptr(), &mut len);
        win::RegCloseKey(key);
        if code != 0 {
            return format!("读不到值({code})");
        }
        if kind == 1 {
            String::from_utf8_lossy(&bytes[..len.saturating_sub(1) as usize]).into_owned()
        } else if kind == 3 {
            let units = std::slice::from_raw_parts(bytes.as_ptr() as *const u16, len as usize / 2);
            let mut n = units.len();
            while n > 0 && units[n - 1] == 0 {
                n -= 1;
            }
            String::from_utf16_lossy(&units[..n])
        } else {
            format!("类型 {kind}")
        }
    }
}
