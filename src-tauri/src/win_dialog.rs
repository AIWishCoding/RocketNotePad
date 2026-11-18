//! Windows 下 release 构建是 GUI 子系统，没有控制台，出问题时唯一的可见出口是弹窗。

use windows::core::PCWSTR;
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_YESNO, MESSAGEBOX_STYLE,
};

/// 单按钮提示，只把话说清楚，不改变流程。
pub fn notice(title: &str, text: &str) {
    message_box(title, text, MB_OK);
}

/// 是/否询问，返回用户是否选了「是」。
pub fn confirm(title: &str, text: &str) -> bool {
    message_box(title, text, MB_YESNO) == IDYES.0
}

/// 报错并退出：静默退出在双击启动时表现为「没反应」，必须先把原因说完。
pub fn fail(title: &str, text: &str) -> ! {
    message_box(title, text, MB_OK);
    std::process::exit(1)
}

fn message_box(title: &str, text: &str, buttons: MESSAGEBOX_STYLE) -> i32 {
    let title = wide(title);
    let text = wide(text);
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            buttons | MB_ICONWARNING | MB_SETFOREGROUND,
        )
    }
    .0
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
