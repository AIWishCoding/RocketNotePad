use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

fn item(app: &AppHandle, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, true, check_accel(id, accel))
}

/// Windows 的菜单加速键只能表达 Ctrl/Alt/Shift，`Command`/`Cmd`/`Super`/`Meta` 会让 muda 在建
/// 菜单时直接报错、整个应用启动失败（macOS 上却一切正常），所以在装配前挡住。
fn check_accel<'a>(id: &str, accel: Option<&'a str>) -> Option<&'a str> {
    if let Some(accel) = accel {
        for token in accel.split('+') {
            let token = token.trim();
            assert!(
                !matches!(token.to_ascii_uppercase().as_str(), "CMD" | "COMMAND" | "SUPER" | "META" | "WIN"),
                "菜单项 {id} 的加速键 {accel:?} 含 macOS 限定修饰键 {token:?}，Windows 下会导致启动失败，请改用 CmdOrCtrl"
            );
        }
    }
    accel
}

/// macOS 用 ⌘G 做查找导航；Windows/Linux 上 Ctrl+G 已被「跳转到行」占用，
/// 查找下一个按 Windows 惯例走 F3，否则两个菜单项会抢同一个加速键。
#[cfg(target_os = "macos")]
const FIND_NEXT_ACCEL: &str = "CmdOrCtrl+G";
#[cfg(not(target_os = "macos"))]
const FIND_NEXT_ACCEL: &str = "F3";
#[cfg(target_os = "macos")]
const FIND_PREV_ACCEL: &str = "Shift+CmdOrCtrl+G";
#[cfg(not(target_os = "macos"))]
const FIND_PREV_ACCEL: &str = "Shift+F3";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    build_with_limits(app, DEFAULT_EDIT_LIMIT_MB, DEFAULT_MAX_FILE_MB)
}

/// 文件大小三档的菜单默认值；前端配置缺省时与后端常量保持一致
pub const DEFAULT_EDIT_LIMIT_MB: u64 = 64;
pub const DEFAULT_MAX_FILE_MB: u64 = 256;
const EDIT_OPTIONS: [u64; 5] = [8, 16, 32, 64, 128];
const MAX_OPTIONS: [u64; 5] = [64, 128, 256, 512, 1024];

