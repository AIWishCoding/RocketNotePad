use encoding_rs::{BIG5, EUC_KR, GB18030, SHIFT_JIS, UTF_16BE, UTF_16LE, WINDOWS_1252};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::AppHandle;

const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;
/// 超过这个大小的文件按只读打开：编辑文档要维护撤销栈和增量结构，
/// 内存会是原始文本的数倍，超大文件只做“看”不做“改”才能封顶占用。
const EDIT_SIZE_LIMIT: u64 = 8 * 1024 * 1024;
const MAX_RECENT: usize = 20;

#[derive(Serialize)]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
    pub line_ending: String,
    pub size: u64,
    /// 超过编辑阈值的超大文件：前端以只读方式打开，避免撤销栈与增量文档结构吃掉内存
    pub large: bool,
}

#[derive(Serialize)]
pub struct FileMeta {
    pub size: u64,
    pub modified: u64,
    pub read_only: bool,
    pub exists: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub opened_at: u64,
}

/// 常用中日韩汉字表，用于区分“真正的中文”和“中文编码误读出的生僻乱码”。
/// 只收录高频字：表越长越容易把误读出来的生僻字也判成正确编码。
const COMMON_CJK: &str = "的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出会三要于下得可你年生自学后么去好者小当只没看样理入手行问部外天空气数主里从四长短日月光书会同对过起开明前间心现高质量记录信息名称系统文档编第码二试测\
    繁體簡與或者將已經還進運動車點邊裏東風雲電話語請謝讓超路腦程式設計歷台聽覺識讀誰幾號關說國時會於學問氣數裡從長書對開間質錄資訊稱係統檔編碼電计算法网络数据库文件夹视图窗口打印预览设置帮助关于确定取消应用关闭保存打开新建导出导入";

/// 判定只取开头若干个字符，足够区分语言，又不必扫描整个文件
const DETECT_SAMPLE_CHARS: usize = 2000;

/// 统计解码结果里各语言字符的分布。GB18030/BIG5/SHIFT_JIS/EUC_KR 的双字节区间互相覆盖，
/// 「能无错解码」不足以判定编码：中文的双字节按 EUC-KR 读约有三分之一落在谚文区，
/// 按 Shift_JIS 读则大量落在半角假名区。因此再按脚本特征打分——
/// 只有本语言字符占到多数才加分，零星出现的假名/谚文按误读扣分，
/// 常用汉字比生僻汉字更有说服力。
fn score_legacy_text(enc: &'static encoding_rs::Encoding, text: &str) -> i32 {
    let mut common = 0i32;
    let mut other_han = 0i32;
    let mut kana_full = 0i32;
    let mut kana_half = 0i32;
    let mut hangul = 0i32;
    for ch in text.chars().take(DETECT_SAMPLE_CHARS) {
        let u = ch as u32;
        if (0x3040..=0x30FF).contains(&u) || (0x31F0..=0x31FF).contains(&u) {
            kana_full += 1;
        } else if (0xFF66..=0xFF9D).contains(&u) {
            kana_half += 1;
        } else if (0xAC00..=0xD7A3).contains(&u) || (0x1100..=0x11FF).contains(&u) {
            hangul += 1;
        } else if (0x4E00..=0x9FFF).contains(&u) || (0x3400..=0x4DBF).contains(&u) {
            if COMMON_CJK.chars().any(|c| c == ch) {
                common += 1;
            } else {
                other_han += 1;
            }
        }
    }
    let han = common * 2 + other_han;
    let cjk_total = common + other_han + kana_full + kana_half + hangul;
    // 日文假名约占三成，韩文谚文几乎占满整篇；低于比例就是零星误读
    let kana_ratio_ok = kana_full * 3 >= cjk_total;
    let hangul_ratio_ok = hangul * 4 >= cjk_total * 3;
    match enc.name() {
        "Shift_JIS" if kana_full > 0 && kana_ratio_ok => kana_full * 6 + han,
        "EUC-KR" if hangul > 0 && hangul_ratio_ok => hangul * 5 + han,
        // 中文编码只该看到汉字；任何假名、谚文都是误读。
        _ => han + common * 4 - kana_full * 8 - hangul * 8 - kana_half * 4,
    }
}

/// 编码嗅探只看开头这么多字节：四个候选各解码一遍全文的话，
/// 打开 16MB 的旧编码文件要多拷贝 4 份整文件内容。
const DETECT_SNIFF_BYTES: usize = 64 * 1024;

/// 判定窗口：从第一个非 ASCII 字节起的 DETECT_SNIFF_BYTES 个字节。
/// 大文件开头常是纯 ASCII 的表头，跳过它们打分才看得到真正的内容；
/// 这些编码的字节序列一定以高位字节开头，所以窗口起点不会切进序列中间。
fn sniff_window(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| *b >= 0x80)
        .unwrap_or(bytes.len());
    let end = bytes.len().min(start + DETECT_SNIFF_BYTES);
    &bytes[start..end]
}

/// 按窗口解码用于判定。用 last=false 的流式解码，被切断的尾部字节序列
/// 会留在解码器里等待后续输入，不会被当成解码错误；
/// 窗口内出现真正的非法字节才返回 None（与整份解码失败同样排除该候选）。
fn sniff_decode(enc: &'static encoding_rs::Encoding, bytes: &[u8]) -> Option<String> {
    let window = sniff_window(bytes);
    if window.is_empty() {
        return None;
    }
    let mut decoder = enc.new_decoder();
    // 单字节最多展开成 3 字节 UTF-8（Shift_JIS 半角假名），这个容量保证输出不会写满
    let mut out = String::with_capacity(window.len() * 3);
    let (result, _, replaced) = decoder.decode_to_string(window, &mut out, false);
    if replaced || matches!(result, encoding_rs::CoderResult::OutputFull) || out.is_empty() {
        return None;
    }
    Some(out)
}

fn detect_encoding(bytes: &[u8]) -> &'static encoding_rs::Encoding {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return encoding_rs::UTF_8;
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return UTF_16LE;
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return UTF_16BE;
    }
    // UTF-8 判定只看字节流有效性，不拷贝，仍按全量校验
    if std::str::from_utf8(bytes).is_ok() {
        return encoding_rs::UTF_8;
    }
    let mut best: Option<(&'static encoding_rs::Encoding, i32)> = None;
    for enc in [GB18030, BIG5, SHIFT_JIS, EUC_KR] {
        let Some(text) = sniff_decode(enc, bytes) else {
            continue;
        };
        let score = score_legacy_text(enc, &text);
        // 同分保留先出现的候选，维持 GB18030 优先的历史行为
        if best.map(|(_, s)| score > s).unwrap_or(true) {
            best = Some((enc, score));
        }
    }
    // 窗口之后的字节可能对该编码非法：正文解码时会得到 U+FFFD 并由 read_text_file 剔除，
    // 不再为此把四个候选按全文重跑一遍。
    best.map(|(enc, _)| enc).unwrap_or(WINDOWS_1252)
}

fn detect_line_ending(text: &str) -> &'static str {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    crlf += 1;
                    i += 2;
                    continue;
                }
                cr += 1;
            }
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    if cr > crlf && cr > lf {
        "\r"
    } else if crlf > lf {
        "\r\n"
    } else {
        "\n"
    }
}

/// 单遍把 \r\n 与裸 \r 都写成 \n。没有 \r 时直接返回，
/// 免得为整篇内容再分配一份等大的副本。
fn normalize_newlines(text: &mut String) {
    if !text.contains('\r') {
        return;
    }
    let mut buf = String::with_capacity(text.len());
    {
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\r' {
                buf.push('\n');
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            } else {
                buf.push(ch);
            }
        }
    }
    *text = buf;
}

fn encoding_by_name(name: &str) -> &'static encoding_rs::Encoding {
    match name.to_ascii_uppercase().as_str() {
        "UTF-16LE" => UTF_16LE,
        "UTF-16BE" => UTF_16BE,
        "GB18030" => GB18030,
        "BIG5" => BIG5,
        "SHIFT_JIS" => SHIFT_JIS,
        "EUC-KR" => EUC_KR,
        "WINDOWS-1252" => WINDOWS_1252,
        _ => encoding_rs::UTF_8,
    }
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<FileContent, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!(
            "文件过大（{} MB），当前上限为 {} MB",
            meta.len() / 1024 / 1024,
            MAX_FILE_SIZE / 1024 / 1024
        ));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let size = meta.len();
    let enc = detect_encoding(&bytes);
    let (cow, _, had_errors) = enc.decode(&bytes);
    let mut content = cow.into_owned();
    // 解码结果已经独立持有，先释放原始字节再加工，峰值内存少一整份文件大小
    drop(bytes);
    if had_errors {
        content.retain(|c| c != '\u{FFFD}');
    }
    // strip BOM from decoded text
    if content.starts_with('\u{FEFF}') {
        content.drain(..'\u{FEFF}'.len_utf8());
    }
    let line_ending = detect_line_ending(&content).to_owned();
    normalize_newlines(&mut content);
    Ok(FileContent {
        content,
        encoding: enc.name().to_owned(),
        line_ending,
        size,
        large: size > EDIT_SIZE_LIMIT,
    })
}

