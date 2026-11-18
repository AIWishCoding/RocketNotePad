use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::paths;

/// 「关于」面板展示的运行期事实。路径取自真正生效的候选位置，
/// 不让前端按平台猜一个可能并不存在的目录出来。
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct AppInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub config_path: String,
    pub config_dir: String,
    /// 配置文件是否已经生成：没生成时「打开配置文件夹」只能退而打开目录
    pub config_exists: bool,
    pub exe_path: String,
}

/// 已经写过配置就报那一份，否则报首选位置（首次启动时文件还没生成）。
/// 一个候选都没有时返回 None，前端据此隐藏路径行。
pub fn pick_config(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|p| p.is_file())
        .or_else(|| candidates.first())
        .cloned()
}

fn dir_of(path: Option<&Path>) -> String {
    path.and_then(Path::parent)
        .map(|d| d.display().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let config = pick_config(&paths::files_of(super::config::CONFIG_FILE, &app));
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        config_dir: dir_of(config.as_deref()),
        config_exists: config.as_deref().is_some_and(Path::is_file),
        config_path: config.map(|p| p.display().to_string()).unwrap_or_default(),
        exe_path: std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("rnp-app-{}-{}-{}", std::process::id(), n, name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_reported_config_is_the_one_actually_in_use() {
        let primary = tmp("primary");
        let fallback = tmp("fallback");
        let a = primary.join("rocketnotepad.config.json");
        let b = fallback.join("rocketnotepad.config.json");
        // 还没写过配置时报首选位置，用户照着这个路径就能找到将来的文件
        assert_eq!(pick_config(&[a.clone(), b.clone()]), Some(a.clone()));
        // 首选写不进去、实际落在回退位置时，报的必须是回退那份
        std::fs::write(&b, "{}").unwrap();
        assert_eq!(pick_config(&[a.clone(), b.clone()]), Some(b.clone()));
        std::fs::write(&a, "{}").unwrap();
        assert_eq!(pick_config(&[a.clone(), b]), Some(a));
        assert_eq!(pick_config(&[]), None);
    }

    #[test]
    fn the_config_dir_is_the_parent_of_the_reported_file() {
        let dir = tmp("parent");
        let file = dir.join("rocketnotepad.config.json");
        assert_eq!(dir_of(Some(file.as_path())), dir.display().to_string());
        assert_eq!(dir_of(None), "");
    }

    /// 「关于」面板报的版本必须和安装包上写的是同一个，三处版本不能各走各的
    #[test]
    fn the_crate_version_matches_the_bundle_version() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"].as_str(), Some(env!("CARGO_PKG_VERSION")));
    }
}
