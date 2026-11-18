//! 启动追踪。
//!
//! release 包在 Windows 上是 GUI 子系统（没有控制台），窗口或页面起不来时双击只会
//! 「没页面、也没提示」。这里把每个里程碑攒在内存里，只在**出问题**的那一刻补写进
//! `rocketnotepad.startup.log`（先试应用自己的目录——macOS 是 `~/.rocketnote`、Windows 是
//! exe 同目录，再试应用配置目录，最后系统临时目录），并在超时仍收不到「页面就绪」时弹窗
//! 指路这个文件。日志能停在第几行，就说明卡在哪一步；连文件都没有，说明进程根本没跑起来。
//!
//! 默认只在出问题时写盘（`Mode::Off`），免得正常启动也往目录里丢文件；想全程留痕就把
//! 配置项 `startupLog` 打开，或临时用 `RNP_STARTUP_LOG=1`、`--startup-log` 覆盖一次。

use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::paths;

pub const LOG_FILE: &str = "rocketnotepad.startup.log";

/// 超过这个时长还没有收到页面就绪信号，就主动弹窗问用户要不要看日志
pub const WATCHDOG: Duration = Duration::from_secs(10);

/// 内存里最多攒多少条里程碑，防止「一直没就绪又开着用」把内存吃满
const PENDING_CAP: usize = 128;

/// 日志的落盘时机
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// 默认：只攒在内存里，出问题（超时、崩溃、启动失败）时才补写文件
    Off,
    /// 全程记录：启动一开始就建文件，逐条追加
    Always,
}

impl Mode {
    const fn code(self) -> u8 {
        match self {
            Mode::Off => 0,
            Mode::Always => 1,
        }
    }

    const fn from_code(code: u8) -> Mode {
        if code == 0 {
            Mode::Off
        } else {
            Mode::Always
        }
    }
}

static CLOCK: Mutex<Option<Instant>> = Mutex::new(None);
static SINK: Mutex<Option<File>> = Mutex::new(None);
/// 日志文件没打开时，里程碑先待在这里；补写或全程记录档开档时用
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());
static CHOSEN: Mutex<Option<PathBuf>> = Mutex::new(None);
static MODE: AtomicU8 = AtomicU8::new(0);
static PAGE_READY: AtomicBool = AtomicBool::new(false);

fn lock<T>(cell: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    cell.lock().unwrap_or_else(PoisonError::into_inner)
}

fn mode() -> Mode {
    Mode::from_code(MODE.load(Ordering::Relaxed))
}

