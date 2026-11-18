mod commands;
mod menu;
mod paths;
pub mod startup;
#[cfg(target_os = "windows")]
pub mod win_dialog;

use tauri::Emitter;

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|_| {
            startup::note("后端：应用与插件已就绪，进入窗口创建");
            Ok(())
        })
        .on_page_load(|_, payload| {
            startup::note(match payload.event() {
                tauri::webview::PageLoadEvent::Started => "后端：页面开始加载",
                tauri::webview::PageLoadEvent::Finished => "后端：页面加载完成",
            });
        })
        .menu(menu::build)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-action", event.id().as_ref().to_string());
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::files::file_metadata,
            commands::files::is_directory,
            commands::files::list_text_files,
            commands::files::list_folder_tree,
            commands::files::create_file,
            commands::files::create_dir,
            commands::files::rename_path,
            commands::files::delete_path,
            commands::files::path_exists,
            commands::files::copy_path,
            commands::files::reveal_in_file_manager,
            commands::files::list_recent,
            commands::files::push_recent,
            commands::files::clear_recent,
            commands::config::read_app_config,
            commands::config::write_app_config,
            commands::format::format_document,
            commands::format::formatter_status,
            menu::refresh_size_menu,
            startup::log_startup,
            startup::mark_page_ready,
            startup::set_startup_log,
            startup::flush_startup_log
        ])
        .run(tauri::generate_context!())
}
