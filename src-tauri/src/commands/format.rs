use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 菜单项据此决定「格式化文档」是否可点：available=false 时前端禁用并提示安装 tool。
#[derive(Serialize)]
pub struct FormatterStatus {
    pub available: bool,
    pub tool: String,
}

struct Candidate {
    tool: &'static str,
    args: Vec<String>,
}

fn cand(tool: &'static str, args: &[&str]) -> Candidate {
    Candidate {
        tool,
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// 每种语言按优先级给出候选工具：命中第一个已安装的就用它。
/// 这些工具都从 stdin 读源码、把格式化结果写到 stdout，不改磁盘文件。
fn candidates(lang: &str) -> Vec<Candidate> {
    match lang {
        "Rust" => vec![cand("rustfmt", &["--edition", "2021", "--emit", "stdout"])],
        "Go" => vec![cand("gofmt", &[])],
        "C" => vec![cand("clang-format", &["-assume-filename=file.c"])],
        "C++" => vec![cand("clang-format", &["-assume-filename=file.cpp"])],
        "Java" => vec![cand("clang-format", &["-assume-filename=file.java"])],
        "Python" => vec![
            cand("black", &["--quiet", "-"]),
            cand("autopep8", &["-"]),
            cand("yapf", &[]),
        ],
        _ => vec![],
    }
}

/// 把工具输出里的 \r\n / 裸 \r 统一成 \n：编辑器内部文档约定只用 \n，
/// 行尾风格在保存时由 write_text_file 按标签设置展开。
fn to_lf(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Python 的 pip --user 安装会把可执行文件放进按版本号区分的 bin/Scripts 目录，
/// 这些目录通常不在 GUI 进程的 PATH 里，扫一遍常见安装根把它们补上。
fn python_bin_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join("Library/Python"));
        }
    } else if cfg!(windows) {
        for var in ["LOCALAPPDATA", "APPDATA"] {
            if let Ok(base) = std::env::var(var) {
                roots.push(PathBuf::from(&base).join("Programs/Python"));
                roots.push(PathBuf::from(&base).join("Python"));
            }
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            roots.push(PathBuf::from(pf));
        }
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !name.starts_with("python") && !name.starts_with("3.") {
                continue;
            }
            for sub in ["bin", "Scripts"] {
                let d = p.join(sub);
                if d.is_dir() {
                    out.push(d);
                }
            }
        }
    }
    out
}

/// GUI 程序（macOS 的 .app、Windows 资源管理器启动）不继承登录 shell 的 PATH，
/// 只靠 env PATH 会找不到 brew/cargo/llvm 里的工具，这里补上常见安装位置。
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if cfg!(target_os = "macos") {
        for d in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/opt/homebrew/opt/llvm/bin",
            "/opt/homebrew/opt/rustup/bin",
        ] {
            dirs.push(PathBuf::from(d));
        }
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(&home).join(".cargo/bin"));
            dirs.push(PathBuf::from(&home).join("go/bin"));
        }
    } else if cfg!(windows) {
        if let Ok(home) = std::env::var("USERPROFILE") {
            dirs.push(PathBuf::from(&home).join(".cargo/bin"));
            dirs.push(PathBuf::from(&home).join("go/bin"));
            dirs.push(PathBuf::from(&home).join("scoop/shims"));
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(pf) = std::env::var(var) {
                dirs.push(PathBuf::from(&pf).join("LLVM/bin"));
                dirs.push(PathBuf::from(&pf).join("Go/bin"));
            }
        }
        dirs.push(PathBuf::from("C:/Go/bin"));
        dirs.push(PathBuf::from("C:/ProgramData/chocolatey/bin"));
    } else {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(&home).join(".cargo/bin"));
            dirs.push(PathBuf::from(&home).join("go/bin"));
        }
    }
    dirs.extend(python_bin_dirs());
    dirs
}