/// 调档后重建整棵菜单：勾当前值、禁用会让「可编辑 ≥ 拒绝」的非法组合
pub fn build_with_limits(app: &AppHandle, edit_mb: u64, max_mb: u64) -> tauri::Result<Menu<Wry>> {
    let mut edit_items: Vec<CheckMenuItem<Wry>> = Vec::new();
    for v in EDIT_OPTIONS {
        let it = CheckMenuItem::with_id(app, format!("limits.edit.{v}"), format!("{v} MB"), v < max_mb, v == edit_mb, None::<&str>)?;
        edit_items.push(it);
    }
    let mut max_items: Vec<CheckMenuItem<Wry>> = Vec::new();
    for v in MAX_OPTIONS {
        let it = CheckMenuItem::with_id(app, format!("limits.max.{v}"), format!("{v} MB"), v > edit_mb, v == max_mb, None::<&str>)?;
        max_items.push(it);
    }
    let edit_refs: Vec<&dyn IsMenuItem<Wry>> = edit_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let max_refs: Vec<&dyn IsMenuItem<Wry>> = max_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let edit_sub = Submenu::with_items(
        app,
        &format!("可编辑上限（当前 {edit_mb} MB）"),
        true,
        &edit_refs,
    )?;
    let max_sub = Submenu::with_items(
        app,
        &format!("只读上限 / 拒绝阈值（当前 {max_mb} MB）"),
        true,
        &max_refs,
    )?;

    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &item(app, "file.new", "新建", Some("CmdOrCtrl+N"))?,
            &item(app, "file.open", "打开…", Some("CmdOrCtrl+O"))?,
            &item(app, "file.open_folder", "打开文件夹…", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "file.save", "保存", Some("CmdOrCtrl+S"))?,
            &item(app, "file.save_as", "另存为…", Some("Shift+CmdOrCtrl+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "file.close_tab", "关闭标签", Some("CmdOrCtrl+W"))?,
            &item(app, "file.close_all", "关闭所有标签", Some("Shift+CmdOrCtrl+W"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "app.quit", "退出 RocketNotePad", Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;

    let find = Submenu::with_items(
        app,
        "查找",
        true,
        &[
            &item(app, "find.open", "查找…", Some("CmdOrCtrl+F"))?,
            &item(app, "find.replace", "替换…", Some("CmdOrCtrl+Alt+E"))?,
            &item(app, "find.next", "查找下一个", Some(FIND_NEXT_ACCEL))?,
            &item(app, "find.prev", "查找上一个", Some(FIND_PREV_ACCEL))?,
        ],
    )?;

    let selection = Submenu::with_items(
        app,
        "选择",
        true,
        &[&item(
            app,
            "select.next_occurrence",
            "选中下一个相同项",
            Some("CmdOrCtrl+D"),
        )?],
    )?;

    let view = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &item(app, "view.sidebar", "切换侧边栏", Some("CmdOrCtrl+\\"))?,
            &item(app, "view.palette", "命令面板…", Some("Shift+CmdOrCtrl+P"))?,
            &item(app, "view.goto", "跳转任意处…", Some("CmdOrCtrl+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "view.zoom_in", "放大", Some("CmdOrCtrl+="))?,
            &item(app, "view.zoom_out", "缩小", Some("CmdOrCtrl+-"))?,
            &item(app, "view.zoom_reset", "重置缩放", Some("CmdOrCtrl+0"))?,
        ],
    )?;

    let goto = Submenu::with_items(
        app,
        "转到",
        true,
        &[
            &item(app, "goto.line", "跳转到行…", Some("Ctrl+G"))?,
            &item(app, "goto.file", "跳转到文件…", Some("CmdOrCtrl+P"))?,
        ],
    )?;

    let settings = Submenu::with_items(
        app,
        "设置",
        true,
        &[
            &edit_sub,
            &max_sub,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "view.wrap", "切换自动换行", None)?,
            &item(app, "view.theme", "切换明暗主题", None)?,
            &item(app, "view.font", "字体…", None)?,
            &item(app, "view.minimap", "切换 Minimap", None)?,
            &item(app, "view.preview", "切换 Markdown 预览", None)?,
        ],
    )?;

    let help = Submenu::with_items(
        app,
        "帮助",
        true,
        &[&item(app, "help.about", "关于 RocketNotePad", None)?],
    )?;

    Menu::with_items(
        app,
        &[&file, &edit, &find, &selection, &view, &goto, &settings, &help],
    )
}

/// 前端改完档位配置后调用：按新值重建菜单（勾选与禁用状态跟着变）
#[tauri::command]
pub fn refresh_size_menu(app: AppHandle, edit_limit_mb: u64, max_file_mb: u64) -> Result<(), String> {
    let menu = build_with_limits(&app, edit_limit_mb, max_file_mb).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check_accel;

    #[test]
    fn cross_platform_accelerators_pass() {
        for accel in [
            "CmdOrCtrl+N",
            "Shift+CmdOrCtrl+S",
            "CmdOrCtrl+Alt+E",
            "CmdOrCtrl+\\",
            "Ctrl+G",
            "CmdOrCtrl+0",
        ] {
            assert_eq!(check_accel("x", Some(accel)), Some(accel));
        }
        assert_eq!(check_accel("x", None), None);
    }

    #[test]
    #[should_panic(expected = "Windows 下会导致启动失败")]
    fn mac_only_modifier_is_rejected() {
        check_accel("find.replace", Some("Alt+Command+E"));
    }
}
