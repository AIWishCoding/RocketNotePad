#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod win_start;

use rocketnotepad_lib::startup;

fn main() {
    // 默认只在出问题时补写日志，全程记录由配置项 startupLog 决定
    startup::begin(startup::initial_mode());
    startup::note(&format!(
        "后端：进程已起来，参数 {:?}，{} {}",
        std::env::args().skip(1).collect::<Vec<_>>(),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));

    // 没有 WebView2 运行时时窗口根本建不起来，提前给出可操作的提示
    #[cfg(target_os = "windows")]
    {
        win_start::install();
        match win_start::check_webview2() {
            Ok(source) => startup::note(&format!("后端：找到 WebView2 运行时（{source}）")),
            Err(()) => {
                startup::note("后端：注册表和固定安装目录里都没找到 WebView2 运行时");
                // 这是个要拿给用户看的结论，别让默认档把它留在内存里
                startup::flush();
                if !win_start::warn_missing() {
                    startup::note("后端：用户选择不继续启动，进程退出");
                    return;
                }
            }
        }
    }

    // 卡在哪一步都不会自己退出，超时后主动弹窗把日志位置告诉用户
    startup::start_watchdog(startup::WATCHDOG);

    if let Err(error) = rocketnotepad_lib::run() {
        startup::note(&format!("后端：窗口初始化失败 —— {error}"));
        startup::flush();
        #[cfg(target_os = "windows")]
        rocketnotepad_lib::win_dialog::fail(
            "RocketNotePad 启动失败",
            &format!("窗口初始化失败，请检查 WebView2 运行时后重试。\n\n{error}\n\n\
                      启动步骤已经补写到 exe 同目录（或配置目录、临时目录）的 rocketnotepad.startup.log。"),
        );
        #[cfg(not(target_os = "windows"))]
        {
            eprintln!("error while running RocketNotePad: {error}");
            std::process::exit(1);
        }
    }
    startup::note("后端：事件循环已结束");
}