/// 在给定目录列表里找工具的可执行文件全路径；找不到返回 None。
/// 拆出 dirs 参数便于单元测试用临时目录验证，而不依赖本机真实装了什么。
fn resolve_with_dirs(tool: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{tool}.exe"), format!("{tool}.cmd"), format!("{tool}.bat")]
    } else {
        vec![tool.to_string()]
    };
    for dir in dirs {
        for name in &names {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn resolve(tool: &str) -> Option<PathBuf> {
    resolve_with_dirs(tool, &search_dirs())
}

/// 跑一个格式化工具：源码走 stdin，结果走 stdout。
/// stdin 在独立线程里写，主线程同时收 stdout/stderr——否则大文档时
/// 工具写满 stdout 管道会和我们写 stdin 互相阻塞成死锁。
fn run_tool(path: &Path, args: &[String], content: &str) -> Result<String, String> {
    let mut child = Command::new(path)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动格式化工具：{e}"))?;
    let data = content.as_bytes().to_vec();
    let writer = child.stdin.take().map(|mut stdin| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        })
    });
    let out = child
        .wait_with_output()
        .map_err(|e| format!("格式化工具执行失败：{e}"))?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            "格式化失败：工具返回非零退出码（源码可能有语法错误）".to_string()
        } else {
            format!("格式化失败：{err}")
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 格式化整篇文档。lang 是前端语言标签（Rust/Go/C/C++/Java/Python）。
/// SQL 由前端内置格式化器处理，不会走到这里。
#[tauri::command]
pub fn format_document(lang: String, content: String) -> Result<String, String> {
    let cands = candidates(&lang);
    if cands.is_empty() {
        return Err(format!("暂不支持格式化 {lang}"));
    }
    let mut missing: Vec<&str> = Vec::new();
    for c in &cands {
        match resolve(c.tool) {
            Some(path) => return Ok(to_lf(&run_tool(&path, &c.args, &content)?)),
            None => missing.push(c.tool),
        }
    }
    Err(format!(
        "未找到格式化工具，请先安装并加入 PATH：{}",
        missing.join(" / ")
    ))
}

/// 只探测工具是否可用（不执行），供右键菜单决定「格式化文档」的启用状态与提示。
#[tauri::command]
pub fn formatter_status(lang: String) -> FormatterStatus {
    let cands = candidates(&lang);
    if cands.is_empty() {
        return FormatterStatus { available: false, tool: String::new() };
    }
    for c in &cands {
        if resolve(c.tool).is_some() {
            return FormatterStatus { available: true, tool: c.tool.to_string() };
        }
    }
    FormatterStatus { available: false, tool: cands[0].tool.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("rnp-fmt-{}-{}-{}", name, std::process::id(), n));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn candidates_map_each_language_to_its_tools() {
        assert_eq!(candidates("Rust")[0].tool, "rustfmt");
        assert!(candidates("Rust")[0].args.contains(&"2021".to_string()));
        assert_eq!(candidates("Go")[0].tool, "gofmt");
        for lang in ["C", "C++", "Java"] {
            assert_eq!(candidates(lang)[0].tool, "clang-format");
        }
        assert!(candidates("C")[0].args[0].ends_with("file.c"));
        assert!(candidates("C++")[0].args[0].ends_with("file.cpp"));
        assert!(candidates("Java")[0].args[0].ends_with("file.java"));
        let py: Vec<&str> = candidates("Python").iter().map(|c| c.tool).collect();
        assert_eq!(py, vec!["black", "autopep8", "yapf"]);
    }

    #[test]
    fn unsupported_language_has_no_candidates() {
        assert!(candidates("SQL").is_empty());
        assert!(candidates("Markdown").is_empty());
        assert!(candidates("纯文本").is_empty());
        assert!(candidates("").is_empty());
    }

    #[test]
    fn status_of_unsupported_language_is_unavailable() {
        let st = formatter_status("Markdown".into());
        assert!(!st.available);
        assert!(st.tool.is_empty());
    }

    #[test]
    fn format_unsupported_language_errors_in_chinese() {
        let err = format_document("Markdown".into(), "x".into()).unwrap_err();
        assert!(err.contains("暂不支持格式化"), "实际：{err}");
    }

    #[test]
    fn to_lf_normalizes_all_line_endings() {
        assert_eq!(to_lf("a\r\nb\rc\n"), "a\nb\nc\n");
        // 无 \r 时原样返回
        assert_eq!(to_lf("a\nb\n"), "a\nb\n");
        assert_eq!(to_lf(""), "");
    }

    #[test]
    fn resolve_with_dirs_finds_executable_in_given_dir() {
        let dir = tmp("resolve");
        let name = if cfg!(windows) { "faketool.exe" } else { "faketool" };
        let exe = dir.join(name);
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        let found = resolve_with_dirs("faketool", &[dir.clone()]);
        assert_eq!(found, Some(exe));
        // 不存在的工具返回 None
        assert!(resolve_with_dirs("no-such-tool-xyz", &[dir]).is_none());
    }

    #[test]
    fn resolve_with_dirs_prefers_earlier_dir() {
        let a = tmp("first");
        let b = tmp("second");
        let name = if cfg!(windows) { "duptool.exe" } else { "duptool" };
        std::fs::write(a.join(name), b"a").unwrap();
        std::fs::write(b.join(name), b"b").unwrap();
        assert_eq!(resolve_with_dirs("duptool", &[a.clone(), b]), Some(a.join(name)));
    }

    #[test]
    fn missing_tools_report_install_hint() {
        // 选一个本机几乎不可能装齐候选链的语言来验证缺失分支：
        // 若候选全部缺失，错误文案应列出工具名并提示安装。
        let cands = candidates("Python");
        let any_present = cands.iter().any(|c| resolve(c.tool).is_some());
        if !any_present {
            let err = format_document("Python".into(), "x=1".into()).unwrap_err();
            assert!(err.contains("未找到格式化工具"), "实际：{err}");
            assert!(err.contains("black"), "实际：{err}");
        }
    }

    #[test]
    fn rustfmt_formats_when_available() {
        // 守卫式集成测试：装了 rustfmt 就验证真实格式化管道，没装就验证缺失分支。
        // CI 的 Rust 工具链通常带 rustfmt；两种环境都能确定性通过。
        if resolve("rustfmt").is_some() {
            let st = formatter_status("Rust".into());
            assert!(st.available);
            assert_eq!(st.tool, "rustfmt");
            let out = format_document("Rust".into(), "fn  main( ){let x=1;}".into()).unwrap();
            assert!(out.contains("fn main()"), "实际：{out}");
            assert!(!out.contains('\r'), "输出行尾应归一化为 \\n");
        } else {
            let st = formatter_status("Rust".into());
            assert!(!st.available);
            let err = format_document("Rust".into(), "fn main(){}".into()).unwrap_err();
            assert!(err.contains("未找到格式化工具"), "实际：{err}");
        }
    }

    #[test]
    fn clang_format_formats_c_when_available() {
        if resolve("clang-format").is_some() {
            let out = format_document("C".into(), "int main(){int x=1;return 0;}".into()).unwrap();
            assert!(out.contains("int main()"), "实际：{out}");
            assert!(!out.contains('\r'));
        }
    }
}