#[tauri::command]
pub fn write_text_file(
    path: String,
    content: String,
    encoding: Option<String>,
    line_ending: Option<String>,
) -> Result<FileMeta, String> {
    let enc = encoding_by_name(encoding.as_deref().unwrap_or("UTF-8"));
    let le = line_ending.unwrap_or_else(|| "\n".to_owned());
    // 先归一化成 \n 再按目标行尾展开：粘贴进来的文本本身可能已经带 \r\n，
    // 直接替换 \n 会写出 \r\r\n
    let lf = content.replace("\r\n", "\n").replace('\r', "\n");
    let text = if le == "\r\n" {
        lf.replace('\n', "\r\n")
    } else if le == "\r" {
        lf.replace('\n', "\r")
    } else {
        lf
    };
    // encoding_rs' encode() falls back to UTF-8 for UTF-16, so encode UTF-16 manually
    let bytes: Vec<u8> = match enc.name() {
        "UTF-16LE" => {
            let mut v = vec![0xFF, 0xFE];
            v.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
            v
        }
        "UTF-16BE" => {
            let mut v = vec![0xFE, 0xFF];
            v.extend(text.encode_utf16().flat_map(|u| u.to_be_bytes()));
            v
        }
        _ => {
            let (encoded, _, _) = enc.encode(&text);
            encoded.into_owned()
        }
    };

    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // atomic-ish write: temp file then rename
    let tmp = format!("{}.rnp-tmp", path);
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    file_metadata(path)
}

#[tauri::command]
pub fn file_metadata(path: String) -> Result<FileMeta, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileMeta {
        size: meta.len(),
        modified,
        read_only: meta.permissions().readonly(),
        exists: true,
    })
}

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "mdown", "mkd", "log", "json", "jsonc", "jsonl", "geojson",
    "topojson", "yaml", "yml", "toml", "ini", "conf", "cfg", "properties", "xml", "svg",
    "xsl", "xsd", "plist", "pom", "wsdl", "csv", "tsv", "html", "htm", "xht", "xhtml",
    "vue", "svelte", "css", "scss", "sass", "styl", "less", "js", "mjs", "cjs", "jsx",
    "coffee", "ts", "mts", "cts", "tsx", "py", "pyi", "pyw", "rs", "go", "java", "kt",
    "kts", "scala", "sbt", "c", "h", "cpp", "cc", "cxx", "cp", "hpp", "hh", "hxx", "inl",
    "ipp", "tpp", "cs", "csx", "dart", "m", "mm", "objc", "swift", "php", "php3", "php4",
    "php5", "phtml", "rb", "rake", "gemspec", "cr", "sh", "bash", "zsh", "fish", "ksh",
    "bashrc", "zshrc", "ps1", "psm1", "psd1", "sql", "ddl", "dml", "pl", "pm", "pod",
    "lua", "r", "rd", "jl", "hs", "lhs", "erl", "hrl", "escript", "clj", "cljs", "cljc",
    "edn", "lisp", "lsp", "el", "scm", "ss", "rkt", "groovy", "gvy", "gy", "gradle", "f",
    "f77", "f90", "f95", "f03", "for", "pas", "dpr", "dpk", "inc", "v", "sv", "svh", "vh",
    "proto", "cmake", "tcl", "tk", "vb", "vbs", "bas", "http", "rest", "diff", "patch",
    "rej", "env", "editorconfig", "gitignore",
];

const NO_EXT_NAMES: &[&str] = &[
    "dockerfile", "makefile", "readme", "license", "changelog", "todo", "authors",
    "cmakelists", "jenkinsfile", "gemfile", "brewfile", "vagrantfile",
];

const MAX_FOLDER_FILES: usize = 200;
const MAX_FOLDER_FILE_SIZE: u64 = 8 * 1024 * 1024;
const MAX_FOLDER_DEPTH: u32 = 4;

fn is_text_candidate(path: &Path) -> bool {
    let name = match path.file_name().map(|n| n.to_string_lossy().to_lowercase()) {
        Some(n) => n,
        None => return false,
    };
    if name.starts_with('.') {
        return false;
    }
    if let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_lowercase()) {
        return TEXT_EXTS.contains(&ext.as_str());
    }
    if NO_EXT_NAMES.contains(&name.as_str()) {
        return true;
    }
    // 无后缀又不在白名单：这类文件在 Windows/Linux 上很常见（notes、todo、backup 等），
    // 按内容判定，纯文本就列出来，二进制才排除。
    looks_like_text(path)
}

/// 只读开头 8 KiB 做嗅探：出现 NUL 字节就认为是二进制，
/// 这样无后缀的可执行文件、镜像不会混进资源管理器。
fn looks_like_text(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 8 * 1024];
    let Ok(read) = file.read(&mut buf) else {
        return false;
    };
    !buf[..read].contains(&0)
}

fn scan_dir(dir: &Path, depth: u32, out: &mut Vec<String>) {
    if depth > MAX_FOLDER_DEPTH || out.len() >= MAX_FOLDER_FILES {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut files: Vec<PathBuf> = Vec::new();
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let is_dir = p.is_dir();
        if is_dir {
            if p.file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(true)
            {
                continue;
            }
            subdirs.push(p);
        } else if p.is_file() && is_text_candidate(&p) {
            if fs::metadata(&p).map(|m| m.len() <= MAX_FOLDER_FILE_SIZE).unwrap_or(false) {
                files.push(p);
            }
        }
    }
    files.sort();
    subdirs.sort();
    for f in files {
        if out.len() >= MAX_FOLDER_FILES {
            return;
        }
        out.push(f.to_string_lossy().to_string());
    }
    for d in subdirs {
        scan_dir(&d, depth + 1, out);
    }
}

#[tauri::command]
pub fn is_directory(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
pub fn list_text_files(dir: String) -> Vec<String> {
    let mut out = Vec::new();
    scan_dir(Path::new(&dir), 0, &mut out);
    out
}

#[derive(Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<TreeNode>>,
}

fn build_tree(path: &Path, depth: u32) -> TreeNode {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let is_dir = path.is_dir();
    let children = if is_dir && depth < 6 {
        let mut dirs: Vec<PathBuf> = Vec::new();
        let mut files: Vec<PathBuf> = Vec::new();
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let p = entry.path();
                let hidden = p
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with('.'))
                    .unwrap_or(true);
                if hidden {
                    continue;
                }
                if p.is_dir() {
                    dirs.push(p);
                } else if p.is_file() && is_text_candidate(&p) {
                    if fs::metadata(&p)
                        .map(|m| m.len() <= MAX_FOLDER_FILE_SIZE)
                        .unwrap_or(false)
                    {
                        files.push(p);
                    }
                }
                if dirs.len() + files.len() > 500 {
                    break;
                }
            }
        }
        // 与 VS Code 资源管理器一致：忽略大小写排序，目录在前
        let sort_key = |p: &PathBuf| {
            p.file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        };
        dirs.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
        files.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
        let mut nodes: Vec<TreeNode> = dirs.iter().map(|d| build_tree(d, depth + 1)).collect();
        nodes.extend(files.iter().map(|f| TreeNode {
            name: f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            path: f.to_string_lossy().to_string(),
            is_dir: false,
            children: None,
        }));
        Some(nodes)
    } else if is_dir {
        Some(Vec::new())
    } else {
        None
    };
    TreeNode {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
        children,
    }
}