/// 纯函数版本，便于单测：应用自己的目录按优先级排在前面，最后兜底到系统临时目录——
/// 前面几个在「装进 Program Files + 普通权限」时都可能写不了。候选相同或拿不到时只留一个。
pub fn log_files(dirs: Vec<PathBuf>, temp: Option<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = dirs.into_iter().map(|dir| dir.join(LOG_FILE)).collect();
    if let Some(dir) = temp {
        let path = dir.join(LOG_FILE);
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

fn candidates() -> Vec<PathBuf> {
    log_files(paths::own_dirs(paths::fallback_app_config()), Some(std::env::temp_dir()))
}

/// 迁移前那几个老位置（macOS 才有）：日志不需要搬过来，但顺利启动时要一起清干净
fn legacy_logs() -> Vec<PathBuf> {
    paths::legacy_dirs(paths::fallback_app_config())
        .into_iter()
        .map(|dir| dir.join(LOG_FILE))
        .collect()
}

/// 配置文件里的 `startupLog`。坏值、缺字段、整份配置读不到都按「关闭」处理。
pub fn enabled_in_config(text: Option<&str>) -> bool {
    let Some(text) = text else { return false };
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| value.get("startupLog").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn from_env(raw: &str) -> Option<Mode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Some(Mode::Always),
        "0" | "false" | "off" | "no" => Some(Mode::Off),
        _ => None,
    }
}

/// 生效优先级：环境变量 > 命令行 > 配置文件 > 默认关闭。
/// 前两者是留给「这台机器就这一次要查」的后门，不用去改设置。
pub fn decide_mode(config_text: Option<&str>, env_value: Option<&str>, args: &[String]) -> Mode {
    if let Some(mode) = env_value.and_then(from_env) {
        return mode;
    }
    if args.iter().any(|arg| arg == "--startup-log") {
        return Mode::Always;
    }
    if enabled_in_config(config_text) {
        Mode::Always
    } else {
        Mode::Off
    }
}

/// 进程刚起来时读一次配置（这时还没有 `AppHandle`，位置和 `commands::config` 用同一套候选）
pub fn initial_mode() -> Mode {
    let text = paths::read_first(&paths::files_for(
        crate::commands::config::CONFIG_FILE,
        paths::fallback_app_config(),
    ));
    let args: Vec<String> = std::env::args().skip(1).collect();
    decide_mode(text.as_deref(), std::env::var("RNP_STARTUP_LOG").ok().as_deref(), &args)
}

fn stamp() -> String {
    let mut clock = lock(&CLOCK);
    let elapsed = clock.get_or_insert_with(Instant::now).elapsed();
    format!("[{:>6} ms]", elapsed.as_millis())
}

/// 本次启动真正落盘的日志位置；一个都写不了时是 None，弹窗文案要跟着变。
pub fn log_location() -> Option<PathBuf> {
    lock(&CHOSEN).clone()
}

/// 开始一次新的追踪。默认档不碰磁盘，只把内存缓冲和计时清零。
pub fn begin(next: Mode) {
    MODE.store(next.code(), Ordering::Relaxed);
    *lock(&CLOCK) = None;
    *lock(&SINK) = None;
    *lock(&CHOSEN) = None;
    lock(&PENDING).clear();
    if next == Mode::Always {
        flush();
    }
}

/// 把攒下的里程碑写进文件（文件没打开时按候选位置开一个）。正常启动不会调它，
/// 只有超时、崩溃、启动失败或用户主动打开设置时才落盘。
pub fn flush() {
    if !ensure_open() {
        return;
    }
    let lines: Vec<String> = lock(&PENDING).drain(..).collect();
    let mut sink = lock(&SINK);
    if let Some(file) = sink.as_mut() {
        for line in lines {
            let _ = writeln!(file, "{line}");
        }
        let _ = file.flush();
    }
}

/// 保证日志文件已打开；返回 false 表示所有候选位置都写不了。
fn ensure_open() -> bool {
    open_first(&candidates())
}

/// 按给定顺序挑第一个能写的位置开文件（单测要注入位置，故与 `candidates()` 分开）
fn open_first(paths: &[PathBuf]) -> bool {
    if lock(&SINK).is_some() {
        return true;
    }
    for path in paths {
        if begin_at(path, mode()) {
            let mut sink = lock(&SINK);
            if let Some(file) = sink.as_mut() {
                let _ = writeln!(file, "{} 日志位置：{}", stamp(), path.display());
                let _ = file.flush();
            }
            return true;
        }
    }
    false
}

fn begin_at(path: &Path, mode: Mode) -> bool {
    let reason = match mode {
        Mode::Always => "设置里开着全程记录",
        Mode::Off => "本次启动没走到正常就绪，以下是攒下来的过程",
    };
    let header = format!(
        "RocketNotePad {} 启动记录（只保留最近一次，{reason}）\nexe：{}\n系统：{} {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::current_exe().map_or_else(|_| String::from("?"), |p| p.display().to_string()),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    // 回退目录可能从来没被建过（应用一次都没成功启动过），先补一次
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut file = match OpenOptions::new().create(true).write(true).truncate(true).open(path) {
        Ok(file) => file,
        // 日志写不了（目录只读等）只影响诊断，不影响启动
        Err(e) => {
            eprintln!("无法写启动日志 {}: {e}", path.display());
            return false;
        }
    };
    let _ = file.write_all(header.as_bytes());
    let _ = file.flush();
    *lock(&SINK) = Some(file);
    *lock(&CHOSEN) = Some(path.to_path_buf());
    true
}

/// 记一条里程碑；文件没打开时进内存队列（超上限丢最早的）。
pub fn note(msg: &str) {
    let line = format!("{} {msg}", stamp());
    #[cfg(debug_assertions)]
    eprintln!("startup {line}");
    let mut sink = lock(&SINK);
    match sink.as_mut() {
        Some(file) => {
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
        None => {
            let mut pending = lock(&PENDING);
            if pending.len() >= PENDING_CAP {
                pending.remove(0);
            }
            pending.push(line);
        }
    }
}

pub fn page_ready() -> bool {
    PAGE_READY.load(Ordering::Relaxed)
}

fn mark_ready() {
    PAGE_READY.store(true, Ordering::Relaxed);
    let mut paths = candidates();
    paths.extend(legacy_logs());
    apply_ready(mode(), &paths);
}

/// 就绪之后要做的事拆出来，便于单测注入日志位置
fn apply_ready(mode: Mode, paths: &[PathBuf]) {
    if mode == Mode::Always {
        note("前端：页面已就绪，本次启动正常");
        return;
    }
    // 默认档：这次启动是好的，攒下的过程直接丢掉，顺手清掉上次出问题留下的日志。
    // 已经落过盘（比如超时后又起来了）就留着，那份记录仍然有用。
    if lock(&SINK).is_none() {
        lock(&PENDING).clear();
        remove_stale_logs(paths);
    }
}

/// 只删我们自己那个文件名，别把配置目录里的其他东西带走
fn remove_stale_logs(paths: &[PathBuf]) {
    for path in paths {
        if path.file_name() == Some(OsStr::new(LOG_FILE)) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 超时仍没等到页面就绪就弹窗，把「静默没反应」变成看得见的下一步。
pub fn start_watchdog(budget: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(budget);
        if page_ready() {
            return;
        }
        note("看门狗超时：窗口或页面一直没就绪");
        flush();
        let hint = match log_location() {
            Some(path) => format!(
                "这次攒下的启动过程已经补写到了这个文件里，把它发回来就能定位卡在哪一步：\n{}\n\n\
                 如果它行数很少或根本不存在，说明进程没真正跑起来（多为杀软拦截），\
                 请查看杀毒软件/防火墙的隔离记录，或改用安装包。",
                path.display()
            ),
            None => "这次连启动日志都写不了：exe 所在目录、应用配置目录和临时目录都不可写。\n\n\
                     这台机器的权限策略可能比较特殊，请把程序拷到自己的文件夹（例如桌面）再双击一次，\n\
                     那时会在 exe 同目录生成 rocketnotepad.startup.log，把它发回来就能定位。"
                .to_string(),
        };
        alert(
            "RocketNotePad 页面没能打开",
            &format!("启动 {} 秒后仍未收到页面就绪的信号。\n\n{}", budget.as_secs(), hint),
        );
    });
}

#[cfg(target_os = "windows")]
fn alert(title: &str, text: &str) {
    crate::win_dialog::notice(title, text);
}

#[cfg(not(target_os = "windows"))]
fn alert(title: &str, text: &str) {
    eprintln!("{title}\n{text}");
}

#[tauri::command]
pub fn log_startup(message: String) {
    note(&format!("前端：{message}"));
}

#[tauri::command]
pub fn mark_page_ready() {
    mark_ready();
}

/// 前后端共用一个开关：打开时立刻把已攒的过程补写出来，关闭时把日志文件收走。
/// 配置的持久化在前端 `cfg.startupLog`，这里只管当前这次运行；返回值是日志落盘位置，
/// 设置页要把它念给用户，否则开了也不知道去哪看。
#[tauri::command]
pub fn set_startup_log(enabled: bool) -> Option<PathBuf> {
    MODE.store((if enabled { Mode::Always } else { Mode::Off }).code(), Ordering::Relaxed);
    if enabled {
        note("设置：已打开启动日志，之后的每一步都会写盘");
        flush();
        return log_location();
    }
    let written = log_location();
    note("设置：已关闭启动日志");
    // 先放下句柄再删文件，Windows 删不掉正开着的文件
    *lock(&SINK) = None;
    lock(&PENDING).clear();
    if let Some(path) = written {
        let _ = std::fs::remove_file(path);
    }
    *lock(&CHOSEN) = None;
    None
}

/// 前端遇到致命错误时调用：把内存里的过程补写出来，弹窗里才能给出文件位置。
#[tauri::command]
pub fn flush_startup_log() -> Option<PathBuf> {
    flush();
    log_location()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 这一组用例动的是全局状态，必须串起来跑
    static SERIAL: Mutex<()> = Mutex::new(());

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rnp-startup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn reset(next: Mode) {
        MODE.store(next.code(), Ordering::Relaxed);
        *lock(&CLOCK) = None;
        *lock(&SINK) = None;
        *lock(&CHOSEN) = None;
        lock(&PENDING).clear();
        PAGE_READY.store(false, Ordering::Relaxed);
    }

    #[test]
    fn the_log_prefers_the_app_dirs_and_falls_back_to_the_temp_dir() {
        let app = PathBuf::from("/Users/maple/.rocketnote");
        let cfg = PathBuf::from("/cfg/com.maple.rocketnotepad");
        let temp = PathBuf::from("/tmp");
        assert_eq!(
            log_files(vec![app.clone(), cfg.clone()], Some(temp.clone())),
            vec![
                app.join(LOG_FILE),
                cfg.join(LOG_FILE),
                temp.join(LOG_FILE)
            ]
        );
        // 临时目录本身就是应用目录时别把同一个文件写两遍
        assert_eq!(log_files(vec![temp.clone()], Some(temp.clone())), vec![temp.join(LOG_FILE)]);
        // 一个候选目录都拿不到时，临时目录仍然兜底
        assert_eq!(log_files(vec![], Some(temp.clone())), vec![temp.join(LOG_FILE)]);
        assert!(log_files(vec![], None).is_empty());
    }

    #[test]
    fn the_current_platform_gets_one_hidden_folder_on_macos() {
        let macos_dirs = paths::app_dirs(
            "macos",
            Some(PathBuf::from("/Users/maple")),
            Some(PathBuf::from("/Applications/RocketNotePad.app/Contents/MacOS")),
            Some(PathBuf::from("/Users/maple/Library/Application Support/com.maple.rocketnotepad")),
        );
        assert_eq!(
            log_files(macos_dirs, Some(PathBuf::from("/tmp"))),
            vec![
                PathBuf::from("/Users/maple/.rocketnote").join(LOG_FILE),
                PathBuf::from("/tmp").join(LOG_FILE)
            ]
        );
    }

    #[test]
    fn the_startup_log_is_off_unless_config_env_or_flag_turns_it_on() {
        let on = r#"{"theme":"light","startupLog":true}"#;
        let wrong_type = r#"{"theme":"light","startupLog":"yes"}"#;
        let no_field = r#"{"theme":"light"}"#;
        let broken = "{ 这不是 JSON";
        let flag_on: Vec<String> = vec!["--startup-log".into()];
        let flag_off: Vec<String> = vec!["--other".into()];

        // 没有配置文件（首次启动）时就是关闭
        assert_eq!(decide_mode(None, None, &flag_off), Mode::Off);
        assert_eq!(decide_mode(Some(no_field), None, &flag_off), Mode::Off);
        // 坏值不能让应用起不来，按默认档处理
        assert_eq!(decide_mode(Some(broken), None, &flag_off), Mode::Off);
        assert_eq!(decide_mode(Some(wrong_type), None, &flag_off), Mode::Off);
        assert_eq!(decide_mode(Some(on), None, &flag_off), Mode::Always);
        // 后门优先于配置：既能临时开也能临时关
        assert_eq!(decide_mode(Some(on), Some("0"), &flag_on), Mode::Off);
        assert_eq!(decide_mode(None, Some("true"), &flag_off), Mode::Always);
        assert_eq!(decide_mode(None, Some("也许"), &flag_on), Mode::Always);
        assert_eq!(decide_mode(None, Some("也许"), &flag_off), Mode::Off);
        assert!(!enabled_in_config(Some("[1,2]")));
    }

    #[test]
    fn milestones_stay_in_memory_until_something_goes_wrong() {
        let _g = lock(&SERIAL);
        let dir = tmp_dir("buffered");
        let path = dir.join(LOG_FILE);

        // 默认档：进程活着但磁盘上没有日志
        reset(Mode::Off);
        begin(Mode::Off);
        note("后端：进程已起来");
        note("后端：setup 已进入");
        assert!(!path.exists(), "默认档不该在启动时建日志");
        assert_eq!(lock(&PENDING).len(), 2);

        // 出问题（看门狗/panic/启动失败）时才补写：位置按候选顺序挑，头部说明原因
        let blocker = dir.join("not-a-dir");
        fs::write(&blocker, "").unwrap();
        assert!(open_first(&[blocker.join(LOG_FILE), path.clone()]));
        flush();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("没走到正常就绪"), "{text}");
        assert!(text.contains("进程已起来"), "{text}");
        assert!(text.contains("setup 已进入"), "{text}");
        assert!(text.contains("日志位置"), "{text}");
        // 补写过的不能留在队列里，否则第二次 flush 会重复一份
        assert!(lock(&PENDING).is_empty());
        flush();
        assert_eq!(fs::read_to_string(&path).unwrap().matches("进程已起来").count(), 1);

        // 上一次留下的日志，在这次顺利启动时被清掉
        reset(Mode::Off);
        begin(Mode::Off);
        note("后端：进程已起来");
        fs::write(&path, "上一次的记录").unwrap();
        apply_ready(Mode::Off, &[path.clone()]);
        assert!(!path.exists(), "顺利启动后不该留日志");
        assert!(lock(&PENDING).is_empty());
        fs::write(dir.join("other.txt"), "不是我们的文件").unwrap();
        remove_stale_logs(&[dir.join("other.txt"), path.clone()]);
        assert!(dir.join("other.txt").exists(), "只删自己的文件名");

        // 全程记录档：启动就建文件，就绪也写进去，日志不清理
        reset(Mode::Always);
        assert!(begin_at(&path, Mode::Always));
        note("后端：setup 已进入");
        mark_ready();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("全程记录"), "{text}");
        assert!(text.contains("setup 已进入"), "{text}");
        assert!(text.contains("页面已就绪"), "{text}");
        assert!(page_ready());
        assert_eq!(log_location().as_deref(), Some(path.as_path()));

        // 关闭开关时把刚写的文件收走
        set_startup_log(false);
        assert!(!path.exists(), "关掉开关不该留日志");
        assert_eq!(log_location(), None);
        assert_eq!(mode(), Mode::Off);
        // 再打开时回一句日志位置给设置页（位置仍是本次已选定的那个）
        assert!(begin_at(&path, Mode::Always));
        assert_eq!(set_startup_log(true).as_deref(), Some(path.as_path()));
        assert_eq!(mode(), Mode::Always);
        assert!(fs::read_to_string(&path).unwrap().contains("已打开启动日志"));
        assert_eq!(flush_startup_log().as_deref(), Some(path.as_path()));

        // 打不开的位置（中间路径是文件）要返回 false，好让 ensure_open 换下一个候选
        let blocker = dir.join("not-a-dir");
        fs::write(&blocker, "").unwrap();
        reset(Mode::Always);
        assert!(!begin_at(&blocker.join(LOG_FILE), Mode::Always));

        // 队列有上限，长时间不就绪也不会无限攒
        reset(Mode::Off);
        for i in 0..(PENDING_CAP + 20) {
            note(&format!("里程碑 {i}"));
        }
        assert_eq!(lock(&PENDING).len(), PENDING_CAP);
        assert!(lock(&PENDING)[0].contains("里程碑 20"));

        let _ = fs::remove_dir_all(&dir);
    }
}
