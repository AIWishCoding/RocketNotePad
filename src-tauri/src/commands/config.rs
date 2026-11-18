use std::path::PathBuf;
use tauri::AppHandle;

use crate::paths;

/// 应用配置文件名。macOS 放在用户主目录下的隐藏文件夹 `~/.rocketnote`，
/// 其余平台保持 exe 同目录优先（便携语义），写不进去时退回应用配置目录。
pub const CONFIG_FILE: &str = "rocketnotepad.config.json";

/// 候选路径，顺带把老位置（macOS 的 `.app` 内和系统应用配置目录）已有的配置搬过来
fn real_paths(app: &AppHandle) -> Vec<PathBuf> {
    paths::files_of(CONFIG_FILE, app)
}

#[tauri::command]
pub fn read_app_config(app: AppHandle) -> Option<String> {
    paths::read_first(&real_paths(&app))
}

#[tauri::command]
pub fn write_app_config(app: AppHandle, content: String) -> Result<String, String> {
    paths::write_first(&real_paths(&app), content.as_bytes()).map(|p| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("rnp-cfg-{}-{}-{}", std::process::id(), n, name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_config_file_lands_in_the_hidden_folder_on_macos() {
        let home = Some(PathBuf::from("/Users/maple"));
        let bundle = Some(PathBuf::from("/Applications/RocketNotePad.app/Contents/MacOS"));
        let cfg = Some(PathBuf::from("/Users/maple/Library/Application Support/com.maple.rocketnotepad"));
        assert_eq!(
            paths::app_files(CONFIG_FILE, "macos", home, bundle, cfg),
            vec![PathBuf::from("/Users/maple/.rocketnote").join(CONFIG_FILE)]
        );
    }

    #[test]
    fn a_read_takes_the_first_candidate_and_a_write_stays_there() {
        let primary = tmp("roundtrip-primary");
        let fallback = tmp("roundtrip-fallback");
        std::fs::write(fallback.join(CONFIG_FILE), "{\"theme\":\"dark\"}").unwrap();
        let files = vec![primary.join(CONFIG_FILE), fallback.join(CONFIG_FILE)];
        // 主位置还没有文件时读回退那份；写永远写第一个能写的位置，之后读它也优先命中
        assert_eq!(paths::read_first(&files).as_deref(), Some("{\"theme\":\"dark\"}"));
        assert_eq!(paths::write_first(&files, b"{\"theme\":\"light\"}").unwrap(), files[0]);
        assert_eq!(paths::read_first(&files).as_deref(), Some("{\"theme\":\"light\"}"));
    }

    #[test]
    fn missing_config_everywhere_reads_as_none() {
        let files = vec![tmp("ghost-a").join(CONFIG_FILE), tmp("ghost-b").join(CONFIG_FILE)];
        assert_eq!(paths::read_first(&files), None);
    }

    #[test]
    fn adoption_carries_the_old_settings_without_touching_the_source() {
        let root = tmp("adopt");
        let legacy = root.join("Library").join("Application Support").join(paths::APP_ID);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join(CONFIG_FILE), "{\"startupLog\":true}").unwrap();
        let primary = root.join(".rocketnote").join(CONFIG_FILE);
        assert_eq!(paths::adopt(&primary, &[legacy.clone()]).as_deref(), Some(primary.as_path()));
        assert_eq!(std::fs::read_to_string(&primary).unwrap(), "{\"startupLog\":true}");
        // 老文件留着，用户想退回旧版本还能看见自己的设置
        assert!(legacy.join(CONFIG_FILE).is_file());
        // 已经搬过一次就不再动
        assert_eq!(paths::adopt(&primary, &[legacy]), None);
    }

    #[test]
    fn an_unwritable_primary_falls_back_to_the_next_candidate() {
        let blocked = tmp("blocked");
        // 把主位置变成一个同名目录：写它只会报错，只能退到下一个候选
        std::fs::create_dir_all(blocked.join(CONFIG_FILE)).unwrap();
        let home = tmp("blocked-home");
        let written = paths::write_first(&[blocked.join(CONFIG_FILE), home.join(CONFIG_FILE)], b"x").unwrap();
        assert_eq!(written, home.join(CONFIG_FILE));
        // 回退目录从来没被建过时也要补出来
        let fresh = tmp("fresh").join("missing-sub");
        assert_eq!(
            paths::write_first(&[fresh.join(CONFIG_FILE)], b"y").unwrap(),
            fresh.join(CONFIG_FILE)
        );
    }
}
