//! Windows 启动前置检查。
//!
//! release 构建是 GUI 子系统（没有控制台）且 `panic = "abort"`，所以 WebView2 运行时缺失等
//! 启动失败只会静默中止，双击后表现为「没反应、也没报错」。这里把失败变成看得见的弹窗，
//! 并把结论同步写进 exe 同目录的启动日志。

use std::path::Path;

use rocketnotepad_lib::{startup, win_dialog};
use windows::core::PCWSTR;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
};

/// Edge WebView2 Runtime 在注册表里的客户端 GUID
const WEBVIEW2_CLIENT_KEY: &str =
    r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

const WEBVIEW2_MISSING: &str = concat!(
    "RocketNotePad 需要 Microsoft Edge WebView2 运行时才能显示窗口，当前系统没有检测到它。\n\n",
    "请按下面任一方式安装后重新启动：\n",
    "1. 运行 RocketNotePad 安装包（RocketNotePad_",
    env!("CARGO_PKG_VERSION"),
    "_x64-setup.exe），它会自动引导安装；\n",
    "2. 或到 https://developer.microsoft.com/microsoft-edge/webview2/ 下载 Evergreen Bootstrapper 运行；\n",
    "3. 或先安装/更新 Microsoft Edge 浏览器。\n\n",
    "点“是”仍尝试直接启动一次，点“否”退出。\n\n",
    "本次启动的过程会补写到 exe 同目录（或配置目录、临时目录）的 rocketnotepad.startup.log，把它发回来就能定位。"
);

/// 让崩溃可见：无控制台时 panic 只会静默中止，这里先记日志再弹窗。
pub fn install() {
    std::panic::set_hook(Box::new(|info| {
        let payload = info.payload();
        let text = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "未知错误".to_string());
        let where_ = info.location().map_or("", |l| l.file());
        startup::note(&format!("后端：panic 于 {where_} —— {text}"));
        // 崩了就是「出问题」，默认档下这里必须落盘，否则弹窗说完就查无实据
        startup::flush();
        win_dialog::fail(
            "RocketNotePad 意外崩溃",
            &format!("{text}\n\n位置：{where_}\n\n启动步骤已经补写到 exe 同目录（或配置目录、临时目录）的 rocketnotepad.startup.log。"),
        );
    }));
}

/// 注册表与固定安装目录任一命中即认为运行时存在，Ok 里带命中来源；Err 表示完全找不到痕迹。
pub fn check_webview2() -> Result<String, ()> {
    for (root, sub_key) in [
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT_KEY),
        (HKEY_LOCAL_MACHINE, &format!("WOW6432Node\\{WEBVIEW2_CLIENT_KEY}")),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT_KEY),
    ] {
        if let Some(version) = reg_version(root, sub_key) {
            return Ok(format!("注册表项 {sub_key}，版本 {version}"));
        }
    }

    // 精简镜像可能没有写 EdgeUpdate 客户端项，但固定版本运行时的文件仍在磁盘上
    for dir in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        let Some(root) = std::env::var_os(dir) else {
            continue;
        };
        let path = Path::new(&root).join("Microsoft").join("EdgeWebView");
        if has_webview2_binary(&path) {
            return Ok(format!("固定版运行文件在 {}", path.display()));
        }
    }
    Err(())
}

/// 提示运行时缺失；返回 true 表示用户仍要继续启动。
pub fn warn_missing() -> bool {
    win_dialog::confirm("未检测到 Microsoft Edge WebView2 运行时", WEBVIEW2_MISSING)
}

fn reg_version(root: HKEY, sub_key: &str) -> Option<String> {
    let key = wide(sub_key);
    let value = wide("pv");
    let mut buf = [0u16; 64];
    let mut size = (buf.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
    };
    if status.0 != 0 {
        return None;
    }
    let chars = (size as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..chars]).trim_end_matches('\0').to_string();
    if text.is_empty() || text == "0.0.0.0" {
        None
    } else {
        Some(text)
    }
}

fn has_webview2_binary(edge_web_view_dir: &Path) -> bool {
    let Ok(versions) = std::fs::read_dir(edge_web_view_dir.join("Application")) else {
        return false;
    };
    versions
        .flatten()
        .any(|entry| entry.path().join("msedgewebview2.exe").is_file())
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
