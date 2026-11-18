//! 应用自己文件的落盘位置（配置、最近打开、启动日志共用同一套候选目录）。
//!
//! Windows 保持「exe 同目录优先」的便携语义：整个文件夹拷到 U 盘，设置跟着走；装进
//! `Program Files` 这类普通权限写不进去的位置时自动退回 `%APPDATA%\com.maple.rocketnotepad`。
//! macOS 反过来：`.app` 是交付物，不该往里塞运行期文件，统一收进用户主目录下的隐藏文件夹
//! `~/.rocketnote`，和大多数本地工具的习惯一致，卸载后也一眼能看到还剩了什么。

use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri::Manager;

/// macOS 上的应用目录名（用户主目录下的隐藏文件夹）
pub const DOT_DIR: &str = ".rocketnote";

/// 应用标识符与 `tauri.conf.json` 保持一致；非 macOS 的回退位置要和
/// `app.path().app_config_dir()` 对齐
pub const APP_ID: &str = "com.maple.rocketnotepad";

/// 纯函数版本，便于单测：`os` 传 `std::env::consts::OS`，各位置拿不到就传 `None`。
/// macOS 只认 `~/.rocketnote`（拿不到主目录时才退回应用配置目录）；其余平台 exe 同目录优先。
pub fn app_dirs(
    os: &str,
    home: Option<PathBuf>,
    exe_dir: Option<PathBuf>,
    app_config: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if os == "macos" {
        match home {
            Some(dir) => out.push(dir.join(DOT_DIR)),
            // HOME 没设置时退回系统应用配置目录，别落到一个候选位置都没有
            None => out.extend(app_config),
        }
        return out;
    }
    if let Some(dir) = exe_dir {
        out.push(dir);
    }
    if let Some(dir) = app_config {
        if !out.contains(&dir) {
            out.push(dir);
        }
    }
    out
}

/// `app_dirs` 里某个文件的候选路径，按优先顺序
pub fn app_files(
    name: &str,
    os: &str,
    home: Option<PathBuf>,
    exe_dir: Option<PathBuf>,
    app_config: Option<PathBuf>,
) -> Vec<PathBuf> {
    app_dirs(os, home, exe_dir, app_config)
        .into_iter()
        .map(|dir| dir.join(name))
        .collect()
}

/// 当前平台上我们自己的目录
pub fn own_dirs(app_config: Option<PathBuf>) -> Vec<PathBuf> {
    app_dirs(std::env::consts::OS, dirs::home_dir(), exe_dir(), app_config)
}

/// 当前平台上某个应用文件的候选路径
pub fn own_files(name: &str, app_config: Option<PathBuf>) -> Vec<PathBuf> {
    app_files(name, std::env::consts::OS, dirs::home_dir(), exe_dir(), app_config)
}

/// 候选路径 + 一次性搬迁老位置的同名文件（macOS 换目录后设置和最近打开不能凭空消失）
pub fn files_for(name: &str, app_config: Option<PathBuf>) -> Vec<PathBuf> {
    let files = own_files(name, app_config.clone());
    if let Some(primary) = files.first() {
        adopt(primary, &legacy_dirs(app_config));
    }
    files
}

/// 带 `AppHandle` 的版本：回退位置取 `app.path().app_config_dir()`，与旧行为对齐
pub fn files_of(name: &str, app: &AppHandle) -> Vec<PathBuf> {
    files_for(name, Some(app_config_dir(app)))
}

pub fn app_config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")))
}

/// 按优先级读第一个存在且能读的文件；都没有时 None（首次启动）
pub fn read_first(paths: &[PathBuf]) -> Option<String> {
    paths.iter().find_map(|p| fs::read_to_string(p).ok())
}

/// 写到第一个能写的位置，返回真正落盘的路径；全都写不了时报出最后一个错误
pub fn write_first(paths: &[PathBuf], content: &[u8]) -> Result<PathBuf, String> {
    let mut last = String::from("没有可用的应用目录");
    for path in paths {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        match fs::write(path, content) {
            Ok(()) => return Ok(path.clone()),
            Err(e) => last = format!("{}: {}", path.display(), e),
        }
    }
    Err(last)
}

pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().filter(|d| !d.as_os_str().is_empty()).map(PathBuf::from))
}

/// 没有 `AppHandle` 时的回退目录，和 `app.path().app_config_dir()` 指向同一套位置
pub fn fallback_app_config() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(APP_ID))
}

/// 换目录（macOS 从 `.app` 内 / `~/Library/Application Support` 迁到 `~/.rocketnote`）之后，
/// 老位置的同一个文件先搬过来，用户的设置和最近打开不能凭空消失。
/// 新位置已有文件时什么都不做。
pub fn adopt(primary: &Path, legacy_dirs: &[PathBuf]) -> Option<PathBuf> {
    if primary.exists() {
        return None;
    }
    let name = primary.file_name()?;
    for dir in legacy_dirs {
        let old = dir.join(name);
        if old == primary || !old.is_file() {
            continue;
        }
        if let Some(parent) = primary.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::copy(&old, primary) {
            Ok(_) => return Some(primary.to_path_buf()),
            // 搬不动就照常走「文件不存在」的分支，不该把启动卡住
            Err(_) => continue,
        }
    }
    None
}