#[tauri::command]
pub fn list_folder_tree(dir: String) -> TreeNode {
    build_tree(Path::new(&dir), 0)
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("目标已存在".into());
    }
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("目标已存在".into());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if !Path::new(&from).exists() {
        return Err("源路径不存在".into());
    }
    if Path::new(&to).exists() {
        return Err("目标名称已存在".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("移入回收站失败: {e}"))
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        let entries = fs::read_dir(src).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let p = entry.path();
            let name = match p.file_name() {
                Some(n) => n.to_owned(),
                None => continue,
            };
            copy_recursive(&p, &dst.join(name))?;
        }
        Ok(())
    } else {
        fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn copy_path(from: String, to: String) -> Result<(), String> {
    let src = Path::new(&from);
    let dst = Path::new(&to);
    if !src.exists() {
        return Err("源路径不存在".into());
    }
    if dst.exists() {
        return Err("目标已存在".into());
    }
    if src.is_dir() {
        let src_canon = src.canonicalize().map_err(|e| e.to_string())?;
        if let Some(parent) = dst.parent().and_then(|p| p.canonicalize().ok()) {
            if parent.starts_with(&src_canon) {
                return Err("不能将文件夹复制到其自身内部".into());
            }
        }
    }
    copy_recursive(src, dst)
}

#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.to_string_lossy()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if p.is_dir() {
            p.to_path_buf()
        } else {
            p.parent().unwrap_or(p).to_path_buf()
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

const RECENT_FILE: &str = "recent.json";

/// 最近打开列表的候选位置：macOS 为 `~/.rocketnote`，其余平台 exe 同目录优先。
/// 老位置（`.app` 包内、系统应用配置目录）已有的列表先搬一次。
fn recent_paths(app: &AppHandle) -> Vec<PathBuf> {
    crate::paths::files_of(RECENT_FILE, app)
}

fn load_recent(app: &AppHandle) -> Vec<RecentEntry> {
    crate::paths::read_first(&recent_paths(app))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn list_recent(app: AppHandle) -> Vec<RecentEntry> {
    load_recent(&app)
}

#[tauri::command]
pub fn push_recent(app: AppHandle, path: String) {
    let name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut list = load_recent(&app);
    list.retain(|e| e.path != path);
    list.insert(
        0,
        RecentEntry {
            path,
            name,
            opened_at: now,
        },
    );
    list.truncate(MAX_RECENT);
    if let Ok(json) = serde_json::to_string(&list) {
        let _ = crate::paths::write_first(&recent_paths(&app), json.as_bytes());
    }
}

#[tauri::command]
pub fn clear_recent(app: AppHandle) {
    // 连老位置那份一起删，否则下次启动又把旧列表搬回来
    for path in recent_paths(&app) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 每个用例独立临时目录：目录名附加进程 id 与递增计数，先清空再创建，
    /// 避免并行用例或重复运行之间相互干扰。
    fn tmp(name: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("rnp-test-{}-{}-{}", name, std::process::id(), n));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    /// 造一个稀疏文件：只声明长度不写数据，APFS 上几乎零成本。
    fn sparse_file(path: &Path, len: u64) {
        let f = fs::File::create(path).unwrap();
        f.set_len(len).unwrap();
    }

    fn utf16le_bytes(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(|c| c.to_le_bytes()).collect()
    }

    fn utf16be_bytes(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(|c| c.to_be_bytes()).collect()
    }

    fn from_utf16_le(data: &[u8]) -> String {
        let units: Vec<u16> = data
            .chunks(2)
            .filter_map(|c| if c.len() == 2 { Some(u16::from_le_bytes([c[0], c[1]])) } else { None })
            .collect();
        String::from_utf16_lossy(&units)
    }

    fn find_node<'a>(node: &'a TreeNode, name: &str) -> Option<&'a TreeNode> {
        if node.name == name {
            return Some(node);
        }
        node.children.as_ref()?.iter().find_map(|c| find_node(c, name))
    }

    fn child_names(node: &TreeNode) -> Vec<String> {
        node.children
            .as_ref()
            .map(|cs| cs.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default()
    }

    // ===================== A. read_text_file：编码识别与解码 =====================

    #[test]
    fn reads_utf8() {
        let dir = tmp("utf8");
        let f = dir.join("a.txt");
        fs::write(&f, "hello 世界\nline2\n").unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "UTF-8");
        assert_eq!(fc.line_ending, "\n");
        assert!(fc.content.contains("世界"));
    }

    #[test]
    fn reads_utf8_with_bom_and_strips_it() {
        let dir = tmp("utf8bom");
        let f = dir.join("bom.txt");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("带BOM的文件\r\n第二行".as_bytes());
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "UTF-8");
        // BOM 必须被剥掉，不能残留在内容开头
        assert!(!fc.content.starts_with('\u{FEFF}'));
        assert!(!fc.content.contains('\u{FEFF}'));
        assert_eq!(fc.content, "带BOM的文件\n第二行");
        assert_eq!(fc.line_ending, "\r\n");
        // size 是磁盘字节数（含 3 字节 BOM）
        assert_eq!(fc.size, bytes.len() as u64);
    }

    #[test]
    fn reads_pure_ascii_as_utf8() {
        let dir = tmp("ascii");
        let f = dir.join("ascii.txt");
        fs::write(&f, b"plain ascii, no high bytes\r\n").unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "UTF-8");
        assert_eq!(fc.content, "plain ascii, no high bytes\n");
        assert_eq!(fc.line_ending, "\r\n");
    }

    #[test]
    fn reads_utf16le_bom() {
        let dir = tmp("u16lebom");
        let f = dir.join("le.txt");
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(utf16le_bytes("UTF-16LE 测试\n第二行"));
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "UTF-16LE");
        assert_eq!(fc.content, "UTF-16LE 测试\n第二行");
    }

    #[test]
    fn reads_utf16be_bom_with_crlf() {
        let dir = tmp("u16be");
        let f = dir.join("be.txt");
        let mut bytes = vec![0xFE, 0xFF];
        bytes.extend(utf16be_bytes("UTF-16BE 测试\r\n第二行"));
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "UTF-16BE");
        assert_eq!(fc.line_ending, "\r\n");
        assert_eq!(fc.content, "UTF-16BE 测试\n第二行");
        assert!(!fc.content.contains('\r'));
    }

    #[test]
    fn detects_gbk_and_crlf() {
        let dir = tmp("gbk");
        let f = dir.join("g.txt");
        let bytes = GB18030.encode("这是GBK编码。\r\n第二行").0;
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "gb18030");
        assert_eq!(fc.line_ending, "\r\n");
        assert_eq!(fc.content, "这是GBK编码。\n第二行");
    }

    #[test]
    fn roundtrips_utf16le_with_bom() {
        let dir = tmp("u16");
        let f = dir.join("u.txt");
        fs::write(&f, "\u{FEFF}测试UTF16".encode_utf16().flat_map(|c| c.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "UTF-16LE");
        assert_eq!(fc.content, "测试UTF16");
        write_text_file(s(&f), fc.content + "\n", Some("UTF-16LE".into()), Some("\r\n".into())).unwrap();
        let raw = fs::read(&f).unwrap();
        assert!(raw.starts_with(&[0xFF, 0xFE]));
        let text = from_utf16_le(&raw[2..]);
        assert_eq!(text, "测试UTF16\r\n");
    }

    #[test]
    fn legacy_big5_sample_decodes_to_traditional_chinese() {
        // BIG5 双字节序列的字节范围被 GB18030 两字节编码完全覆盖，
        // 单靠“能否无错解码”无法区分，因此按脚本特征打分：
        // GB18030 读出的假名按乱码扣分，BIG5 读出的常用繁体中文加分。
        let dir = tmp("big5");
        let f = dir.join("big5.txt");
        let bytes = BIG5.encode("中文繁體測試").0;
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "Big5");
        assert_eq!(fc.content, "中文繁體測試");
    }

    #[test]
    fn legacy_shiftjis_sample_decodes_to_japanese() {
        // Shift_JIS 双字节序列同样可被 GB18030 无错解码，
        // 但 GB18030 读出的是生僻转借字，Shift_JIS 读出假名+常用汉字。
        let dir = tmp("sjis");
        let f = dir.join("sjis.txt");
        let bytes = SHIFT_JIS.encode("日本語テスト").0;
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "Shift_JIS");
        assert_eq!(fc.content, "日本語テスト");
    }

    #[test]
    fn legacy_euckr_sample_decodes_to_korean() {
        // EUC-KR 双字节序列（0xA1-0xFE）落在 GB18030 两字节范围内，靠谚文特征判回 EUC-KR。
        let dir = tmp("euckr");
        let f = dir.join("euckr.txt");
        let bytes = EUC_KR.encode("한국어 테스트").0;
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "EUC-KR");
        assert_eq!(fc.content, "한국어 테스트");
    }

    #[test]
    fn ambiguous_chinese_bytes_still_prefer_gb18030() {
        // 简体中文字节：GB18030 读出常用汉字得分最高，BIG5 读出的是生僻字。
        // 得分相同的候选（如纯 GB2312 区字节）仍按候选顺序保留 GB18030。
        let dir = tmp("ambig");
        let f = dir.join("gb.txt");
        let bytes = GB18030.encode("这是一段中文文本\n").0;
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "gb18030");
        assert_eq!(fc.content, "这是一段中文文本\n");
    }

    #[test]
    fn legacy_encoding_roundtrips_after_detection() {
        // 识别正确后，按上报的编码原样写回应得到同样的字节
        let dir = tmp("legacy-rt");
        for (name, enc, text) in [
            ("big5.txt", BIG5, "中文繁體測試，電腦與程式設計。"),
            ("sjis.txt", SHIFT_JIS, "ひらがなテスト"),
            ("euckr.txt", EUC_KR, "한국어 테스트"),
        ] {
            let f = dir.join(name);
            let bytes = enc.encode(text).0;
            fs::write(&f, &bytes).unwrap();
            let fc = read_text_file(s(&f)).unwrap();
            assert_eq!(fc.content, text, "{}", fc.encoding);
            write_text_file(s(&f), text.into(), Some(fc.encoding.clone()), Some("\n".into())).unwrap();
            assert_eq!(fs::read(&f).unwrap(), bytes.to_vec(), "{}", fc.encoding);
        }
    }

    #[test]
    fn long_cjk_documents_keep_their_own_encoding() {
        // 更长的真实文本：中文里按 EUC-KR 误读出的零星谚文、按 Shift_JIS 误读出的
        // 半角假名都不该把整篇判成韩文/日文，韩文里的谚文比例则该压倒其他候选。
        let dir = tmp("cjk-long");
        let cases = [
            (
                "gb.txt",
                GB18030,
                "简体中文与标点：《句号》。\n第二行还有一段更长的说明文字，用来验证编码识别。\n",
                "gb18030",
            ),
            (
                "big5.txt",
                BIG5,
                "中文繁體測試，電腦與程式設計。\n這是一份用來驗證編碼識別的說明文件。\n",
                "Big5",
            ),
            (
                "sjis.txt",
                SHIFT_JIS,
                "東京大学で日本語を勉強しました。\nこれはコードエディタのテスト文です。\n",
                "Shift_JIS",
            ),
            (
                "kr.txt",
                EUC_KR,
                "안녕하세요. 반가워요.\n이것은 코딩 편집기 테스트 문서입니다.\n",
                "EUC-KR",
            ),
        ];
        for (name, enc, text, want) in cases {
            let f = dir.join(name);
            fs::write(&f, enc.encode(text).0.as_ref()).unwrap();
            let fc = read_text_file(s(&f)).unwrap();
            assert_eq!(fc.encoding, want, "{name}");
            assert_eq!(fc.content, text, "{name}");
        }
    }

    #[test]
    fn undecodable_bytes_fall_back_to_windows1252() {
        let dir = tmp("cp1252");
        let f = dir.join("bad.txt");
        // 0xFF 使 GB18030/BIG5/SHIFT_JIS/EUC_KR 全部解码失败，回退 WINDOWS-1252；
        // WHATWG windows-1252 对每个字节都有映射，不会产生 U+FFFD。
        fs::write(&f, [0x41u8, 0xFF, 0x42, 0x81, 0xFE]).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "windows-1252");
        assert_eq!(fc.content, "A\u{FF}B\u{81}\u{FE}");
        assert!(!fc.content.contains('\u{FFFD}'));
    }

    #[test]
    fn reads_empty_file() {
        let dir = tmp("emptyfile");
        let f = dir.join("empty.txt");
        fs::write(&f, "").unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.content, "");
        assert_eq!(fc.encoding, "UTF-8");
        assert_eq!(fc.line_ending, "\n");
        assert_eq!(fc.size, 0);
    }

    #[test]
    fn read_missing_file_and_directory_return_err() {
        let dir = tmp("readerr");
        assert!(read_text_file(s(&dir.join("nope.txt"))).is_err());
        // 对目录调用读取：metadata 能过但 fs::read 会报 Is a directory
        assert!(read_text_file(s(&dir)).is_err());
    }

    // ===================== B. 行尾检测与归一化 =====================

    #[test]
    fn detect_line_ending_rules() {
        // CRLF 为主
        assert_eq!(detect_line_ending("a\r\nb\r\n"), "\r\n");
        // LF 为主
        assert_eq!(detect_line_ending("a\nb\n"), "\n");
        // 混合按多数：2 个 CRLF、1 个裸 LF
        assert_eq!(detect_line_ending("a\r\nb\r\nc\n"), "\r\n");
        // 混合平局（crlf == lf）实现判定为 LF
        assert_eq!(detect_line_ending("a\r\nb\nc\r\nd\n"), "\n");
        // 纯 CR（旧 Mac 行尾）：裸 \r 计数占多数，上报 CR
        assert_eq!(detect_line_ending("a\rb\rc"), "\r");
        // CR 与 CRLF 数量相同：按更常见的 CRLF
        assert_eq!(detect_line_ending("a\rb\r\n"), "\r\n");
        // 空文件 / 单行无换行 / 只有尾部换行
        assert_eq!(detect_line_ending(""), "\n");
        assert_eq!(detect_line_ending("only line"), "\n");
        assert_eq!(detect_line_ending("abc\n"), "\n");
        assert_eq!(detect_line_ending("abc\r\n"), "\r\n");
    }

    #[test]
    fn read_normalizes_all_line_endings() {
        let dir = tmp("normalize");
        // 混合行尾：1 个 \r\n + 1 个裸 \n，平局按 LF 上报，但内容统一为 \n
        let f1 = dir.join("mix.txt");
        fs::write(&f1, "a\r\nb\nc").unwrap();
        let fc = read_text_file(s(&f1)).unwrap();
        assert_eq!(fc.line_ending, "\n");
        assert_eq!(fc.content, "a\nb\nc");
        assert!(!fc.content.contains('\r'));
        // \r\r\n（旧 Mac 与 CRLF 粘连）：按实现计 1 个 CRLF，内容归一化为两个 \n
        let f2 = dir.join("cr.txt");
        fs::write(&f2, "abc\r\r\ndef").unwrap();
        let fc = read_text_file(s(&f2)).unwrap();
        assert_eq!(fc.line_ending, "\r\n");
        assert_eq!(fc.content, "abc\n\ndef");
        // 纯 CR 文件：上报 CR，内容仍被归一化成 \n
        let f3 = dir.join("pure-cr.txt");
        fs::write(&f3, "x\ry\rz").unwrap();
        let fc = read_text_file(s(&f3)).unwrap();
        assert_eq!(fc.line_ending, "\r");
        assert_eq!(fc.content, "x\ny\nz");
        assert!(!fc.content.contains('\r'));
    }

    // ===================== C. write_text_file =====================

    #[test]
    fn write_crlf_roundtrip() {
        let dir = tmp("wrcrlf");
        let f = dir.join("crlf.txt");
        let meta = write_text_file(s(&f), "x\ny\n".into(), None, Some("\r\n".into())).unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"x\r\ny\r\n");
        assert_eq!(meta.size, 6);
        assert!(meta.exists);
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.line_ending, "\r\n");
        assert_eq!(fc.content, "x\ny\n");
    }

    #[test]
    fn write_crlf_is_idempotent_and_cr_writes_lone_cr() {
        let dir = tmp("wridem");
        let f = dir.join("idem.txt");
        // 内容已带 \r\n（粘贴/外部导入）时再按 CRLF 保存，不能写出 \r\r\n
        write_text_file(s(&f), "x\r\ny\r\n".into(), None, Some("\r\n".into())).unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"x\r\ny\r\n");
        // 反复保存保持字节不变
        for _ in 0..3 {
            let content = read_text_file(s(&f)).unwrap().content;
            write_text_file(s(&f), content, None, Some("\r\n".into())).unwrap();
            assert_eq!(fs::read(&f).unwrap(), b"x\r\ny\r\n");
        }
        // CR 行尾：写出裸 \r，读取后仍识别为 CR 并归一化
        let cr = dir.join("cr.txt");
        write_text_file(s(&cr), "x\ny\n".into(), None, Some("\r".into())).unwrap();
        assert_eq!(fs::read(&cr).unwrap(), b"x\ry\r");
        let fc = read_text_file(s(&cr)).unwrap();
        assert_eq!(fc.line_ending, "\r");
        assert_eq!(fc.content, "x\ny\n");
    }

    #[test]
    fn write_utf16le_and_be_include_bom() {
        let dir = tmp("wru16");
        let le = dir.join("le.txt");
        write_text_file(s(&le), "写入UTF16LE\n".into(), Some("UTF-16LE".into()), None).unwrap();
        let raw = fs::read(&le).unwrap();
        assert!(raw.starts_with(&[0xFF, 0xFE]));
        assert_eq!(from_utf16_le(&raw[2..]), "写入UTF16LE\n");
        let fc = read_text_file(s(&le)).unwrap();
        assert_eq!(fc.encoding, "UTF-16LE");
        assert_eq!(fc.content, "写入UTF16LE\n");
        assert_eq!(fc.size, raw.len() as u64);

        let be = dir.join("be.txt");
        write_text_file(s(&be), "写入UTF16BE".into(), Some("utf-16be".into()), None).unwrap();
        let raw = fs::read(&be).unwrap();
        assert!(raw.starts_with(&[0xFE, 0xFF]));
        // 编码名匹配忽略大小写（encoding_by_name 会先转大写）
        let fc = read_text_file(s(&be)).unwrap();
        assert_eq!(fc.encoding, "UTF-16BE");
        assert_eq!(fc.content, "写入UTF16BE");
    }

    #[test]
    fn write_gb18030_roundtrip() {
        let dir = tmp("wrgb");
        let f = dir.join("gb.txt");
        let text = "简体中文与标点：《句号》。\n第二行";
        let meta = write_text_file(s(&f), text.into(), Some("GB18030".into()), Some("\r\n".into())).unwrap();
        let raw = fs::read(&f).unwrap();
        assert_eq!(raw, GB18030.encode("简体中文与标点：《句号》。\r\n第二行").0.as_ref());
        assert_eq!(meta.size, raw.len() as u64);
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "gb18030");
        assert_eq!(fc.content, text);
    }

    #[test]
    fn write_creates_missing_parent_dirs_and_no_tmp_leftover() {
        let dir = tmp("wrparent");
        let f = dir.join("a").join("b").join("c").join("note.txt");
        write_text_file(s(&f), "深层目录\n".into(), None, None).unwrap();
        assert!(f.exists());
        assert_eq!(fs::read_to_string(&f).unwrap(), "深层目录\n");
        // 原子写不允许留下 .rnp-tmp 残留：本层目录里只应有目标文件
        let siblings: Vec<_> = fs::read_dir(f.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(siblings, vec!["note.txt".to_string()]);
        assert!(!Path::new(&format!("{}.rnp-tmp", s(&f))).exists());
        // 覆盖写同样不留残留
        write_text_file(s(&f), "第二版".into(), None, None).unwrap();
        assert_eq!(fs::read_dir(f.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn write_empty_content_makes_empty_file() {
        let dir = tmp("wrempty");
        let f = dir.join("e.txt");
        let meta = write_text_file(s(&f), "".into(), None, None).unwrap();
        assert_eq!(meta.size, 0);
        let raw = fs::read(&f).unwrap();
        assert!(raw.is_empty());
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.content, "");
    }

    // ===================== D. file_metadata =====================

    #[test]
    fn metadata_reports_size_modified_and_read_only() {
        let dir = tmp("meta");
        let f = dir.join("m.txt");
        fs::write(&f, "12345").unwrap();
        let m = file_metadata(s(&f)).unwrap();
        assert!(m.exists);
        assert_eq!(m.size, 5);
        assert!(m.modified > 0);
        assert!(!m.read_only);
        // 只读属性（POSIX 权限位；Windows 上不验证）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&f, fs::Permissions::from_mode(0o444)).unwrap();
            let m = file_metadata(s(&f)).unwrap();
            assert!(m.read_only);
            fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        }
    }

    #[test]
    fn metadata_missing_file_is_err() {
        let dir = tmp("metaerr");
        let r = file_metadata(s(&dir.join("missing.txt")));
        assert!(r.is_err());
    }

    // ===================== E. is_directory / path_exists =====================

    #[test]
    fn is_directory_and_path_exists() {
        let dir = tmp("exists");
        let f = dir.join("f.txt");
        fs::write(&f, "x").unwrap();
        assert!(is_directory(s(&dir)));
        assert!(!is_directory(s(&f)));
        assert!(!is_directory(s(&dir.join("nope"))));
        assert!(path_exists(s(&dir)));
        assert!(path_exists(s(&f)));
        assert!(!path_exists(s(&dir.join("nope"))));
    }

    // ===================== F. is_text_candidate =====================

    #[test]
    fn candidate_recognizes_known_extensions() {
        for name in ["a.txt", "b.md", "c.json", "d.rs", "e.py", "f.tsx", "g.html", "h.css", "i.sql", "j.sh"] {
            assert!(is_text_candidate(Path::new(name)), "{} 应判为文本", name);
        }
        // 扩展名大小写不敏感
        assert!(is_text_candidate(Path::new("A.MD")));
        assert!(is_text_candidate(Path::new("Code.RS")));
        // 多段扩展名按最后一段判断
        assert!(is_text_candidate(Path::new("a.test.md")));
        assert!(!is_text_candidate(Path::new("a.tar.gz")));
    }

    #[test]
    fn candidate_recognizes_no_extension_whitelist() {
        // NO_EXT_NAMES 以全小写存储，匹配时对文件名做小写化，任意大小写都应命中
        for name in ["Dockerfile", "dockerfile", "Makefile", "CMakeLists", "README", "LICENSE", "CHANGELOG", "Gemfile", "Brewfile", "Vagrantfile"] {
            assert!(is_text_candidate(Path::new(name)), "{} 应判为文本", name);
        }
    }

    #[test]
    fn candidate_rejects_hidden_unknown_and_empty() {
        // 以点开头的文件被排除，即使扩展名在白名单里
        assert!(!is_text_candidate(Path::new(".gitignore")));
        assert!(!is_text_candidate(Path::new(".env")));
        assert!(!is_text_candidate(Path::new(".DS_Store")));
        // 未知扩展名被排除
        assert!(!is_text_candidate(Path::new("photo.jpg")));
        assert!(!is_text_candidate(Path::new("app.exe")));
        assert!(!is_text_candidate(Path::new("data.xlsx")));
        // 未知扩展名（即使带白名单前缀）
        assert!(!is_text_candidate(Path::new("LICENSE.txt.bak")));
        // 没有文件名的路径
        assert!(!is_text_candidate(Path::new("")));
    }

    #[test]
    fn candidate_uses_content_sniff_for_extensionless_files() {
        let dir = tmp("candidate-noext");
        let plain = dir.join("notes");
        fs::write(&plain, "第一行\n第二行\n").unwrap();
        assert!(is_text_candidate(&plain), "无后缀纯文本应列出");

        let empty = dir.join("empty");
        fs::write(&empty, "").unwrap();
        assert!(is_text_candidate(&empty), "空文件也当纯文本列出");

        let binary = dir.join("blob");
        fs::write(&binary, [0x7f_u8, b'E', b'L', 0, 1, 2]).unwrap();
        assert!(!is_text_candidate(&binary), "含 NUL 的无后缀文件应排除");

        let beyond = dir.join("payload");
        fs::write(&beyond, [b'a'; 8 * 1024].iter().chain([0u8].iter()).copied().collect::<Vec<u8>>()).unwrap();
        assert!(is_text_candidate(&beyond), "NUL 在嗅探窗口之外就不影响判定");

        assert!(!is_text_candidate(&dir.join("ghost")), "读不到的路径不应列出");
        let _ = fs::remove_dir_all(dir);
    }

    // ===================== G. list_text_files =====================

    #[test]
    fn scans_folder_for_text_files() {
        let dir = tmp("folder");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join("a.txt"), "aaa").unwrap();
        fs::write(dir.join("b.bin"), [0u8; 10]).unwrap();
        fs::write(dir.join("Dockerfile"), "FROM x").unwrap();
        fs::write(dir.join("sub").join("c.md"), "# c").unwrap();
        fs::write(dir.join(".hidden").join("d.txt"), "ddd").unwrap();
        fs::write(dir.join("huge.txt"), vec![b'x'; 9 * 1024 * 1024]).unwrap();
        let found = list_text_files(s(&dir));
        let mut names: Vec<String> = found
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_lowercase()
            })
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "c.md", "dockerfile"]);
        assert!(is_directory(s(&dir)));
        assert!(!is_directory(s(&dir.join("a.txt"))));
    }

    #[test]
    fn list_text_files_orders_files_before_recursion_and_respects_depth() {
        let dir = tmp("listorder");
        // 根层：三个文本文件 + 一个二进制 + 一个隐藏文件 + 一个超限稀疏文件
        fs::write(dir.join("z.txt"), "z").unwrap();
        fs::write(dir.join("a.txt"), "a").unwrap();
        fs::write(dir.join("b.md"), "b").unwrap();
        fs::write(dir.join("bin.dat"), [1, 2, 3]).unwrap();
        fs::write(dir.join(".hidden.txt"), "h").unwrap();
        sparse_file(&dir.join("huge.txt"), MAX_FOLDER_FILE_SIZE + 1);
        // 子目录（按名字典序递归：d1 < e1 < sub < sub2）
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("a2.txt"), "x").unwrap();
        fs::write(dir.join("sub").join("c.md"), "y").unwrap();
        fs::create_dir_all(dir.join("sub2")).unwrap();
        fs::write(dir.join("sub2").join("x.txt"), "x").unwrap();
        // 深度 4 的文件可见：d1/d2/d3/d4/ok.txt 在 scan_dir(depth=4) 中收集
        fs::create_dir_all(dir.join("d1").join("d2").join("d3").join("d4")).unwrap();
        fs::write(dir.join("d1").join("d2").join("d3").join("d4").join("ok.txt"), "d").unwrap();
        // 深度 5 的文件不可见：scan_dir(e5, 5) 因 5 > MAX_FOLDER_DEPTH 直接返回
        fs::create_dir_all(dir.join("e1").join("e2").join("e3").join("e4").join("e5")).unwrap();
        fs::write(dir.join("e1").join("e2").join("e3").join("e4").join("e5").join("deep.txt"), "d").unwrap();
        // 隐藏目录整体跳过
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("config"), "g").unwrap();

        let found = list_text_files(s(&dir));
        let rel: Vec<String> = found
            .iter()
            .map(|p| {
                Path::new(p)
                    .strip_prefix(&dir)
                    .unwrap()
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .collect();
        // 先本层（按路径字典序），再按子目录名字典序递归
        assert_eq!(
            rel,
            vec![
                "a.txt", "b.md", "z.txt",
                "d1/d2/d3/d4/ok.txt",
                "sub/a2.txt", "sub/c.md",
                "sub2/x.txt",
            ]
        );
    }

    #[test]
    fn list_text_files_caps_at_max_folder_files() {
        let dir = tmp("listcap");
        for i in 0..250 {
            fs::write(dir.join(format!("f{:03}.txt", i)), "x").unwrap();
        }
        let found = list_text_files(s(&dir));
        assert_eq!(found.len(), MAX_FOLDER_FILES);
        assert_eq!(found.len(), 200);
        // 命中上限的是字典序前 200 个文件
        assert!(found.first().unwrap().ends_with("f000.txt"));
        assert!(found.get(199).unwrap().ends_with("f199.txt"));
        assert!(!found.iter().any(|p| p.ends_with("f200.txt")));
    }

    #[test]
    fn list_text_files_missing_dir_returns_empty() {
        let dir = tmp("listmissing");
        assert!(list_text_files(s(&dir.join("nope"))).is_empty());
    }

    // ===================== H. list_folder_tree / build_tree =====================

    #[test]
    fn tree_orders_dirs_then_files_case_insensitively() {
        let dir = tmp("treeorder");
        fs::create_dir_all(dir.join("Zeta")).unwrap();
        fs::create_dir_all(dir.join("alpha")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("Zeta").join("note.txt"), "n").unwrap();
        fs::write(dir.join("Beta.md"), "b").unwrap();
        fs::write(dir.join("apple.md"), "a").unwrap();
        fs::write(dir.join("skip.bin"), [0u8; 4]).unwrap();
        fs::write(dir.join(".hidden.md"), "h").unwrap();
        fs::write(dir.join(".git").join("config"), "g").unwrap();

        let root = list_folder_tree(s(&dir));
        assert!(root.is_dir);
        assert_eq!(root.name, dir.file_name().unwrap().to_string_lossy().to_string());
        assert_eq!(root.path, s(&dir));
        // 目录在前（忽略大小写：alpha < Zeta），文件在后（apple.md < Beta.md）；隐藏与非文本被排除
        assert_eq!(child_names(&root), vec!["alpha", "Zeta", "apple.md", "Beta.md"]);

        // 空目录 children 为空数组
        let alpha = find_node(&root, "alpha").unwrap();
        assert!(matches!(alpha.children.as_deref(), Some(cs) if cs.is_empty()));
        // 有内容的目录
        assert_eq!(child_names(find_node(&root, "Zeta").unwrap()), vec!["note.txt"]);
        // 文件节点 children 为 None
        let apple = find_node(&root, "apple.md").unwrap();
        assert!(!apple.is_dir);
        assert_eq!(apple.name, "apple.md");
        assert!(apple.children.is_none());
        assert!(find_node(&root, "skip.bin").is_none());
        assert!(find_node(&root, ".hidden.md").is_none());
        assert!(find_node(&root, ".git").is_none());
    }

    #[test]
    fn tree_stops_expanding_at_depth_six() {
        let dir = tmp("treedepth");
        let deep = (1..=6).fold(dir.clone(), |acc, i| acc.join(format!("n{}", i)));
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("deep.txt"), "x").unwrap();

        let root = list_folder_tree(s(&dir));
        // 逐层走到 n6（depth=6），其 children 应为空数组且看不见更深处内容
        let mut node = &root;
        for i in 1..=6 {
            node = find_node(node, &format!("n{}", i)).expect("逐层目录应存在");
            assert!(node.is_dir);
        }
        assert!(matches!(node.children.as_deref(), Some(cs) if cs.is_empty()));
        assert!(find_node(&root, "deep.txt").is_none());
    }

    #[test]
    fn tree_skips_oversized_file() {
        let dir = tmp("treebig");
        fs::write(dir.join("small.txt"), "ok").unwrap();
        sparse_file(&dir.join("big.txt"), MAX_FOLDER_FILE_SIZE + 1);
        let root = list_folder_tree(s(&dir));
        assert_eq!(child_names(&root), vec!["small.txt"]);
    }

    #[test]
    fn tree_for_missing_path_is_not_dir() {
        let dir = tmp("treemissing");
        let missing = dir.join("nope");
        let root = list_folder_tree(s(&missing));
        assert!(!root.is_dir);
        assert!(root.children.is_none());
        assert_eq!(root.name, "nope");
        assert_eq!(root.path, s(&missing));
    }

    #[test]
    fn list_folder_tree_perf_16mb_folder() {
        // 性能护栏：含 16MB 文件与数百小文件的目录，建树应在 3 秒内完成
        let dir = tmp("perftree");
        let filler = "0123456789abcdef ".repeat(16 * 1024); // ~272B
        let mut data = String::new();
        while data.len() < 16 * 1024 * 1024 {
            data.push_str(&filler);
            data.push('\n');
        }
        fs::write(dir.join("big.md"), &data).unwrap();
        fs::create_dir_all(dir.join("many")).unwrap();
        for i in 0..300 {
            fs::write(dir.join("many").join(format!("f{:03}.txt", i)), "x").unwrap();
        }
        let start = std::time::Instant::now();
        let root = list_folder_tree(s(&dir));
        let elapsed = start.elapsed();
        println!("list_folder_tree over 16MB + 300 files in {:?}", elapsed);
        // 超过 8MB 的 big.md 不进树（建树不读取内容，但按大小过滤）
        assert_eq!(child_names(&root), vec!["many"]);
        assert_eq!(find_node(&root, "many").unwrap().children.as_ref().unwrap().len(), 300);
        assert!(elapsed.as_millis() < 3000, "16MB 目录树构建耗时 {elapsed:?}");
    }

    // ===================== I. create / rename / copy / delete =====================

    #[test]
    fn create_and_rename_paths() {
        let dir = tmp("fsops");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("note.md");
        create_file(s(&f)).unwrap();
        assert!(f.exists());
        assert!(create_file(s(&f)).is_err());
        let sub = dir.join("subdir");
        create_dir(s(&sub)).unwrap();
        assert!(sub.is_dir());
        let renamed = dir.join("renamed.md");
        rename_path(s(&f), s(&renamed)).unwrap();
        assert!(!f.exists());
        assert!(renamed.exists());
        assert!(rename_path(s(&renamed), s(&renamed)).is_err());
    }

    #[test]
    fn create_file_and_dir_duplicate_and_parents() {
        let dir = tmp("createops");
        // create_file 自动建父目录，且内容为空
        let f = dir.join("deep").join("nest").join("new.txt");
        create_file(s(&f)).unwrap();
        assert!(f.exists());
        assert_eq!(fs::read_to_string(&f).unwrap(), "");
        // 重复创建报错文案
        assert_eq!(create_file(s(&f)).unwrap_err(), "目标已存在");
        let d = dir.join("adir");
        create_dir(s(&d)).unwrap();
        assert!(d.is_dir());
        assert_eq!(create_dir(s(&d)).unwrap_err(), "目标已存在");
        // create_dir 也支持多级
        create_dir(s(&dir.join("x").join("y").join("z"))).unwrap();
        assert!(dir.join("x").join("y").join("z").is_dir());
    }

    #[test]
    fn rename_errors_and_dir_moves_children() {
        let dir = tmp("renamedir");
        // 源不存在
        assert_eq!(
            rename_path(s(&dir.join("no.txt")), s(&dir.join("to.txt"))).unwrap_err(),
            "源路径不存在"
        );
        // 目标已存在
        fs::write(dir.join("a.txt"), "a").unwrap();
        fs::write(dir.join("b.txt"), "b").unwrap();
        assert_eq!(
            rename_path(s(&dir.join("a.txt")), s(&dir.join("b.txt"))).unwrap_err(),
            "目标名称已存在"
        );
        // 目录重命名：子路径随迁（rename 移动整个目录，子孙全部跟着新路径）
        fs::create_dir_all(dir.join("d").join("child")).unwrap();
        let inner = dir.join("d").join("child").join("i.txt");
        fs::write(&inner, "inner").unwrap();
        rename_path(s(&dir.join("d")), s(&dir.join("d2"))).unwrap();
        assert!(!dir.join("d").exists());
        assert_eq!(
            fs::read_to_string(dir.join("d2").join("child").join("i.txt")).unwrap(),
            "inner"
        );
    }

    #[test]
    fn copies_paths_recursively() {
        let dir = tmp("copyops");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src").join("nested")).unwrap();
        fs::write(dir.join("src").join("a.txt"), "aaa").unwrap();
        fs::write(dir.join("src").join("nested").join("b.md"), "# b").unwrap();
        let src = s(&dir.join("src"));
        let dst = s(&dir.join("dst"));
        copy_path(src.clone(), dst.clone()).unwrap();
        assert_eq!(fs::read_to_string(dir.join("dst").join("a.txt")).unwrap(), "aaa");
        assert_eq!(
            fs::read_to_string(dir.join("dst").join("nested").join("b.md")).unwrap(),
            "# b"
        );
        // dest exists -> error
        assert!(copy_path(src.clone(), dst.clone()).is_err());
        // copying a folder into itself -> error
        let inner = s(&dir.join("src").join("inner"));
        assert!(copy_path(src.clone(), inner).is_err());
        // single file copy
        let fdst = s(&dir.join("a-copy.txt"));
        copy_path(s(&dir.join("src").join("a.txt")), fdst.clone()).unwrap();
        assert!(Path::new(&fdst).exists());
        assert!(path_exists(fdst));
        assert!(!path_exists(s(&dir.join("nope.txt"))));
    }

    #[test]
    fn copy_error_messages_are_exact() {
        let dir = tmp("copymsg");
        // 源不存在
        assert_eq!(
            copy_path(s(&dir.join("no")), s(&dir.join("dst"))).unwrap_err(),
            "源路径不存在"
        );
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("f.txt"), "f").unwrap();
        fs::create_dir_all(dir.join("dst")).unwrap();
        // 目标已存在
        assert_eq!(
            copy_path(s(&dir.join("src")), s(&dir.join("dst"))).unwrap_err(),
            "目标已存在"
        );
        // 复制进自身内部
        assert_eq!(
            copy_path(s(&dir.join("src")), s(&dir.join("src").join("mine"))).unwrap_err(),
            "不能将文件夹复制到其自身内部"
        );
        // 单文件递归复制：目录内容逐字节一致
        let full = s(&dir.join("full"));
        copy_path(s(&dir.join("src")), full.clone()).unwrap();
        assert_eq!(fs::read_to_string(dir.join("full").join("f.txt")).unwrap(), "f");
        assert_eq!(
            fs::read_dir(dir.join("src")).unwrap().count(),
            fs::read_dir(Path::new(&full)).unwrap().count()
        );
    }

    #[test]
    fn delete_path_missing_returns_err_without_side_effects() {
        // 只测错误分支：trash::delete 对真实文件会把内容放进用户废纸篓，
        // 属于对共享系统的副作用，单元测试禁止触发。
        let dir = tmp("delerr");
        let err = delete_path(s(&dir.join("nope.txt"))).unwrap_err();
        assert!(
            err.starts_with("移入回收站失败"),
            "错误文案应以「移入回收站失败」开头，实际：{}",
            err
        );
    }

    // ===================== J. MAX_FILE_SIZE 边界 =====================

    #[test]
    fn rejects_oversized_file() {
        let dir = tmp("big");
        // 用稀疏文件造一个刚好超过 64MB 上限的文件：APFS 上不占实际磁盘块
        let f = dir.join("sparse.txt");
        sparse_file(&f, MAX_FILE_SIZE + 1);
        let err = match read_text_file(s(&f)) {
            Ok(_) => panic!("超过 64MB 的文件应被拒绝读取"),
            Err(e) => e,
        };
        assert!(err.contains("文件过大"), "错误文案应包含「文件过大」，实际：{}", err);
        assert!(err.contains("64 MB"), "错误文案应包含上限 MB 数，实际：{}", err);
        // 同目录下的正常小文件不受影响
        let small = dir.join("small.txt");
        fs::write(&small, "still fine").unwrap();
        let fc = read_text_file(s(&small)).unwrap();
        assert_eq!(fc.content, "still fine");
        // 恰好等于上限的文件按实现（> 才拒绝）应可读
        let edge = dir.join("edge.txt");
        sparse_file(&edge, MAX_FILE_SIZE);
        // 64MB 全零稀疏文件读取较快，解码后是 64MB 的 NUL 文本；只验证不被拒绝
        assert!(read_text_file(s(&edge)).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    // ===================== K. 常量 / 私有映射 / 性能 =====================

    #[test]
    fn encoding_by_name_maps_known_names() {
        // encoding_by_name 忽略大小写（先 to_ascii_uppercase）
        assert_eq!(encoding_by_name("UTF-8").name(), "UTF-8");
        assert_eq!(encoding_by_name("utf-16le").name(), "UTF-16LE");
        assert_eq!(encoding_by_name("UTF-16BE").name(), "UTF-16BE");
        assert_eq!(encoding_by_name("gb18030").name(), "gb18030");
        assert_eq!(encoding_by_name("BIG5").name(), "Big5");
        assert_eq!(encoding_by_name("shift_jis").name(), "Shift_JIS");
        assert_eq!(encoding_by_name("euc-kr").name(), "EUC-KR");
        assert_eq!(encoding_by_name("windows-1252").name(), "windows-1252");
    }

    #[test]
    fn encoding_by_name_unknown_falls_back_to_utf8() {
        assert_eq!(encoding_by_name("no-such-codec").name(), "UTF-8");
        assert_eq!(encoding_by_name("").name(), "UTF-8");
        assert_eq!(encoding_by_name("utf 8").name(), "UTF-8");
        assert_eq!(encoding_by_name("ANSI").name(), "UTF-8");
    }

    #[test]
    fn large_file_read_is_fast() {
        let dir = tmp("perf");
        let f = dir.join("big.txt");
        let line = "the quick brown fox jumps over the lazy dog 0123456789\n";
        let mut data = String::with_capacity(16 * 1024 * 1024);
        while data.len() < 16 * 1024 * 1024 {
            data.push_str(line);
        }
        fs::write(&f, &data).unwrap();
        let start = std::time::Instant::now();
        let fc = read_text_file(s(&f)).unwrap();
        let elapsed = start.elapsed();
        println!("read 16MB in {:?}", elapsed);
        assert!(fc.content.len() > 16 * 1024 * 1024);
        assert!(elapsed.as_millis() < 1500, "16MB read took {elapsed:?}");
    }

    #[test]
    fn read_16mb_utf16_is_within_guardrail() {
        // 性能护栏：16MB 的 UTF-16LE 文件读取应在 3 秒内完成，且行尾、编码识别正确
        let dir = tmp("perf16u16");
        let f = dir.join("u16big.txt");
        let text = "混合内容 mixed content 0123456789 éü中文\n".repeat(250_000);
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(utf16le_bytes(&text));
        assert!(bytes.len() > 16 * 1024 * 1024);
        fs::write(&f, &bytes).unwrap();
        let start = std::time::Instant::now();
        let fc = read_text_file(s(&f)).unwrap();
        let elapsed = start.elapsed();
        println!("read 16MB UTF-16LE in {:?}", elapsed);
        assert_eq!(fc.encoding, "UTF-16LE");
        assert_eq!(fc.line_ending, "\n");
        assert_eq!(fc.content, text);
        assert!(elapsed.as_millis() < 3000, "16MB UTF-16 读取耗时 {elapsed:?}");
    }
    // ---------- 性能优化点：前缀嗅探 / 原地归一化 / 只读阈值 ----------

    #[test]
    fn sniff_window_skips_ascii_prefix_and_is_capped() {
        // 前导纯 ASCII 被跳过，窗口从第一个高位字节开始
        let ascii = b"header line\n".repeat(10);
        let mut bytes = ascii.clone();
        bytes.extend_from_slice(&GB18030.encode("\u{4e2d}\u{6587}\u{6d4b}\u{8bd5}").0);
        let win = sniff_window(&bytes);
        assert_eq!(win, &bytes[ascii.len()..]);

        // 全文纯 ASCII 时窗口为空，不必做任何 legacy 解码
        assert!(sniff_window(b"plain ascii only").is_empty());

        // 窗口长度封顶 64 KiB，与文件大小无关
        let big_text = "\u{4e2d}\u{534e}\u{4eba}\u{6c11} repet ".repeat(200_000);
        let big = GB18030.encode(&big_text).0;
        assert!(big.len() > 4 * DETECT_SNIFF_BYTES);
        assert_eq!(sniff_window(&big).len(), DETECT_SNIFF_BYTES);
    }

    #[test]
    fn sniff_decode_accepts_window_cut_inside_a_multibyte_char() {
        let full = GB18030.encode("\u{4e2d}\u{534e}\u{4eba}\u{6c11}\u{6587}\u{5b57}\u{7f16}\u{7801}\u{6d4b}\u{8bd5}").0;
        // 逐个截短：哪怕切在多字节字符中间，流式解码也只是缓冲半个字符，不应判为失败
        for cut in 2..full.len() {
            assert!(
                sniff_decode(&GB18030, &full[..cut]).is_some(),
                "截断到 {} 字节时不应放弃候选",
                cut
            );
        }
        // 单个高位字节只够开头，流式解码没有产出任何字符，此时放弃候选
        assert!(sniff_decode(&GB18030, &full[..1]).is_none());
        assert!(sniff_decode(&GB18030, b"").is_none());
        assert!(sniff_decode(&GB18030, b"all ascii").is_none());
    }

    #[test]
    fn detection_scans_only_a_window_not_the_whole_file() {
        // 16MB 的 GB18030 文本：识别只读前 64 KiB，耗时应当与文件大小无关
        let chunk = GB18030.encode("\u{4e2d}\u{534e}\u{4eba}\u{6c11}\u{5171}\u{548c}\u{56fd}\u{5386}\u{53f2}\u{60a0}\u{4e45} ").0;
        let mut bytes = Vec::with_capacity(17 * 1024 * 1024);
        while bytes.len() < 16 * 1024 * 1024 {
            bytes.extend_from_slice(&chunk);
        }
        let start = std::time::Instant::now();
        let enc = detect_encoding(&bytes);
        let elapsed = start.elapsed();
        println!("detect_encoding over {} MB in {:?}", bytes.len() / 1024 / 1024, elapsed);
        assert_eq!(enc.name(), "gb18030");
        // 旧实现对整篇做四次解码，这里应在几十毫秒内完成
        assert!(elapsed.as_millis() < 150, "编码嗅探耗时 {elapsed:?}");
        // 同样的文本换成 64 KiB 片段，耗时同量级（差异只是噪声）
        let small = &bytes[..DETECT_SNIFF_BYTES];
        let start = std::time::Instant::now();
        assert_eq!(detect_encoding(small).name(), "gb18030");
        println!("detect_encoding over 64 KiB in {:?}", start.elapsed());
    }

    #[test]
    fn reads_legacy_text_behind_a_long_ascii_header() {
        // 前导 70 KiB 纯 ASCII 表头 + 之后的 GB18030 正文：窗口从高位字节起算，仍应识别为 GB18030
        let dir = tmp("asciihead");
        let header = "REM header line\n".repeat(5_000); // ~85 KiB
        let body = "\u{4e2d}\u{6587}\u{6bb5}\u{843d}\u{5728}\u{540e}\u{9762}\u{3002}".repeat(30);
        let mut bytes = header.into_bytes();
        bytes.extend_from_slice(&GB18030.encode(&body).0);
        let f = dir.join("head.log");
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "gb18030");
        assert!(fc.content.starts_with("REM header line\n"));
        assert!(fc.content.ends_with(&body));
        assert!(!fc.content.contains('\u{FFFD}'));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bytes_after_the_window_are_decoded_with_the_chosen_encoding() {
        // 已记录的取舍：窗口之外的非法字节按选中的编码解码，坏字节被剔除而不是回退成 windows-1252
        let dir = tmp("tailnoise");
        let mut bytes = Vec::new();
        let chunk = GB18030.encode("\u{4e2d}\u{534e}\u{6587}\u{5b57} ").0;
        for _ in 0..12_000 {
            bytes.extend_from_slice(&chunk);
        }
        assert!(bytes.len() > DETECT_SNIFF_BYTES);
        bytes.extend_from_slice(&[0xF8, 0xFF, 0xFE]); // 窗口之外的非法字节
        let f = dir.join("tail.gbk");
        fs::write(&f, &bytes).unwrap();
        let fc = read_text_file(s(&f)).unwrap();
        assert_eq!(fc.encoding, "gb18030");
        assert!(!fc.content.contains('\u{FFFD}'), "非法字节应被剔除而不是留下替换字符");
        assert!(fc.content.starts_with("\u{4e2d}\u{534e}\u{6587}\u{5b57} "));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_newlines_skips_the_copy_without_cr() {
        // 快路径：没有 \r 就不复制，缓冲区地址不变
        let mut text = "line one\nline two\n\u{4e2d}\u{6587}".to_string();
        let before = text.as_ptr();
        normalize_newlines(&mut text);
        assert_eq!(text, "line one\nline two\n\u{4e2d}\u{6587}");
        assert_eq!(before, text.as_ptr(), "无 \r 时不应重新分配缓冲区");

        // \r\n、裸 \r、\r\r\n 都在单遍里归一成 \n
        let mut crlf = "a\r\nb\rc\r\r\nd\n".to_string();
        normalize_newlines(&mut crlf);
        assert_eq!(crlf, "a\nb\nc\n\nd\n");
    }

    #[test]
    fn normalize_newlines_is_one_pass_on_16mb() {
        let line = "the quick brown fox jumps over the lazy dog 0123456789\r\n";
        let mut data = String::with_capacity(16 * 1024 * 1024);
        while data.len() < 16 * 1024 * 1024 {
            data.push_str(line);
        }
        let start = std::time::Instant::now();
        normalize_newlines(&mut data);
        let elapsed = start.elapsed();
        println!("normalize 16MB CRLF in {:?}", elapsed);
        assert!(!data.contains('\r'));
        assert!(data.matches('\n').count() > 200_000);
        // 本机几百毫秒的线性扫描，在 CI 的共享 Windows runner 上实测能到 470ms+，阈值取 3 倍余量
        assert!(elapsed.as_millis() < 1200, "归一化耗时 {elapsed:?}");
    }

    #[test]
    fn read_16mb_gb18030_is_within_guardrail() {
        // 端到端护栏：16MB legacy 编码文件从磁盘到字符串应在 2 秒内
        let dir = tmp("perfgbk");
        let line = "\u{4e2d}\u{534e}\u{4eba}\u{6c11}\u{5171}\u{548c}\u{56fd}\u{5386}\u{53f2}\u{60a0}\u{4e45}\r\n";
        let text = line.repeat(700_000);
        let bytes = GB18030.encode(&text).0;
        assert!(bytes.len() > 16 * 1024 * 1024);
        let f = dir.join("big.gbk");
        fs::write(&f, &bytes).unwrap();
        let start = std::time::Instant::now();
        let fc = read_text_file(s(&f)).unwrap();
        let elapsed = start.elapsed();
        println!("read 16MB GB18030 in {:?}", elapsed);
        assert_eq!(fc.encoding, "gb18030");
        assert_eq!(fc.line_ending, "\r\n");
        assert_eq!(fc.content, text.replace("\r\n", "\n"));
        assert!(fc.content.contains("\u{4e2d}\u{534e}\u{4eba}\u{6c11}"));
        assert!(elapsed.as_millis() < 2000, "16MB legacy 读取耗时 {elapsed:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_rejection_does_not_read_the_file() {
        // 拒绝路径只 stat：即便 64MB 也应在几十毫秒内返回错误
        let dir = tmp("rejectperf");
        let f = dir.join("huge.bin");
        sparse_file(&f, MAX_FILE_SIZE + 1);
        let start = std::time::Instant::now();
        let err = match read_text_file(s(&f)) {
            Ok(_) => panic!("超过 64MB 的文件应被拒绝读取"),
            Err(e) => e,
        };
        let elapsed = start.elapsed();
        println!("reject 64MB+ in {:?} ({})", elapsed, err);
        assert!(err.contains("文件过大"));
        assert!(elapsed.as_millis() < 100, "拒绝超大文件不该读盘，耗时 {elapsed:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_marks_files_over_the_edit_limit_as_large() {
        let dir = tmp("largeflag");
        // 恰好等于阈值仍可编辑，超过一个字节就只读
        let at = dir.join("at-limit.txt");
        sparse_file(&at, EDIT_SIZE_LIMIT);
        let fc = read_text_file(s(&at)).unwrap();
        assert_eq!(fc.size, EDIT_SIZE_LIMIT);
        assert!(!fc.large, "恰好 8MB 不该标记为超大");

        let over = dir.join("over-limit.txt");
        sparse_file(&over, EDIT_SIZE_LIMIT + 1);
        let fc = read_text_file(s(&over)).unwrap();
        assert_eq!(fc.size, EDIT_SIZE_LIMIT + 1);
        assert!(fc.large, "超过 8MB 应标记为超大并交给前端只读打开");

        // 阈值之下的普通文件
        let small = dir.join("small.txt");
        fs::write(&small, "\u{65e5}\u{5fd7}\u{5185}\u{5bb9}").unwrap();
        assert!(!read_text_file(s(&small)).unwrap().large);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_9mb_plain_text_is_flagged_large_but_complete() {
        // 真实略超阈值的文本：既给出 large 标记，也保证内容完整可读
        let dir = tmp("large9mb");
        let line = "2026-01-01 12:00:00 INFO worker thread handled request 0123456789\n";
        let mut data = String::new();
        while data.len() < 9 * 1024 * 1024 {
            data.push_str(&line.repeat(1000));
        }
        let f = dir.join("app.log");
        fs::write(&f, &data).unwrap();
        let start = std::time::Instant::now();
        let fc = read_text_file(s(&f)).unwrap();
        let elapsed = start.elapsed();
        println!("read 9MB log in {:?}", elapsed);
        assert!(fc.large);
        assert_eq!(fc.size, data.len() as u64);
        assert_eq!(fc.content.len(), data.len());
        assert_eq!(fc.line_ending, "\n");
        assert!(elapsed.as_millis() < 1500, "9MB 读取耗时 {elapsed:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