/// macOS 上被弃用的老位置（`adopt` 的来源，按顺序试）
pub fn legacy_dirs(app_config: Option<PathBuf>) -> Vec<PathBuf> {
    if std::env::consts::OS != "macos" {
        return Vec::new();
    }
    [exe_dir(), app_config, dirs::config_dir().map(|d| d.join(APP_ID))]
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(p: &str) -> Option<PathBuf> {
        Some(PathBuf::from(p))
    }

    const MAC_HOME: &str = "/Users/maple";
    const MAC_BUNDLE: &str = "/Applications/RocketNotePad.app/Contents/MacOS";
    const MAC_APP_SUPPORT: &str = "/Users/maple/Library/Application Support/com.maple.rocketnotepad";

    #[test]
    fn macos_keeps_app_files_out_of_the_bundle() {
        assert_eq!(
            app_dirs("macos", some(MAC_HOME), some(MAC_BUNDLE), some(MAC_APP_SUPPORT)),
            vec![PathBuf::from("/Users/maple/.rocketnote")]
        );
        assert_eq!(
            app_files("rocketnotepad.config.json", "macos", some(MAC_HOME), some(MAC_BUNDLE), some(MAC_APP_SUPPORT)),
            vec![PathBuf::from("/Users/maple/.rocketnote/rocketnotepad.config.json")]
        );
        // HOME 拿不到时还有回退，不能一个位置都没有
        assert_eq!(
            app_dirs("macos", None, some(MAC_BUNDLE), some(MAC_APP_SUPPORT)),
            vec![PathBuf::from(MAC_APP_SUPPORT)]
        );
        assert_eq!(app_dirs("macos", None, some(MAC_BUNDLE), None), Vec::<PathBuf>::new());
    }

    #[test]
    fn windows_and_linux_still_prefer_the_exe_dir() {
        // 便携优先：整个文件夹拷走，设置跟着走
        assert_eq!(
            app_dirs("windows", some(MAC_HOME), some("/app/dir"), some("/cfg/com.maple.rocketnotepad")),
            vec![PathBuf::from("/app/dir"), PathBuf::from("/cfg/com.maple.rocketnotepad")]
        );
        assert_eq!(app_dirs("windows", None, None, some("/cfg")), vec![PathBuf::from("/cfg")]);
        assert_eq!(app_dirs("linux", None, some("/app/dir"), None), vec![PathBuf::from("/app/dir")]);
        // 配置目录就是 exe 同目录时只留一条，避免同一个文件试两遍
        assert_eq!(app_dirs("windows", None, some("/app/dir"), some("/app/dir")), vec![PathBuf::from("/app/dir")]);
        assert_eq!(app_files("recent.json", "windows", None, some("/app/dir"), None), vec![PathBuf::from("/app/dir/recent.json")]);
        assert!(app_dirs("windows", None, None, None).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_legacy_places_are_only_offered_on_macos() {
        let dirs = legacy_dirs(some(MAC_APP_SUPPORT));
        // 系统应用配置目录（上一版写 recent.json 的地方）必须在来源里
        assert!(dirs.contains(&PathBuf::from(MAC_APP_SUPPORT)), "{dirs:?}");
        assert!(dirs.contains(&dirs::config_dir().unwrap().join(APP_ID)), "{dirs:?}");
        // 新的家目录不该出现在来源里，否则会把文件搬给自己
        assert!(own_dirs(None).iter().all(|d| !dirs.contains(d)));
    }

    fn tmp(name: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("rnp-paths-{}-{}-{}", std::process::id(), n, name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_take_the_first_candidate_and_writes_the_first_writable() {
        let a = tmp("read-a");
        let b = tmp("read-b");
        std::fs::write(a.join("recent.json"), "便携").unwrap();
        std::fs::write(b.join("recent.json"), "安装").unwrap();
        let paths = vec![a.join("recent.json"), b.join("recent.json")];
        assert_eq!(read_first(&paths).as_deref(), Some("便携"));
        assert_eq!(read_first(&[]), None);
        assert_eq!(read_first(&[a.join("nope.json")]), None);

        // 主位置写不了（同名目录挡着）就退到下一个
        let blocked = tmp("blocked");
        std::fs::create_dir_all(blocked.join("recent.json")).unwrap();
        let paths = vec![blocked.join("recent.json"), b.join("recent.json")];
        assert_eq!(write_first(&paths, b"ok").unwrap(), b.join("recent.json"));
        assert_eq!(std::fs::read_to_string(b.join("recent.json")).unwrap(), "ok");

        // 从来没被建过的目录要补上，否则首次启动无处可写
        let fresh = tmp("fresh").join("missing-sub");
        assert_eq!(
            write_first(&[fresh.join("recent.json")], b"x").unwrap(),
            fresh.join("recent.json")
        );
        assert_eq!(read_first(&[fresh.join("recent.json")]).as_deref(), Some("x"));
        assert!(write_first(&[], b"x").is_err());
    }

    #[test]
    fn a_file_from_the_old_place_is_carried_over_once() {
        let root = tmp("adopt");
        let new_dir = root.join(".rocketnote");
        let old_dir = root.join("bundle").join("MacOS");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join("rocketnotepad.config.json"), "旧配置").unwrap();

        let primary = new_dir.join("rocketnotepad.config.json");
        assert_eq!(adopt(&primary, &[old_dir.clone()]).as_deref(), Some(primary.as_path()));
        assert_eq!(std::fs::read_to_string(&primary).unwrap(), "旧配置");
        // 新目录还没被建过时也要能搬（上面 create_dir_all 是 adopt 自己做的）
        assert!(new_dir.is_dir());

        // 已经有文件就不覆盖，老文件也不删，用户想回退还在
        std::fs::write(old_dir.join("rocketnotepad.config.json"), "被改过的旧配置").unwrap();
        assert_eq!(adopt(&primary, &[old_dir.clone()]), None);
        assert_eq!(std::fs::read_to_string(&primary).unwrap(), "旧配置");

        // 没有可搬的东西时返回 None，回退目录本身不存在也不报错
        assert_eq!(adopt(&new_dir.join("recent.json"), &[old_dir.clone()]), None);
        assert_eq!(adopt(&primary, &[]), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
